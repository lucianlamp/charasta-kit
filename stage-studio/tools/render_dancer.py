"""踊る人だけを透明な背景で描く(グラフィックの MV の素材)。Blender の中で動く。
  blender -b --factory-startup --python render_dancer.py -- --glb bake.glb --vrm model.vrm --out-dir dancer --pass full [--frames 1-510] [--pct 50 --samples 32]
見た目は stage-studio の --look cel(lib/look.py)をそのまま使う。STAGE_STUDIO でその木を指す(既定はこのファイルのある木)。
カメラは正面に固定し、腰の道筋をならした分だけ横へ付いていく(ゆれない)。
スカートは揺れ骨の回転を --skirt-damp 倍に縮め、カメラの高さに関係なく股の前が見えるコマを数える。1 コマでもあれば描かずに止める(--allow-exposed で続ける)。
--pass full は全身、mid は太ももから上、face は顔の寄り(頭の道筋をならして付いていく)。コマごとの顔と腰の画面の位置、スカートの中が見えるかを <out-dir>/<pass>.json へ書く。
--skip-existing は描いてあるコマ(<out-dir>/<pass>/00001.png など)を飛ばし、続きから描く。<pass>.json は前のコマの記録に足して書く。
"""
import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

SS = Path(os.environ.get('STAGE_STUDIO', str(Path(__file__).resolve().parent.parent)))
sys.path.insert(0, str(SS))

import bpy  # noqa: E402
from bpy_extras.object_utils import world_to_camera_view  # noqa: E402
from mathutils import Vector  # noqa: E402

from lib import look as Lk  # noqa: E402
from lib import studio as St  # noqa: E402

# 画面の高さに写す範囲(m)と、その中心の高さ(m)、カメラの高さ(m)
PASSES = {
    'full': {'span': 2.05, 'center': 0.93, 'cam_z': 1.20, 'res': (1620, 1920)},
    'mid': {'span': 1.15, 'center': 1.13, 'cam_z': 1.38, 'res': (1440, 1920)},
    'face': {'span': 0.62, 'follow': 'head', 'res': (1440, 1920)},  # 顔の中心の高さとカメラの高さは頭に合わせる
}
LENS = 85.0  # 長い焦点で遠近を弱め、平らなグラフィックに馴染ませる
SMOOTH = 1.5  # 腰の横の動きをならす幅(秒)。カメラはこの幅より速く動かない

a = argparse.ArgumentParser()
a.add_argument('--glb', required=True)
a.add_argument('--vrm')
a.add_argument('--yaw', type=float, default=0)
a.add_argument('--out-dir', required=True)
a.add_argument('--pass', dest='pass_', choices=PASSES, default='full')
a.add_argument('--frames', default='1-510')  # 1-510、1,30,90、40-125,468-510
a.add_argument('--pct', type=int, default=100)
a.add_argument('--samples', type=int, default=32)
a.add_argument('--skip-render', action='store_true')
a.add_argument('--skirt-damp', type=float, default=0.6)  # スカートの揺れ骨の回転を元の形へ寄せる割合(1 でそのまま)。めくれて股が見えるのを防ぐ
a.add_argument('--allow-exposed', action='store_true')
a.add_argument('--skip-existing', action='store_true')
args = a.parse_args(sys.argv[sys.argv.index('--') + 1:])
P = PASSES[args.pass_]
frames = []
for part in args.frames.split(','):
    lo, _, hi = part.partition('-')
    frames += list(range(int(lo), int(hi or lo) + 1))
frames = sorted(set(frames))
out = Path(args.out_dir)
(out / args.pass_).mkdir(parents=True, exist_ok=True)
old = {}
if (out / f'{args.pass_}.json').exists():
    prev = json.loads((out / f'{args.pass_}.json').read_text())
    if list(prev.get('res', [])) == list(P['res']):
        old = prev.get('frames', {})
if args.skip_existing:
    frames = [f for f in frames if not (out / args.pass_ / f'{f:05d}.png').exists()]
    print('skip existing: left', len(frames), flush=True)
    if not frames:
        sys.exit(0)

t0 = time.time()
St.clear()
St.setup_cycles(args.samples, args.pct, w=P['res'][0], h=P['res'][1])
s = bpy.context.scene
s.render.film_transparent = True
s.render.image_settings.color_mode = 'RGBA'
s.render.dither_intensity = 1.0
s.view_settings.view_transform = 'Standard'  # ステージと同じ。AgX だとセル塗りの色が白っぽく濁る
s.view_settings.look = 'None'
if s.world is None:
    s.world = bpy.data.worlds.new('World')
