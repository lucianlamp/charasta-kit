"""ステージを撮る。Blender の中で動く。
  静止画:  blender -b --factory-startup --python tools/render.py -- --stage concert --view target --out out/x.png [--glb bake.glb --frame 100] [--pct 50 --samples 64]
  動画:    blender -b --factory-startup --python tools/render.py -- --stage concert --glb bake.glb --seconds 15 --bpm 120 --frames-dir out/frames [--seed 1 --pct 100 --samples 128]
  複数シーン: --shots-json shots.json を渡すと、その予定で stage が --stage のショットのコマだけ描く(tools/make_mv.py)
  複数のキャラ: --cast-json cast.json を渡すと 1 つのシーンに並べる。[{"glb": "...", "yaw": 0, "slot": 0, "count": 2, "turn": 0}]。slot は立ち位置の番号で、ショットの who はこの番号。turn は立ち位置の向きに足す度(tools/make_short.py)。mark、spread、inward があると、ステージの mark と 2 人の立ち方を替える
  生き物: --creature-json creature.json を渡すと、ステージの枝へ生き物を置いて動かす(lib/creature.py)
  見た目: --look anime でキャラをトゥーンにし、輪郭の光、顔の光、奥の霞、光のにじみ、顔に合わせた被写界深度を足す(lib/look.py)。--face-front も含む
  --face-front は踊りのショットのカメラを顔の向きの ±45 度へ寄せる(Sh.face_front)。どちらも無ければ前と同じ絵
  --frame-list 30,90 は描くコマを並べて渡す(試し撮り用。--start と --count より先に効く)
  スカート: --face-front(--look anime)では、カメラから股と太ももの付け根の下向きの面が直に見えるコマでカメラを上げる(Lk.skirt_lift)。
  寄り: --look anime では踊りのショットを膝上から胸上の大きさへ寄せる(Sh.tighten)
  --frame-report x.json はこのシーンのコマごとに、スカートの中が見えるかと写る大きさを書き出す。--report-only は書き出して描かずに終える
"""
import argparse
import importlib
import json
import math
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'stages'))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from bpy_extras.object_utils import world_to_camera_view  # noqa: E402
from mathutils import Matrix, Quaternion, Vector  # noqa: E402

from lib import creature as Cr  # noqa: E402
from lib import look as Lk  # noqa: E402
from lib import shots as Sh  # noqa: E402
from lib import studio as St  # noqa: E402

a = argparse.ArgumentParser()
a.add_argument('--stage', required=True)
a.add_argument('--view')
a.add_argument('--out')
a.add_argument('--glb')
a.add_argument('--cast-json')
a.add_argument('--creature-json')
a.add_argument('--frame', type=int, default=1)
a.add_argument('--pct', type=int, default=100)
a.add_argument('--samples', type=int, default=128)
a.add_argument('--seconds', type=float, default=0)
a.add_argument('--bpm', type=float, default=120)
a.add_argument('--beat-offset', type=float, default=0)
a.add_argument('--beats-json')
a.add_argument('--shots-json')
a.add_argument('--seed', type=int, default=0)
a.add_argument('--variant', default='')
a.add_argument('--yaw', type=float, default=0)
a.add_argument('--frames-dir')
a.add_argument('--start', type=int, default=0)
a.add_argument('--count', type=int, default=0)
a.add_argument('--blur', type=float, default=0.4)
a.add_argument('--face-fill', type=float, default=24)
a.add_argument('--look', choices=['anime', 'cel'])
a.add_argument('--denoiser', choices=['optix', 'oidn'])  # 無ければ studio.use_best_device が機器に合わせて選ぶ(OPTIX の機器なら OptiX)
a.add_argument('--vrm')  # --look cel で MToon の影の色と線の設定を読む元の VRM
a.add_argument('--face-front', action='store_true')
a.add_argument('--frame-list')
a.add_argument('--frame-report')
a.add_argument('--report-only', action='store_true')
args = a.parse_args(sys.argv[sys.argv.index('--') + 1:])
face_front = args.face_front or bool(args.look)

t0 = time.time()
St.clear()
St.setup_cycles(args.samples, args.pct)
if args.denoiser == 'oidn':
    bpy.context.scene.cycles.denoiser = 'OPENIMAGEDENOISE'
    bpy.context.scene.cycles.denoising_use_gpu = True
