"""生き物のサムネイル: creature.json の rest の姿勢を、斜め前から 3 灯(主光、補助光、逆光)で撮る。背景は透明。Blender の背景で動かす。
blender -b <blend> --python-exit-code 1 --python tools/creature_thumb.py -- <creature.json> <out.png> [size]
座標は stage-studio の lib/creature.py と同じく、生き物の前が +X、上が +Z。GPU(OPTIX、無ければ CUDA)で描き、使えなければ CPU。"""
import json
import math
import sys

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
spec = json.load(open(args[0], encoding='utf8'))
out = args[1]
size = int(args[2]) if len(args) > 2 else 512
scene = bpy.context.scene

arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
if arm is None:
    sys.stderr.write('Armature が無い\n')
    sys.exit(1)
name, frame = spec['rest'][0], int(spec['rest'][1])
action = bpy.data.actions.get(name)
if action is None:
    sys.stderr.write('rest の Action が無い: %s\n' % name)
    sys.exit(1)
ad = arm.animation_data_create()
ad.action = action
if getattr(ad, 'action_slot', None) is None and len(getattr(action, 'slots', [])):
    ad.action_slot = action.slots[0]
scene.frame_set(frame)

# 生き物の体だけを描く(Armature の子か、Armature で変形するメッシュ)。カメラと灯りは作り直す
for o in list(bpy.data.objects):
    if o.type in ('CAMERA', 'LIGHT'):
        bpy.data.objects.remove(o, do_unlink=True)
body = []
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    on_arm = o.parent == arm or any(m.type == 'ARMATURE' and m.object == arm for m in o.modifiers)
    o.hide_render = not on_arm
    o.hide_viewport = not on_arm
    if on_arm:
        body.append(o)
if not body:
    sys.stderr.write('Armature に付いたメッシュが無い\n')
    sys.exit(1)

dg = bpy.context.evaluated_depsgraph_get()
dg.update()
lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
for o in body:
    e = o.evaluated_get(dg)
    for c in e.bound_box:
        p = e.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, p))
        hi = Vector(map(max, hi, p))
center, dims = (lo + hi) / 2, hi - lo

cam = bpy.data.objects.new('thumb_cam', bpy.data.cameras.new('thumb_cam'))
scene.collection.objects.link(cam)
cam.data.lens = 50
fov = 2 * math.atan(18 / 50)
az, el = math.radians(38), math.radians(12)   # 前(+X)から左へ 38 度、少し上から
direction = Vector((math.cos(az) * math.cos(el), -math.sin(az) * math.cos(el), math.sin(el)))
dist = 0.5 * max(dims) * 1.05 / math.tan(fov / 2) + 0.5 * max(dims)
cam.location = center + direction * dist
cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam.data.clip_start, cam.data.clip_end = dist / 100, dist * 10
scene.camera = cam


def sun(label, pitch_yaw, strength, color):
    data = bpy.data.lights.new(label, 'SUN')
    data.energy, data.color, data.angle = strength, color, math.radians(8)
    o = bpy.data.objects.new(label, data)
    o.rotation_euler = (math.radians(pitch_yaw[0]), 0, math.radians(pitch_yaw[1]))
    scene.collection.objects.link(o)


sun('key', (55, 40), 3.2, (1.0, 0.96, 0.9))     # 主光: 前の左上
sun('fill', (70, -60), 1.0, (0.85, 0.9, 1.0))   # 補助光: 右から弱く
sun('rim', (120, 170), 2.4, (1.0, 1.0, 1.0))    # 逆光: 後ろの上から輪郭を出す

world = bpy.data.worlds.new('thumb_world')
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs[0].default_value = (0.04, 0.045, 0.05, 1)
bg.inputs[1].default_value = 1.0
scene.world = world

r = scene.render
r.engine = 'CYCLES'
r.resolution_x = r.resolution_y = size
r.resolution_percentage = 100
r.film_transparent = True
r.image_settings.file_format = 'PNG'
r.image_settings.color_mode = 'RGBA'
r.filepath = out
scene.view_settings.view_transform = 'Standard'
scene.cycles.samples = 64
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA'):
        prefs.compute_device_type = kind
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == kind]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == kind
            scene.cycles.device = 'GPU'
            print('thumb device', kind, [d.name for d in gpus])
            break
except Exception as e:   # GPU が使えなければ CPU で描く
    print('thumb GPU unavailable', e)
bpy.ops.render.render(write_still=True)
print('thumb written', out)