s.world.use_nodes = True
bg = next(n for n in s.world.node_tree.nodes if n.type == 'BACKGROUND')
bg.inputs['Color'].default_value = (0.8, 0.8, 0.82, 1)  # 自己発光に少し混ぜる拡散の光(CEL['diffuse'])の元
bg.inputs['Strength'].default_value = 1.0

before = set(bpy.data.objects)
_, arm = St.load_character(args.glb, (0, 0, 0), 0, args.yaw, 0)
meshes = [o for o in set(bpy.data.objects) - before if o.type == 'MESH']


def damp_skirt(arm, k):
    """焼き込んだ動きのスカートの骨(J_Sec_Skirt*)の回転を、休みの形(単位の回転)から k 倍の角度に縮める"""
    from mathutils import Quaternion
    act = arm.animation_data.action if arm.animation_data else None
    if act is None or k >= 1:
        return 0
    curves = {}
    fcs = act.fcurves if hasattr(act, 'fcurves') else [fc for layer in act.layers for st in layer.strips for cb in st.channelbags for fc in cb.fcurves]
    for fc in fcs:
        if 'Skirt' in fc.data_path and fc.data_path.endswith('rotation_quaternion'):
            curves.setdefault(fc.data_path, {})[fc.array_index] = fc
    n = 0
    for ch in curves.values():
        if len(ch) != 4:
            continue
        for i in range(len(ch[0].keyframe_points)):
            q = Quaternion([ch[j].keyframe_points[i].co[1] for j in range(4)])
            q2 = Quaternion().slerp(q, k)
            for j in range(4):
                kp = ch[j].keyframe_points[i]
                kp.co[1] = kp.handle_left[1] = kp.handle_right[1] = q2[j]
        n += 1
    return n


print('skirt bones damped', damp_skirt(arm, args.skirt_damp), flush=True)
head = St.find_bone(arm, 'J_Bip_C_Head', 'Head')
hips = St.find_bone(arm, 'J_Bip_C_Hips', 'Hips')
lk = Lk.stage_look('graphic')
key = Lk.add_key(meshes, lk)
focus = Lk.focus_target(arm, head, 0.09)
mtoon = Lk.read_mtoon(args.vrm, out / 'mtoon') if args.vrm else {}
rig = Lk.cel_drivers(key, focus)
for m in {m for o in meshes for m in o.data.materials if m}:
    Lk.cel_material(m, lk, rig, mtoon.get(m.name))
outlines = [mod for o in meshes if (mod := Lk.add_outline(o, mtoon))]
print('cel', len(mtoon), 'outlines', len(outlines), round(time.time() - t0, 1), flush=True)

# 腰の道筋をすべてのコマで測り、横(x)と奥行き(y)をならす
lo_f, hi_f = min(frames), max(frames)
path, hpath = {}, {}
for f in range(max(1, lo_f - 60), hi_f + 61):
    s.frame_set(f)
    path[f] = tuple(St.bone_world(arm, hips))
    hpath[f] = tuple((arm.matrix_world @ arm.pose.bones[head].matrix).translation + Vector((0, 0, 0.09)))
keys = sorted(path)
half = int(SMOOTH * 30 / 2)


def smooth(f, src=None, n=2):
    src = src or path
    ks = [k for k in range(f - half, f + half + 1) if k in src]
    w = [math.cos((k - f) / (half + 1) * math.pi / 2) ** 2 for k in ks]
    return tuple(sum(src[k][i] * wi for k, wi in zip(ks, w)) / sum(w) for i in range(n))


cam = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
s.collection.objects.link(cam)
s.camera = cam
cam.data.lens = LENS
cam.data.sensor_fit = 'VERTICAL'
cam.data.sensor_height = 36
dist = P['span'] * LENS / 36
skirt = Lk.skirt_points(meshes, arm, [St.find_bone(arm, 'J_Bip_L_UpperLeg', 'LeftUpperLeg'), St.find_bone(arm, 'J_Bip_R_UpperLeg', 'RightUpperLeg')])