s = bpy.context.scene
seconds = args.seconds
beats = json.load(open(args.beats_json)) if args.beats_json else Sh.beats_of(args.bpm, max(seconds, 30), args.beat_offset)
ctx = St.Ctx(args.stage, St.ROOT / 'assets' / args.stage, args.seed, args.variant, beats, 30, max(1, round(seconds * 30)))
stage = importlib.import_module(args.stage).build(ctx)
cast = json.load(open(args.cast_json, encoding='utf8')) if args.cast_json else [{'glb': args.glb, 'yaw': args.yaw}] if args.glb else []
facing0 = stage.get('facing', 0)
plan = json.load(open(args.shots_json, encoding='utf8')) if args.shots_json else Sh.plan(beats, seconds, args.seed, stage.get('beats_per_shot', 8))
drama = any(p['kind'] in Sh.DRAMA_KINDS for p in plan)
actors = []
for k, c in enumerate(cast):
    slot = c.get('slot', k)
    pos, turn, side = Sh.stand(c.get('mark') or stage.get('mark', (0, 0, 0)), facing0, c.get('count', len(cast)), c.get('spread', Sh.STAND), c.get('inward', Sh.INWARD))[slot]
    before = set(bpy.data.objects)
    _, arm = St.load_character(c['glb'], pos, turn + c.get('turn', 0), c['yaw'], 0)
    new = set(bpy.data.objects) - before
    level = St.skin_level(new) if drama else None
    gain = Sh.skin_gain(level) if level else 1
    for m in {m for o in new if o.type == 'MESH' for m in o.data.materials if m}:
        St.tune_material(m, stage.get('char_emission', 0.32) * (Sh.DRAMA_EMISSION * gain if drama else 1), min(1, gain))
        if args.look == 'anime':
            Lk.toon_material(m, Lk.stage_look(args.stage), min(1, gain))
    print('actor', slot, 'skin', level, 'gain', round(gain, 2))
    actors.append({'arm': arm, 'slot': slot, 'side': side, 'gain': gain, 'turn': c.get('turn', 0), 'prop': c.get('prop'), 'meshes': [o for o in new if o.type == 'MESH'], 'paths': {'hips': [], 'head': [], 'chest': [], 'turn': [], 'hand': [], 'fingers': []}})
print('build', round(time.time() - t0, 1))
s.render.dither_intensity = 1.0

if args.view:
    v = stage['views'][args.view]
    St.add_camera(v)
    s.frame_set(args.frame)
    St.write_png(args.out)
    print('still', round(time.time() - t0, 1))
    sys.exit(0)

# 動画: 動きからキャラの道筋を測り、カメラをコマごとに置く
for actor in actors:
    arm = actor['arm']
    actor['bones'] = [St.find_bone(arm, *n) for n in (('J_Bip_C_Hips', 'Hips'), ('J_Bip_C_Head', 'Head'), ('J_Bip_C_UpperChest', 'J_Bip_C_Chest', 'Chest'), ('J_Bip_L_UpperArm', 'LeftUpperArm', 'upper_arm.L'), ('J_Bip_R_UpperArm', 'RightUpperArm', 'upper_arm.R'))]
    if actor['prop']:  # 手の道筋は小道具を持つ人だけ測る。指の骨の無い体は手首で代える
        actor['hand'] = St.find_bone(arm, 'J_Bip_R_Hand', 'RightHand', 'hand.R', 'J_Bip_R_LowerArm', 'RightLowerArm', 'lower_arm.R')
        actor['fingers'] = St.find_bone(arm, 'J_Bip_R_Middle1', 'RightMiddleProximal', 'middle_proximal.R') or actor['hand']
    legs = [St.find_bone(arm, *n) for n in (('J_Bip_L_UpperLeg', 'LeftUpperLeg'), ('J_Bip_R_UpperLeg', 'RightUpperLeg'))]
    actor['skirt'] = Lk.skirt_points(actor['meshes'], arm, legs) if (face_front or args.frame_report) and all(legs) else None

