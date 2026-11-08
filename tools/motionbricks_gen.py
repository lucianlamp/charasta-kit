"""MotionBricks（NVIDIA、SOMA の人のモデル）で動きを作り、VRM の骨に移し替えて VRMA を書く。

MotionBricks の uv の環境で動かす（MotionBricks のリポジトリは変えない。デモの runtime（app/）を読み込んで使うだけ）:

    uv run --project <MotionBricks のリポジトリ> --no-sync python tools/motionbricks_gen.py --motionbricks <同じ場所> \
        --out motion.vrma --info info.json --kind forward --speed 2.0 --turn 90 --seconds 6

動かし方は MotionBricks のデモ Scene Preview（app/scene_preview.py）と同じで、SOMACharacter に毎コマ
LocomotionCommand（進む向き・速さ・種類）を渡す。最初は待機の見本の動き（クリップ）から始まり、そこから先の
生成した区間だけを書き出す（クリップのコマそのものは書き出さない）。最後に止まるときは、待機のクリップへの
つなぎの生成までを書き出す。

--fake は MotionBricks を使わず、決まった作りものの動き（足を振りながら前へ進む）を同じ移し替えで書く（テスト用。
ふだんの Python と numpy だけで動く）。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from soma_vrma import retarget, write_vrma  # noqa: E402

FPS = 30
# 種類 -> (MotionBricks の locomotion mode の名前, 表示名)。app/runtime/soma/presets.py の DEFAULT_LOCOMOTION_MODES
KINDS = {
    "forward": ("linear_1d", "歩き・走り"),
    "strafe": ("directional_2d", "向きを保って動く"),
    "crouch": ("crouch_directional_2d", "しゃがみ歩き"),
    "skipping": ("skipping_1d", "スキップ"),
    "vogue": ("vogue_1d", "ヴォーグ"),
    "injured-torso": ("injured_torso_1d", "おなかを押さえて歩く"),
    "injured-leg": ("injured_leg_1d", "足を引きずる"),
    "zombie": ("zombie_1d", "ゾンビ"),
    "combat": ("combat_1d", "構えて動く"),
}
# 向きを保つ種類の、体の向きに対する進む向き（度、左が正）
DIRECTIONS = {"forward": 0.0, "left": 90.0, "backward": 180.0, "right": -90.0}
# 途中の動作 -> Smart Primitive の文書（assets/smart_primitives/soma/）。ふるまいはどれも VelocityMatchingSequenceBehavior
ACTIONS = {"jump": "jump_0_5m", "jump-high": "jump_0_75m", "duck": "avoidance"}
# 曲がりはこの割合の区間でかける（前後はまっすぐ）
TURN_SPAN = (0.2, 0.8)
STOP_MAX_SEC = 6.0


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--out", required=True, help="書き出す .vrma")
    p.add_argument("--info", help="生成の記録を書く JSON")
    p.add_argument("--contacts", help="足の接地を書く JSON（docs/foot-ik.md。コマごとの左かかと・左爪先・右かかと・右爪先の信頼度）")
    p.add_argument("--motionbricks", default=os.environ.get("MOTIONBRICKS_DIR"), help="MotionBricks のリポジトリ(省くと環境変数 MOTIONBRICKS_DIR)")
    p.add_argument("--kind", choices=sorted(KINDS), default="forward")
    p.add_argument("--speed", type=float, default=None, help="m/s。種類ごとの範囲に収める。省くと種類の標準")
    p.add_argument("--direction", choices=sorted(DIRECTIONS), default="forward", help="strafe と crouch の進む向き")
    p.add_argument("--turn", type=float, default=0.0, help="動く間に曲がる角度（度、左が正）")
    p.add_argument("--seconds", type=float, default=6.0, help="動く長さ（秒）。止まる分は別")
    p.add_argument("--action", choices=["none", *sorted(ACTIONS)], default="none", help="途中の動作（forward だけ）")
    p.add_argument("--ending", choices=["stop", "move"], default="stop", help="stop は止まって終わる、move は動いたまま終わる")
    p.add_argument("--root", choices=["keep", "inplace"], default="keep", help="keep は進む、inplace はその場")
    p.add_argument("--fp16", action="store_true", help="混合 FP16 のモデルを使う（既定は FP32）")
    p.add_argument("--fake", action="store_true", help="MotionBricks を使わない作りものの動き（テスト用）")
    a = p.parse_args(argv)
    if not 1.0 <= a.seconds <= 30.0:
        p.error("--seconds は 1〜30")
    if not -360.0 <= a.turn <= 360.0:
        p.error("--turn は -360〜360")
    if a.action != "none" and a.kind != "forward":
        p.error("--action は --kind forward のときだけ")
    if a.action != "none" and a.seconds < 4.0:
        p.error("--action を入れるときは --seconds を 4 以上にする")
    return a


def smoothstep(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3.0 - 2.0 * x)


def turn_angle(args, t):
    """動き始めから t 秒の、曲がった角度（ラジアン）。"""
    a, b = TURN_SPAN
    return math.radians(args.turn) * smoothstep((t / args.seconds - a) / (b - a))


def rotate2(v, angle):
    c, s = math.cos(angle), math.sin(angle)
    return np.array([c * v[0] - s * v[1], s * v[0] + c * v[1], 0.0], dtype=np.float32)


# ---------------------------------------------------------------- 本物（MotionBricks）
def generate(args, log):
    mb = Path(args.motionbricks).resolve()
    sys.path.insert(0, str(mb))  # デモの runtime（app/）を読み込むため
    t0 = time.perf_counter()
    import warp as wp

    wp.config.quiet = True
    wp.init()
    wp.set_device("cuda:0")
    from motionbricks.inference.builder import TensorRTBuildOptions
    from motionbricks.model.contract import ModelRig
    from motionbricks.model.soma.contract import SOMA_N1_FP16_ONNX_PATH, SOMA_N1_FP32_ONNX_PATH
    from motionbricks.model.soma.engine import MotionBricksSOMAEngine
    from motionbricks.runtime.smart_primitive import InteractionBox, compute_interaction_box_overlaps

    from app.runtime.common.io.smart_primitive_document import SmartPrimitiveAssetPool
    from app.runtime.common.motion import LocomotionCommand, PlaybackSource
    from app.runtime.common.rig import ASSETS_ROOT, load_rig_assets
    from app.runtime.common.smart_primitive_behaviors import VelocityMatchingSequenceBehavior
    from app.runtime.soma import presets
    from app.runtime.soma.character import SOMACharacter

    mode_name = KINDS[args.kind][0]
    mode = next(m for m in presets.DEFAULT_LOCOMOTION_MODES if m.name == mode_name)
    crouch = mode_name == "crouch_directional_2d"
    # 待機のクリップは 1 つに決める（毎回同じ始まりにするため。既定は 4 つから乱数で選ぶ）
    idle_clip = presets.DEFAULT_CROUCH_IDLE_CLIPS[0] if crouch else presets.DEFAULT_IDLE_CLIPS[0]

    assets = load_rig_assets(ModelRig.SOMA)
    pool = SmartPrimitiveAssetPool(assets.clip_registry, assets.reference_pose, assets.model_to_runtime)
    log(f"エンジンを読み込む（{'混合 FP16' if args.fp16 else 'FP32'}。初回は TensorRT の plan を作るので数分かかる）")
    t1 = time.perf_counter()
    engine = MotionBricksSOMAEngine(
        SOMA_N1_FP16_ONNX_PATH if args.fp16 else SOMA_N1_FP32_ONNX_PATH,
        model_to_runtime=assets.model_to_runtime,
        build_options=TensorRTBuildOptions(enable_fp16=args.fp16),
        cache_dir=mb / ".trt-cache",
    )
    engine_sec = time.perf_counter() - t1
    log(f"エンジンを読み込んだ（{engine_sec:.1f} 秒）")

    skeleton = assets.clip_registry.skeleton
    m2r = assets.model_to_runtime
    r2m_q = np.array(wp.transform_inverse(m2r))[3:]
    frames = []
    contacts = []
    action_started = None
    t2 = time.perf_counter()
    with engine, wp.ScopedStream(engine.stream):
        character = SOMACharacter(engine, asset_pool=pool, initial_mode=mode_name,
                                  idle_paths=(idle_clip,), crouch_idle_paths=(presets.DEFAULT_CROUCH_IDLE_CLIPS[0],))
        facing0 = character.movement.current_facing.copy()
        speed = min(max(args.speed if args.speed is not None else mode.default_speed, mode.minimum_speed), mode.max_speed)
        amount = speed / mode.max_speed

        primitive = None
        if args.action != "none":
            path = ASSETS_ROOT / "smart_primitives" / "soma" / f"{ACTIONS[args.action]}.smart_primitive.json"
            primitive = pool.instantiate(path, VelocityMatchingSequenceBehavior)
            character.state_machine.interaction_state.prepare(character, primitive)
            boxes = wp.empty(max(1, primitive.interaction_box_count), dtype=InteractionBox)
            hits = wp.zeros(max(1, primitive.interaction_box_count), dtype=wp.int32)
            # 動く長さの 4 割の時点で、そのときの前方に置く（Scene Preview の gym と同じく、体の向きから -90 度回す）
            place_at = max(1.5, 0.4 * args.seconds)
            placed = False

        dt = 1.0 / FPS
        step = 0
        stop_steps = 0
        while True:
            t = step * dt
            moving = t < args.seconds
            if not moving and args.ending == "move":
                break
            if not moving:
                stop_steps += 1
                if stop_steps > STOP_MAX_SEC * FPS:
                    raise RuntimeError(f"止まりきらない（{STOP_MAX_SEC} 秒）")
            angle = turn_angle(args, t) if moving else turn_angle(args, args.seconds)
            facing = rotate2(facing0, angle)
            if moving:
                rel = math.radians(DIRECTIONS[args.direction]) if mode.blend_space_type.name == "DIRECTIONAL_2D" else 0.0
                command = LocomotionCommand(facing_direction=facing, movement=rotate2(facing, rel) * amount, use_max_speed=True)
            else:
                command = LocomotionCommand(facing_direction=facing, movement=None)

            if primitive is not None and moving and action_started is None:
                if not placed and t >= place_at:
                    yaw = math.atan2(float(character.movement.current_facing[1]), float(character.movement.current_facing[0]))
                    ahead = character.character_ground_position + character.movement.current_facing * max(2.0, speed * 1.2)
                    place = wp.transform(wp.vec3(float(ahead[0]), float(ahead[1]), 0.0),
                                         wp.quat_from_axis_angle(wp.vec3(0.0, 0.0, 1.0), yaw - 0.5 * math.pi))
                    primitive.set_node_world_transform(0, place, stream=engine.stream)
                    placed = True
                    log(f"{args.action} を置いた（{t:.2f} 秒、前方 {max(2.0, speed * 1.2):.2f} m）")
                if placed and primitive.interaction_box_count:
                    primitive.get_world_interaction_boxes(boxes, engine.stream)
                    compute_interaction_box_overlaps(boxes, character.probe_box, hits, engine.stream)
                    if hits.numpy().any() and not character.state_machine.is_interacting:
                        character.state_machine.start_interaction(character, primitive)
                        action_started = t
                        log(f"{args.action} を始めた（{t:.2f} 秒）")

            character.step(dt, command)
            source = character._playback_source
            if source is PlaybackSource.CLIP:
                if frames and not moving:
                    break  # 止まって待機のクリップに入った。クリップのコマは書かない
            else:
                frames.append(character.current_pose.numpy().copy())
                contacts.append(character.current_foot_contacts.numpy().copy())
            step += 1
        engine.synchronize()
    gen_sec = time.perf_counter() - t2
    if primitive is not None and action_started is None:
        raise RuntimeError(f"{args.action} が始まらなかった（置いた物に近づけなかった）")
    if len(frames) < 2:
        raise RuntimeError("生成したコマが無い")

    local = np.stack(frames).astype(np.float64)  # [F, J, 7]、根（Hips）は Z が上の runtime の空間
    # 根を SOMA の空間（Y が上）に戻す: model = runtime_to_model * runtime
    from soma_vrma import qmul, qrot
    local[:, 0, :3] = qrot(np.broadcast_to(r2m_q, (len(local), 4)), local[:, 0, :3])
    local[:, 0, 3:] = qmul(np.broadcast_to(r2m_q, (len(local), 4)), local[:, 0, 3:])
    rest = skeleton.reference_local_transforms.numpy().astype(np.float64)
    parents = [int(skeleton.joint_parent(i)) for i in range(skeleton.num_joints)]

    clips = used_clips(mb, args, mode, idle_clip)
    stats = {"engine": "fp16" if args.fp16 else "fp32", "speedUsed": round(speed, 3),
             "speedRange": [mode.minimum_speed, mode.max_speed], "actionStartedSec": action_started,
             "timings": {"importSec": round(t1 - t0, 2), "engineSec": round(engine_sec, 2), "generateSec": round(gen_sec, 2)},
             "sampleClips": clips}
    return skeleton.joint_names, parents, rest, local, stats, np.stack(contacts)


def used_clips(mb, args, mode, idle_clip):
    """生成の文脈と目標に使った見本の動き（BVH）。ライセンスの記録に書く。"""
    out = {Path(idle_clip).resolve()}
    sp_dir = mb / "assets" / "smart_primitives" / "soma"

    def clips_of(doc, names=None):
        found = set()

        def walk(node):
            if names is None or node.get("name") in names:
                for c in node.get("components", []):
                    if c.get("clip"):
                        found.add((doc.parent / c["clip"]).resolve())
            for ch in node.get("children", []):
                walk(ch)
        walk(json.loads(doc.read_text(encoding="utf8"))["root"])
        return found

    out |= clips_of(Path(mode.smart_primitive_path), {name for name, _ in mode.target_values})
    if args.action != "none":
        out |= clips_of(sp_dir / f"{ACTIONS[args.action]}.smart_primitive.json")
    return sorted(str(p.relative_to(mb)).replace("\\", "/") for p in out)


# ---------------------------------------------------------------- 作りもの（テスト用）
FAKE_SKELETON = [  # 名前, 親, 静止姿勢（T ポーズ）の親からの位置
    ("Hips", -1, (0, 1.0, 0)), ("Spine1", 0, (0, 0.05, 0)), ("Spine2", 1, (0, 0.07, 0)), ("Chest", 2, (0, 0.07, 0)),
    ("Neck1", 3, (0, 0.26, 0)), ("Head", 4, (0, 0.14, 0)),
    ("LeftShoulder", 3, (0.02, 0.23, 0)), ("LeftArm", 6, (0.15, 0, 0)), ("LeftForeArm", 7, (0.29, 0, 0)), ("LeftHand", 8, (0.27, 0, 0)),
    ("RightShoulder", 3, (-0.02, 0.23, 0)), ("RightArm", 10, (-0.15, 0, 0)), ("RightForeArm", 11, (-0.29, 0, 0)), ("RightHand", 12, (-0.27, 0, 0)),
    ("LeftLeg", 0, (0.1, -0.08, 0)), ("LeftShin", 14, (0, -0.43, 0)), ("LeftFoot", 15, (0, -0.42, 0)), ("LeftToeBase", 16, (0, -0.05, 0.13)),
    ("RightLeg", 0, (-0.1, -0.08, 0)), ("RightShin", 18, (0, -0.43, 0)), ("RightFoot", 19, (0, -0.42, 0)), ("RightToeBase", 20, (0, -0.05, 0.13)),
]


def fake_motion(args):
    names = [n for n, _, _ in FAKE_SKELETON]
    parents = [p for _, p, _ in FAKE_SKELETON]
    rest = np.zeros((len(names), 7))
    rest[:, :3] = [o for _, _, o in FAKE_SKELETON]
    rest[:, 6] = 1.0
    n = int(round(args.seconds * FPS)) + 1
    local = np.repeat(rest[None], n, 0)
    speed = args.speed if args.speed is not None else 1.5
    t = np.arange(n) / FPS
    swing = 0.5 * np.sin(2 * np.pi * 1.0 * t)
    for name, sign in (("LeftLeg", 1), ("RightLeg", -1)):  # 足を前後に振る（X 軸まわり）
        j = names.index(name)
        local[:, j, 3] = np.sin(sign * swing / 2)
        local[:, j, 6] = np.cos(sign * swing / 2)
    local[:, 0, 2] = speed * t  # +Z へ進む
    stats = {"engine": "fake", "speedUsed": speed, "speedRange": [0, 10], "actionStartedSec": None,
             "timings": {"importSec": 0, "engineSec": 0, "generateSec": 0}, "sampleClips": []}
    contacts = np.tile([0.0, 1.0, 1.0, 0.0], (n, 1))  # 作りもの: 左はかかとを上げ、右はかかとを着く
    return names, parents, rest, local, stats, contacts


def main(argv=None):
    args = parse_args(argv)

    def log(msg):
        print(msg, flush=True)

    t0 = time.perf_counter()
    names, parents, rest, local, stats, contacts = fake_motion(args) if args.fake else generate(args, log)
    log(f"移し替える（{len(local)} コマ）")
    motion = retarget(names, parents, rest, local, FPS, root_motion=args.root)
    meta = write_vrma(args.out, motion)
    hips = motion["hips"]
    travel = float(np.linalg.norm(hips[-1, [0, 2]] - hips[0, [0, 2]]))
    info = {**meta, **stats, "fps": FPS, "travelM": round(travel, 3),
            "options": {k: getattr(args, k) for k in ("kind", "speed", "direction", "turn", "seconds", "action", "ending", "root", "fp16")},
            "totalSec": round(time.perf_counter() - t0, 2)}
    if args.info:
        Path(args.info).write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf8")
    if args.contacts:
        Path(args.contacts).write_text(json.dumps({"fps": FPS, "order": ["leftHeel", "leftToe", "rightHeel", "rightToe"],
                                                   "frames": np.round(contacts, 3).tolist()}), encoding="utf8")
    log(f"書いた: {args.out}（{meta['frames']} コマ、{meta['durationSec']:.2f} 秒、進んだ距離 {travel:.2f} m）")


if __name__ == "__main__":
    main()
