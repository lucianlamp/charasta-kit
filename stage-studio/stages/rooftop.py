"""雨上がりの夜の屋上。濡れたコンクリート、水たまり、給水塔、室外機と配管、電球の列、手すり、ネオンの摩天楼。

座標: +Y が目標画像の奥。target の視点は高さ 0.5m、y=-5、焦点距離 22.6mm(1672px に対して f=1050px、地平線は y=825)。
街は遠くの帯の板を除いて全部メッシュで、どの向きでも途切れない。塔の面は窓の画像で、窓の明滅は画像の格子に合わせて材質の中で決める。
夜空は 1 枚の写真の殻を回す。床に映す空は暗い別の殻にする。飛行機は親を回す。キーフレームは全部 animate に置く。
"""
import math
import random

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from lib.studio import load_image

TAU = math.tau
F_PX = 1050.0
CAM = (0.0, -5.0, 0.5)
HORIZON = 825.0
ASSETS = None
MARK = (0.0, -1.0, 0.0)
X0, X1, Y0, Y1 = -9.0, 9.0, -10.0, 9.0  # 屋上の内側の範囲
WATER_Z = 0.0
WARM = (1.0, .62, .25, 1)
FLOOR_BEND = .16  # 水膜の法線を視線の向きに傾ける強さ。大きいほど反射が縦に伸びる
FILM_COLOR = (.66, .69, .8, 1)  # 水膜の反射の色
POOL_COLOR = (.74, .74, .8, 1)  # 水たまりの反射の色
DRY_TINT = (.19, .18, .24, 1)  # 乾いた面の色の倍率
FAR_BREAK = 3.0  # 奥の床で濡れを破る強さ
GLINT_K = 8.5  # 光の粒の強さ
WET_GRAIN = 1.5  # 骨材が水を破る強さ
ROUGH_WET = .2  # 濡れた面の粗さの揺れの幅
LIFT = .012  # コンポジットで暗部から引く量。カメラに直接写る空には足して打ち消す
SKY_NAVY = (.0044 + .0113, .0123 + .0113, .042 + .0113, 1)  # 上空の紺
SKY_TINT = (1, 1, 1, 1)  # 夜空の写真の色の倍率
SKY_US, SKY_YAW, SKY_K, SKY_MIRROR = 4, 45.0, 1.0, .12  # 夜空の写真の繰り返し、向き、明るさ、床に写す明るさの倍率


def P(px, py, d):
    """目標画像の画素 (px, py) に、カメラから奥行き d(m)で写る点"""
    return (CAM[0] + (px - 470.5) / F_PX * d, CAM[1] + d, CAM[2] + (HORIZON - py) / F_PX * d)


# ---- メッシュの組み立て ----
class B:
    """頂点、面、UV、材質番号をためて 1 つのオブジェクトにする"""

    def __init__(self):
        self.v, self.f, self.uv, self.mi, self.sm = [], [], [], [], []

    def face(self, idx, uvs, mat=0, smooth=True):
        self.f.append(idx)
        self.uv.extend(uvs)
        self.mi.append(mat)
        self.sm.append(smooth)

    def grid(self, rows, closed=False, mat=0, smooth=True, us=1.0, vs=1.0):
        n = len(rows[0])
        base = len(self.v)
        for r in rows:
            self.v.extend(r)
        for i in range(len(rows) - 1):
            for j in range(n if closed else n - 1):
                j2 = (j + 1) % n
                a, b, c, d = base + i * n + j, base + i * n + j2, base + (i + 1) * n + j2, base + (i + 1) * n + j
                u0, u1 = j / (n if closed else n - 1) * us, (j + 1) / (n if closed else n - 1) * us
                v0, v1 = i / (len(rows) - 1) * vs, (i + 1) / (len(rows) - 1) * vs
                self.face((a, b, c, d), [(u0, v0), (u1, v0), (u1, v1), (u0, v1)], mat, smooth)

    def lathe(self, prof, n=32, c=(0, 0, 0), mat=0, smooth=True, us=1.0):
        rows = [[(c[0] + r * math.cos(TAU * j / n), c[1] + r * math.sin(TAU * j / n), c[2] + z) for j in range(n)] for r, z in prof]
        self.grid(rows, closed=True, mat=mat, smooth=smooth, us=us)

    def tube(self, pts, r, n=8, mat=0, closed=False):
        pts = [Vector(p) for p in pts]
        m = len(pts)
        rows, nor = [], None
        for i in range(m):
            t = (pts[(i + 1) % m if closed else min(i + 1, m - 1)] - pts[(i - 1) % m if closed else max(i - 1, 0)]).normalized()
            if nor is None:
                nor = t.cross(Vector((0.13, 0.31, 0.94))).normalized()
            nor = (nor - t * nor.dot(t)).normalized()
            bi = t.cross(nor)
            rows.append([tuple(pts[i] + (nor * math.cos(TAU * j / n) + bi * math.sin(TAU * j / n)) * r) for j in range(n)])
        if closed:
            rows.append(rows[0])
        self.grid(rows, closed=True, mat=mat)

    def box(self, c, s, mat=0, rot=0.0):
        cx, cy, cz = c
        sx, sy, sz = (x / 2 for x in s)
        co, si = math.cos(rot), math.sin(rot)
        base = len(self.v)
        for dz in (-sz, sz):
            for dx, dy in ((-sx, -sy), (sx, -sy), (sx, sy), (-sx, sy)):
                self.v.append((cx + dx * co - dy * si, cy + dx * si + dy * co, cz + dz))
        uv = [(0, 0), (1, 0), (1, 1), (0, 1)]
        for f in ((3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            self.face(tuple(base + i for i in f), uv, mat, False)

    def beam(self, a, b, w, h=None, mat=0):
        """a から b へ伸びる四角い材。角が立つ"""
        a, b = Vector(a), Vector(b)
        h = h or w
        t = (b - a).normalized()
        u = t.cross(Vector((0.03, 0.05, 1))).normalized()
        v = t.cross(u)
        base = len(self.v)
        for p in (a, b):
            for du, dv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                self.v.append(tuple(p + u * du * w / 2 + v * dv * h / 2))
        uv = [(0, 0), (1, 0), (1, 1), (0, 1)]
        for f in ((3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            self.face(tuple(base + i for i in f), uv, mat, False)

    def mesh(self, name, mats):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.v, [], self.f)
        me.update()
        uv = me.uv_layers.new(name='UVMap')
        uv.uv.foreach_set('vector', [x for p in self.uv for x in p])
        me.polygons.foreach_set('use_smooth', self.sm)
        me.polygons.foreach_set('material_index', self.mi)
        for m in mats:
            me.materials.append(m)
        me.update()
        return me

    def obj(self, name, mats, parent=None, loc=(0, 0, 0), rot=(0, 0, 0)):
        return add(name, self.mesh(name, mats), parent, loc, rot)


def add(name, data, parent=None, loc=(0, 0, 0), rot=(0, 0, 0)):
    o = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(o)
    o.location, o.rotation_euler = loc, rot
    o.parent = parent
    return o


def sphere_mesh(name, r, mat, sub=1):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.materials.append(mat)
    return me


def instance_verts(name, pts, proto_mesh):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(p) for p in pts], [], [])
    host = add(name, me)
    host.instance_type = 'VERTS'
    host.show_instancer_for_render = False
    add(name + '_p', proto_mesh, host)
    return host


def catenary(a, b, sag, n):
    a, b = Vector(a), Vector(b)
    return [a.lerp(b, i / n) + Vector((0, 0, -sag * 4 * (i / n) * (1 - i / n))) for i in range(n + 1)]


def bend(pts, r=.12, n=4):
    """折れ線の角を半径 r の弧で丸める。配管の曲がりに使う"""
    pts = [Vector(p) for p in pts]
    out = [pts[0]]
    for a, b, c in zip(pts[:-2], pts[1:-1], pts[2:]):
        p0 = b + (a - b).normalized() * r
        p1 = b + (c - b).normalized() * r
        for i in range(n + 1):
            t = i / n
            out.append(p0.lerp(b, t).lerp(b.lerp(p1, t), t))
    out.append(pts[-1])
    return out


# ---- 材質 ----
def image(name, data=False):
    return load_image(ASSETS / name, data)


def mat_base(name):
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    return m, nt, out


def tex_node(nt, img, ext='REPEAT', interp='Linear'):
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = img
    t.extension = ext
    t.interpolation = interp
    return t


def link(nt, sock, target):
    if isinstance(sock, (int, float)):
        target.default_value = sock
    elif isinstance(sock, tuple):
        target.default_value = sock
    else:
        nt.links.new(sock, target)


def mixc(nt, fac, a, b, blend='MIX'):
    n = nt.nodes.new('ShaderNodeMix')
    n.data_type = 'RGBA'
    n.blend_type = blend
    link(nt, fac, n.inputs[0])
    link(nt, a, n.inputs[6])
    link(nt, b, n.inputs[7])
    return n.outputs[2]


def math_(nt, op, a, b=None, clamp=False):
    n = nt.nodes.new('ShaderNodeMath')
    n.operation = op
    n.use_clamp = clamp
    link(nt, a, n.inputs[0])
    if b is not None:
        link(nt, b, n.inputs[1])
    return n.outputs[0]


def ramp(nt, v, a, b, c=0.0, d=1.0, smooth=True):
    n = nt.nodes.new('ShaderNodeMapRange')
    n.interpolation_type = 'SMOOTHSTEP' if smooth else 'LINEAR'
    n.clamp = True
    link(nt, v, n.inputs['Value'])
    n.inputs['From Min'].default_value = a
    n.inputs['From Max'].default_value = b
    n.inputs['To Min'].default_value = c
    n.inputs['To Max'].default_value = d
    return n.outputs[0]


def scale_pos(nt, pos, k, rot=0.0):
    """位置を k 倍し、必要なら Z 軸で回す。床の画像の繰り返しを隠すのに使う"""
    if rot:
        n = nt.nodes.new('ShaderNodeVectorRotate')
        n.rotation_type = 'Z_AXIS'
        n.inputs['Angle'].default_value = rot
        nt.links.new(pos, n.inputs['Vector'])
        pos = n.outputs[0]
    s = nt.nodes.new('ShaderNodeVectorMath')
    s.operation = 'SCALE'
    s.inputs['Scale'].default_value = k
    nt.links.new(pos, s.inputs[0])
    return s.outputs[0]


def bump(nt, height, strength, dist, normal=None):
    n = nt.nodes.new('ShaderNodeBump')
    link(nt, height, n.inputs['Height'])
    n.inputs['Strength'].default_value = strength
    n.inputs['Distance'].default_value = dist
    if normal is not None:
        nt.links.new(normal, n.inputs['Normal'])
    return n.outputs[0]


def worldmat(name, img, tile, rough=.5, metal=0.0, tint=1.0, spec=.5, coat=0.0, bump_k=.4, gray=0.0):
    """世界座標の箱の投影で画像を貼る材質。メッシュに UV が要らない。濡れの弱い反射は coat で足す"""
    m, nt, out = mat_base(name)
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], out.inputs[0])
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    t = tex_node(nt, image(img))
    t.projection = 'BOX'
    t.projection_blend = .25
    nt.links.new(scale_pos(nt, geo.outputs['Position'], 1 / tile), t.inputs[0])
    bw = nt.nodes.new('ShaderNodeRGBToBW')
    nt.links.new(t.outputs[0], bw.inputs[0])
    nt.links.new(mixc(nt, 1, mixc(nt, gray, t.outputs[0], bw.outputs[0]), (tint, tint, tint, 1), 'MULTIPLY'), b.inputs['Base Color'])
    b.inputs['Metallic'].default_value = metal
    b.inputs['Specular IOR Level'].default_value = spec
    b.inputs['Coat Weight'].default_value = coat
    b.inputs['Coat Roughness'].default_value = .08
    nt.links.new(ramp(nt, t.outputs[0], 0, .7, min(rough + .22, 1), rough - .1, False), b.inputs['Roughness'])
    if bump_k:
        nt.links.new(bump(nt, t.outputs[0], bump_k, .02), b.inputs['Normal'])
    m.cycles.emission_sampling = 'NONE'
    return m