F = round(seconds * 30)
for f in range(1, F + 1, 3):
    s.frame_set(f)
    t = (f - 1) / 30
    for actor in actors:
        arm, paths = actor['arm'], actor['paths']
        for k, b in zip(('hips', 'head', 'chest'), actor['bones']):
            paths[k].append((t, tuple(St.bone_world(arm, b))))
        if actor['prop']:
            paths['hand'].append((t, tuple(St.bone_world(arm, actor['hand']))))
            paths['fingers'].append((t, tuple(St.bone_world(arm, actor['fingers']))))
        # 体の向きは角度のままだと 360 度の境で跳ぶので、単位ベクトルで持つ
        a_ = Sh.facing_angle(St.bone_world(arm, actor['bones'][3]), St.bone_world(arm, actor['bones'][4]))
        paths['turn'].append((t, (math.sin(math.radians(a_)), math.cos(math.radians(a_)), 0.0)))
        if face_front and actor['bones'][1]:
            # 顔の向きは頭の骨の向きで測る。肩の向きは腕を上げると崩れ、首を振った顔の向きも入らない。
            # 頭の骨のどの軸が顔の前かは、1 コマ目で肩から求めた体の前に一番近い軸とする
            m3 = (arm.matrix_world @ arm.pose.bones[actor['bones'][1]].matrix).to_3x3()
            if 'face_axis' not in actor:
                ahead = Vector((math.sin(math.radians(a_)), -math.cos(math.radians(a_)), 0))
                actor['face_axis'] = max(((c, sg) for c in range(3) for sg in (1, -1)), key=lambda q: q[1] * m3.col[q[0]].dot(ahead))
            c, sg = actor['face_axis']
            v = m3.col[c] * sg
            fa = math.atan2(v.x, -v.y)
            actor.setdefault('face_dir', []).append((t, (math.sin(fa), math.cos(fa), 0.0)))
lane =Sh.fit_lane([Sh.lane_samples(x['paths']['hips'], plan) for x in actors], [Sh.lane_samples(x['paths']['head'], plan) for x in actors]) if {p['kind'] for p in plan} & Sh.WALK_KINDS else None
for actor in actors:
    if face_front:  # 顔の向きはターンでカメラが振り回されないよう、広くならす。ならしはショットの中だけ(切り替えで前のショットの向きを引き継がない)
        actor['gaze'] = Sh.smooth_in_shots(actor.get('face_dir') or actor['paths']['turn'], Sh.GAZE_WIDTH_LOOK if args.look else Sh.GAZE_WIDTH, plan)
        raw = dict(actor['paths'])
    # 道筋は 0.1 秒ごと。話す動画のカメラは頭の細かい動きを追わない。踊りも寄りの揺れが出ないよう前後 0.5 秒でならす
    width = 8 if any(p['kind'] in Sh.FLOW for p in plan) else 20
    actor['paths'] = {k: Sh.smooth_path(p, width if k not in ('hand', 'fingers') else 2) for k, p in actor['paths'].items()}
    if face_front:
        for k in ('hips', 'head', 'chest', 'turn'):  # 寄りのカメラが追う道筋も、ショットの頭で前のショットの姿勢に引かれない
            actor['paths'][k] = Sh.smooth_in_shots(raw[k], Sh.HEAD_WIDTH_LOOK if args.look and k == 'head' else width, plan)
        actor['paths']['gaze'] = actor.pop('gaze')
if drama:  # 対話では服が光らないよう、シーンのブルームを弱める。stages のコードは変えない
    tree = s.compositing_node_group
    for n in (tree.nodes if tree else []):
        if n.bl_idname == 'CompositorNodeGlare' and n.inputs['Type'].default_value == 'Bloom':
            n.inputs['Threshold'].default_value = 1.4
            n.inputs['Strength'].default_value *= 0.4
front = (math.sin(math.radians(facing0)), -math.cos(math.radians(facing0)))
bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'


