"""MV のアニメ調の見た目(render.py の --look anime)。キャラだけをトゥーンにし、輪郭の光、顔の光、奥の霞、光のにじみを足す。Blender の中で動く。
ステージのコードは変えない。シーンごとの色はステージの名前で引く表に置く。
"""
from __future__ import annotations

import math
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector

# シーンごとの色。rim は輪郭の光の色、fog は奥の霞の色、density は霞の最大の濃さ、depth は霞が最大になるまでの距離(m)、key は顔の光の色
DEFAULT = {'rim': (0.75, 0.85, 1.0), 'fog': (0.45, 0.45, 0.55), 'density': 0.25, 'depth': 30.0, 'key': (1.0, 0.95, 0.92)}
STAGES = {
    'concert': {'rim': (0.45, 0.8, 1.0), 'fog': (0.12, 0.05, 0.2), 'density': 0.22, 'depth': 22.0, 'key': (1.0, 0.9, 0.97)},
    'themepark': {'rim': (1.0, 0.78, 0.6), 'fog': (0.8, 0.52, 0.62), 'density': 0.2, 'depth': 35.0, 'key': (1.0, 0.93, 0.88)},
    'rooftop': {'rim': (0.55, 0.75, 1.0), 'fog': (0.03, 0.05, 0.11), 'density': 0.25, 'depth': 40.0, 'key': (0.95, 0.95, 1.0)},
    'classroom': {'rim': (1.0, 0.9, 0.72), 'fog': (0.85, 0.8, 0.72), 'density': 0.18, 'depth': 14.0},
    'shrine': {'rim': (0.8, 0.72, 1.0), 'fog': (0.38, 0.36, 0.52), 'density': 0.3},
    'waterside': {'rim': (1.0, 0.85, 0.7), 'fog': (0.6, 0.6, 0.7)},
    'parkway': {'rim': (1.0, 0.9, 0.75), 'fog': (0.65, 0.68, 0.72), 'density': 0.2},
}

SHADE_TINT = (0.78, 0.62, 0.78)  # 影の色。灰ではなく、基本色に赤紫を掛けた色にする
SHADE = 0.26  # 影の側の明るさ(基本色に掛ける自己発光の強さ)
ALBEDO = 0.62  # 光の当たる側の基本色の倍率。白い服を飛ばさない
TOON = (0.5, 0.08)  # 体の Toon BSDF の size と smooth。境目のはっきりした 2 段
TOON_FACE = (0.95, 0.35)  # 顔はほとんど明るい側にし、影で濁らせない
FACE_ALBEDO = 1.15  # 服より肌を少し明るく残す
WHITE_KNEE = (0.4, 3.0)  # 白に近い色を暗くする量と、効き始めの鋭さ(輝度のべき)
RIM = (1.4, 3.0)  # 輪郭の光の強さ、縁の細さ(大きいほど細い)
RIM_DIR = (-0.55, 0.83, 0.0)  # 画面の上で輪郭の光が来る向き(カメラの座標。左上)
RIM_OPEN = (0.08, 0.72, 0.95)  # 外のシルエットだけに限る AO の距離(m)と、開けているとみなす範囲。髪の束の内側の縁は隣の束や体で塞がっている
KEY = (1.6, 55.0, 35.0, 1.0)  # 顔の光の顔からの距離(m)、カメラから横へ回す角度、上からの角度、大きさ(m)
KEY_ENERGY = 30.0  # はじめの強さ(W)。シーンごとに試し撮りで合わせる
FACE_TARGET = 0.42  # 顔の領域の輝度の目標
GLOW = (1.3, 0.3, 0.8)  # 足すにじみの閾値、強さ、大きさ。閾値は白い服の明るさより上
FOG_LIT = (0.04, 0.3)  # 霞を出す背景の明るさ(ぼかした画面の輝度)の範囲。これより暗い所は霞まない
FSTOP = {'close': 2.2, 'side_track': 1.8, 'orbit': 1.4, 'low_feet': 1.2, 'wide_push': 1.0, 'crane_up': 1.0, 'crane_down': 1.0}  # ショットの f 値に掛ける。寄りで顔の奥行き(鼻から耳)までぼけないよう絞り、背景は距離でぼける


def stage_look(stage):
    return {**DEFAULT, **STAGES.get(stage, {})}


def is_face(m):
    n = m.name.upper()
    return 'FACE' in n and 'SKIN' in n


