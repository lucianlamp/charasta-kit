"""ステージと動画に共通の処理: Cycles の設定、キャラの読み込み、カメラの置き方。Blender の中で動く。"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parent.parent
HEIGHT = 1.6  # 標準の体の高さ(m)。ステージの寸法の基準


@dataclass
class Ctx:
    stage: str
    assets: Path
    seed: int = 0
    variant: str = ''
    beats: list = field(default_factory=list)  # 拍の時刻(秒)
    fps: int = 30
    frames: int = 1


def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.actions, bpy.data.images):
        for x in list(block):
            if x.users == 0:
                block.remove(x)


def use_best_device(scene):
    """Cycles の計算に使う機器を選ぶ。OPTIX、CUDA、HIP、METAL、ONEAPI の順に試し、どれも無ければ CPU。
    環境変数 STAGE_DEVICE で上書きできる(CPU、OPTIX、CUDA、HIP、METAL、ONEAPI)。ノイズ除去は OPTIX の機器のときだけ OptiX、それ以外は OpenImageDenoise。選んだ種類を返す。"""
    forced = os.environ.get('STAGE_DEVICE', '').strip().upper()
    kind = 'CPU'
    if forced != 'CPU':
        try:
            prefs = bpy.context.preferences.addons['cycles'].preferences
            for k in ([forced] if forced else ['OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI']):
                try:
                    prefs.compute_device_type = k
                    prefs.get_devices()
                except TypeError:  # この Blender が知らない種類
                    continue
                if any(d.type == k for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = d.type == k
                    kind = k
                    break
        except Exception as e:  # 機器の調べに失敗したら CPU で描く
            print('stage GPU unavailable', e)
    scene.cycles.device = 'CPU' if kind == 'CPU' else 'GPU'
    scene.cycles.denoiser = 'OPTIX' if kind == 'OPTIX' else 'OPENIMAGEDENOISE'
    print('stage device', kind)
    return kind


def setup_cycles(samples=128, pct=100, fps=30, w=1080, h=1920):
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    use_best_device(s)
    c = s.cycles
    c.samples = samples
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.02
    c.use_denoising = True  # denoiser は use_best_device が機器に合わせて決める
    c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
    c.max_bounces = 8
    c.glossy_bounces = 4
    c.transmission_bounces = 6
    c.caustics_reflective = False
    c.caustics_refractive = False
    c.sample_clamp_indirect = 8.0
    s.render.use_persistent_data = True
    s.render.resolution_x, s.render.resolution_y, s.render.resolution_percentage = w, h, pct
    s.render.fps = fps
    s.render.film_transparent = False
    s.render.use_motion_blur = False
    s.render.image_settings.file_format = 'PNG'


def load_character(glb, mark=(0, 0, 0), facing_deg=0.0, yaw=0.0, emission=0.32):
    """焼き込んだ GLB を読み、MToon の代わりに物理ベースの材質へ整える。返すのは (動かす親の空オブジェクト, アーマチュア)。
    Cycles は MToon の Shader to RGB を描けないので、基本色に自己発光を少し混ぜて、暗い場面でもアニメの明るさを残す。"""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(glb), import_pack_images=True, merge_vertices=False, bone_heuristic='BLENDER')
    new = set(bpy.data.objects) - before
    arm = next(o for o in new if o.type == 'ARMATURE')
    root = bpy.data.objects.new('CharRoot', None)
    bpy.context.collection.objects.link(root)
    root.location = mark
    root.rotation_euler = (0, 0, math.radians(facing_deg) + yaw)
    for o in new:
        if o.parent is None:
            o.parent = root
    for o in new:
        if o.type != 'MESH':
            continue
        for m in o.data.materials:
            if m:
                tune_material(m, emission)
    return root, arm


def tune_material(m, emission, albedo=1.0):
    """albedo は基本色に掛ける倍率。明るいキャラの服が日なたで白く飛ぶのを抑える"""
    nt = m.node_tree
    b = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if b is None:
        return
    b.inputs['Roughness'].default_value = 0.55
    b.inputs['Metallic'].default_value = 0.0
    if 'Specular IOR Level' in b.inputs:
        b.inputs['Specular IOR Level'].default_value = 0.25
    src = b.inputs['Base Color'].links[0].from_socket if b.inputs['Base Color'].links else None
    if src is not None and albedo < 1:
        mul = nt.nodes.new('ShaderNodeMix')
        mul.data_type, mul.blend_type = 'RGBA', 'MULTIPLY'
        mul.inputs['Factor'].default_value = 1
        mul.inputs['B'].default_value = (albedo, albedo, albedo, 1)
        nt.links.new(src, mul.inputs['A'])
        src = mul.outputs['Result']
        nt.links.new(src, b.inputs['Base Color'])
    if src is not None:
        for link in list(b.inputs['Emission Color'].links):
            nt.links.remove(link)
        nt.links.new(src, b.inputs['Emission Color'])
    else:
        b.inputs['Emission Color'].default_value = b.inputs['Base Color'].default_value
    b.inputs['Emission Strength'].default_value = emission


def skin_level(objects):
    """顔のテクスチャの明るさ(リニア)。顔の材質が見つからなければ None"""
    for o in objects:
        if o.type != 'MESH':
            continue
        for m in o.data.materials:
            if not m or 'Face_00_SKIN' not in m.name:
                continue
            b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            links = b.inputs['Base Color'].links if b else []
            if not links or links[0].from_node.type != 'TEX_IMAGE' or not links[0].from_node.image:
                continue
            img = links[0].from_node.image
            px = np.empty(len(img.pixels), np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(-1, 4)
            on = px[px[:, 3] > 0.5]
            lum = 0.2126 * on[:, 0] + 0.7152 * on[:, 1] + 0.0722 * on[:, 2]
            return float(np.median(lum))
    return None


def add_letter(texture, w, h, folded=False):
    """手紙の紙。原点が紙の中心で、-Y の面に文字がある。少し反らせ、裏は文字の無い紙の色。
    folded は左の 4 分の 1 を裏へ折る。最後の行はこの中にあるので、開くまで読めない"""
    nx, nz = 8, 12
    crease = (0.25 - 0.5) * w
    verts, faces, uvs = [], [], []
    for j in range(nz + 1):
        for i in range(nx + 1):
            u, v = i / nx, j / nz
            x, y = (u - 0.5) * w, 0.006 * math.sin(math.pi * u) + 0.004 * math.sin(math.pi * v * 1.5)
            if folded and x < crease:  # 折り目のまわりに 165 度回す
                x, y = crease + (x - crease) * math.cos(math.radians(165)), y - (x - crease) * math.sin(math.radians(165)) + 0.002
            verts.append((x, y, (v - 0.5) * h))
    for j in range(nz):
        for i in range(nx):
            a = j * (nx + 1) + i
            faces.append((a, a + 1, a + nx + 2, a + nx + 1))
    me = bpy.data.meshes.new('Letter')
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name='UV')
    for loop in me.loops:
        k = loop.vertex_index  # 紙の上の位置は折っても変わらない
        uv.data[loop.index].uv = ((k % (nx + 1)) / nx, (k // (nx + 1)) / nz)
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    obj = bpy.data.objects.new('Letter', me)
    bpy.context.collection.objects.link(obj)
    obj.rotation_mode = 'QUATERNION'
    mat = bpy.data.materials.new('Letter')
    mat.use_nodes = True
    N, L = mat.node_tree.nodes, mat.node_tree.links
    b = next(n for n in N if n.type == 'BSDF_PRINCIPLED')
    tex = N.new('ShaderNodeTexImage')
    tex.image = load_image(texture)
    geo = N.new('ShaderNodeNewGeometry')
    mix = N.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.inputs['B'].default_value = (0.72, 0.66, 0.54, 1)
    L.new(geo.outputs['Backfacing'], mix.inputs['Factor'])
    L.new(tex.outputs['Color'], mix.inputs['A'])
    L.new(mix.outputs['Result'], b.inputs['Base Color'])
    L.new(mix.outputs['Result'], b.inputs['Emission Color'])
    b.inputs['Emission Strength'].default_value = 0.08
    b.inputs['Roughness'].default_value = 0.7
    me.materials.append(mat)
    return obj


def bone_world(arm, name):
    b = arm.pose.bones.get(name) if name else None
    return (arm.matrix_world @ b.matrix).translation.copy() if b else None


def find_bone(arm, *names):
    for n in names:
        for b in arm.pose.bones:
            if b.name == n or b.name.lower().endswith(n.lower()):
                return b.name
    return None


def look_at(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def add_camera(view):
    """view: {loc, look, lens, fstop?}。fstop があれば被写界深度を使う"""
    s = bpy.context.scene
    cam = s.camera
    if cam is None:
        cam = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
        s.collection.objects.link(cam)
        s.camera = cam
    cam.location = view['loc']
    look_at(cam, view['look'])
    cam.data.lens = view.get('lens', 30)
    cam.data.sensor_width = 36
    cam.data.sensor_fit = 'AUTO'
    cam.data.clip_end = 1000
    f = view.get('fstop')
    cam.data.dof.use_dof = f is not None
    if f is not None:
        cam.data.dof.aperture_fstop = f
        cam.data.dof.focus_distance = view.get('focus', (Vector(view['look']) - Vector(view['loc'])).length)
    return cam


def asset_file(path):
    """素材の絵の実際の場所。.png が無ければ同じ名前の .webp(きゃらすたのキットは書き出すときに WebP へ変える)"""
    p = Path(path)
    if p.suffix.lower() == '.png' and not p.exists() and p.with_suffix('.webp').exists():
        return p.with_suffix('.webp')
    return p


def load_image(path, data=False):
    """素材の絵を読む。data=True は数として使う絵(高さ、法線、粗さ、マスク)で、色の変換をしない"""
    img = bpy.data.images.load(str(asset_file(path)), check_existing=True)
    if data:
        img.colorspace_settings.name = 'Non-Color'
    return img


def write_png(path):
    s = bpy.context.scene
    path = Path(path) if Path(path).is_absolute() else ROOT / path
    s.render.filepath = str(path)
    os.makedirs(Path(path).parent, exist_ok=True)
    bpy.ops.render.render(write_still=True)