def carry_prop(actor):
    """手紙を手の位置へ 3 コマごとに置く。紙は立てたまま、手を伸ばした向きと手前の間を向ける。指の骨に向きまで従わせると紙が寝るので、位置だけ手に従う"""
    obj = St.add_letter(St.ROOT / 'assets' / 'props' / 'letter.png', Sh.PAPER_W, Sh.PAPER_H, actor['prop'] != 'letter_open')
    out = []
    for (t, hand), (_, fingers), (_, chest), (_, turn) in zip(*(actor['paths'][k] for k in ('hand', 'fingers', 'chest', 'turn'))):
        ang = math.atan2(turn[0], turn[1])
        dx, dy = hand[0] - chest[0], hand[1] - chest[1]
        reach = math.hypot(dx, dy)
        k = min(1, reach / 0.4)
        nx = k * dx / max(reach, 1e-3) * 0.6 + (1 - k) * math.sin(ang) + front[0]
        ny = k * dy / max(reach, 1e-3) * 0.6 - (1 - k) * math.cos(ang) + front[1]
        n = math.hypot(nx, ny)
        normal, side = (nx / n, ny / n, 0.0), (-ny / n, nx / n, 0.0)  # side は紙の右。-Y の面が手前を向く
        center = (fingers[0] + normal[0] * Sh.PAPER_FRONT, fingers[1] + normal[1] * Sh.PAPER_FRONT, fingers[2] + Sh.PAPER_H * 0.44)  # 手の少し前で持ち上げ、袖が紙に入らない
        out.append((t, center, normal, side))
        obj.location = center
        obj.rotation_quaternion = Matrix(((side[0], -normal[0], 0), (side[1], -normal[1], 0), (0, 0, 1))).to_quaternion()
        f = round(t * 30) + 1
        obj.keyframe_insert('location', frame=f)
        obj.keyframe_insert('rotation_quaternion', frame=f)
    return out


def sample(actor, t):
    p = {k: Sh.sample_path(v, t) for k, v in actor['paths'].items() if v}
    p['facing'] = math.degrees(math.atan2(*p['turn'][:2]))
    return p


def track(t, who=None):
    """話す人(立ち位置の番号)の道筋。相手は同じ場に居る次の人。指定が無ければ最初の人"""
    me = next((x for x in actors if x['slot'] == who), actors[0])
    others = [x for x in actors if x is not me]
    walk = {'lane': Sh.lane_at(lane, t), 'creature': creature} if lane else {}
    return {**sample(me, t), 'side': me['side'], 'inward': Sh.INWARD, 'front': front, 'facing0': facing0, 'turn0': me['turn'], 'other': sample(others[0], t) if others else None, 'prop': prop, **walk}


creature = Cr.add(json.load(open(args.creature_json, encoding='utf8')), stage, F, 30) if args.creature_json else None
props = [carry_prop(x) for x in actors if x['prop']]
prop = None
if props:  # 手が止まった所をカメラの基準にする
    _, c, n, side = props[0][-1]
    prop = {'rest': c, 'rest_normal': n, 'rest_side': side}
print('shots', [(p['kind'], round(p['start'], 2)) for p in plan])
bounds = stage.get('bounds')
cam = St.add_camera({'loc': (0, -3, 1), 'look': (0, 0, 1), 'lens': 30, 'fstop': 2.8})
s.render.use_motion_blur = args.blur > 0
s.render.motion_blur_shutter = args.blur
cam.data.dof.use_dof = True
if any(p['kind'] in Sh.FACE_KINDS for p in plan):  # 話す動画は顔が主役なので、カメラに付けた柔らかい光で肌を起こす
    fill = bpy.data.objects.new('FaceFill', bpy.data.lights.new('FaceFill', 'AREA'))
    who = next((x for x in actors if x['slot'] == plan[0].get('who')), actors[0] if actors else {'gain': 1})
    fill.data.shape, fill.data.size, fill.data.energy, fill.data.color = 'DISK', 1.6, args.face_fill * (Sh.DRAMA_FILL * who['gain'] if drama else 1) * (0.3 if plan[0]['kind'].startswith('prop_') else 1), (1.0, 0.95, 0.9)
    s.collection.objects.link(fill)
    fill.parent = cam
    fill.location = (0.15, 0.35, 0.1)


def key_camera(frame):
    cam.keyframe_insert('location', frame=frame)
    cam.keyframe_insert('rotation_euler', frame=frame)
    cam.data.keyframe_insert('lens', frame=frame)
    cam.data.dof.keyframe_insert('aperture_fstop', frame=frame)
    cam.data.dof.keyframe_insert('focus_distance', frame=frame)