def toon_material(m, look, albedo=1.0):
    """Principled の材質の出力を、基本色のテクスチャのままトゥーンに替える。透明(Alpha)と法線はそのまま使う"""
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    b = next((n for n in N if n.type == 'BSDF_PRINCIPLED'), None)
    out = next((n for n in N if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None) or next((n for n in N if n.type == 'OUTPUT_MATERIAL'), None)
    if b is None or out is None:
        return False

    def color_of(sock):
        return sock.links[0].from_socket if sock.links else None

    src = color_of(b.inputs['Base Color'])

    def times(rgb, k=1.0):
        mul = N.new('ShaderNodeMix')
        mul.data_type, mul.blend_type = 'RGBA', 'MULTIPLY'
        mul.inputs['Factor'].default_value = 1
        if src is not None:
            L.new(src, mul.inputs['A'])
        else:
            mul.inputs['A'].default_value = b.inputs['Base Color'].default_value
        mul.inputs['B'].default_value = (rgb[0] * k, rgb[1] * k, rgb[2] * k, 1)
        return mul.outputs['Result']

    face = is_face(m)
    if src is not None and not face:  # 白に近い色ほど暗くする。白い服が光の重なりで飛ばず、赤や肌の色は残る
        bw = N.new('ShaderNodeRGBToBW')
        L.new(src, bw.inputs['Color'])
        sq = N.new('ShaderNodeMath')
        sq.operation = 'POWER'
        L.new(bw.outputs['Val'], sq.inputs[0])
        sq.inputs[1].default_value = WHITE_KNEE[1]
        k = N.new('ShaderNodeMapRange')
        k.inputs['To Min'].default_value, k.inputs['To Max'].default_value = 1.0, 1.0 - WHITE_KNEE[0]
        L.new(sq.outputs[0], k.inputs['Value'])
        soft = N.new('ShaderNodeMix')
        soft.data_type, soft.blend_type = 'RGBA', 'MULTIPLY'
        soft.inputs['Factor'].default_value = 1
        L.new(src, soft.inputs['A'])
        L.new(k.outputs['Result'], soft.inputs['B'])
        src = soft.outputs['Result']
    toon = N.new('ShaderNodeBsdfToon')
    toon.component = 'DIFFUSE'
    toon.inputs['Size'].default_value, toon.inputs['Smooth'].default_value = TOON_FACE if face else TOON
    L.new(times((1, 1, 1), ALBEDO * albedo * (FACE_ALBEDO if face else 1)), toon.inputs['Color'])
    nrm = color_of(b.inputs['Normal'])
    if nrm is not None:
        L.new(nrm, toon.inputs['Normal'])
    shade = N.new('ShaderNodeEmission')
    L.new(times(SHADE_TINT, albedo), shade.inputs['Color'])
    shade.inputs['Strength'].default_value = SHADE * (1.25 if face else 1)
    add = N.new('ShaderNodeAddShader')
    L.new(toon.outputs[0], add.inputs[0])
    L.new(shade.outputs[0], add.inputs[1])
    surface = add.outputs[0]
    # 輪郭の光: 縁ほど強く、画面の左上を向く面だけ。光源を置かないので、どのカメラでも同じ側に細く出る
    lw = N.new('ShaderNodeLayerWeight')
    lw.inputs['Blend'].default_value = 0.5
    edge = N.new('ShaderNodeMath')
    edge.operation = 'POWER'
    L.new(lw.outputs['Facing'], edge.inputs[0])
    edge.inputs[1].default_value = RIM[1]
    geo = N.new('ShaderNodeNewGeometry')
    vt = N.new('ShaderNodeVectorTransform')
    vt.vector_type, vt.convert_from, vt.convert_to = 'NORMAL', 'WORLD', 'CAMERA'
    L.new(geo.outputs['Normal'], vt.inputs['Vector'])
    dot = N.new('ShaderNodeVectorMath')
    dot.operation = 'DOT_PRODUCT'
    L.new(vt.outputs['Vector'], dot.inputs[0])
    dot.inputs[1].default_value = RIM_DIR
    side = N.new('ShaderNodeMapRange')
    side.inputs['From Min'].default_value, side.inputs['From Max'].default_value = 0.05, 0.45
    L.new(dot.outputs['Value'], side.inputs['Value'])
    mask = N.new('ShaderNodeMath')
    mask.operation = 'MULTIPLY'
    L.new(edge.outputs[0], mask.inputs[0])
    L.new(side.outputs['Result'], mask.inputs[1])
    ao = N.new('ShaderNodeAmbientOcclusion')  # 縁の外側が開けている所だけ。髪の束の重なりや腕と胴の間では消える
    ao.samples, ao.only_local = 8, False
    ao.inputs['Distance'].default_value = RIM_OPEN[0]
    opened = N.new('ShaderNodeMapRange')
    opened.inputs['From Min'].default_value, opened.inputs['From Max'].default_value = RIM_OPEN[1], RIM_OPEN[2]
    L.new(ao.outputs['AO'], opened.inputs['Value'])
    gate = N.new('ShaderNodeMath')
    gate.operation = 'MULTIPLY'
    L.new(mask.outputs[0], gate.inputs[0])
    L.new(opened.outputs['Result'], gate.inputs[1])
    mask = gate
    band = N.new('ShaderNodeMapRange')  # 縁の光もトゥーンらしく境目をはっきりさせる
    band.interpolation_type = 'SMOOTHSTEP'
    band.inputs['From Min'].default_value, band.inputs['From Max'].default_value = 0.15, 0.25
    L.new(mask.outputs[0], band.inputs['Value'])
    rim = N.new('ShaderNodeEmission')
    tint = N.new('ShaderNodeMix')  # 基本色と光の色の間。赤い髪の上でも縁の色が見える
    tint.data_type = 'RGBA'
    tint.inputs['Factor'].default_value = 0.6
    L.new(times((1, 1, 1)), tint.inputs['A'])
    tint.inputs['B'].default_value = (*look['rim'], 1)
    L.new(tint.outputs['Result'], rim.inputs['Color'])
    k = N.new('ShaderNodeMath')
    k.operation = 'MULTIPLY'
    L.new(band.outputs['Result'], k.inputs[0])
    k.inputs[1].default_value = RIM[0] * (0.5 if face else 1)
    L.new(k.outputs[0], rim.inputs['Strength'])
    add2 = N.new('ShaderNodeAddShader')
    L.new(surface, add2.inputs[0])
    L.new(rim.outputs[0], add2.inputs[1])
    surface = add2.outputs[0]
    alpha = b.inputs['Alpha']
    if alpha.links or alpha.default_value < 1:
        mix = N.new('ShaderNodeMixShader')
        if alpha.links:
            L.new(alpha.links[0].from_socket, mix.inputs['Fac'])
        else:
            mix.inputs['Fac'].default_value = alpha.default_value
        L.new(N.new('ShaderNodeBsdfTransparent').outputs[0], mix.inputs[1])
        L.new(surface, mix.inputs[2])
        surface = mix.outputs[0]
    for link in list(out.inputs['Surface'].links):
        L.remove(link)
    L.new(surface, out.inputs['Surface'])
    return True


def add_key(meshes, look):
    """キャラだけに当てる顔の光(ライトリンク)。置き場所は key_place でコマごとに決める"""
    s = bpy.context.scene
    light = bpy.data.objects.new('LookKey', bpy.data.lights.new('LookKey', 'AREA'))
    light.data.shape, light.data.size, light.data.energy, light.data.color = 'DISK', KEY[3], KEY_ENERGY, look['key']
    s.collection.objects.link(light)
    own = bpy.data.collections.new('LookLit')
    for o in meshes:
        own.objects.link(o)
    light.light_linking.receiver_collection = own
    return light


def key_place(light, face, cam_loc, frame):
    """顔の光をカメラの向きから横へ KEY[1] 度、上へ KEY[2] 度に置く。どのショットでも影が画面の同じ側に出る"""
    d, side, up, _ = KEY
    v = Vector(cam_loc) - Vector(face)
    a = math.atan2(v.x, -v.y) + math.radians(side)
    e = math.radians(up)
    light.location = Vector(face) + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * d
    light.rotation_euler = (Vector(face) - light.location).to_track_quat('-Z', 'Y').to_euler()
    light.keyframe_insert('location', frame=frame)
    light.keyframe_insert('rotation_euler', frame=frame)


def focus_target(arm, head_bone, above):
    """被写界深度の焦点を顔に置く空のオブジェクト。頭の骨に付けるので、道筋をならしても焦点は顔から外れない"""
    s = bpy.context.scene
    e = bpy.data.objects.new('LookFocus', None)
    s.collection.objects.link(e)
    s.frame_set(1)
    e.parent = arm
    e.parent_type = 'BONE'
    e.parent_bone = head_bone
    bpy.context.view_layer.update()
    want = Matrix.Translation((arm.matrix_world @ arm.pose.bones[head_bone].matrix).translation + Vector((0, 0, above)))
    e.matrix_world = want  # 1 コマ目の顔の位置。あとは頭の骨に従って動く
    return e


def add_post(look):
    """ステージの合成の最後に、奥の霞(Mist のパス)と、明るい所だけのにじみを足す"""
    s = bpy.context.scene
    tree = s.compositing_node_group
    if tree is None:
        return None
    N, L = tree.nodes, tree.links
    out = next((n for n in N if n.bl_idname == 'NodeGroupOutput'), None)
    rl = next((n for n in N if n.bl_idname == 'CompositorNodeRLayers'), None)
    if out is None or rl is None or not out.inputs[0].links:
        return None
    s.view_layers[0].use_pass_mist = True
    w = s.world
    w.mist_settings.falloff = 'QUADRATIC'
    w.mist_settings.depth = look['depth']
    last = out.inputs[0].links[0].from_socket
    k = N.new('ShaderNodeMath')
    k.operation = 'MULTIPLY'
    L.new(rl.outputs['Mist'], k.inputs[0])
    k.inputs[1].default_value = look['density']
    # 霞は光の当たる所の空気だけに出す。暗い骨組みや夜空は浮かせない。明るさは大きくぼかした画面から取る
    blur = N.new('CompositorNodeBlur')
    px = max(4, round(0.055 * s.render.resolution_x * s.render.resolution_percentage / 100))
    blur.inputs['Size'].default_value = (px, px)
    L.new(last, blur.inputs['Image'])
    bw = N.new('CompositorNodeRGBToBW')
    L.new(blur.outputs['Image'], bw.inputs['Image'])
    lit = N.new('ShaderNodeMapRange')
    lit.inputs['From Min'].default_value, lit.inputs['From Max'].default_value = FOG_LIT
    L.new(bw.outputs['Val'], lit.inputs['Value'])
    k2 = N.new('ShaderNodeMath')
    k2.operation = 'MULTIPLY'
    L.new(k.outputs[0], k2.inputs[0])
    L.new(lit.outputs['Result'], k2.inputs[1])
    k = k2
    fog = N.new('ShaderNodeMix')
    fog.data_type = 'RGBA'
    L.new(k.outputs[0], fog.inputs['Factor'])
    L.new(last, fog.inputs['A'])
    fog.inputs['B'].default_value = (*look['fog'], 1)
    res = fog.outputs['Result']
    g = N.new('CompositorNodeGlare')
    g.inputs['Type'].default_value = 'Bloom'
    g.inputs['Quality'].default_value = 'Medium'
    g.inputs['Threshold'].default_value = GLOW[0]
    g.inputs['Strength'].default_value = GLOW[1]
    g.inputs['Size'].default_value = GLOW[2]
    L.new(res, g.inputs['Image'])
    L.new(g.outputs['Image'], out.inputs[0])
    return w


def mist_place(world, cam_loc, face, frame):
    """霞はキャラの少し奥から始める。キャラ自身は霞まない"""
    world.mist_settings.start = (Vector(cam_loc) - Vector(face)).length + 1.0
    world.keyframe_insert('mist_settings.start', frame=frame)


# スカートの中を映さない。股と太ももの付け根の下向きの面の頂点へ、カメラから光線を飛ばし、キャラの体と服に遮られずに届けば見えている
SKIRT_PICK = (0.1, 0.15, 0.0, -0.15, 32)  # 股の中心からの横の範囲(m)、股の関節より下の範囲(m)、上の範囲、法線の上下の値の上限(下向き)、使う頂点の数
SKIRT_SEEN = 2  # 見えている頂点がこの数以上のコマを「スカートの中が見える」とする
SKIRT_LIFT_MAX = 1.6  # カメラを上げる上限(m)


def skirt_points(meshes, arm, legs):
    """1 コマ目の姿勢で、両脚の付け根の間の下向きの面の頂点 [(物, 番号)] を選ぶ。スカートの揺れ骨に付いた頂点(スカート自身)は除く。見つからなければ None"""
    s = bpy.context.scene
    s.frame_set(1)
    dg = bpy.context.evaluated_depsgraph_get()
    hl, hr = ((arm.matrix_world @ arm.pose.bones[n].head) for n in legs)
    c = (hl + hr) / 2
    side, below, above, nz, count = SKIRT_PICK
    found = []
    for o in (m for m in meshes if m.visible_get() and not m.hide_render):
        skirt = {g.index for g in o.vertex_groups if 'skirt' in g.name.lower()}
        ev = o.evaluated_get(dg)
        rot = ev.matrix_world.to_3x3()
        for v, w in zip(ev.data.vertices, o.data.vertices):
            p = ev.matrix_world @ v.co
            if abs(p.x - c.x) > side or abs(p.y - c.y) > side or not (c.z - below < p.z < c.z + above):
                continue
            if (rot @ v.normal).normalized().z > nz:
                continue
            if sum(g.weight for g in w.groups if g.group in skirt) > 0.3:
                continue
            found.append((o, v.index))
    if len(found) < 4:
        return None
    pick = found[::max(1, len(found) // count)][:count]
    print('skirt points', len(found), 'use', len(pick), flush=True)
    return pick


def _seen(cam, points, meshes, inside=None):
    """カメラから直に見える頂点の数"""
    dg = bpy.context.evaluated_depsgraph_get()
    evs = [(o.evaluated_get(dg), o) for o in meshes if o.visible_get() and not o.hide_render]  # 見えない当たり判定の球などは除く
    mats = {o.name: (ev.matrix_world.copy(), ev.matrix_world.inverted()) for ev, o in evs}
    cam = Vector(cam)
    n = 0
    for o, i in points:
        ev = o.evaluated_get(dg)
        p = mats[o.name][0] @ ev.data.vertices[i].co
        if inside and not inside(p):
            continue
        if cam.z >= p.z:  # 上や同じ高さからは見上げていない。脚を上げてめくれた布の外の太ももが見えるだけ
            continue
        d = (p - cam).length
        hit_first = d
        for e, ob in evs:
            mw, inv = mats[ob.name]
            lo, ld = inv @ cam, (inv.to_3x3() @ (p - cam)).normalized()
            ok, loc, _, _ = e.ray_cast(lo, ld)
            if ok:
                hit_first = min(hit_first, (mw @ loc - cam).length)
        if hit_first >= d - 0.012:
            n += 1
    return n


def skirt_seen(cam, points, meshes, inside=None):
    return _seen(cam, points, meshes, inside) >= SKIRT_SEEN


def lifted(cam, look, dz):
    """カメラを dz だけ上げ、見る点からの距離を元に戻す。写る大きさを変えずに、上から見下ろす向きにする"""
    cam, look = Vector(cam), Vector(look)
    dist = (cam - look).length
    up = cam + Vector((0, 0, dz))
    return tuple(look + (up - look).normalized() * dist)


def skirt_lift(cam, look, points, meshes):
    """スカートの中が見えなくなるまでカメラを上げる高さ(m、lifted に渡す値)。上げるほど見えにくくなるとみて二分で探す"""
    if not skirt_seen(cam, points, meshes):
        return 0.0
    if skirt_seen(lifted(cam, look, SKIRT_LIFT_MAX), points, meshes):
        return SKIRT_LIFT_MAX
    lo, hi = 0.0, SKIRT_LIFT_MAX
    for _ in range(7):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if skirt_seen(lifted(cam, look, mid), points, meshes) else (lo, mid)
    dz = hi + 0.03
    while dz < SKIRT_LIFT_MAX and skirt_seen(lifted(cam, look, dz), points, meshes):  # 見え方は高さで単調とは限らないので、見えなくなるまで確かめて上げる
        dz += 0.05
    return min(dz, SKIRT_LIFT_MAX)


# ---- --look cel: MToon に寄せたセル塗り。光の当たり方を自分で計算して自己発光で塗るので、境目が硬く、ざらつきも出ない ----
CEL = {
    'steps': (0.3, -0.1),  # 明るい段と中の段の境、中の段と影の境(光の向きとの内積 + shift)
    'edge': 0.015,  # 境目の幅。0 だと線が欠ける
    'shift': {'body': 0.4, 'skin': 0.55, 'face': 0.55, 'hair': 0.2},  # 体も影を浅く少なく(MToon の VRoid の体は shift 1 でほぼ影が無い)
    'mid': 0.35,  # 中の段の色は明るい色と影の色の間のこの位置
    'lit': 0.98,  # 明るい側の自己発光の強さ。顔も体も同じ
    'white': (0.1, 6.0),
    'skin_gain': 1.05,  # 体のテクスチャの肌は顔のテクスチャより 3〜8% 暗いので、体の材質の肌(SKIN)だけ上げてそろえる  # 白い所を暗くする量と、3 色の一番小さい値のべき(白だけに効く)
    'sat': 1.15,  # 彩度
    'sphere': 0.6,  # 顔の法線を顔の中心からの向きへ寄せる割合。鼻や頬に陰が出ない
    'diffuse': 0.12,  # 舞台の光を少し受ける割合(色が場に馴染む)
}
# ステージの MV の --look cel(render.py)だけで使う値。2026-11-07「コンサートと神社のキャラクターがアニメっぽくされてない」:
# 影の段を増やし(shift を下げる)、境目を硬くし、舞台の光の拡散(なめらかな陰と光沢の元)を入れない
CEL_STAGE = {
    'shift': {'body': 0.0, 'skin': 0.2, 'face': 0.5, 'hair': -0.1},
    'edge': 0.004,
    'diffuse': 0.0,
    'mid': 0.45,
    'shade_gain': 0.85,  # 服と髪の影の段の色を少し暗くし、段の形を見せる(顔と肌には掛けない)
}
CEL_FSTOP = 2.5  # ステージの MV の --look cel では f 値をこの倍にし、キャラのぼけを減らす(線と段の境が溶けない)
OUTLINE_PX = 2.5  # ステージの MV の --look cel の線の太さ(1080x1920 の出力で、画面の縦の px)
OUTLINE = {'scale': (1.6, 0.7, 2.2), 'default_width': 0.0008, 'color': (0.06, 0.01, 0.01)}  # 太さを決めるカメラの距離の基準(m)と倍率の下限・上限


def read_mtoon(vrm, out_dir):
    """VRM(glTF)の MToon の設定を材質の名前ごとに返す。影の色のテクスチャと線の幅のテクスチャは out_dir に書き出す"""
    import json
    import struct
    from pathlib import Path
    data = Path(vrm).read_bytes()
    n = struct.unpack_from('<I', data, 12)[0]
    j = json.loads(data[20:20 + n])
    binoff = 20 + n + 8
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    def image(tex):
        if tex is None:
            return None
        src = j['textures'][tex['index']]['source']
        im = j['images'][src]
        bv = j['bufferViews'][im['bufferView']]
        ext = '.png' if 'png' in im.get('mimeType', 'png') else '.jpg'
        p = out_dir / f'mtoon_{src}{ext}'
        if not p.exists():
            start = binoff + bv.get('byteOffset', 0)
            p.write_bytes(data[start:start + bv['byteLength']])
        return str(p)

    out = {}
    for m in j.get('materials', []):
        e = (m.get('extensions') or {}).get('VRMC_materials_mtoon')
        if not e:
            continue
        out[m['name']] = {'shade': tuple(e.get('shadeColorFactor', (1, 1, 1))[:3]), 'shade_tex': image(e.get('shadeMultiplyTexture')),
                          'outline': e.get('outlineWidthFactor', 0) if e.get('outlineWidthMode', 'none') != 'none' else 0,
                          'outline_color': tuple(e.get('outlineColorFactor', OUTLINE['color'])[:3]), 'outline_tex': image(e.get('outlineWidthMultiplyTexture'))}
    return out


def cel_drivers(light, face):
    """光の位置と顔の中心を、どの材質からも読める節のまとまりにする(ドライバ。単純な式なので自動実行を許さなくても動く)"""
    g = bpy.data.node_groups.new('CelRig', 'ShaderNodeTree')
    g.interface.new_socket('Light', in_out='OUTPUT', socket_type='NodeSocketVector')
    g.interface.new_socket('Face', in_out='OUTPUT', socket_type='NodeSocketVector')
    out = g.nodes.new('NodeGroupOutput')
    for k, obj in enumerate((light, face)):
        c = g.nodes.new('ShaderNodeCombineXYZ')
        for i in range(3):
            d = c.inputs[i].driver_add('default_value').driver
            d.type = 'SCRIPTED'
            v = d.variables.new()
            v.name, v.type = 'v', 'TRANSFORMS'
            v.targets[0].id = obj
            v.targets[0].transform_type = 'LOC_' + 'XYZ'[i]
            v.targets[0].transform_space = 'WORLD_SPACE'
            d.expression = 'v'
        g.links.new(c.outputs[0], out.inputs[k])
    return g


def _kind(m):
    n = m.name.upper()
    return 'face' if is_face(m) else 'hair' if 'HAIR' in n else 'skin' if 'SKIN' in n else 'body'


def cel_material(m, look, rig, mt=None, albedo=1.0, params=None):
    """Principled の材質を、MToon に寄せた 3 段のセル塗りの自己発光に替える。影の色は MToon の影のテクスチャ(無ければ基本色に SHADE_TINT)。
    params は CEL を部分的に置き換える値(ステージの MV の --look cel は CEL_STAGE)"""
    P = {**CEL, **(params or {})}
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    b = next((n for n in N if n.type == 'BSDF_PRINCIPLED'), None)
    out = next((n for n in N if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None) or next((n for n in N if n.type == 'OUTPUT_MATERIAL'), None)
    if b is None or out is None:
        return False
    kind = _kind(m)
    src = b.inputs['Base Color'].links[0].from_socket if b.inputs['Base Color'].links else None
    uv_node = None
    if src is not None and src.node.type == 'TEX_IMAGE' and src.node.inputs['Vector'].links:
        uv_node = src.node.inputs['Vector'].links[0].from_socket
    if src is None:
        rgb = N.new('ShaderNodeRGB')
        rgb.outputs[0].default_value = b.inputs['Base Color'].default_value
        src = rgb.outputs[0]

    def mul(a, rgb):
        x = N.new('ShaderNodeMix')
        x.data_type, x.blend_type = 'RGBA', 'MULTIPLY'
        x.inputs['Factor'].default_value = 1
        L.new(a, x.inputs['A'])
        if isinstance(rgb, tuple):
            x.inputs['B'].default_value = (*rgb[:3], 1)
        else:
            L.new(rgb, x.inputs['B'])
        return x.outputs['Result']

    def sat(a):
        h = N.new('ShaderNodeHueSaturation')
        h.inputs['Saturation'].default_value = P['sat']
        L.new(a, h.inputs['Color'])
        return h.outputs['Color']

    lit = sat(src)
    if kind != 'face':
        # 白い所だけ少し暗くする(白い服を飛ばさない)。白さは 3 色の一番小さい値で測るので、肌や赤は暗くならず、顔と同じ明るさになる
        sep = N.new('ShaderNodeSeparateColor')
        L.new(src, sep.inputs['Color'])
        m1 = N.new('ShaderNodeMath')
        m1.operation = 'MINIMUM'
        L.new(sep.outputs[0], m1.inputs[0])
        L.new(sep.outputs[1], m1.inputs[1])
        m2 = N.new('ShaderNodeMath')
        m2.operation = 'MINIMUM'
        L.new(m1.outputs[0], m2.inputs[0])
        L.new(sep.outputs[2], m2.inputs[1])
        sq = N.new('ShaderNodeMath')
        sq.operation = 'POWER'
        L.new(m2.outputs[0], sq.inputs[0])
        sq.inputs[1].default_value = P['white'][1]
        k = N.new('ShaderNodeMapRange')
        k.inputs['To Min'].default_value, k.inputs['To Max'].default_value = 1.0, 1.0 - P['white'][0]
        L.new(sq.outputs[0], k.inputs['Value'])
        lit = mul(lit, k.outputs['Result'])
    if kind == 'skin':
        lit = mul(lit, (P['skin_gain'],) * 3)
    if albedo < 1:
        lit = mul(lit, (albedo, albedo, albedo))
    if mt and mt.get('shade_tex') and kind != 'face':  # 焼き込んだ GLB の顔は UV を作り直しているので、VRM の影のテクスチャが合わない
        tex = N.new('ShaderNodeTexImage')
        tex.image = bpy.data.images.load(mt['shade_tex'], check_existing=True)
        if uv_node is not None:
            L.new(uv_node, tex.inputs['Vector'])
        shade = sat(mul(tex.outputs['Color'], mt['shade']))
    else:
        shade = sat(mul(src, SHADE_TINT))
    if P.get('shade_gain', 1.0) != 1.0 and kind not in ('face', 'skin'):  # 肌の影は灰色に寄るので暗くしない
        shade = mul(shade, (P['shade_gain'],) * 3)
    mid = N.new('ShaderNodeMix')
    mid.data_type = 'RGBA'
    mid.inputs['Factor'].default_value = P['mid']
    L.new(lit, mid.inputs['A'])
    L.new(shade, mid.inputs['B'])
    geo = N.new('ShaderNodeNewGeometry')
    grp = N.new('ShaderNodeGroup')
    grp.node_tree = rig
    nrm = geo.outputs['Normal']
    if kind == 'face':  # 顔は法線を顔の中心からの向きへ寄せ、鼻や頬の陰を消す

        def vm(op, a, b_=None):
            x = N.new('ShaderNodeVectorMath')
            x.operation = op
            L.new(a, x.inputs[0])
            if b_ is not None:
                L.new(b_, x.inputs[1])
            return x.outputs[0]

        rn = vm('NORMALIZE', vm('SUBTRACT', geo.outputs['Position'], grp.outputs['Face']))
        blend = N.new('ShaderNodeMix')
        blend.data_type = 'VECTOR'
        blend.inputs['Factor'].default_value = P['sphere']
        L.new(nrm, blend.inputs['A'])
        L.new(rn, blend.inputs['B'])
        nrm = vm('NORMALIZE', blend.outputs['Result'])
    tol = N.new('ShaderNodeVectorMath')
    tol.operation = 'SUBTRACT'
    L.new(grp.outputs['Light'], tol.inputs[0])
    L.new(geo.outputs['Position'], tol.inputs[1])
    ln = N.new('ShaderNodeVectorMath')
    ln.operation = 'NORMALIZE'
    L.new(tol.outputs[0], ln.inputs[0])
    dot = N.new('ShaderNodeVectorMath')
    dot.operation = 'DOT_PRODUCT'
    L.new(nrm, dot.inputs[0])
    L.new(ln.outputs[0], dot.inputs[1])
    sh = N.new('ShaderNodeMath')
    sh.inputs[1].default_value = P['shift'][kind]
    L.new(dot.outputs['Value'], sh.inputs[0])

    def step(at):
        r = N.new('ShaderNodeMapRange')
        r.interpolation_type = 'SMOOTHSTEP'
        r.inputs['From Min'].default_value, r.inputs['From Max'].default_value = at - P['edge'], at + P['edge']
        L.new(sh.outputs[0], r.inputs['Value'])
        return r.outputs['Result']

    lo = N.new('ShaderNodeMix')
    lo.data_type = 'RGBA'
    L.new(step(P['steps'][1]), lo.inputs['Factor'])
    L.new(shade, lo.inputs['A'])
    L.new(mid.outputs['Result'], lo.inputs['B'])
    hi = N.new('ShaderNodeMix')
    hi.data_type = 'RGBA'
    L.new(step(P['steps'][0]), hi.inputs['Factor'])
    L.new(lo.outputs['Result'], hi.inputs['A'])
    L.new(lit, hi.inputs['B'])
    em = N.new('ShaderNodeEmission')
    L.new(mul(hi.outputs['Result'], look['key']), em.inputs['Color'])
    em.inputs['Strength'].default_value = P['lit']  # 顔も体も同じ光の強さ
    dif = N.new('ShaderNodeBsdfDiffuse')
    L.new(src, dif.inputs['Color'])
    mixd = N.new('ShaderNodeMixShader')
    mixd.inputs['Fac'].default_value = P['diffuse']
    L.new(em.outputs[0], mixd.inputs[1])
    L.new(dif.outputs[0], mixd.inputs[2])
    surface = mixd.outputs[0]
    alpha = b.inputs['Alpha']
    if alpha.links or alpha.default_value < 1:
        mix = N.new('ShaderNodeMixShader')
        if alpha.links:
            L.new(alpha.links[0].from_socket, mix.inputs['Fac'])
        else:
            mix.inputs['Fac'].default_value = alpha.default_value
        L.new(N.new('ShaderNodeBsdfTransparent').outputs[0], mix.inputs[1])
        L.new(surface, mix.inputs[2])
        surface = mix.outputs[0]
    if os.environ.get('LOOK_MASK'):  # 明るさを部位ごとに測るための色分け。描く絵には使わない
        code = N.new('ShaderNodeEmission')
        if os.environ['LOOK_MASK'] == 'albedo':
            L.new(src, code.inputs['Color'])
        elif kind in ('face', 'skin', 'hair'):
            code.inputs['Color'].default_value = {'face': (1, 0, 0, 1), 'skin': (0, 1, 0, 1), 'hair': (1, 1, 0, 1)}[kind]
        else:
            bw2 = N.new('ShaderNodeRGBToBW')
            L.new(src, bw2.inputs['Color'])
            cc = N.new('ShaderNodeCombineColor')
            L.new(bw2.outputs['Val'], cc.inputs['Blue'])
            L.new(cc.outputs[0], code.inputs['Color'])
        surface = code.outputs[0]
        if alpha.links:
            mk = N.new('ShaderNodeMixShader')
            L.new(alpha.links[0].from_socket, mk.inputs['Fac'])
            L.new(N.new('ShaderNodeBsdfTransparent').outputs[0], mk.inputs[1])
            L.new(surface, mk.inputs[2])
            surface = mk.outputs[0]
    for link in list(out.inputs['Surface'].links):
        L.remove(link)
    L.new(surface, out.inputs['Surface'])
    return True


def add_outline(obj, mtoon):
    """MToon の線を反転した殻で描く。材質ごとの幅(m)を頂点の重みにし、線の幅のテクスチャ(顔は顎だけ)があれば掛ける。
    殻の材質は手前を向く面だけ暗い色で塗り、基本色の透明もそのまま使う。答えは Solidify の modifier(太さはコマごとに合わせる)"""
    me = obj.data
    mats = list(me.materials)
    if not mats or not obj.visible_get() or obj.hide_render:
        return None
    widths = []
    for m in mats:
        mt = mtoon.get(m.name) if m and mtoon else None
        widths.append(0 if m and is_face(m) else mt['outline'] if mt else (OUTLINE['default_width'] if m else 0))  # 顔の物には殻を付けない(重なる殻で顔が抜ける)
    top = max(widths)
    if top <= 0:
        return None
    masks = {}
    for i, m in enumerate(mats):
        mt = mtoon.get(m.name) if m and mtoon else None
        if mt and mt.get('outline_tex'):
            img = bpy.data.images.load(mt['outline_tex'], check_existing=True)
            px = np.empty(len(img.pixels), np.float32)
            img.pixels.foreach_get(px)
            masks[i] = (px.reshape(img.size[1], img.size[0], 4), img.size)
    uv = me.uv_layers.active.data if me.uv_layers.active else None
    w = [0.0] * len(me.vertices)
    for poly in me.polygons:
        k = poly.material_index
        f = widths[k] / top
        for li in poly.loop_indices:
            g = f
            vi = me.loops[li].vertex_index
            if is_face(mats[k]):
                # 顔には線を出さない。焼き込んだ GLB の顔は UV を作り直していて VRM の線の幅のテクスチャ(顎だけ)が合わず、
                # 下を向く面で選ぶと瞼や鼻の裏の殻が顔の上に出た。顎の外の形は首と髪の線で見える
                g = 0.0
            elif k in masks and uv is not None:
                arr, (iw, ih) = masks[k]
                u, v = uv[li].uv
                g *= float(arr[min(ih - 1, max(0, int(v * ih))), min(iw - 1, max(0, int(u * iw))), 0])
            w[vi] = max(w[vi], g)
    vg = obj.vertex_groups.new(name='LookOutline')
    by = {}
    for vi, x in enumerate(w):
        if x > 0:
            by.setdefault(round(x, 3), []).append(vi)
    for x, vs in by.items():
        vg.add(vs, x, 'REPLACE')
    base = len(mats)
    for m in mats:
        mt = mtoon.get(m.name) if m and mtoon else None
        om = bpy.data.materials.new(f'Outline_{m.name if m else "x"}')
        om.use_nodes = True
        N, L = om.node_tree.nodes, om.node_tree.links
        for n in list(N):
            if n.type == 'BSDF_PRINCIPLED':
                N.remove(n)
        o = next(n for n in N if n.type == 'OUTPUT_MATERIAL')
        em = N.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (*(mt['outline_color'] if mt else OUTLINE['color']), 1)
        geo = N.new('ShaderNodeNewGeometry')
        tr = N.new('ShaderNodeBsdfTransparent')
        mix = N.new('ShaderNodeMixShader')  # 反転した殻は、手前を向く面(Backfacing が 0)だけ描く
        L.new(geo.outputs['Backfacing'], mix.inputs['Fac'])
        L.new(em.outputs[0], mix.inputs[1])
        L.new(tr.outputs[0], mix.inputs[2])
        surface = mix.outputs[0]
        b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if m and m.node_tree else None
        al = b.inputs['Alpha'].links[0].from_node if b is not None and b.inputs['Alpha'].links else None
        if al is not None and al.type == 'TEX_IMAGE':
            t = N.new('ShaderNodeTexImage')
            t.image = al.image
            a2 = N.new('ShaderNodeMixShader')
            L.new(t.outputs['Alpha'], a2.inputs['Fac'])
            L.new(tr.outputs[0], a2.inputs[1])
            L.new(surface, a2.inputs[2])
            surface = a2.outputs[0]
        if m is None or is_face(m) or widths[mats.index(m)] <= 0:  # 線を出さない材質の殻は透明にする。太さ 0 の殻が面と重なって黒く出る
            surface = tr.outputs[0]
        L.new(surface, o.inputs['Surface'])
        me.materials.append(om)
    mod = obj.modifiers.new('LookOutline', 'SOLIDIFY')
    mod.thickness = top
    mod.offset = 1.0
    mod.use_flip_normals = True
    mod.use_rim = False
    mod.use_even_offset = False
    mod.material_offset = base
    mod.vertex_group = vg.name
    mod.thickness_vertex_group = 0.0
    obj['look_outline_width'] = top  # modifier には独自の値を持てないので物に持たせる
    return mod


def outline_place(mods, cam_loc, face, frame):
    """線の太さをカメラの距離で補う。世界の幅のままだと引きで消え、寄りで太くなりすぎる"""
    lo, hi = OUTLINE['scale'][1], OUTLINE['scale'][2]
    k = max(lo, min(hi, (Vector(cam_loc) - Vector(face)).length / OUTLINE['scale'][0]))
    for mod in mods:
        mod.thickness = mod.id_data['look_outline_width'] * k
        mod.id_data.keyframe_insert(f'modifiers["{mod.name}"].thickness', frame=frame)


def outline_place_px(mods, cam, face, frame, px=None, res_y=1920):
    """線の太さを、顔の位置で画面の px 幅になるように決める(ステージの MV の --look cel)。
    縦長の出力ではセンサーの幅(36 mm)が縦に当たるので、1 px は 距離 x 36 / 焦点距離 / res_y の幅"""
    px = OUTLINE_PX if px is None else px
    d = (Vector(cam.location) - Vector(face)).length
    w = px * d * cam.data.sensor_width / cam.data.lens / res_y
    for mod in mods:
        mod.thickness = w
        mod.id_data.keyframe_insert(f'modifiers["{mod.name}"].thickness', frame=frame)
