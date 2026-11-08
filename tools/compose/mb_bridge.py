"""MotionBricks で 2 つの区間の間を生成する。MotionBricks の uv の環境で動かす（MotionBricks のリポジトリは変えない。場所は環境変数 MOTIONBRICKS_DIR）:

    uv run --project $MOTIONBRICKS_DIR --no-sync python tools/compose/mb_bridge.py jobs.json report.json

jobs.json: [{"a": "前の区間.npz", "b": "位置を合わせた次の区間.npz", "seconds": 1.6, "out": "つなぎ.npz"}]

context は a の最後の 4 コマ、target は b の最初の 4 コマ。見本の動き（BVH）は context にも target にも使わない。
エンジンは TensorRT の GPU で動かす（CUDA が要る）。1 本の生成は 1 秒ほどで、エンジンの読み込みは 1 回で済む。
生成の長さはトークンの数で決まる: 書き出すコマは 4 × トークン - 8 で、トークンは 6〜16。
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clip as C  # noqa: E402
from soma_vrma import BONES, forward_kinematics, qinv, qmul, qrot, retarget  # noqa: E402

MB = os.environ.get("MOTIONBRICKS_DIR") or sys.exit("MotionBricks の場所が分からない。きゃらすたの設定(motionbricksDir)か、環境変数 MOTIONBRICKS_DIR で指定する")
sys.path.insert(0, MB)
TOKEN_RANGE = (6, 16)


def token_count(seconds):
    return int(np.clip(round((seconds * C.FPS + 8) / 4), *TOKEN_RANGE))


def to_soma(m, names, parents, rest_local):
    """中間形式を MotionBricks の骨の並びのローカルの変換 [F, J, 7]（Y が上の SOMA の空間）にする。VRM に無い関節は親の向きに従う。"""
    deltas = C.world_deltas(m)
    bone_of = {s: b for b, s, _ in BONES}
    _, rest_rot = forward_kinematics(parents, rest_local)
    F, J = C.frames(m), len(names)
    D = np.zeros((F, J, 4))
    for j, n in enumerate(names):
        D[:, j] = deltas[bone_of[n]] if n in bone_of else (D[:, parents[j]] if parents[j] >= 0 else C.IDENTITY)
    W = qmul(D, rest_rot[None])
    local = np.broadcast_to(rest_local, (F, J, 7)).copy()
    for j, p in enumerate(parents):
        local[:, j, 3:] = W[:, j] if p < 0 else qmul(qinv(W[:, p]), W[:, j])
    local[:, 0, :3] = m["hips"]
    return local


def main():
    jobs = json.load(open(sys.argv[1], encoding="utf8"))
    t0 = time.perf_counter()
    import warp as wp
    wp.config.log_level = wp.LOG_WARNING
    wp.init()
    wp.set_device("cuda:0")
    from motionbricks.inference.builder import TensorRTBuildOptions
    from motionbricks.model.config import MotionBricksInferenceConfig
    from motionbricks.model.contract import ModelRig
    from motionbricks.model.soma.contract import SOMA_N1_FP32_ONNX_PATH
    from motionbricks.model.soma.engine import MotionBricksSOMAEngine
    from app.runtime.common.rig import load_rig_assets

    assets = load_rig_assets(ModelRig.SOMA)
    skeleton = assets.clip_registry.skeleton
    names = list(skeleton.joint_names)
    parents = [int(skeleton.joint_parent(i)) for i in range(skeleton.num_joints)]
    rest_local = skeleton.reference_local_transforms.numpy().astype(np.float64)
    m2r = assets.model_to_runtime
    m2r_q = np.array(m2r)[3:]
    r2m_q = np.array(wp.transform_inverse(m2r))[3:]

    def to_runtime(frames):
        f = frames.copy()
        q = np.broadcast_to(m2r_q, (len(f), 4))
        f[:, 0, :3] = qrot(q, f[:, 0, :3])
        f[:, 0, 3:] = qmul(q, f[:, 0, 3:])
        return f

    t1 = time.perf_counter()
    engine = MotionBricksSOMAEngine(SOMA_N1_FP32_ONNX_PATH, model_to_runtime=m2r, build_options=TensorRTBuildOptions(enable_fp16=False), cache_dir=MB + "/.trt-cache")
    report = {"setupSec": round(t1 - t0, 2), "engineLoadSec": round(time.perf_counter() - t1, 2), "bridges": []}
    with engine, wp.ScopedStream(engine.stream):
        context, target, output = engine.create_input(skeleton), engine.create_input(skeleton), engine.create_output(skeleton)
        for job in jobs:
            t = time.perf_counter()
            a, b = C.load(job["a"]), C.load(job["b"])
            tokens = token_count(job["seconds"])
            ca = to_runtime(to_soma(C.make({k: v[-4:] for k, v in a["rotations"].items()}, a["hips"][-4:]), names, parents, rest_local))
            tb = to_runtime(to_soma(C.make({k: v[:4] for k, v in b["rotations"].items()}, b["hips"][:4]), names, parents, rest_local))
            context.update_from_poses(wp.array(ca.astype(np.float32), dtype=wp.transform, device=engine.device), stream=engine.stream)
            target.update_from_poses(wp.array(tb.astype(np.float32), dtype=wp.transform, device=engine.device), stream=engine.stream)
            engine.generate_animation(context=context, target=target, output=output, config=MotionBricksInferenceConfig(allowed_token_counts=(tokens,)))
            engine.synchronize()
            n = int(output.num_frames)
            gen = output.poses.numpy()[:n].astype(np.float64)
            fc = output.foot_contacts.numpy()[:n].astype(np.float64)
            q = np.broadcast_to(r2m_q, (n, 4))
            gen[:, 0, :3] = qrot(q, gen[:, 0, :3])
            gen[:, 0, 3:] = qmul(q, gen[:, 0, 3:])
            ends = [float(np.linalg.norm(gen[0, 0, :3] - a["hips"][-1])), float(np.linalg.norm(gen[-1, 0, :3] - b["hips"][0]))]
            # 生成の最初と最後のコマは context と target の端のコマと同じ姿勢なので除く（重ねると 1 コマ止まる）
            gen, fc = gen[1:-1], fc[1:-1]
            motion = retarget(names, parents, rest_local, gen, C.FPS, root_motion="keep", align=False)
            C.save(job["out"], C.fill_fingers(C.make(motion["rotations"], motion["hips"], fc), a, b))
            report["bridges"].append({"out": job["out"], "tokens": tokens, "frames": len(gen), "generateSec": round(time.perf_counter() - t, 3),
                                      "endGapCm": [round(x * 100, 2) for x in ends]})
    json.dump(report, open(sys.argv[2], "w", encoding="utf8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