look_rig = None
if args.look and actors:  # 顔の光、焦点、霞は踊る 1 人目に合わせる
    lk = Lk.stage_look(args.stage)
    me = actors[0]
    look_rig = {'key': Lk.add_key(me['meshes'], lk), 'world': Lk.add_post(lk),
                'focus': Lk.focus_target(me['arm'], me['bones'][1], Sh.FACE_ABOVE_HEAD) if me['bones'][1] else None}
    cam.data.dof.focus_object = look_rig['focus']
    print('look', args.stage, lk)
    look_rig['outlines'] = []
    if args.look == 'cel' and look_rig['focus']:
        # MToon に寄せたセル塗りと線。光の向きは顔の光(LookKey)の位置から計算する
        mtoon = Lk.read_mtoon(args.vrm, Path(args.frames_dir).parent / 'mtoon') if args.vrm else {}
        rig = Lk.cel_drivers(look_rig['key'], look_rig['focus'])
        for x in actors:
            for m in {m for o in x['meshes'] for m in o.data.materials if m}:
                Lk.cel_material(m, lk, rig, mtoon.get(m.name), min(1, x['gain']), Lk.CEL_STAGE)
            look_rig['outlines'] += [mod for o in x['meshes'] if (mod := Lk.add_outline(o, mtoon))]
        print('cel', len(mtoon), 'mtoon materials', len(look_rig['outlines']), 'outlines', flush=True)

def place(f):
    t = (f - 1) / 30
    loc, look, lens, fstop, k = Sh.camera_at(t, plan, track)
    kind = plan[k]['kind']
    if args.look and kind in Sh.FLOW:  # 寄りにする。ショットの種類と時間はそのまま
        u = (t - plan[k]['start']) / max(plan[k]['end'] - plan[k]['start'], 1e-3)
        loc, look, lens = Sh.tighten(kind, u, loc, look, lens, track(t, plan[k].get('who')))
    if face_front and kind in Sh.FLOW:
        p = track(t, plan[k].get('who'))
        loc = Sh.face_front(loc, look, math.degrees(math.atan2(*p['gaze'][:2])), p['facing'] if kind == 'close' else facing0, Sh.FACE_LIMIT_LOOK if args.look else Sh.FACE_LIMIT, Sh.FACE_SCALE_LOOK if args.look else 1.0)
    if args.look and kind in Sh.FLOW:
        fstop *= Lk.FSTOP.get(kind, 1.0)
    if bounds and plan[k]['kind'] not in Sh.ABOVE_KINDS:
        loc = tuple(max(lo, min(hi, x)) for x, (lo, hi) in zip(loc, bounds))
    if len(actors) > 1:
        loc = Sh.clear_bodies(loc, [Sh.sample_path(x['paths']['head'], t)[:2] for x in actors])
    return t, loc, look, lens, fstop, k


lift = None
if face_front and actors and actors[0]['skirt']:
    # スカートの中(股と太ももの付け根の下向きの面)がカメラから直に見えるコマはカメラを上げる。見る点はそのままなので、上から見下ろす向きになる。
    # 全コマで確かめ、前後 0.5 秒の最大を取ってからならすので、どのコマも要る高さ以上で、上げ下げはゆっくり。上げても見る点からの距離は保つ(写る大きさを変えない)
    me, step, need3 = actors[0], 1, {}
    for f in range(1, F + 1, step):
        _, loc, look, _, _, k = place(f)
        if plan[k]['kind'] not in Sh.FLOW:
            continue
        s.frame_set(f)
        need3[f] = Lk.skirt_lift(loc, look, me['skirt'], me['meshes'])
    need, keys = [], []
    for f in range(1, F + 1):
        a_ = f - (f - 1) % step
        need.append(max(need3.get(a_, 0.0), need3.get(a_ + step, 0.0)) if f != a_ else need3.get(f, 0.0))
        keys.append(place(f)[5])
    lift = Sh.hold_max(need, keys, 15)
    for _ in range(3):  # 見え方は高さで単調とは限らない。ならした高さで見えるコマは、その高さより上で見えない所まで上げて、ならし直す
        bad = 0
        for f in range(1, F + 1):
            _, loc, look, _, _, k = place(f)
            if lift[f - 1] <= 0 or plan[k]['kind'] not in Sh.FLOW:
                continue
            s.frame_set(f)
            dz = lift[f - 1]
            while dz < Lk.SKIRT_LIFT_MAX and Lk.skirt_seen(Lk.lifted(loc, look, dz), me['skirt'], me['meshes']):
                dz += 0.05
            if dz > lift[f - 1]:
                need[f - 1], bad = max(need[f - 1], dz), bad + 1
        if not bad:
            break
        lift = Sh.hold_max(need, keys, 15)
    print('skirt lift frames', sum(1 for x in need if x > 0), 'max', round(max(need), 2), flush=True)