def crotch_points(legs, count=24):
    """股の真ん中の前の面(スカートの骨に付かない体の頂点)。正面から直に見えたら、スカートがめくれて中が見えている"""
    s.frame_set(1)
    dg = bpy.context.evaluated_depsgraph_get()
    hl, hr = ((arm.matrix_world @ arm.pose.bones[n].head) for n in legs)
    c = (hl + hr) / 2
    found = []
    for o in meshes:
        sk = {g.index for g in o.vertex_groups if 'skirt' in g.name.lower()}
        ev = o.evaluated_get(dg)
        for v, w in zip(ev.data.vertices, o.data.vertices):
            p = ev.matrix_world @ v.co
            if abs(p.x - c.x) < 0.035 and c.z - 0.11 < p.z < c.z + 0.01 and p.y < c.y + 0.03 and sum(g.weight for g in w.groups if g.group in sk) < 0.3:
                found.append((o, v.index))
    print('crotch points', len(found), flush=True)
    return found[::max(1, len(found) // count)][:count]


crotch = crotch_points([St.find_bone(arm, 'J_Bip_L_UpperLeg', 'LeftUpperLeg'), St.find_bone(arm, 'J_Bip_R_UpperLeg', 'RightUpperLeg')])


def crotch_seen(cam_loc):
    """カメラの高さに関わらず、股の点が直に見える数(Lk._seen はカメラより低い点しか数えない)"""
    dg = bpy.context.evaluated_depsgraph_get()
    evs = [o.evaluated_get(dg) for o in meshes if o.visible_get() and not o.hide_render]
    cam = Vector(cam_loc)
    n = 0
    for o, i in crotch:
        ev = o.evaluated_get(dg)
        p = ev.matrix_world @ ev.data.vertices[i].co
        d = (p - cam).length
        hit = d
        for e in evs:
            inv = e.matrix_world.inverted()
            ok, loc, _, _ = e.ray_cast(inv @ cam, (inv.to_3x3() @ (p - cam)).normalized())
            if ok:
                hit = min(hit, (e.matrix_world @ loc - cam).length)
        if hit >= d - 0.012:
            n += 1
    return n
report = {'pass': args.pass_, 'res': P['res'], 'frames': {str(k): v for k, v in old.items()}}
new = set()
for f in frames:
    if P.get('follow') == 'head':  # 顔の寄り: ならした顔の位置を真ん中に、ほぼ同じ高さから見る
        hx, hy, fz = smooth(f, hpath, 3)
        cz = fz - 0.13  # 画面の中心は首の下。顔は上 3 分の 1 に来て、胸が下の端まで続く
        loc = Vector((hx, hy - dist, fz - 0.01))
    else:
        hx, hy = smooth(f)
        cz = P['center']
        loc = Vector((hx, hy - dist, P['cam_z']))
    # キャラは -Y を向く(glTF の前)。カメラは前から見て、写す中心の高さへわずかに見下ろす
    cam.location = loc
    St.look_at(cam, Vector((hx, hy, cz)))
    cam.keyframe_insert('location', frame=f)
    cam.keyframe_insert('rotation_euler', frame=f)
    s.frame_set(f)
    face = (arm.matrix_world @ arm.pose.bones[head].matrix).translation + Vector((0, 0, 0.09))
    Lk.key_place(key, face, loc, f)
    Lk.outline_place(outlines, loc, face, f)
    bpy.context.view_layer.update()
    fc = world_to_camera_view(s, cam, face)
    hc = world_to_camera_view(s, cam, Vector(path[f]))
    seen = Lk.skirt_seen(cam.location, skirt, meshes) if skirt else False
    cs = crotch_seen(cam.location)
    new.add(str(f))
    report['frames'][str(f)] = {'face': (round(fc.x, 4), round(1 - fc.y, 4)), 'hips': (round(hc.x, 4), round(1 - hc.y, 4)), 'skirt': bool(seen), 'crotch': cs}
bad = [int(f) for f, v in report['frames'].items() if f in new and v['crotch'] >= 2]
print('placed', len(frames), 'skirt seen', sum(report['frames'][f]['skirt'] for f in new), 'crotch seen', len(bad), bad[:80], round(time.time() - t0, 1), flush=True)
report['crotch_frames'] = sorted(bad)
(out / f'{args.pass_}.json').write_text(json.dumps(report))
if args.skip_render:
    sys.exit(0)
if bad and not args.allow_exposed:
    print('ERROR crotch visible in', len(bad), 'frames; not rendering', flush=True)
    sys.exit(2)

t1 = time.time()
for f in frames:
    s.frame_set(f)
    s.render.filepath = str(out / args.pass_ / f'{f:05d}.png')
    bpy.ops.render.render(write_still=True)
print('render', len(frames), 'frames', round(time.time() - t1, 1), 's', round((time.time() - t1) / len(frames), 2), 's/frame', flush=True)