def pbr(name, color, rough=.5, metal=0.0, spec=.5, coat=0.0):
    m, nt, out = mat_base(name)
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], out.inputs[0])
    b.inputs['Base Color'].default_value = color
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    b.inputs['Specular IOR Level'].default_value = spec
    b.inputs['Coat Weight'].default_value = coat
    b.inputs['Coat Roughness'].default_value = .08
    return m


def emis(name, color, k):
    m, nt, out = mat_base(name)
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[0].default_value = color
    e.inputs[1].default_value = k
    nt.links.new(e.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


# ---- 街 ----
# 画像ごとの (1 階の窓の数, 階の数)。明滅と点灯の格子に使う
FACADES = {'r_navy': (34, 14), 'r_warm': (18, 20), 'r_ice': (24, 12), 'r_sparse': (16, 18), 'r_low': (10, 12), 'f_navy': (26, 24), 'f_warm': (26, 24), 'f_cool': (29, 21), 'f_tan': (20, 22), 'f_apart': (16, 24), 'f_mixed': (24, 26), 'f_tower': (30, 30), 'f_blue': (28, 28)}
ROW_PX = 4.6  # target の焦点距離での 1 階の高さ(px)
WARM_T, PALE, COOL, ICE, TEAL, ROSE = (1, .74, .42), (1, .92, .74), (.72, .84, 1), (.55, .85, 1), (.45, 1, .92), (1, .55, .8)


def facade_mat(name, cols, rows, keys):
    """窓の画像の発光。塔ごとの値で色、窓の点灯率、階の点灯率を変える。
    UV 'S' = (塔の乱数, 明るさ)、UV 'D' = (窓の点灯率, 階の点灯率)、UV 'W' = (壁が照らされる量, 0)、色属性 Tint = 窓の色(黒なら画像の色のまま)"""
    m, nt, out = mat_base(name)
    N = nt.nodes
    L = nt.links
    uv = N.new('ShaderNodeUVMap')
    uv.uv_map = 'UVMap'
    us = N.new('ShaderNodeUVMap')
    us.uv_map = 'S'
    ud = N.new('ShaderNodeUVMap')
    ud.uv_map = 'D'
    sp = N.new('ShaderNodeSeparateXYZ')
    L.new(us.outputs[0], sp.inputs[0])
    sd = N.new('ShaderNodeSeparateXYZ')
    L.new(ud.outputs[0], sd.inputs[0])
    uw = N.new('ShaderNodeUVMap')
    uw.uv_map = 'W'
    sw = N.new('ShaderNodeSeparateXYZ')
    L.new(uw.outputs[0], sw.inputs[0])
    t = tex_node(nt, image(name + '.png'))
    L.new(uv.outputs[0], t.inputs[0])
    tint = N.new('ShaderNodeVertexColor')
    tint.layer_name = 'Tint'
    bw = N.new('ShaderNodeRGBToBW')
    L.new(t.outputs[0], bw.inputs[0])
    has = math_(nt, 'GREATER_THAN', math_(nt, 'ADD', tint.outputs['Alpha'], 0), .5)
    src = mixc(nt, has, t.outputs[0], mixc(nt, 1, tint.outputs[0], bw.outputs[0], 'MULTIPLY'))
    gm = N.new('ShaderNodeGamma')
    gm.inputs[1].default_value = 1.5
    L.new(src, gm.inputs[0])
    su = N.new('ShaderNodeSeparateXYZ')
    L.new(uv.outputs[0], su.inputs[0])
    cx = math_(nt, 'FLOOR', math_(nt, 'MULTIPLY', su.outputs['X'], float(cols)))
    cy = math_(nt, 'FLOOR', math_(nt, 'MULTIPLY', su.outputs['Y'], float(rows)))
    tm = N.new('ShaderNodeValue')
    tm.name = 'BlinkTime'
    keys['blink'].append(tm.outputs[0])
    cmb = N.new('ShaderNodeCombineXYZ')
    L.new(cx, cmb.inputs[0])
    L.new(cy, cmb.inputs[1])
    L.new(sp.outputs['X'], cmb.inputs[2])
    wn = N.new('ShaderNodeTexWhiteNoise')
    wn.noise_dimensions = '3D'
    L.new(cmb.outputs[0], wn.inputs['Vector'])
    # 階ごとの点灯: 階の番号と塔の乱数で決める
    rw = N.new('ShaderNodeCombineXYZ')
    L.new(math_(nt, 'FLOOR', math_(nt, 'DIVIDE', cy, 2.0)), rw.inputs[0])
    L.new(sp.outputs['X'], rw.inputs[1])
    wr = N.new('ShaderNodeTexWhiteNoise')
    wr.noise_dimensions = '3D'
    L.new(rw.outputs[0], wr.inputs['Vector'])
    on_floor = math_(nt, 'LESS_THAN', wr.outputs[0], sd.outputs['Y'])
    on_win = math_(nt, 'LESS_THAN', math_(nt, 'FRACT', math_(nt, 'MULTIPLY', wn.outputs[0], 3.7)), sd.outputs['X'])
    bl = N.new('ShaderNodeCombineXYZ')  # 階のまとまりごとの点灯。塔ごとに明るい階の帯ができる
    L.new(math_(nt, 'FLOOR', math_(nt, 'DIVIDE', cy, 5.0)), bl.inputs[0])
    L.new(math_(nt, 'ADD', sp.outputs['X'], .37), bl.inputs[1])
    wb = N.new('ShaderNodeTexWhiteNoise')
    wb.noise_dimensions = '3D'
    L.new(bl.outputs[0], wb.inputs['Vector'])
    on_block = ramp(nt, wb.outputs[0], .3, .34, .3, 1.0, False)
    lit_mask = math_(nt, 'MULTIPLY', math_(nt, 'MULTIPLY', on_floor, on_win), on_block)
    step = math_(nt, 'FLOOR', math_(nt, 'ADD', tm.outputs[0], math_(nt, 'MULTIPLY', wn.outputs[0], 7.0)))
    wn2 = N.new('ShaderNodeTexWhiteNoise')
    wn2.noise_dimensions = '4D'
    L.new(cmb.outputs[0], wn2.inputs['Vector'])
    L.new(step, wn2.inputs['W'])
    alive = ramp(nt, wn2.outputs[0], .07, .09, .03, 1.0, False)
    lit = mixc(nt, math_(nt, 'MULTIPLY', alive, lit_mask), (0, 0, 0, 1), gm.outputs[0])
    lp = N.new('ShaderNodeLightPath')
    lit = mixc(nt, mix_f(nt, lp.outputs['Is Glossy Ray'], 0.0, ramp(nt, bw.outputs[0], .35, .5, 1, 0)), lit, (0, 0, 0, 1))  # 映りでは暗い壁の画素を消す
    lit = mixc(nt, 1, lit, (3.0, 3.0, 3.0, 1), 'MULTIPLY')
    lit = mixc(nt, 1, lit, mixc(nt, sp.outputs['Y'], (0, 0, 0, 1), (1, 1, 1, 1)), 'MULTIPLY')
    geo = N.new('ShaderNodeNewGeometry')
    ln = N.new('ShaderNodeVectorMath')
    ln.operation = 'LENGTH'
    L.new(geo.outputs['Position'], ln.inputs[0])
    haze = math_(nt, 'MULTIPLY', ramp(nt, ln.outputs['Value'], 120, 760, .0, .2, False), math_(nt, 'SUBTRACT', 1.0, lp.outputs['Is Glossy Ray']))
    col = mixc(nt, 1, lit, (.0065, .012, .024, 1), 'ADD')  # 暗い紺の本体
    col = mixc(nt, 1, col, mixc(nt, sw.outputs['X'], (0, 0, 0, 1), (.13, .085, .075, 1)), 'ADD')  # 手前の棟は壁が街の光で見える
    zp = N.new('ShaderNodeSeparateXYZ')
    L.new(geo.outputs['Position'], zp.inputs[0])
    col = mixc(nt, ramp(nt, zp.outputs['Z'], -40, 30, 1, 0, True), col, (.105, .06, .05, 1), 'ADD')  # 低い所の街の照り返し
    col = mixc(nt, haze, col, (.05, .085, .18, 1))
    em = N.new('ShaderNodeEmission')
    L.new(col, em.inputs[0])
    L.new(em.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


class Tower:
    """同じ窓の画像の塔を 1 つのメッシュにまとめる"""

    def __init__(self):
        self.b = B()
        self.s, self.d, self.t, self.w = [], [], [], []

    def loop(self, n, s, d, t, w=0.0):
        self.w += [(w, 0)] * n
        self.s += [s] * n
        self.d += [d] * n
        self.t += [t] * n

    def add(self, cx, cy, w, dp, z0, z1, yaw, tile, rnd, lum, dens=(1, 1), tint=None, cap='flat', wall=0.0):
        co, si = math.cos(yaw), math.sin(yaw)
        cs = [(-w / 2, -dp / 2), (w / 2, -dp / 2), (w / 2, dp / 2), (-w / 2, dp / 2)]
        pts = [(cx + x * co - y * si, cy + x * si + y * co) for x, y in cs]
        b = self.b
        rid = rnd.random()
        tc = (*tint, 1) if tint else (0, 0, 0, 0)
        for i in range(4):
            (ax, ay), (bx, by) = pts[i], pts[(i + 1) % 4]
            face_lum = lum * (1.0 if i % 2 == 0 else .55)  # 側面は暗い。棟の面が読める
            L = math.hypot(bx - ax, by - ay)
            u0, v0 = rnd.randrange(8) / 8.0, rnd.randrange(8) / 8.0
            k = len(b.v)
            b.v += [(ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1)]
            b.face((k, k + 1, k + 2, k + 3), [(u0, v0), (u0 + L / tile, v0), (u0 + L / tile, v0 + (z1 - z0) / tile), (u0, v0 + (z1 - z0) / tile)], 0, False)
            self.loop(4, (rid, face_lum), dens, tc, wall * (1.0 if i % 2 == 0 else .45))
        k = len(b.v)
        if cap == 'slant':  # 左肩が高く、右へ斜めに切れた屋根
            lo = z1 - w * .75
            for i in range(1, 3):  # 右の 2 本の角を下げる
                for q in range(len(b.v)):
                    if abs(b.v[q][0] - pts[i][0]) < 1e-4 and abs(b.v[q][2] - z1) < 1e-4:
                        b.v[q] = (b.v[q][0], b.v[q][1], lo)
            b.v += [(pts[0][0], pts[0][1], z1), (pts[1][0], pts[1][1], lo), (pts[2][0], pts[2][1], lo), (pts[3][0], pts[3][1], z1)]
            b.face((k, k + 1, k + 2, k + 3), [(0, 0)] * 4, 1, False)
            self.loop(4, (0, 0), (0, 0), (0, 0, 0, 0))
        elif cap == 'peak':  # 尖った屋根。窓のない暗い面
            top = (cx, cy, z1 + w * .78)
            for i in range(4):
                k = len(b.v)
                b.v += [(*pts[i], z1), (*pts[(i + 1) % 4], z1), top]
                b.face((k, k + 1, k + 2), [(0, 0)] * 3, 1, False)
                self.loop(3, (0, 0), (0, 0), (0, 0, 0, 0))
        else:
            b.v += [(x, y, z1) for x, y in pts]
            b.face((k, k + 1, k + 2, k + 3), [(0, 0)] * 4, 1, False)
            self.loop(4, (0, 0), (0, 0), (0, 0, 0, 0))

    def obj(self, name, mats):
        me = self.b.mesh(name, mats)
        me.uv_layers.new(name='S').uv.foreach_set('vector', [x for p in self.s for x in p])
        me.uv_layers.new(name='D').uv.foreach_set('vector', [x for p in self.d for x in p])
        me.uv_layers.new(name='W').uv.foreach_set('vector', [x for p in self.w for x in p])
        ca = me.color_attributes.new('Tint', 'FLOAT_COLOR', 'CORNER')
        ca.data.foreach_set('color', [x for p in self.t for x in p])
        o = add(name, me)
        for a in ('visible_shadow', 'visible_diffuse'):
            setattr(o, a, False)
        return o


# 目標の画素で置く看板: (左, 右, 上, 下, 奥行き, 色)
SIGNS = [(285, 298, 400, 475, 516, 'm'), (335, 350, 480, 600, 465, 'm'), (323, 328, 620, 700, 465, 'm'), (748, 756, 535, 640, 495, 'c'), (551, 558, 540, 580, 655, 'c'),
         (668, 682, 263, 275, 615, 'c'), (461, 472, 650, 693, 375, 'r'), (486, 497, 660, 690, 405, 'c'), (456, 474, 742, 800, 175, 'i'), (432, 448, 740, 752, 175, 'm'), (415, 443, 574, 583, 425, 'c'),
         (388, 445, 513, 522, 425, 'm'), (646, 652, 686, 726, 355, 'm'), (725, 733, 590, 640, 495, 'c'), (535, 545, 606, 636, 295, 'g'), (880, 886, 505, 540, 615, 'c'),
         (205, 240, 690, 700, 150, 'g'), (650, 670, 730, 740, 140, 'g')]
NEON_U = {'m': (.015, .183), 'c': (.35,), 'i': (.515,), 'r': (.68,), 'g': (.85,)}  # signs.png の看板の左端
NEON_W = .137  # 看板 1 枚の幅。高さは 1
# 目標の画素で置くアンテナ: (x, 先端の y, 根元の y, 奥行き)
ANTENNAS = [(620, 197, 252, 620), (632, 184, 252, 620), (641, 200, 252, 620), (550, 375, 400, 660), (716, 412, 450, 610), (740, 440, 470, 610)]
# 街の隙間のにじみ: (x px, y px, 奥行き, 幅 m, 高さ m, 色, 強さ)
GLOWS = [(290, 432, 495, 70, 70, (1, .15, .6, 1), .12), (466, 670, 165, 30, 22, (1, .25, .08, 1), .2), (340, 640, 280, 30, 60, (1, .12, .6, 1), .1), (752, 590, 280, 30, 50, (.1, .7, 1, 1), .1)]


def box_px(x0, x1, ytop, d):
    """target の画素の範囲から、手前の面が奥行き d にある塔の中心の x、手前の y、幅、頂上を求める"""
    a, c = P(x0, 0, d), P(x1, 0, d)
    return (a[0] + c[0]) / 2, a[1], c[0] - a[0], P(0, ytop, d)[2]


# 目標の街の並び: (左 px, 右 px, 頂上 py, 奥行き, 窓の画像, 明るさ, 窓の色, 窓の点灯率, 階の点灯率, 屋根)
SKYLINE = [
    (572, 693, 252, 620, 'f_tower', 1.5, None, 1, 1, 'flat'),
    (562, 693, 545, 600, 'f_tower', 1.4, None, 1, 1, 'flat'),
    (482, 526, 456, 560, 'f_warm', .9, PALE, 1, .9, 'peak'),
    (545, 572, 400, 660, 'f_blue', 1.2, None, 1, 1, 'flat'),
    (700, 752, 450, 610, 'f_blue', 1.2, None, 1, 1, 'flat'),
    (725, 775, 525, 500, 'f_blue', 1.1, None, .9, 1, 'flat'),
    (825, 898, 475, 620, 'f_blue', 1.0, None, .8, .9, 'flat'),
    (252, 300, 402, 520, 'f_blue', 1.0, None, .9, .9, 'flat'),
    (300, 362, 405, 520, 'f_blue', 1.1, None, 1, 1, 'flat'),
    (208, 308, 458, 450, 'f_warm', .95, None, .85, .85, 'flat'),
    (305, 362, 470, 470, 'f_navy', .7, None, .7, .7, 'flat'),
    (388, 445, 513, 430, 'f_warm', 1.0, PALE, .85, .9, 'flat'),
    (362, 392, 545, 440, 'f_navy', .6, None, .6, .7, 'flat'),
    (350, 445, 600, 340, 'f_warm', .75, PALE, .55, .7, 'flat'),
    (442, 462, 538, 400, 'f_blue', .9, None, .8, .8, 'flat'),
    (462, 482, 572, 380, 'f_navy', .6, None, .6, .6, 'flat'),
    (482, 500, 552, 410, 'f_blue', .9, None, .8, .8, 'flat'),
    (497, 545, 610, 300, 'f_warm', 1.2, None, .9, .95, 'flat'),
    (540, 590, 575, 320, 'f_tan', .9, None, .7, .8, 'flat'),
    (590, 650, 575, 340, 'f_warm', 1.0, PALE, .9, .9, 'flat'),
    (648, 700, 590, 360, 'f_blue', 1.0, None, .8, .9, 'flat'),
    (175, 280, 645, 260, 'f_warm', .95, PALE, .8, .85, 'flat'),
    (655, 730, 640, 240, 'f_warm', 1.0, None, .85, .9, 'flat'),
    (800, 845, 650, 300, 'f_blue', 1.0, None, .8, .9, 'flat'),
    (820, 870, 600, 420, 'f_blue', .9, None, .8, .8, 'flat'),
    (192, 212, 530, 520, 'f_blue', 1.0, None, 1, 1, 'flat'),
    (150, 200, 600, 440, 'f_blue', .8, None, .7, .8, 'flat'),
    (80, 170, 590, 500, 'f_warm', .8, PALE, .7, .8, 'flat'),
    (-40, 90, 560, 520, 'f_blue', .9, None, .8, .8, 'flat'),
    (895, 960, 610, 400, 'f_warm', .8, None, .7, .8, 'flat'),
    # 手すりの向こうの低い棟。壁が見えて、窓がまばらに灯る
    (60, 178, 735, 120, 'f_warm', 1.0, None, .75, .8, 'flat'),
    (178, 225, 698, 90, 'f_tan', .7, None, .6, .7, 'flat'),
    (225, 300, 748, 170, 'f_warm', 1.0, None, .75, .8, 'flat'),
    (300, 372, 722, 190, 'f_apart', .8, None, .5, .6, 'flat'),
    (340, 400, 688, 230, 'f_navy', .5, None, .4, .5, 'flat'),
    (372, 430, 765, 120, 'f_warm', .7, None, .5, .6, 'flat'),
    (430, 500, 738, 180, 'f_tan', .75, None, .55, .7, 'flat'),
    (500, 565, 758, 130, 'f_apart', .8, None, .5, .6, 'flat'),
    (565, 640, 716, 200, 'f_warm', 1.0, None, .75, .8, 'flat'),
    (640, 700, 748, 150, 'f_warm', 1.0, None, .75, .8, 'flat'),
    (700, 765, 702, 220, 'f_warm', 1.0, None, .75, .8, 'flat'),
    (760, 850, 738, 160, 'f_tan', .7, None, .5, .6, 'flat'),
]


def city(keys):
    rng = random.Random(11)
    towers = {k: Tower() for k in FACADES}
    masts = B()
    beacons = [[], []]

    def tower(cx, cy, w, dp, z1, name, lum, yaw, dist, px_row=6.0, tint=None, dens=(1, 1), cap='flat', step=False, wall=0.0):
        """px_row は target の焦点距離での 1 階の高さ(px)。遠くても階の列が読める大きさにする"""
        tile = FACADES[name][1] * px_row / F_PX * dist  # 帯の窓の画像は階が少ないので縦を詰める
        tw = towers[name]
        tw.add(cx, cy, w, dp, -72.0, z1, yaw, tile, rng, lum, dens, tint, cap, wall)
        if step:
            tw.add(cx + w * .08, cy, w * .62, dp * .62, z1 - 1, z1 + w * .4, yaw, tile, rng, lum, dens, tint, 'flat', wall)
            z1 += w * .4
        return z1

    for x0_, x1_, top, d, name, lum, tint, dw, df, cap in SKYLINE:
        cx, cy, w, z1 = box_px(x0_, x1_, top, d)
        dp = w * rng.uniform(.8, 1.1)
        step = d <= 360 and cap == 'flat' and rng.random() < .6  # 手前の棟は屋上が段になる
        if step:
            z1 -= w * .4
        z2 = tower(cx, cy + dp / 2, w, dp, z1, name, lum, 0.0 if x1_ - x0_ > 100 else rng.uniform(-.06, .06), d, 9.0 if name == 'f_tower' else ROW_PX if d > 200 else ROW_PX * 1.3, tint, (dw, df), cap, step, .38 if d <= 260 else .12 if d <= 360 else 0.0)
        if d <= 360:  # 屋上の機械室
            masts.box((cx - w * .2, cy + dp * .6, z2 + .9), (w * .16, w * .16, 1.8), 0)
    beacons[0] += [P(585, 262, 620), P(680, 262, 620)]  # 主塔の屋根の角の赤い灯
    for px, top, base, d in ANTENNAS:
        p0, p1 = P(px, base, d), P(px, top, d)
        masts.tube([(p0[0], p0[1] + 1, p0[2]), (p1[0], p1[1] + 1, p1[2])], .0005 * d, 5, 0)
        beacons[rng.randrange(2)].append((p1[0], p1[1] + 1, p1[2]))
    for ang_span, n, r0, r1, h0, h1, mix in (
        # 周りの街: (方位の範囲, 数, 距離, 高さ, 窓の画像)。細く高い塔を遠くに多く置く
        (((-180, 180),), 90, 60, 150, -30, -3, ('f_apart', 'f_warm', 'r_sparse')),
        (((-180, -28), (28, 180)), 130, 240, 420, 5, 60, ('f_apart', 'f_warm', 'f_mixed', 'f_tan', 'f_cool')),
        (((-180, -33), (33, 180)), 320, 420, 780, 60, 300, ('f_navy', 'r_navy', 'f_cool', 'r_warm', 'f_warm', 'r_sparse', 'f_mixed', 'r_ice')),
        (((-33, 33),), 90, 640, 800, 70, 215, ('f_blue', 'f_navy', 'f_blue', 'r_ice')),
        (((-33, 33),), 140, 430, 640, 40, 120, ('f_blue', 'f_navy', 'f_blue', 'f_cool', 'r_sparse', 'f_warm')),
    ):
        for _ in range(n):
            a0, a1 = rng.choice(ang_span)
            az = math.radians(rng.uniform(a0, a1))
            r = rng.uniform(r0, r1)
            cx, cy = r * math.sin(az), r * math.cos(az)
            w = rng.uniform(.05, .08) * r
            z1 = rng.uniform(h0, h1)
            if abs(a0) < 40 and a1 < 40:  # 正面は手で置いた塔を隠さない高さにする
                w = rng.uniform(16, 36)
                z1 = min(z1, r * rng.uniform(.14, .3))
            elif z1 > 0:  # 周りも空が見える高さにする
                z1 = min(z1, r * rng.uniform(.1, .34))
            name = rng.choice(mix)
            tint = rng.choice((None, None, COOL, COOL, ICE, ROSE, PALE, WARM_T))
            z2 = tower(cx, cy, w, w * rng.uniform(.8, 1.2), z1, name, rng.uniform(.5, 1.0), -az + rng.uniform(-.2, .2), r, rng.uniform(.9, 1.2) * ROW_PX, tint, (rng.uniform(.6, 1), rng.uniform(.45, 1)), 'flat', z1 > 50 and rng.random() < .5)
            if z2 > 45:  # 屋上の小さな箱とアンテナ
                bx, by = cx + rng.uniform(-.2, .2) * w, cy + rng.uniform(-.2, .2) * w
                masts.box((bx, by, z2 + 2), (w * .2, w * .2, 4), 0)
                if rng.random() < .35:
                    h = rng.uniform(.3, .8) * min(w, 45)
                    masts.tube([(bx, by, z2), (bx, by, z2 + h)], max(.2, r * .0005), 5, 0)
                    if z2 > 90:
                        beacons[rng.randrange(2)].append((bx, by, z2 + h))
    roof_m = pbr('NeighborRoof', (.02, .022, .03, 1), .7)
    for name, tw in towers.items():
        cols, rows = FACADES[name]
        tw.obj('City_' + name, [facade_mat(name, cols, rows, keys), roof_m])
    masts.obj('Masts', [pbr('Mast', (.01, .01, .012, 1), .5, .6)]).visible_shadow = False
    # 看板
    nmats = {}
    for col, k in (('m', 2.0), ('c', 1.5), ('r', 1.2), ('g', 1.4), ('i', 1.5)):
        m, nt, out = mat_base('Neon_' + col)
        t = tex_node(nt, image('signs.png'))
        uv = nt.nodes.new('ShaderNodeUVMap')
        uv.uv_map = 'UVMap'
        nt.links.new(uv.outputs[0], t.inputs[0])
        e = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(t.outputs[0], e.inputs[0])
        e.inputs[1].default_value = k
        nt.links.new(e.outputs[0], out.inputs[0])
        m.cycles.emission_sampling = 'NONE'
        nmats[col] = m
        keys['neon'].append(e.inputs[1])
    b = B()
    order = 'mcrgi'

    def sign_uv(col, w, h):
        """看板 1 枚の中から、面の縦横比に合う範囲を選ぶ"""
        u0 = rng.choice(NEON_U[col])
        span = min(1.0, .205 * h / max(w, 1e-3))
        v0 = rng.uniform(.03, 1.0 - span) if span < .94 else .03
        return [(u0, v0), (u0 + NEON_W, v0), (u0 + NEON_W, v0 + span), (u0, v0 + span)]

    for x0_, x1_, y0_, y1_, d, col in SIGNS:
        a, c = P(x0_, y1_, d), P(x1_, y0_, d)
        k = len(b.v)
        b.v += [a, (c[0], a[1], a[2]), c, (a[0], a[1], c[2])]
        b.face((k, k + 1, k + 2, k + 3), sign_uv(col, x1_ - x0_, y1_ - y0_), order.index(col), False)
    for _ in range(70):  # 周りの塔の短い看板
        az, r = rng.uniform(0, TAU), rng.uniform(150, 560)
        if abs(((az + math.pi) % TAU) - math.pi) < .62:
            continue
        cx, cy = r * math.sin(az), r * math.cos(az)
        z0, hh = rng.uniform(-10, .1 * r), rng.uniform(8, 26)
        k = len(b.v)
        ux, uy = math.cos(az) * 2.4, -math.sin(az) * 2.4
        b.v += [(cx, cy, z0), (cx + ux, cy + uy, z0), (cx + ux, cy + uy, z0 + hh), (cx, cy, z0 + hh)]
        col = rng.choice('mc')
        b.face((k, k + 1, k + 2, k + 3), sign_uv(col, 2.4, hh), order.index(col), False)
    o = b.obj('Neon', [nmats[c_] for c_ in order])
    o.visible_shadow = False
    o.visible_diffuse = False
    for i, pts in enumerate(beacons):
        m = emis(f'Beacon{i}', (1, .03, .02, 1), 40)
        h = instance_verts(f'Beacons{i}', pts, sphere_mesh(f'Beacon{i}', .75, m, 1))
        h.children[0].visible_shadow = False
        keys['beacon'].append(m.node_tree.nodes['Emission'].inputs[1])
    ring(880, -30, 210, 'city_far_a.png', 'FarCity', 1.5)
    glows(rng)
    g = B()
    g.grid([[(-950, -950, -72), (950, -950, -72)], [(-950, 950, -72), (950, 950, -72)]], us=7, vs=7)
    m, nt, out = mat_base('Street')
    t = tex_node(nt, image('street.png'))
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[1].default_value = .7
    nt.links.new(t.outputs[0], e.inputs[0])
    nt.links.new(e.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    o = g.obj('Street', [m])
    o.visible_shadow = o.visible_diffuse = False


def glow_mat(name, col, k):
    """四角の中央が明るく端で消える光の膜。透明のまま光を足す"""
    m, nt, out = mat_base(name)
    N = nt.nodes
    uv = N.new('ShaderNodeUVMap')
    uv.uv_map = 'UVMap'
    v = N.new('ShaderNodeVectorMath')
    v.operation = 'DISTANCE'
    nt.links.new(uv.outputs[0], v.inputs[0])
    v.inputs[1].default_value = (.5, .5, 0)
    f = ramp(nt, v.outputs['Value'], 0, .5, 1, 0, True)
    e = N.new('ShaderNodeEmission')
    e.inputs[0].default_value = col
    nt.links.new(math_(nt, 'MULTIPLY', f, k), e.inputs[1])
    tr = N.new('ShaderNodeBsdfTransparent')
    ad = N.new('ShaderNodeAddShader')
    nt.links.new(tr.outputs[0], ad.inputs[0])
    nt.links.new(e.outputs[0], ad.inputs[1])
    nt.links.new(ad.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def glows(rng):
    """街の隙間のにじみ。低い所に金、青、桃の光の膜を全周に立てる"""
    cols = ((1, .55, .2, 1), (1, .55, .2, 1), (.2, .45, 1, 1), (1, .2, .65, 1))
    mats = [glow_mat(f'Glow{i}', c, .075) for i, c in enumerate(cols)]
    b = [B() for _ in cols]
    for _ in range(170):
        az, r = rng.uniform(0, TAU), rng.uniform(110, 620)
        w, h = rng.uniform(.4, .9) * r * .45, rng.uniform(.1, .22) * r
        cx, cy, z = r * math.sin(az), r * math.cos(az), rng.uniform(-.02, .06) * r
        ux, uy = math.cos(az) * w / 2, -math.sin(az) * w / 2
        b[rng.randrange(4)].grid([[(cx - ux, cy - uy, z - h / 2), (cx + ux, cy + uy, z - h / 2)], [(cx - ux, cy - uy, z + h / 2), (cx + ux, cy + uy, z + h / 2)]])
    for i, x in enumerate(b):
        o = x.obj(f'Glows{i}', [mats[i]])
        o.visible_shadow = o.visible_diffuse = False
    # 目標の看板の周りのにじみ
    t = B()
    gm, k = [], 0
    for x_, y_, d, w, h, c, s_ in GLOWS:
        q = P(x_, y_, d)
        t.grid([[(q[0] - w / 2, q[1], q[2] - h / 2), (q[0] + w / 2, q[1], q[2] - h / 2)], [(q[0] - w / 2, q[1], q[2] + h / 2), (q[0] + w / 2, q[1], q[2] + h / 2)]], mat=k)
        gm.append(glow_mat(f'SignGlow{k}', c, s_))
        k += 1
    o = t.obj('SignGlows', gm)
    o.visible_shadow = o.visible_diffuse = False


def plate(name, img, k):
    m, nt, out = mat_base(name)
    N = nt.nodes
    t = tex_node(nt, image(img), 'MIRROR')
    t.image.alpha_mode = 'STRAIGHT'
    e = N.new('ShaderNodeEmission')
    e.inputs[1].default_value = k
    nt.links.new(t.outputs[0], e.inputs[0])
    tr = N.new('ShaderNodeBsdfTransparent')
    mx = N.new('ShaderNodeMixShader')
    nt.links.new(t.outputs[1], mx.inputs[0])
    nt.links.new(tr.outputs[0], mx.inputs[1])
    nt.links.new(e.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def ring(r, z0, z1, img, name, k):
    b = B()
    n = 96
    rows = [[(r * math.cos(TAU * j / n), r * math.sin(TAU * j / n), z) for j in range(n + 1)] for z in (z0, z1)]
    b.grid(rows, us=4)
    o = b.obj(name, [plate(name, img, k)])
    o.visible_shadow = o.visible_diffuse = False
    return o


def shell(name, r, el0, el1, us, mat):
    """空の殻。uv の v は el0 から el1 まで。空と雲に使う"""
    n, rows_n = 96, 16
    rows = []
    for i in range(rows_n + 1):
        el = math.radians(el0 + (el1 - el0) * i / rows_n)
        rows.append([(r * math.cos(el) * math.cos(TAU * j / n), r * math.cos(el) * math.sin(TAU * j / n), r * math.sin(el)) for j in range(n + 1)])
    b = B()
    b.grid(rows, us=us)
    o = b.obj(name, [mat])
    o.visible_shadow = o.visible_diffuse = False
    return o


def pano_mat(name, k, add_=0.0):
    """夜空の写真の板。上の端は透明にして奥の紺へ消す"""
    m, nt, out = mat_base(name)
    N = nt.nodes
    t = tex_node(nt, image('sky_soft.png'))
    uv = N.new('ShaderNodeUVMap')
    uv.uv_map = 'UVMap'
    nt.links.new(uv.outputs[0], t.inputs[0])
    su = N.new('ShaderNodeSeparateXYZ')
    nt.links.new(uv.outputs[0], su.inputs[0])
    a = ramp(nt, su.outputs['Y'], .8, .98, 1, 0)
    e = N.new('ShaderNodeEmission')
    nt.links.new(mixc(nt, 1, mixc(nt, 1, t.outputs[0], SKY_TINT, 'MULTIPLY'), (add_, add_, add_, 1), 'ADD'), e.inputs[0])
    e.inputs[1].default_value = k
    tr = N.new('ShaderNodeBsdfTransparent')
    mx = N.new('ShaderNodeMixShader')
    nt.links.new(a, mx.inputs[0])
    nt.links.new(tr.outputs[0], mx.inputs[1])
    nt.links.new(e.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def sky(keys):
    m, nt, out = mat_base('Sky')
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[0].default_value = SKY_NAVY
    e.inputs[1].default_value = 1.0
    nt.links.new(e.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    shell('Sky', 960, -4, 90, 3, m)
    # 夜空は 1 枚の写真。雲の線が出ないように切り抜かない。床に写す空は暗い別の殻にして、水たまりに街だけが残る
    o = shell('SkyPano', 940, -4, 50, SKY_US, pano_mat('SkyPano', SKY_K, .0113))
    o.visible_glossy = False
    keys['clouds'].append((o, math.radians(SKY_YAW), .22))
    o = shell('SkyMirror', 930, -4, 50, SKY_US, pano_mat('SkyMirror', SKY_K * SKY_MIRROR))
    o.visible_camera = False
    keys['clouds'].append((o, math.radians(SKY_YAW), .22))
    w = bpy.data.worlds.new('W')
    w.use_nodes = True
    bg = next(x for x in w.node_tree.nodes if x.type == 'BACKGROUND')
    bg.inputs[0].default_value = (.05, .05, .085, 1)  # 暗部を紫がかった灰に持ち上げる環境光
    bg.inputs[1].default_value = 1.0
    bpy.context.scene.world = w


# ---- 床 ----
def mix_f(nt, fac, a, b):
    n = nt.nodes.new('ShaderNodeMix')
    n.data_type = 'FLOAT'
    link(nt, fac, n.inputs[0])
    link(nt, a, n.inputs[2])
    link(nt, b, n.inputs[3])
    return n.outputs[0]


def floor_material():
    """濡れた荒いコンクリート。床全体の図(水の量、水たまり、亀裂)と細かい高さの画像を比べ、骨材の粒ごとに濡れと乾きが分かれる。
    濡れた面は鏡に近く、乾いた面は黒く粗い。濡れた面の細かい凹凸は視線の水平方向にだけ法線を傾けるので、反射は左右へ揺れず縦に切れる。
    水たまりの中は法線を傾けない。亀裂は線を描かず、高さと濡れの差だけで見せる"""
    m, nt, out = mat_base('Concrete')
    N, L = nt.nodes, nt.links
    b = N.new('ShaderNodeBsdfPrincipled')
    L.new(b.outputs[0], out.inputs[0])
    geo = N.new('ShaderNodeNewGeometry')
    pos = geo.outputs['Position']

    def smp(img, k, rot=0.0, data=True):
        t = tex_node(nt, image(img, data=data))
        L.new(scale_pos(nt, pos, k, rot), t.inputs[0])
        return t.outputs[0]

    si = N.new('ShaderNodeSeparateXYZ')
    L.new(geo.outputs['Incoming'], si.inputs[0])
    ti = N.new('ShaderNodeCombineXYZ')
    L.new(si.outputs['X'], ti.inputs[0])
    L.new(si.outputs['Y'], ti.inputs[1])
    tn_ = N.new('ShaderNodeVectorMath')
    tn_.operation = 'NORMALIZE'
    L.new(ti.outputs[0], tn_.inputs[0])
    tang = tn_.outputs[0]
    # 床全体の図
    bx = N.new('ShaderNodeSeparateXYZ')
    L.new(pos, bx.inputs[0])
    cu = N.new('ShaderNodeCombineXYZ')
    L.new(math_(nt, 'DIVIDE', math_(nt, 'SUBTRACT', bx.outputs['X'], X0 - .5), X1 - X0 + 1), cu.inputs[0])
    L.new(math_(nt, 'DIVIDE', math_(nt, 'SUBTRACT', bx.outputs['Y'], Y0 - .5), Y1 - Y0 + 1), cu.inputs[1])
    tm_ = tex_node(nt, image('floor_map.png', data=True), 'EXTEND')
    L.new(cu.outputs[0], tm_.inputs[0])
    fm = N.new('ShaderNodeSeparateColor')
    L.new(tm_.outputs[0], fm.inputs[0])
    level, pool, crk = fm.outputs[0], fm.outputs[1], fm.outputs[2]
    # 細かい高さと粗さ
    h1 = smp('wc_height.png', 1 / .8)
    h2 = smp('wc_height.png', 1 / .27, 1.1)
    rg = smp('wc_rough.png', 1 / 1.1, .6)
    rg2 = smp('wc_rough.png', 1 / .33, 2.0)
    agg = math_(nt, 'ADD', math_(nt, 'MULTIPLY', h1, .55), math_(nt, 'MULTIPLY', h2, .45))
    # 骨材の頭が水を破る。粒の細かさで濡れと乾きが分かれる
    th = math_(nt, 'ADD', level, math_(nt, 'MULTIPLY', math_(nt, 'SUBTRACT', .5, agg), WET_GRAIN))
    far = ramp(nt, bx.outputs['Y'], -.5, 3.5, 0, 1)
    th = math_(nt, 'ADD', th, math_(nt, 'MULTIPLY', math_(nt, 'MULTIPLY', math_(nt, 'SUBTRACT', .5, smp('wc_height.png', 1 / 1.7, .5)), far), FAR_BREAK))
    wet = ramp(nt, th, .4, .6, 0, 1)  # 少し幅を持たせ、中間の明るさを残す
    pool = ramp(nt, pool, .04, .3, 0, 1)  # 水の中は同じ鏡
    wet = math_(nt, 'MAXIMUM', math_(nt, 'MULTIPLY', wet, ramp(nt, crk, .12, .5, 1, 0)), pool)
    # 光の粒: 反射の向きで光の図を読み、骨材の頭にだけ掛ける。水の中には掛からない
    rx, ry = math_(nt, 'MULTIPLY', si.outputs['X'], -1.0), math_(nt, 'MULTIPLY', si.outputs['Y'], -1.0)
    ce = N.new('ShaderNodeCombineXYZ')
    L.new(math_(nt, 'DIVIDE', math_(nt, 'ADD', math_(nt, 'DIVIDE', rx, ry), .5), 1.1), ce.inputs[0])
    L.new(math_(nt, 'DIVIDE', math_(nt, 'DIVIDE', si.outputs['Z'], ry), .85), ce.inputs[1])
    te = tex_node(nt, image('floor_refl.png', data=True), 'CLIP')
    L.new(ce.outputs[0], te.inputs[0])
    glint = math_(nt, 'MULTIPLY', ramp(nt, math_(nt, 'ADD', math_(nt, 'MULTIPLY', h2, .7), math_(nt, 'MULTIPLY', rg2, .3)), .67, .72, 0, 1), ramp(nt, level, .36, .6, .08, 1))  # 頭の高い粒だけ。乾いた面では弱い
    glint = math_(nt, 'MULTIPLY', math_(nt, 'MULTIPLY', glint, ramp(nt, ry, .02, .12, 0, 1)), math_(nt, 'MULTIPLY', math_(nt, 'SUBTRACT', 1.0, pool), ramp(nt, crk, .1, .5, 1, 0)))
    L.new(mixc(nt, glint, (0, 0, 0, 1), te.outputs[0]), b.inputs['Emission Color'])
    b.inputs['Emission Strength'].default_value = GLINT_K
    # 視線の水平方向の傾き
    n1 = N.new('ShaderNodeSeparateColor')
    L.new(smp('floor_n.png', 1 / .8), n1.inputs[0])
    n2 = N.new('ShaderNodeSeparateColor')
    L.new(smp('floor_n.png', 1 / .27, 1.1), n2.inputs[0])
    dn = N.new('ShaderNodeCombineXYZ')
    L.new(math_(nt, 'ADD', math_(nt, 'SUBTRACT', n1.outputs[0], .5), math_(nt, 'MULTIPLY', math_(nt, 'SUBTRACT', n2.outputs[0], .5), .7)), dn.inputs[0])
    L.new(math_(nt, 'ADD', math_(nt, 'SUBTRACT', n1.outputs[1], .5), math_(nt, 'MULTIPLY', math_(nt, 'SUBTRACT', n2.outputs[1], .5), .7)), dn.inputs[1])
    dot = N.new('ShaderNodeVectorMath')
    dot.operation = 'DOT_PRODUCT'
    L.new(dn.outputs[0], dot.inputs[0])
    L.new(tang, dot.inputs[1])
    sc = N.new('ShaderNodeVectorMath')
    sc.operation = 'SCALE'
    L.new(tang, sc.inputs[0])
    L.new(math_(nt, 'MULTIPLY', math_(nt, 'MULTIPLY', dot.outputs['Value'], FLOOR_BEND), math_(nt, 'SUBTRACT', 1.0, pool)), sc.inputs['Scale'])
    ad = N.new('ShaderNodeVectorMath')
    ad.inputs[0].default_value = (0, 0, 1)
    L.new(sc.outputs[0], ad.inputs[1])
    nz = N.new('ShaderNodeVectorMath')
    nz.operation = 'NORMALIZE'
    L.new(ad.outputs[0], nz.inputs[0])
    bent = nz.outputs[0]
    # 色
    a1 = smp('concrete_albedo.png', 1 / 1.3, data=False)
    a2 = smp('concrete_albedo.png', 1 / 4.7, .9, data=False)
    alb = mixc(nt, .5, a1, a2, 'MULTIPLY')
    gbw = N.new('ShaderNodeRGBToBW')
    L.new(alb, gbw.inputs[0])
    dry = mixc(nt, 1, gbw.outputs[0], DRY_TINT, 'MULTIPLY')
    col = mixc(nt, wet, dry, mixc(nt, pool, FILM_COLOR, POOL_COLOR))
    col = mixc(nt, 1, col, mixc(nt, ramp(nt, crk, .1, .5, 0, 1), (1, 1, 1, 1), (.04, .04, .04, 1)), 'MULTIPLY')
    L.new(col, b.inputs['Base Color'])
    L.new(math_(nt, 'MULTIPLY', wet, .95), b.inputs['Metallic'])
    # 粗さ: 乾いた面は荒く、濡れた面も画像で高い周波数に揺らす。水たまりだけが鏡
    r_dry = mix_f(nt, ramp(nt, h2, .66, .74, 0, 1), ramp(nt, rg, .2, .8, .42, .74, False), .09)  # 骨材の頭だけ光る粒になる
    r_wet = math_(nt, 'ADD', .04, math_(nt, 'MULTIPLY', math_(nt, 'MULTIPLY', ramp(nt, rg, .25, .8, 0, 1), ramp(nt, rg2, .2, .8, .35, 1)), ROUGH_WET))
    L.new(mix_f(nt, wet, r_dry, mix_f(nt, pool, r_wet, .012)), b.inputs['Roughness'])
    b.inputs['Specular IOR Level'].default_value = .6  # 乾いた骨材の頭も光る
    L.new(tang, b.inputs['Tangent'])
    L.new(math_(nt, 'MULTIPLY', .8, math_(nt, 'SUBTRACT', 1.0, pool)), b.inputs['Anisotropic'])
    # 高さ: 乾いた面だけ全方向の凹凸を持つ。亀裂の溝はどの面にも効く
    relief = math_(nt, 'MULTIPLY', math_(nt, 'ADD', math_(nt, 'MULTIPLY', h1, .7), math_(nt, 'MULTIPLY', h2, .5)), math_(nt, 'SUBTRACT', 1.0, wet))
    L.new(bump(nt, math_(nt, 'SUBTRACT', relief, math_(nt, 'MULTIPLY', crk, .8)), 1.0, .006, bent), b.inputs['Normal'])
    m.cycles.emission_sampling = 'NONE'
    return m


def floor(mats):
    """床は高さの配列からメッシュにする。亀裂の溝だけが沈む。水膜は材質の中で作る"""
    h = np.load(ASSETS / 'floor_h.npy').astype(np.float32)
    ny, nx = h.shape
    xs = np.linspace(X0 - .5, X1 + .5, nx, dtype=np.float32)
    ys = np.linspace(Y0 - .5, Y1 + .5, ny, dtype=np.float32)
    gx, gy = np.meshgrid(xs, ys)
    co = np.stack([gx, gy, h], -1).reshape(-1)
    me = bpy.data.meshes.new('Floor')
    me.vertices.add(nx * ny)
    me.vertices.foreach_set('co', co)
    nq = (nx - 1) * (ny - 1)
    idx = np.arange(nx * ny, dtype=np.int32).reshape(ny, nx)
    q = np.stack([idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]], -1).reshape(-1)
    me.loops.add(nq * 4)
    me.loops.foreach_set('vertex_index', q)
    me.polygons.add(nq)
    me.polygons.foreach_set('loop_start', np.arange(nq, dtype=np.int32) * 4)
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', np.ones(nq, dtype=bool))
    me.materials.append(floor_material())
    add('Floor', me)


# ---- 屋上の物 ----
def parapet(mats):
    """縁の立ち上がりと手すりを 4 辺に回す。屋上の外の壁は街の高さまで下ろす"""
    c = B()
    H, T = .22, .3
    c.box(((X0 + X1) / 2, Y1 + T / 2, H / 2 - .05), (X1 - X0 + 2 * T, T, H + .1))
    c.box(((X0 + X1) / 2, Y0 - T / 2, H / 2 - .05), (X1 - X0 + 2 * T, T, H + .1))
    c.box((X0 - T / 2, (Y0 + Y1) / 2, H / 2 - .05), (T, Y1 - Y0, H + .1))
    c.box((X1 + T / 2, (Y0 + Y1) / 2, H / 2 - .05), (T, Y1 - Y0, H + .1))
    # 建物の外壁
    c.box(((X0 + X1) / 2, (Y0 + Y1) / 2, -36.1), (X1 - X0 + 2 * T, Y1 - Y0 + 2 * T, 72))
    c.obj('Parapet', [mats['wall']])
    r = B()
    top = 1.25

    def run(a, b):
        L = (Vector(b) - Vector(a)).length
        cnt = max(1, round(L / 2.05))
        for i in range(cnt + 1):
            p = Vector(a).lerp(Vector(b), i / cnt)
            r.tube([(p.x, p.y, H), (p.x, p.y, top)], .042, 8)
            r.lathe([(.07, H), (.07, H + .012), (.034, H + .03)], 10, (p.x, p.y, 0))
            if i < cnt:  # 細い柱
                q = Vector(a).lerp(Vector(b), (i + .5) / cnt)
                r.tube([(q.x, q.y, H), (q.x, q.y, top)], .02, 6)
        for z, rad in ((top, .05), (.92, .028), (.56, .028)):
            r.tube([(a[0], a[1], z), (b[0], b[1], z)], rad, 10)

    for a, b in RAILS:
        run(a, b)
    r.obj('Rail', [mats['rail']])


RAILS = [((X0 - .15, Y1 + .15), (3.2, Y1 + .15)), ((X0 - .15, Y0 - .15), (X1 + .15, Y0 - .15)), ((X0 - .15, Y0 - .15), (X0 - .15, Y1 + .15)), ((X1 + .15, Y0 - .15), (X1 + .15, 3.9))]


def water_tank(mats):
    """給水塔。タンクの中心は画面の左端に来る。4 列 2 行の脚、上と下の水平材、高さ全部に渡る大きな X、足場、はしご"""
    cx, cy = -4.48, 5.0
    R = 1.56
    Z0 = 3.47
    Z1 = 5.72
    t = B()
    prof = [(0.02, Z0 - .1), (R * .98, Z0 - .1)]
    for z in np.linspace(Z0, Z1, 9):
        prof.append((R, float(z)))
    prof += [(R + .03, Z1 + .02), (R * .4, Z1 + .2), (.16, Z1 + .24), (.16, Z1 + .3), (.02, Z1 + .31)]
    t.lathe(prof, 96, (cx, cy, 0), 0, us=4)
    for z in (Z0 + .1, Z0 + .85, Z0 + 1.6, Z1 - .04):  # 帯
        t.tube([(cx + (R + .012) * math.cos(TAU * i / 96), cy + (R + .012) * math.sin(TAU * i / 96), z) for i in range(96)], .011, 6, 1, True)
    # 蓋の取っ手
    t.tube(bend([(cx + .55, cy - 1.3, Z1 + .03), (cx + .55, cy - 1.3, Z1 + .24), (cx + 1.2, cy - .85, Z1 + .24), (cx + 1.2, cy - .85, Z1 + .03)], .06), .014, 6, 1)
    t.obj('Tank', [mats['tank'], mats['frame']])
    f = B()
    # 手前の列の x は target の柱の位置。奥の列は手前の柱の真後ろに見える位置へ寄せる
    front, back = (-5.85, -4.25, -3.43, -2.63), (-7.5, -5.5, -4.54, -3.48)
    ys = (3.75, 6.3)
    ped = .87
    legs = [(x, ys[0]) for x in front] + [(x, ys[1]) for x in back]
    top = Z0 - .2
    for x, y in legs:
        f.box((x, y + .15 if y == ys[0] else y, ped / 2), (.47, .34, ped), 1)
        f.box((x, y, ped + .03), (.3, .3, .06), 0)
        for dx, dy in ((-.1, -.1), (.1, -.1), (.1, .1), (-.1, .1)):
            f.lathe([(.02, ped + .06), (.02, ped + .09), (.002, ped + .1)], 6, (x + dx, y + dy, 0), 0)
        f.beam((x, y, ped), (x, y, top), .12, .12, 0)
    low = 1.25
    for z in (low, top):
        f.beam((front[0] - .3, ys[0], z), (front[-1] + .25, ys[0], z), .08, .11, 0)
        f.beam((back[0], ys[1], z), (back[-1], ys[1], z), .08, .11, 0)
        for a_, c_ in zip(front, back):
            f.beam((a_, ys[0], z), (c_, ys[1], z), .07, .1, 0)
    for row, y in ((front, ys[0]), (back, ys[1])):  # 大きな X
        for x0_, x1_ in zip(row[:-1], row[1:]):
            f.beam((x0_, y, low), (x1_, y, top), .05, .045, 0)
            f.beam((x1_, y, low), (x0_, y, top), .05, .045, 0)
    # 足場。手すりは付けない。右の辺は奥へ斜めに下がり、target で左端に収まる
    x0_, xf, xb, W = -6.2, -2.55, -3.3, 1.7
    y0_, y1_ = cy - W, cy + W
    f.beam((x0_, y0_, top + .05), (xf, y0_, top + .05), .06, .12, 0)
    f.beam((x0_, y1_, top + .05), (xb, y1_, top + .05), .06, .12, 0)
    f.beam((x0_, y0_, top + .05), (x0_, y1_, top + .05), .06, .12, 0)
    f.beam((xf, y0_, top + .05), (xb, y1_, top + .05), .06, .12, 0)
    # はしご: タンクの手前の面と、右の脚
    a = -.89
    lx, ly = cx + (R + .1) * math.sin(a * -1), cy - (R + .1) * math.cos(a)
    ux, uy = math.cos(a), math.sin(a)
    for s_ in (-.14, .14):
        f.tube([(lx + ux * s_, ly - uy * s_, top), (lx + ux * s_, ly - uy * s_, Z1 + .06)], .015, 6, 0)
    for k in range(int((Z1 - top) / .3)):
        z = top + .15 + k * .3
        f.tube([(lx - ux * .14, ly + uy * .14, z), (lx + ux * .14, ly - uy * .14, z)], .011, 5, 0)
    x = front[-1] + .24
    for s_ in (-.16, .16):
        f.tube([(x, ys[0] + s_, ped), (x, ys[0] + s_, top)], .015, 6, 0)
    for k in range(int((top - ped) / .3)):
        f.tube([(x, ys[0] - .16, ped + .15 + k * .3), (x, ys[0] + .16, ped + .15 + k * .3)], .011, 5, 0)
    f.obj('TankFrame', [mats['frame'], mats['wall']])
    # 脚の下の配電箱。扉の線だけ。光らない
    e = B()
    c_, s_ = (-3.03, 4.5, .55), (.62, .4, 1.06)  # 2 つの台の間から見える奥の箱
    e.box(c_, s_, 0)
    e.box((c_[0], c_[1], c_[2] + .53), (.7, .48, .03), 0)
    for dx in (-.15, .15):
        e.box((c_[0] + dx, c_[1] - .205, c_[2]), (.27, .012, .96), 0)
        e.box((c_[0] + dx * .25, c_[1] - .222, c_[2]), (.02, .02, .14), 1)
    e.box((c_[0], c_[1] - .2, .08), (.7, .5, .16), 2)
    c2, s2 = (-5.0, 2.6, .75), (1.0, .5, 1.3)
    e.box(c2, s2, 0)
    e.box((c2[0], c2[1] - .258, c2[2]), (.9, .014, 1.2), 0)
    e.box((c2[0] + .3, c2[1] - .28, c2[2]), (.03, .03, .16), 1)
    e.obj('Boxes', [mats['box'], mats['pipe'], mats['wall']])
    return (-3.05, 3.7, 1.0)


def ac_unit(b, c, yaw, W=1.05, H=1.05, D=.55, stand=.36, fan_dx=0.0, top_grille=False):
    """室外機: 箱、前の丸い枠、羽根、金網、横のスリット、足の台"""
    co, si = math.cos(yaw), math.sin(yaw)

    def T(x, y, z):
        return (c[0] + x * co - y * si, c[1] + x * si + y * co, z)

    for sx in (-1, 1):  # 台
        b['frame'].beam(T(sx * W * .4, -D * .7, .05), T(sx * W * .4, D * .7, .05), .07, .08, 0)
        for sy in (-1, 1):
            b['frame'].beam(T(sx * W * .4, sy * D * .4, .03), T(sx * W * .4, sy * D * .4, stand), .06, .06, 0)
    bb = b['ac']
    z0 = stand
    bb.box(T(0, 0, z0 + H / 2), (W, D, H), 0, yaw)
    bb.box(T(0, 0, z0 + H + .02), (W + .04, D + .04, .04), 0, yaw)
    fr = H * .27
    fc = T(fan_dx, -D / 2 - .004, z0 + H / 2)
    ax = Vector(T(1, 0, 0)) - Vector(T(0, 0, 0))
    ay = Vector(T(0, 1, 0)) - Vector(T(0, 0, 0))
    az = Vector((0, 0, 1))

    def F(r, a, d):
        return tuple(Vector(fc) + ax * r * math.cos(a) + az * r * math.sin(a) + ay * d)

    n = 40
    # 枠の輪と奥の黒い筒
    b['dark'].grid([[F(r, TAU * j / n, d) for j in range(n)] for r, d in ((fr + .035, -.002), (fr + .012, -.012), (fr, .0), (fr, .16), (.02, .16))], closed=True)
    # 羽根
    for k in range(5):
        a0 = TAU * k / 5
        rows = []
        for i in range(5):
            r = .05 + (fr - .08) * i / 4
            w = .3 + .35 * i / 4
            rows.append([F(r, a0 + t * w + i * .05, .09 + t * .035) for t in (-.5, 0, .5)])
        b['dark'].grid(rows)
    b['dark'].grid([[F(r, TAU * j / 16, .08) for j in range(16)] for r in (.001, .06)], closed=True)
    # 金網: 同心の輪と放射の線
    for i in range(1, 9):
        r = fr * i / 9 + .01
        b['grille'].tube([F(r, TAU * j / 36, -.012) for j in range(36)], .0035, 4, 0, True)
    for j in range(12):
        a = TAU * j / 12
        b['grille'].tube([F(.03, a, -.012), F(fr + .02, a, -.012)], .004, 4, 0)
    if top_grille:
        for k in range(9):
            y = -D * .4 + k * D * .1
            b['grille'].tube([T(-W * .42, y, z0 + H + .05), T(W * .42, y, z0 + H + .05)], .006, 4, 0)
        for sx in (-.42, -.14, .14, .42):
            b['grille'].tube([T(sx * W, -D * .42, z0 + H + .05), T(sx * W, D * .42, z0 + H + .05)], .007, 4, 0)
    # 横のスリット
    for k in range(9):
        z = z0 + .15 + k * (H - .3) / 8
        for sx in (-1, 1):
            b['ac'].box(T(sx * (W / 2 + .004), 0, z), (.012, D * .8, .022), 1, yaw)


def utilities(mats):
    b = {k: B() for k in ('frame', 'ac', 'dark', 'grille', 'pipe')}
    ac_unit(b, (3.46, 2.75), -1.48, 1.3, 1.35, .6, .2)  # 手前の室外機。ファンは左へ向く
    for dx in (-.22, .22):  # 奥の箱。ファンが 2 つ
        ac_unit(b, (3.47, 6.0), 0, .88, .8, .5, .54, dx, True)
    ac_unit(b, (5.1, 2.95), .05, 1.05, 1.05, .55)
    ac_unit(b, (6.5, 3.1), 0, 1.05, 1.05, .55)
    b['frame'].obj('AcFrame', [mats['frame']])
    b['ac'].obj('AcBody', [mats['ac'], mats['dark']])
    b['dark'].obj('AcFan', [mats['dark']])
    b['grille'].obj('AcGrille', [mats['rail']])
    p = b['pipe']
    runs = [
        ([(2.36, 3.9, .02), (2.36, 3.9, .55), (3.0, 3.9, .55), (3.0, 3.9, .02)], .08, .14),
        ([(2.72, 3.2, .02), (2.72, 3.2, .77), (3.13, 3.2, .77), (3.13, 3.2, .02)], .07, .13),
        ([(3.13, 3.4, .02), (3.13, 3.4, 1.64), (8.4, 3.4, 1.64), (8.4, 4.4, 1.64)], .085, .2),
        ([(3.0, 2.15, .28), (7.4, 2.15, .28)], .05, .1),
        ([(2.72, 2.3, .02), (2.72, 2.3, 1.62), (8.4, 2.3, 2.0)], .07, .2),
        ([(3.2, 3.7, .02), (3.2, 3.7, .34), (3.2, 5.6, .34), (5.9, 5.6, .34)], .045, .12),
        ([(-6.7, -9.85, .3), (-6.7, -6.0, .3), (-8.8, -6.0, .3)], .05, .14),
    ]
    for pts, r, rad in runs:
        p.tube(bend(pts, rad), r, 12)
        for q in pts[1:-1]:  # 継ぎ手
            q = Vector(q)
            p.lathe([(r * 1.5, -.03), (r * 1.5, .03)], 12, (q.x, q.y, q.z - rad - .02))
    s = B()
    for x in (3.9, 5.2, 6.5, 7.8):
        s.beam((x, 3.4, .03), (x, 3.4, 1.56), .05, .05, 0)
        s.beam((x - .25, 3.4, .03), (x + .25, 3.4, .03), .08, .03, 0)
        s.beam((x - .1, 3.4, 1.55), (x + .1, 3.4, 1.55), .05, .03, 0)
    for x in (3.5, 5.0, 6.5):
        s.beam((x, 2.15, .03), (x, 2.15, .24), .04, .04, 0)
    s.box((2.9, 7.0, .6), (.46, .4, 1.2), 0)  # 手すりの右の暗い箱
    # 手すりの手前の鉄の小さな足場
    sx, sy = -3.1, 8.3
    for k in range(5):
        s.box((sx, sy - .58 + k * .22, .1 + k * .17), (.7, .22, .025), 0)
    s.box((sx, sy + .35, .85), (.75, .5, .03), 0)
    for dx in (-.35, .35):
        s.beam((sx + dx, sy - .75, .03), (sx + dx, sy + .1, .9), .05, .018, 0)
        s.beam((sx + dx, sy - .75, .95), (sx + dx, sy + .1, 1.75), .024, .024, 0)
        s.beam((sx + dx, sy - .75, .03), (sx + dx, sy - .75, .95), .024, .024, 0)
        s.beam((sx + dx, sy + .55, .03), (sx + dx, sy + .55, 1.75), .024, .024, 0)
    p.obj('Pipes', [mats['pipe']])
    s.obj('Supports', [mats['frame']])


def shed(mats):
    """右奥の機械室。手前の壁は少し斜めに振る。壁の柱、帯、鉄の扉、換気口、壁の灯り 1 つ"""
    pts = [(5.05, 9.3), (5.86, 4.5), (X1 + .3, 4.5), (X1 + .3, 9.3)]
    h = 3.9
    b = B()
    for i in range(4):
        (ax, ay), (bx, by) = pts[i], pts[(i + 1) % 4]
        b.grid([[(ax, ay, 0), (bx, by, 0)], [(ax, ay, h), (bx, by, h)]], smooth=False)
    b.grid([[(x, y, h) for x, y in pts[:2]], [(x, y, h) for x, y in pts[:1:-1]]], smooth=False)
    a, c = Vector((*pts[0], 0)), Vector((*pts[1], 0))
    for t in (.03, .34, .66, .97):  # 壁の柱
        q = a.lerp(c, t)
        b.box((q.x - .06, q.y, h / 2), (.2, .3, h), 0, -.167)
    b.beam(a + Vector((-.1, 0, h + .04)), c + Vector((-.1, 0, h + .04)), .3, .16)
    b.beam(a + Vector((-.05, 0, 2.2)), c + Vector((-.05, 0, 2.2)), .08, .06)
    b.beam((6.2, 4.42, h + .04), (X1 + .3, 4.42, h + .04), .3, .16)
    b.obj('Shed', [mats['wall']])
    d = B()
    d.box((7.3, 4.485, 1.05), (1.05, .03, 2.1), 0)
    d.box((7.3, 4.47, 2.16), (1.3, .06, .12), 0)
    d.box((6.9, 4.45, 1.0), (.04, .04, .18), 1)
    d.obj('ShedDoor', [mats['steel'], mats['pipe']])
    v = B()
    for c_ in ((6.8, 6.0), (7.8, 7.5)):
        v.lathe([(.002, h), (.32, h), (.32, h + .6), (.44, h + .6), (.44, h + .72), (.002, h + .82)], 16, (*c_, 0))
    v.obj('Vents', [mats['pipe']])
    # 壁の灯り。腕は壁へ戻す
    lx, ly, lz = 5.05, 8.55, 3.18
    g = B()
    g.lathe([(.002, lz - .08), (.055, lz - .08), (.065, lz), (.055, lz + .08), (.002, lz + .08)], 12, (lx, ly, 0))
    g.obj('WallLampGlass', [emis('WallGlass', (1, .66, .3, 1), 22)])
    h_ = B()
    h_.box((lx + .05, ly, lz + .11), (.16, .14, .02))
    h_.beam((lx, ly, lz + .11), (lx + .3, ly, lz + .22), .022, .022)
    h_.obj('WallLampHood', [mats['steel']])
    return (lx - .12, ly, lz)


def back_side(mats):
    """カメラの後ろ側の階段室。寄りの背景に写る"""
    x0, x1, y0, y1, h = -9.0, -4.2, -10.2, -7.4, 3.2
    b = B()
    b.box(((x0 + x1) / 2, (y0 + y1) / 2, h / 2), (x1 - x0, y1 - y0, h))
    b.box(((x0 + x1) / 2, (y0 + y1) / 2, h + .08), (x1 - x0 + .2, y1 - y0 + .2, .16))
    b.obj('Stair', [mats['wall']])
    d = B()
    d.box((-5.0, y1 + .015, 1.05), (1.0, .03, 2.1), 0)
    d.box((-4.65, y1 + .05, 1.0), (.04, .04, .18), 1)
    d.obj('StairDoor', [mats['steel'], mats['pipe']])
    g = B()
    g.lathe([(.002, 2.42), (.07, 2.42), (.08, 2.5), (.07, 2.58), (.002, 2.58)], 12, (-5.9, y1 + .1, 0))
    g.obj('StairLamp', [bpy.data.materials['WallGlass']])
    c = B()
    for i, (x, y) in enumerate(((7.0, -8.6), (5.6, -8.6), (7.6, -6.8))):
        c.box((x, y, .32), (1.0, .9, .6), 0)
        c.box((x, y, .66), (1.05, .95, .06), 0)
    c.obj('Crates', [mats['ac']])


def bulbs(mats, keys):
    """柱と電球の列。線は 1 本の管、電球はインスタンス。最初の綱は target の画素で読んだ点を通る"""
    D = 9.2
    a_, c_ = P(790, 448, D), P(912, 302, D)
    pl = [a_, c_, (5.9, c_[1], 4.9), (5.6, -1.5, 3.9), (5.6, -6.0, 3.9), (5.6, -9.2, 3.9), (-5.6, -6.6, 3.9), (-6.2, -1.5, 3.9), (-6.2, 2.6, 3.9)]
    poles = B()
    for x, y, z in pl:
        poles.tube([(x, y, .02), (x, y, z + .04)], .06, 10)
        poles.lathe([(.14, .02), (.14, .05), (.07, .09)], 12, (x, y, 0))
    wire, even, odd = B(), [], []
    first = [P(px, py, D) for px, py in ((797, 455), (821, 455), (848, 430), (882, 388), (910, 345), (937, 338), (980, 320))]
    wire.tube([Vector(q) + Vector((0, 0, .06)) for q in first], .007, 5)
    for i, q in enumerate(first):
        (even if i % 2 else odd).append(q)
    chains = [(first[-1], pl[3], .5, 12), (pl[3], pl[4], .45, 11), (pl[4], pl[5], .35, 8), (pl[4], pl[6], .6, 26), (pl[6], pl[7], .45, 12), (pl[7], pl[8], .4, 10)]
    for a, b, sag, n in chains:
        pts = catenary(a, b, sag, n * 4)
        wire.tube(pts, .007, 5)
        for i in range(1, n):
            q = pts[i * 4]
            (even if i % 2 else odd).append((q.x, q.y, q.z - .06))
    poles.obj('Poles', [mats['frame']])
    wire.obj('Wire', [pbr('Wire', (.01, .01, .01, 1), .4)])
    socket = sphere_mesh('Socket', .03, pbr('Socket', (.02, .02, .02, 1), .4, .5), 1)
    instance_verts('Sockets', [(x, y, z + .05) for x, y, z in even + odd], socket)
    for i, pts in enumerate((even, odd)):
        m = emis(f'Bulb{i}', (1, .6, .22, 1), 30)
        h_ = instance_verts(f'Bulbs{i}', pts, sphere_mesh(f'Bulb{i}', .042, m, 2))
        h_.children[0].visible_glossy = False  # 水面に点の列を映さない
        keys['bulb'].append(m.node_tree.nodes['Emission'].inputs[1])


def plane_lights(keys):
    """飛行機: 親を回して空を横切る。短い胴の両端に赤い灯と白い閃光"""
    pivot = bpy.data.objects.new('PlaneRoute', None)
    bpy.context.scene.collection.objects.link(pivot)
    r = 640.0
    for name, col, k, dt, rad in (('PlaneRed', (1, .02, .02, 1), 60, 0, 1.3), ('PlaneWhite', (1, 1, 1, 1), 50, -30, .9)):
        m = emis(name, col, k)
        o = add(name, sphere_mesh(name, rad, m, 1), pivot, (r, dt, 900))
        o.visible_shadow = o.visible_diffuse = False
        keys['plane'].append(m.node_tree.nodes['Emission'].inputs[1])
    keys['pivot'] = pivot


# ---- 動き ----
def linear(obj_or_data):
    ad = obj_or_data.animation_data
    if not ad or not ad.action:
        return
    for bag in ad.action.layers[0].strips[0].channelbags:
        for fc in bag.fcurves:
            for k in fc.keyframe_points:
                k.interpolation = 'LINEAR'


def key_value(sock, frames_values):
    """入力の値に (コマ, 値) を順に打つ"""
    for f, v in frames_values:
        sock.default_value = v
        sock.keyframe_insert('default_value', frame=f)


def animate(ctx, keys):
    fps = ctx.fps
    beats = ctx.beats
    last = int(max(ctx.frames, (beats[-1] if beats else 30) * fps)) + 60
    rng = random.Random(5)
    # 雲: 空の殻を Z 軸で回す
    for o, r0, deg_s in keys['clouds']:
        o.rotation_euler[2] = r0
        o.keyframe_insert('rotation_euler', index=2, frame=1)
        o.rotation_euler[2] = r0 + math.radians(deg_s) * last / fps
        o.keyframe_insert('rotation_euler', index=2, frame=last + 1)
        linear(o)
        o.rotation_euler[2] = r0
    # 飛行機: 目標の空の右の外から入り、毎秒 4 度で進む
    p = keys['pivot']
    a0 = math.radians(60)
    p.rotation_euler[2] = a0
    p.keyframe_insert('rotation_euler', index=2, frame=1)
    p.rotation_euler[2] = a0 + math.radians(4) * last / fps
    p.keyframe_insert('rotation_euler', index=2, frame=last + 1)
    linear(p)
    p.rotation_euler[2] = a0
    red, white = keys['plane']
    key_value(red, [(f, v) for i in range(int(last / fps) + 2) for f, v in ((1 + i * fps, 60), (1 + i * fps + 5, 2), (1 + i * fps + fps - 1, 2))])
    key_value(white, [(f, v) for i in range(int(last / (fps * 1.4)) + 2) for f, v in ((1 + i * fps * 1.4, 50), (1 + i * fps * 1.4 + 2, 0), (1 + i * fps * 1.4 + 3, 0))])
    linear(red.id_data)
    linear(white.id_data)
    # 塔の赤い灯: 2 秒で息をする。2 組で半周期ずらす
    for i, s in enumerate(keys['beacon']):
        per = fps * 2.0
        key_value(s, [(1 + (i * .5 + k) * per + d * per, v) for k in range(-1, int(last / per) + 2) for d, v in ((0, 60), (.18, 4), (.82, 4))])
        linear(s.id_data)
    # 窓: 値を 1 ずつ進める。材質の中で窓ごとに位相をずらして消す窓を引き直す
    for s in keys['blink']:
        off = rng.uniform(0, 50)
        key_value(s, [(1, off), (last + 1, off + last / fps * .9)])
        linear(s.id_data)
    # ネオン: 2 色を 1 拍おきに光らせる
    for j, s in enumerate(keys['neon']):
        b0 = s.default_value
        for i, t in enumerate(beats):
            if i % 2 == j:
                f = 1 + t * fps
                key_value(s, [(f, b0 * 1.7), (f + fps * .24, b0)])
    # 電球: 拍で少し明るくなる
    for j, s in enumerate(keys['bulb']):
        b0 = s.default_value
        for i, t in enumerate(beats):
            if i % 2 == j:
                f = 1 + t * fps
                key_value(s, [(f, b0 * 1.35), (f + fps * .22, b0)])


def refl_mat(name, color, k):
    """透明のまま光を足す発光"""
    m, nt, out = mat_base(name)
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[0].default_value = color
    e.inputs[1].default_value = k
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    ad = nt.nodes.new('ShaderNodeAddShader')
    nt.links.new(tr.outputs[0], ad.inputs[0])
    nt.links.new(e.outputs[0], ad.inputs[1])
    nt.links.new(ad.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


# 床に映す光の列: (target の x, 色, 粒の数)。奥の床の金、マゼンタ、青の順を決める
REFL_COLS = [(89, 'g', 12), (105, 'g', 12), (185, 'g', 12), (410, 'g', 12), (688, 'g', 12), (860, 'g', 16), (877, 'g', 16),
             (314, 'm', 16), (327, 'm', 16), (457, 'b', 14), (480, 'b', 14), (559, 'b', 14), (754, 'b', 14)]
REFL = {'g': ((1, .52, .14, 1), 7), 'm': ((1, .08, .62, 1), 7), 'b': ((.1, .42, 1, 1), 7)}


def reflection_dots():
    """カメラには写らず、床にだけ写る光の粒。target の床の点から反射した先の高さ 20m の奥に置くので、どの視点でも同じ位置にある"""
    rng = random.Random(9)
    only = bpy.data.collections.new('DotReceivers')
    only.objects.link(bpy.data.objects['Floor'])
    D = 20.0

    def spot_pt(px, py):
        return ((px - 470.5) / F_PX * D, CAM[1] + D, -CAM[2] + (py - HORIZON) / F_PX * D)

    pts = {k: [] for k in REFL}
    for px, key, cnt in REFL_COLS:
        for _ in range(cnt):
            pts[key].append(spot_pt(px + rng.uniform(-4, 4), rng.uniform(885, 1012)))
            pts[key].append(spot_pt(px + rng.uniform(-4, 4), rng.uniform(885, 1012)))
    for key, (col, k) in REFL.items():
        name = 'Dots' + key
        h = instance_verts(name, pts[key], sphere_mesh(name + 'P', .07, refl_mat(name + 'M', col, k)))
        for o in (h, h.children[0]):
            o.visible_camera = o.visible_diffuse = o.visible_shadow = o.visible_transmission = False
            o.light_linking.receiver_collection = only


def compositor():
    s = bpy.context.scene
    nt = bpy.data.node_groups.new('Post', 'CompositorNodeTree')
    s.compositing_node_group = nt
    N, L = nt.nodes, nt.links
    rl = N.new('CompositorNodeRLayers')
    sh = N.new('CompositorNodeFilter')
    sh.inputs['Type'].default_value = 'Box Sharpen'
    sh.inputs['Factor'].default_value = .06
    L.new(rl.outputs['Image'], sh.inputs['Image'])
    g = N.new('CompositorNodeGlare')
    g.inputs['Type'].default_value = 'Bloom'
    g.inputs['Quality'].default_value = 'Medium'
    g.inputs['Threshold'].default_value = .85
    g.inputs['Smoothness'].default_value = .4
    g.inputs['Strength'].default_value = .5
    g.inputs['Saturation'].default_value = 1.15
    g.inputs['Size'].default_value = .8
    L.new(sh.outputs[0], g.inputs['Image'])
    cb = N.new('CompositorNodeColorBalance')
    L.new(g.outputs['Image'], cb.inputs['Image'])
    [i for i in cb.inputs if i.name == 'Lift' and i.type == 'VALUE'][0].default_value = -LIFT
    nt.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    out = N.new('NodeGroupOutput')
    L.new(cb.outputs['Image'], out.inputs[0])
    s.render.use_compositing = True


def build(ctx):
    global ASSETS
    ASSETS = ctx.assets
    s = bpy.context.scene
    s.view_settings.view_transform = 'Standard'
    s.view_settings.look = 'None'
    c = s.cycles
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces, c.transparent_max_bounces = 5, 2, 3, 1, 8
    c.sample_clamp_indirect = 5.0
    c.use_light_tree = True
    c.adaptive_threshold = .055
    c.filter_width = 1.0
    c.denoiser = 'OPENIMAGEDENOISE'  # OptiX に法線とアルベドを入れるとボケた遠景に粒が残る。OIDN で補助の画像も先に除去する
    c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
    c.denoising_prefilter = 'ACCURATE'
    c.denoising_use_gpu = True

    keys = {'blink': [], 'neon': [], 'beacon': [], 'bulb': [], 'plane': [], 'clouds': [], 'pivot': None}
    mats = {
        'wall': worldmat('Wall', 'wall_plain.png', 2.4, .6, tint=.215, bump_k=.25),
        'tank': worldmat('TankMetal', 'rust_tank.png', 2.6, .32, .75, tint=1.0, coat=.45, gray=.7),
        'frame': worldmat('Frame', 'steel_paint.png', 1.1, .42, .3, tint=.8, coat=.35, gray=.6),
        'ac': worldmat('AcPanel', 'ac_panel.png', 1.2, .36, .6, tint=.34, coat=.45, gray=.9),
        'box': worldmat('Box', 'ac_panel.png', 1.6, .42, .2, tint=.36, coat=.35, gray=.4),
        'pipe': worldmat('Pipe', 'pipe_metal.png', .8, .18, .95, tint=1.0, coat=.7, bump_k=.12, gray=.7),
        'dark': pbr('AcDark', (.012, .012, .014, 1), .45, .3),
        'rail': worldmat('RailSteel', 'steel_paint.png', .9, .35, .5, tint=.45, coat=.4, bump_k=.15),
        'steel': worldmat('Door', 'steel_paint.png', 1.4, .45, .3, tint=.9, coat=.2),
    }
    sky(keys)
    city(keys)
    floor(mats)
    parapet(mats)
    tank_lamp = water_tank(mats)
    utilities(mats)
    wall_lamp = shed(mats)
    back_side(mats)
    bulbs(mats, keys)
    plane_lights(keys)
    reflection_dots()

    def point(name, loc, w, col, r, glossy=False):
        li = bpy.data.lights.new(name, 'POINT')
        li.energy, li.color, li.shadow_soft_size = w, col, r
        add(name, li, None, loc).visible_glossy = glossy

    def spot(name, loc, aim, w, col, deg, blend=.7, glossy=False):
        li = bpy.data.lights.new(name, 'SPOT')
        li.energy, li.color, li.spot_size, li.spot_blend, li.shadow_soft_size = w, col, math.radians(deg), blend, .15
        o = add(name, li, None, loc)
        o.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        o.visible_glossy = glossy

    # 電球の列と壁の灯りの光。点の数は少なく、電球の発光は場面を照らさない
    point('StringR', (3.3, 3.6, 3.5), 90, (1, .7, .42), .35)
    sun = bpy.data.lights.new('NightFill', 'SUN')  # 雲の下の街明かりの均一な光。暗部を灰紫に持ち上げる
    sun.energy, sun.color, sun.angle = 1.4, (.76, .78, 1), math.radians(60)
    add('NightFill', sun, None, (0, 0, 40), (math.radians(14), 0, 0)).visible_glossy = False
    point('StringGlint', (3.3, 3.6, 3.5), 45, (1, .62, .28), .12, True)  # 濡れた床の金色の照り。床を照らす光とは強さを分ける
    bpy.data.objects['StringGlint'].visible_diffuse = False
    point('StringBack', (5.3, -4, 3.4), 80, (1, .62, .28), .35)
    point('StringL', (-5.8, -2.5, 3.4), 70, (1, .7, .42), .35)
    point('WallLamp', wall_lamp, 60, (1, .66, .3), .08, True)
    point('BoxLamp', tank_lamp, 4, (1, .6, .22), .05, True)
    point('TankBack', (-1.6, 7.6, 4.6), 240, (.6, .72, 1), .3)
    spot('TankFill', (-.6, 2.2, 3.2), (-3.2, 4.2, 4.1), 560, (1, .7, .4), 20, 1.0, True)
    spot('PedFill', (-1.8, .8, 1.2), (-3.0, 3.4, .45), 120, (1, .68, .42), 26)
    spot('FrameFill', (-.8, -.5, 2.4), (-3.4, 3.9, 2.4), 1600, (1, .78, .6), 26)
    spot('AcFill', (.8, -.5, 2.6), (3.0, 3.4, .8), 280, (1, .72, .5), 30, glossy=True)
    area = bpy.data.lights.new('RailWash', 'AREA')
    area.shape, area.size, area.size_y, area.energy, area.color = 'RECTANGLE', 16, 1, 260, (1, .72, .5)
    o = add('RailWash', area, None, (-1.5, 5.5, 2.2), (math.radians(115), 0, 0))
    o.visible_glossy = False
    # キャラの顔の光と、街のネオンの色の縁の光
    spot('Face', (.4, MARK[1] - 3.2, 2.5), (0, MARK[1], 1.35), 320, (1, .82, .66), 20)
    spot('RimM', (-3.0, 3.2, 2.7), (0, MARK[1], 1.3), 900, (1, .1, .6), 26)
    spot('RimC', (3.0, 2.2, 3.0), (0, MARK[1], 1.3), 800, (.1, .5, 1), 26)
    compositor()
    animate(ctx, keys)
    return {
        'mark': MARK,
        'facing': 0,
        'bounds': ((-3.7, 3.7), (-8.0, 2.0), (.12, 4.6)),
        'char_emission': .4,
        'beats_per_shot': 8,
        'views': {
            'target': {'loc': CAM, 'look': (0, 0, .4476), 'lens': 22.6, 'fstop': 2.6, 'focus': 3.5},
            'hold1': {'loc': (3.2, -4.0, 1.2), 'look': (0, 0, 1.0), 'lens': 35, 'fstop': 2.8},
            'hold2': {'loc': (-3.2, -2.2, .5), 'look': (0, 2, 1.5), 'lens': 28, 'fstop': 2.8},
            'back': {'loc': (0, 2.0, 1.2), 'look': (0, -8, 2.2), 'lens': 24, 'fstop': 2.8},
            'left': {'loc': (3.6, -1, 1.2), 'look': (-8, 0, 2.2), 'lens': 24, 'fstop': 2.8},
            'right': {'loc': (-3.6, -1, 1.2), 'look': (8, 0, 2.2), 'lens': 24, 'fstop': 2.8},
            'top': {'loc': (2.0, -3.0, 4.3), 'look': (0, 1, .5), 'lens': 26, 'fstop': 4.0},
        },
    }