last, shot, owner, rolls = None, None, {}, {}
for f in range(1, F + 1):
    t, loc, look, lens, fstop, k = place(f)
    if lift:
        loc = Lk.lifted(loc, look, lift[f - 1])
    if shot is not None and k != shot:  # 切り替えの間はカメラを止めたまま飛ばす。動きのブレが 2 つのショットをつながない
        key_camera(f - 0.55)
    cam.location = loc
    St.look_at(cam, look)
    if args.look and plan[k]['kind'] in Sh.FLOW:  # 正面に置いたまま画面を傾ける(ショットの種類ごとの傾け方。Sh.roll_at)
        u = (t - plan[k]['start']) / max(plan[k]['end'] - plan[k]['start'], 1e-3)
        rolls[f] = Sh.roll_at(plan[k]['kind'], u, plan[k])
        if rolls[f]:
            cam.rotation_euler = (cam.rotation_euler.to_quaternion() @ Quaternion((0, 0, 1), math.radians(rolls[f]))).to_euler('XYZ')
    if last is not None and k == shot:
        e = cam.rotation_euler.copy()
        e.make_compatible(last)  # 180 度の境で回り直さない
        cam.rotation_euler = e
    cam.data.lens = lens
    cam.data.dof.aperture_fstop = fstop * (Lk.CEL_FSTOP if args.look == 'cel' else 1)
    cam.data.dof.focus_distance = (Vector(look) - Vector(loc)).length
    if shot is not None and k != shot:
        key_camera(f - 0.45)
    key_camera(f)
    if look_rig:
        face = Vector(track(t, plan[k].get('who'))['head']) + Vector((0, 0, Sh.FACE_ABOVE_HEAD))
        Lk.key_place(look_rig['key'], face, loc, f)
        if look_rig['outlines']:
            Lk.outline_place_px(look_rig['outlines'], cam, face, f, res_y=max(s.render.resolution_x, s.render.resolution_y))
        if look_rig['world']:
            Lk.mist_place(look_rig['world'], loc, face, f)
    last, shot = cam.rotation_euler.copy(), k
    owner[f] = plan[k].get('stage', args.stage)
out = Path(args.frames_dir)
out.mkdir(parents=True, exist_ok=True)


def face_luma(actor, path):
    """今のコマを小さく撮り、人の顔の領域の輝度の中央値を返す。画面の外なら None"""
    s.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    head = St.bone_world(actor['arm'], actor['bones'][1]) + Vector((0, 0, Sh.FACE_ABOVE_HEAD))
    u, v, z = world_to_camera_view(s, cam, head)
    img = bpy.data.images.load(str(path))
    img.colorspace_settings.name = 'Non-Color'
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    bpy.data.images.remove(img)
    r = max(2, int(0.07 * cam.data.lens / 36 / max(z, 0.1) * h))  # 顔の半径の約 7 cm
    x, y = int(u * w), int(v * h)
    if not (r <= x < w - r and r <= y < h - r):
        return None
    box = px[y - r:y + r, x - r:x + r]
    return float(np.median(0.2126 * box[..., 0] + 0.7152 * box[..., 1] + 0.0722 * box[..., 2]))


def balance_fill():
    """カットの中ほどを試し撮りして、話す人の顔が同じ明るさになるようカメラの光を合わせる"""
    who = next((x for x in actors if x['slot'] == plan[0].get('who')), None)
    if not who or plan[0]['kind'] in ('prop_close', 'prop_line'):
        return
    pct, samples, probe = s.render.resolution_percentage, s.cycles.samples, out / 'probe.png'
    s.render.resolution_percentage, s.cycles.samples = 25, 8
    s.frame_set(max(1, round(plan[0]['end'] * 30) // 2))  # 最初のショットの中ほど。1 ショットのカットなら全体の中ほど
    for _ in range(3):
        y = face_luma(who, probe)
        if y is None:
            break
        fill.data.energy = max(1, min(40, fill.data.energy * (Sh.FACE_TARGET / max(y, 0.05)) ** 2.5))
        print('face', round(y, 3), 'fill', round(fill.data.energy, 2))
    s.render.resolution_percentage, s.cycles.samples = pct, samples
    probe.unlink(missing_ok=True)


FACE_LIGHT = (0.75, 0.12, 0.5, 6.0)  # 顔の前の距離(m)、顔より上へ、光の大きさ、はじめの強さ(W)


def face_lights():
    """歩く 2 人の顔を 1 人ずつ起こす。顔の前を体と一緒に動く光を、その人だけに当て(ライトリンク)、その人が話すショットの中ほどを試し撮りして顔の明るさを FACE_TARGET に合わせる。
    カメラの光は遠くて弱く、肌の暗い人を起こしきれない。地面や相手には当てないので、木漏れ日はそのまま残る"""
    pct, samples, probe = s.render.resolution_percentage, s.cycles.samples, out / 'probe.png'
    for actor in actors:
        light = bpy.data.objects.new(f'FaceLight{actor["slot"]}', bpy.data.lights.new(f'FaceLight{actor["slot"]}', 'AREA'))
        d, up, size, energy = FACE_LIGHT
        light.data.shape, light.data.size, light.data.energy, light.data.color = 'DISK', size, energy, (1.0, 0.96, 0.92)
        s.collection.objects.link(light)
        own = bpy.data.collections.new(f'FaceLit{actor["slot"]}')
        for o in actor['meshes']:
            own.objects.link(o)
        light.light_linking.receiver_collection = own
        for (t, head), (_, turn) in zip(actor['paths']['head'], actor['paths']['turn']):
            face = Vector(head) + Vector((0, 0, Sh.FACE_ABOVE_HEAD))
            light.location = face + Vector((turn[0] * d, -turn[1] * d, up))  # turn は体の正面の向き(around の角度の sin と cos)
            St.look_at(light, face)
            f = round(t * 30) + 1
            light.keyframe_insert('location', frame=f)
            light.keyframe_insert('rotation_euler', frame=f)
        shot = next((p for p in plan if p.get('who') == actor['slot'] and p['kind'] in Sh.LANE_KINDS), None)
        if not shot:
            continue
        s.render.resolution_percentage, s.cycles.samples = 25, 8
        s.frame_set(round((shot['start'] + shot['end']) / 2 * 30) + 1)
        for _ in range(3):
            y = face_luma(actor, probe)
            if y is None:
                break
            light.data.energy = max(0.5, min(200, light.data.energy * (Sh.FACE_TARGET / max(y, 0.05)) ** 2.5))
            print('face', actor['slot'], round(y, 3), 'light', round(light.data.energy, 2))
        s.render.resolution_percentage, s.cycles.samples = pct, samples
    probe.unlink(missing_ok=True)


def look_key_balance():
    """このシーンの最初のショットの中ほどを試し撮りして、顔の光の強さを、顔の明るさが Lk.FACE_TARGET になるよう合わせる"""
    shot = next((p for p in plan if p.get('stage', args.stage) == args.stage and p['kind'] != 'high_top'), None)
    if not shot:
        return
    pct, samples, probe = s.render.resolution_percentage, s.cycles.samples, out / 'probe.png'
    s.render.resolution_percentage, s.cycles.samples = 25, 8
    s.frame_set(round((shot['start'] + shot['end']) / 2 * 30) + 1)
    light = look_rig['key']
    for _ in range(3):
        y = face_luma(actors[0], probe)
        if y is None:
            break
        light.data.energy = max(2, min(40, light.data.energy * (Lk.FACE_TARGET / max(y, 0.05)) ** 2))
        print('look face', round(y, 3), 'key', round(light.data.energy, 2), flush=True)
    s.render.resolution_percentage, s.cycles.samples = pct, samples
    probe.unlink(missing_ok=True)


if lane and len(actors) > 1:
    face_lights()
elif drama and len(actors) > 1:
    balance_fill()
for p in out.glob('*.part.png'):  # 前に止まったときの書きかけ
    p.unlink()
first, last = 1 + args.start, (args.start + args.count) if args.count else F
if args.frame_report and actors:
    # このシーンのコマごとに、描くカメラで (1) 股と太ももの付け根の下向きの面が画面の中に直に見えるか(Lk.skirt_seen)、
    # (2) 写る大きさ: 足まで入れば full、膝まで knee、腰まで waist、それより寄れば chest。body は頭の上から足までが画面の縦の何倍か
    me, rep = actors[0], {}
    names = [St.find_bone(me['arm'], *n) for n in (('J_Bip_L_LowerLeg', 'LeftLowerLeg'), ('J_Bip_R_LowerLeg', 'RightLowerLeg'), ('J_Bip_L_Foot', 'LeftFoot'), ('J_Bip_R_Foot', 'RightFoot'))]

    def view(p):
        return world_to_camera_view(s, cam, p)

    def on_screen(p):
        q = view(p)
        return 0 <= q.x <= 1 and 0 <= q.y <= 1 and q.z > 0

    for f in range(1, F + 1):
        if owner[f] != args.stage:
            continue
        s.frame_set(f)
        seen = Lk.skirt_seen(cam.matrix_world.translation, me['skirt'], me['meshes'], on_screen) if me['skirt'] else None
        top = view(St.bone_world(me['arm'], me['bones'][1]) + Vector((0, 0, Sh.HEAD_TOP))).y
        knee = min(view(St.bone_world(me['arm'], n)).y for n in names[:2])
        foot = min(view(St.bone_world(me['arm'], n) - Vector((0, 0, 0.08))).y for n in names[2:])
        hips = view(St.bone_world(me['arm'], me['bones'][0])).y
        size = 'full' if foot >= 0 else 'knee' if knee >= 0 else 'waist' if hips >= 0 else 'chest'
        m3 = (me['arm'].matrix_world @ me['arm'].pose.bones[me['bones'][1]].matrix).to_3x3()
        if 'face_axis' not in me:  # 顔の前の軸は、1 コマ目で肩から求めた体の前に一番近い頭の骨の軸(--face-front と同じ決め方)
            s.frame_set(1)
            a1 = math.radians(Sh.facing_angle(St.bone_world(me['arm'], me['bones'][3]), St.bone_world(me['arm'], me['bones'][4])))
            m1 = (me['arm'].matrix_world @ me['arm'].pose.bones[me['bones'][1]].matrix).to_3x3()
            me['face_axis'] = max(((c, sg) for c in range(3) for sg in (1, -1)), key=lambda q: q[1] * m1.col[q[0]].dot(Vector((math.sin(a1), -math.cos(a1), 0))))
            s.frame_set(f)
        c_, sg_ = me['face_axis']
        fwd = m3.col[c_] * sg_
        to_cam = cam.matrix_world.translation - St.bone_world(me['arm'], me['bones'][1])
        yaw = math.degrees(math.atan2(fwd.x * to_cam.y - fwd.y * to_cam.x, fwd.x * to_cam.x + fwd.y * to_cam.y))
        rep[f] = {'skirt': seen, 'size': size, 'body': round(top - foot, 3), 'top': round(top, 3), 'yaw': round(yaw, 1), 'roll': rolls.get(f, 0)}
    Path(args.frame_report).write_text(json.dumps(rep), encoding='utf8')
    print('skirt open', sum(1 for x in rep.values() if x['skirt']), 'of', len(rep), [f for f, x in rep.items() if x['skirt']][:40], flush=True)
    ys = sorted(abs(x['yaw']) for x in rep.values())
    print('yaw off p50', ys[len(ys) // 2], 'p90', ys[int(len(ys) * 0.9)], 'max', ys[-1], 'over 30', sum(1 for y in ys if y > 30), flush=True)
    print('sizes', {k: sum(1 for x in rep.values() if x['size'] == k) for k in ('full', 'knee', 'waist', 'chest')}, 'head cut', sum(1 for x in rep.values() if x['top'] > 1.0), flush=True)
if args.report_only:
    sys.exit(0)
if look_rig:
    look_key_balance()
faces = {}
for f in ([int(x) for x in args.frame_list.split(',')] if args.frame_list else range(first, last + 1)):
    p = out / f'{f:05d}.png'
    if p.exists() or owner[f] != args.stage:
        continue
    tf = time.time()
    s.frame_set(f)
    if len(actors) > 1:  # 顔の明るさを測れるよう、画面の中の顔の位置を残す
        faces[f] = [(x['slot'], *world_to_camera_view(s, cam, St.bone_world(x['arm'], x['bones'][1]) + Vector((0, 0, Sh.FACE_ABOVE_HEAD)))) for x in actors]
    part = out / f'{f:05d}.part.png'  # 書き終わってから名前を付ける。止まったときに切れたコマを残さない
    s.render.filepath = str(part)
    bpy.ops.render.render(write_still=True)
    os.replace(part, p)
    print('frame', f, round(time.time() - tf, 2), flush=True)
if faces:
    (out.parent / 'faces.json').write_text(json.dumps(faces), encoding='utf8')
print('all', round(time.time() - t0, 1))
