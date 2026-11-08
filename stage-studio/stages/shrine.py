"""オリジナルの神社の夏祭り。朱の鳥居、石段と社殿、提灯の列、縞の屋台、杉の木立、石灯籠、濡れた石畳、夜空の花火。

座標: キャラの立つ位置の近くが原点、+Y が社殿の方向。寸法は目標画像から逆算した。
target の視点は高さ 0.41m、原点の 6m 手前、f=970px(941x1672)、地平線は y=1085。
動くもの: 花火の開花(拍の時刻に合わせる)、提灯の揺れ、蛍の飛行と明滅。発光面は光のサンプリングから外し、場面を照らすのは少数の光だけにする。
"""
import math
import random

import bmesh
import bpy
import numpy as np
from mathutils import Vector, noise
from lib.studio import load_image

TAU = math.tau
ASSETS = None
F_PX = 970.0
CAM = Vector((0.0, -6.0, 0.41))
PITCH = math.atan((1085 - 836) / F_PX)
YAW = -21.0 / F_PX  # 目標は中心が右へ 21px ずれている
MARK = (0.0, -0.4, 0.0)
FWD = Vector((math.sin(YAW) * math.cos(PITCH), math.cos(YAW) * math.cos(PITCH), math.sin(PITCH)))
RIGHT = FWD.cross(Vector((0, 0, 1))).normalized()
UP = RIGHT.cross(FWD)

STAIR_Y0, STAIR_Y1, TERRACE = 7.3, 11.4, 3.18
STAIR_W0, STAIR_W1 = 1.72, 1.85
# 濡れた石の調整値
STONE_FINE, STONE_COARSE = .62, 1.7  # 凹凸の絵 1 枚の大きさ(m)
STONE_LUM = .09, .24
COAT_W, COAT_GRAZE = 1.0, .52
COAT_R = .07, .15  # 水の多い所と少ない所の粗さ
TILT_FINE, TILT_COARSE = .36, .16


def ray(px, py):
    return FWD + RIGHT * ((px - 470.5) / F_PX) + UP * ((836 - py) / F_PX)


def P(px, py, y):
    """目標画像の画素 (px, py) に写る、奥行きの座標が y の点"""
    d = ray(px, py)
    return CAM + d * ((y - CAM.y) / d.y)


def Px(px, py, x):
    """目標画像の画素に写る、x 座標が x の点"""
    d = ray(px, py)
    return CAM + d * ((x - CAM.x) / d.x)


def G(px, py):
    """目標画像の画素に写る地面の点"""
    d = ray(px, py)
    return CAM + d * (-CAM.z / d.z)


def on_ground(px, py):
    """目標画像の画素に写る、石段の脇の斜面の点"""
    d = ray(px, py)
    for i in range(400):
        p = CAM + d * (12 + i * .03)
        if p.z <= ground_h(p.x, p.y) + .08:
            return p
    return p


def project(p):
    """世界の点が写る目標画像の画素"""
    v = p - CAM
    d = v.dot(FWD)
    return 470.5 + F_PX * v.dot(RIGHT) / d, 836 - F_PX * v.dot(UP) / d


def Px(px, py, x):
    """目標画像の画素に写る、x 座標が x の点"""
    d = ray(px, py)
    return CAM + d * ((x - CAM.x) / d.x)


def G(px, py):
    """目標画像の画素に写る地面の点"""
    d = ray(px, py)
    return CAM + d * (-CAM.z / d.z)


def on_ground(px, py):
    """目標画像の画素に写る、石段の脇の斜面の点"""
    d = ray(px, py)
    for i in range(400):
        p = CAM + d * (12 + i * .03)
        if p.z <= ground_h(p.x, p.y) + .08:
            return p
    return p


def project(p):
    """世界の点が写る目標画像の画素"""
    v = p - CAM
    d = v.dot(FWD)
    return 470.5 + F_PX * v.dot(RIGHT) / d, 836 - F_PX * v.dot(UP) / d


def Px(px, py, x):
    """目標画像の画素に写る、x 座標が x の点"""
    d = ray(px, py)
    return CAM + d * ((x - CAM.x) / d.x)


def G(px, py):
    """目標画像の画素に写る地面の点"""
    d = ray(px, py)
    return CAM + d * (-CAM.z / d.z)


def on_ground(px, py):
    """目標画像の画素に写る、石段の脇の斜面の点"""
    d = ray(px, py)
    for i in range(400):
        p = CAM + d * (12 + i * .03)
        if p.z <= ground_h(p.x, p.y) + .08:
            return p
    return p


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

    def grid(self, rows, closed=False, mat=0, smooth=True, us=1.0, vs=1.0, flip=False, u0=0.0, v0=0.0):
        n = len(rows[0])
        base = len(self.v)
        for r in rows:
            self.v.extend(tuple(p) for p in r)
        for i in range(len(rows) - 1):
            for j in range(n if closed else n - 1):
                j2 = (j + 1) % n
                a, b, c, d = base + i * n + j, base + i * n + j2, base + (i + 1) * n + j2, base + (i + 1) * n + j
                ua, ub = u0 + j / (n if closed else n - 1) * us, u0 + (j + 1) / (n if closed else n - 1) * us
                va, vb = v0 + i / (len(rows) - 1) * vs, v0 + (i + 1) / (len(rows) - 1) * vs
                if flip:
                    self.face((d, c, b, a), [(ua, vb), (ub, vb), (ub, va), (ua, va)], mat, smooth)
                else:
                    self.face((a, b, c, d), [(ua, va), (ub, va), (ub, vb), (ua, vb)], mat, smooth)

    def lathe(self, prof, n=32, c=(0, 0, 0), mat=0, smooth=True, us=1.0, vs=1.0, lean=(0, 0), ph=0.0):
        rows = [[(c[0] + lean[0] * z + r * math.cos(TAU * j / n + ph), c[1] + lean[1] * z + r * math.sin(TAU * j / n + ph), c[2] + z) for j in range(n)] for r, z in prof]
        self.grid(rows, closed=True, mat=mat, smooth=smooth, us=us, vs=vs)

    def tube(self, pts, r, n=8, mat=0, closed=False, us=1.0, vs=1.0):
        pts = [Vector(p) for p in pts]
        m = len(pts)
        rows, nor = [], None
        for i in range(m):
            t = (pts[(i + 1) % m if closed else min(i + 1, m - 1)] - pts[(i - 1) % m if closed else max(i - 1, 0)]).normalized()
            if nor is None:
                nor = t.cross(Vector((0.13, 0.31, 0.94))).normalized()
            nor = (nor - t * nor.dot(t)).normalized()
            bi = t.cross(nor)
            rr = r(i / max(1, m - 1)) if callable(r) else r
            rows.append([tuple(pts[i] + (nor * math.cos(TAU * j / n) + bi * math.sin(TAU * j / n)) * rr) for j in range(n)])
        self.grid(rows, closed=True, mat=mat, us=us, vs=vs)

    def box(self, c, s, mat=0, rot=0.0, tex=1.0):
        """UV は実寸を tex(m)で割る。1 枚の画像が全部の面で同じ大きさに写る"""
        cx, cy, cz = c
        sx, sy, sz = (x / 2 for x in s)
        co, si = math.cos(rot), math.sin(rot)
        base = len(self.v)
        for dz in (-sz, sz):
            for dx, dy in ((-sx, -sy), (sx, -sy), (sx, sy), (-sx, sy)):
                self.v.append((cx + dx * co - dy * si, cy + dx * si + dy * co, cz + dz))
        ox, oy = (cx * .37 + cz * .21) % 1, (cy * .29 + cz * .43) % 1
        for f, (w, h) in (((3, 2, 1, 0), (s[0], s[1])), ((4, 5, 6, 7), (s[0], s[1])), ((0, 1, 5, 4), (s[0], s[2])), ((1, 2, 6, 5), (s[1], s[2])), ((2, 3, 7, 6), (s[0], s[2])), ((3, 0, 4, 7), (s[1], s[2]))):
            w, h = w / tex, h / tex
            self.face(tuple(base + i for i in f), [(ox, oy), (ox + w, oy), (ox + w, oy + h), (ox, oy + h)], mat, False)

    def beam(self, a, b, half, mat=0, tex=1.0, r=.04, n=2):
        """a から b への角の丸い角材。half は断面の半分の幅と高さ。a、b は点の列でもよい"""
        pts = [Vector(p) for p in ([a, b] if b is not None else a)]
        hw, hh = half
        ring = []
        for sx, sy, st in ((1, 1, 0), (-1, 1, 1), (-1, -1, 2), (1, -1, 3)):
            for k in range(n + 1):
                th = st * TAU / 4 + TAU / 4 * k / n
                ring.append((sx * (hw - r) + r * math.cos(th), sy * (hh - r) + r * math.sin(th)))
        rows = []
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            s = t.cross(Vector((0, 0, 1)))
            s = s.normalized() if s.length > 1e-3 else Vector((1, 0, 0))
            u = s.cross(t)
            rows.append([p + s * x + u * y for x, y in ring])
        length = sum((q - p).length for p, q in zip(pts, pts[1:]))
        self.grid(rows, closed=True, mat=mat, us=(hw + hh) * 4 / tex, vs=length / tex)
        for row, flip in ((rows[0], False), (rows[-1], True)):
            base = len(self.v)
            self.v.extend(tuple(p) for p in row)
            idx = list(range(base, base + len(row)))
            self.face(tuple(reversed(idx)) if not flip else tuple(idx), [(x / tex, y / tex) for x, y in ring], mat, False)

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


def add(name, data, parent=None, loc=(0, 0, 0), rot=(0, 0, 0), scale=1.0):
    o = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(o)
    o.location, o.rotation_euler = loc, rot
    o.scale = (scale, scale, scale)
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


def instance_verts(name, pts, proto_mesh, parent=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(p) for p in pts], [], [])
    host = add(name, me, parent)
    host.instance_type = 'VERTS'
    host.show_instancer_for_render = False
    add(name + '_p', proto_mesh, host)
    return host


def card_cloud(name, pos, nor, size, mat, seed=1, bend=.3):
    """葉の絵を貼った四角形を 1 つのメッシュへ焼き込む。真ん中で折って厚みを出す"""
    rng = np.random.default_rng(seed)
    n = nor / np.linalg.norm(nor, axis=1, keepdims=True)
    t = np.cross(n, rng.normal(size=n.shape))
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    w = np.cross(n, t)
    sz = size[:, None]
    N = len(pos)
    v = np.stack([pos - (t + w) * sz - n * sz * bend, pos + (t - w) * sz, pos + (t + w) * sz - n * sz * bend, pos + (w - t) * sz], 1).reshape(-1, 3).astype(np.float32)
    me = bpy.data.meshes.new(name)
    me.vertices.add(N * 4)
    me.vertices.foreach_set('co', v.ravel())
    me.loops.add(N * 4)
    me.loops.foreach_set('vertex_index', np.arange(N * 4, dtype=np.int32))
    me.polygons.add(N)
    me.polygons.foreach_set('loop_start', np.arange(N, dtype=np.int32) * 4)
    me.update(calc_edges=True)
    quad = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float32)
    uv = np.tile(quad, (N, 1)).astype(np.float32)
    me.uv_layers.new(name='UVMap').uv.foreach_set('vector', uv.ravel())
    rnd = np.repeat(rng.random((N, 2)), 4, axis=0).astype(np.float32)
    me.uv_layers.new(name='S').uv.foreach_set('vector', rnd.ravel())
    me.materials.append(mat)
    return add(name, me)


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


def pbr(name, color=(0.8, 0.8, 0.8, 1), rough=0.5, metal=0.0, img=None, spec=0.5, coat=0.0, emit=None, emit_k=0.0, bump=0.0, tone=None, uv_scale=None):
    m, nt, out = mat_base(name)
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], out.inputs[0])
    b.inputs['Base Color'].default_value = color
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    b.inputs['Specular IOR Level'].default_value = spec
    b.inputs['Coat Weight'].default_value = coat
    b.inputs['Coat Roughness'].default_value = 0.12
    src = None
    if img:
        t = tex_node(nt, image(img))
        src = t.outputs[0]
        if tone is not None:
            mx = nt.nodes.new('ShaderNodeMix')
            mx.data_type = 'RGBA'
            mx.blend_type = 'MULTIPLY'
            mx.inputs[0].default_value = 1
            nt.links.new(src, mx.inputs['A'])
            mx.inputs['B'].default_value = tone
            src = mx.outputs['Result']
        nt.links.new(src, b.inputs['Base Color'])
        if bump:
            bu = nt.nodes.new('ShaderNodeBump')
            bu.inputs['Distance'].default_value = bump
            nt.links.new(t.outputs[0], bu.inputs['Height'])
            nt.links.new(bu.outputs[0], b.inputs['Normal'])
    if emit is not None or (emit_k and src is not None):
        if emit is not None:
            b.inputs['Emission Color'].default_value = emit
        else:
            nt.links.new(src, b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = emit_k
    m.cycles.emission_sampling = 'NONE'
    return m


def emis(name, color, k, img=None):
    m, nt, out = mat_base(name)
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[0].default_value = color
    e.inputs[1].default_value = k
    nt.links.new(e.outputs[0], out.inputs[0])
    if img:
        v = nt.nodes.new('ShaderNodeVectorMath')
        v.operation = 'MULTIPLY'
        nt.links.new(tex_node(nt, image(img)).outputs[0], v.inputs[0])
        v.inputs[1].default_value = color[:3]
        nt.links.new(v.outputs[0], e.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def add_air(m, leaf=True):
    """遠くほど夜の空気の色、近くの低い所は提灯の暖色の返りを足す。場所だけで決まり、視点によらない"""
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    b = next(n for n in N if n.type == 'BSDF_PRINCIPLED')
    geo = N.new('ShaderNodeNewGeometry')
    v = N.new('ShaderNodeVectorMath')
    v.operation = 'DISTANCE'
    L.new(geo.outputs['Position'], v.inputs[0])
    v.inputs[1].default_value = (0, 8, 0)
    far = N.new('ShaderNodeMapRange')
    far.inputs['From Min'].default_value = 18
    far.inputs['From Max'].default_value = 62
    far.inputs['To Max'].default_value = .012
    L.new(v.outputs['Value'], far.inputs['Value'])
    near = N.new('ShaderNodeMapRange')
    near.inputs['From Min'].default_value = 8
    near.inputs['From Max'].default_value = 30
    near.inputs['To Min'].default_value = .05
    near.inputs['To Max'].default_value = 0
    L.new(v.outputs['Value'], near.inputs['Value'])
    sp = N.new('ShaderNodeSeparateXYZ')
    L.new(geo.outputs['Position'], sp.inputs[0])
    low = N.new('ShaderNodeMapRange')
    low.inputs['From Min'].default_value = 4
    low.inputs['From Max'].default_value = 16
    low.inputs['To Min'].default_value = 1
    low.inputs['To Max'].default_value = 0
    L.new(sp.outputs['Z'], low.inputs['Value'])
    ml = N.new('ShaderNodeMath')
    ml.operation = 'MULTIPLY'
    L.new(near.outputs[0], ml.inputs[0])
    L.new(low.outputs[0], ml.inputs[1])
    mx = N.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    w = N.new('ShaderNodeMath')
    w.operation = 'DIVIDE'
    L.new(ml.outputs[0], w.inputs[0])
    tot = N.new('ShaderNodeMath')
    tot.operation = 'ADD'
    L.new(ml.outputs[0], tot.inputs[0])
    L.new(far.outputs[0], tot.inputs[1])
    mx2 = N.new('ShaderNodeMath')
    mx2.operation = 'MAXIMUM'
    L.new(tot.outputs[0], mx2.inputs[0])
    mx2.inputs[1].default_value = 1e-4
    L.new(mx2.outputs[0], w.inputs[1])
    L.new(w.outputs[0], mx.inputs[0])
    mx.inputs['A'].default_value = (.32, .42, .75, 1)
    mx.inputs['B'].default_value = (1, .42, .14, 1)
    L.new(mx.outputs['Result'], b.inputs['Emission Color'])
    L.new(tot.outputs[0] if leaf else ml.outputs[0], b.inputs['Emission Strength'])


def torii_mat():
    """鳥居の朱。なめらかな塗膜に色むら。柱の足元は苔の色で黒ずむ"""
    m = pbr('ToriiPaint', img='torii_worn.png', rough=.72, spec=.3, bump=.006, emit_k=.05, tone=(1.06, 1.0, .85, 1))
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    b = next(n for n in N if n.type == 'BSDF_PRINCIPLED')
    worn = b.inputs['Base Color'].links[0].from_socket
    sm = N.new('ShaderNodeMix')  # 傷みの絵と滑らかな朱を半分ずつ
    sm.data_type = 'RGBA'
    sm.inputs[0].default_value = .25
    L.new(worn, sm.inputs['A'])
    L.new(tex_node(nt, image('torii_smooth.png')).outputs[0], sm.inputs['B'])
    src = sm.outputs['Result']
    geo = N.new('ShaderNodeNewGeometry')
    sp = N.new('ShaderNodeSeparateXYZ')
    L.new(geo.outputs['Position'], sp.inputs[0])
    t = tex_node(nt, image('moss_stone.png'))
    co = N.new('ShaderNodeTexCoord')
    L.new(co.outputs['UV'], t.inputs[0])
    r = N.new('ShaderNodeMapRange')
    r.inputs['From Min'].default_value = .6
    r.inputs['From Max'].default_value = 2.4
    r.inputs['To Min'].default_value = .45
    r.inputs['To Max'].default_value = 0
    L.new(sp.outputs['Z'], r.inputs['Value'])
    mx = N.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    mx.blend_type = 'MULTIPLY'
    L.new(r.outputs[0], mx.inputs[0])
    mot = tex_node(nt, image('torii_paint.png'))
    L.new(co.outputs['UV'], mot.inputs[0])
    gm = N.new('ShaderNodeGamma')  # 暗い剥げは弱め、明るい朱の濃淡を生かす
    gm.inputs[1].default_value = 1.0
    L.new(mot.outputs[0], gm.inputs[0])
    m2 = N.new('ShaderNodeMix')
    m2.data_type = 'RGBA'
    m2.blend_type = 'MULTIPLY'
    m2.inputs[0].default_value = .35
    L.new(src, m2.inputs['A'])
    L.new(gm.outputs[0], m2.inputs['B'])
    L.new(m2.outputs['Result'], mx.inputs['A'])
    L.new(t.outputs[0], mx.inputs['B'])
    L.new(mx.outputs['Result'], b.inputs['Base Color'])
    return m


def foot_mat():
    """柱の根元の鉄。汚れた黒い塗りで、下端は苔で暗い"""
    m = pbr('ToriiFoot', img='iron_worn.png', rough=.6, spec=.3, bump=.004, tone=(1.0, .9, .8, 1))
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    b = next(n for n in N if n.type == 'BSDF_PRINCIPLED')
    sp = N.new('ShaderNodeSeparateXYZ')
    L.new(N.new('ShaderNodeNewGeometry').outputs['Position'], sp.inputs[0])
    r = N.new('ShaderNodeMapRange')
    r.inputs['From Min'].default_value = .3
    r.inputs['From Max'].default_value = .62
    r.inputs['To Min'].default_value = .85
    r.inputs['To Max'].default_value = 0
    L.new(sp.outputs['Z'], r.inputs['Value'])
    mx = N.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    L.new(r.outputs[0], mx.inputs[0])
    L.new(b.inputs['Base Color'].links[0].from_socket, mx.inputs['A'])
    t = tex_node(nt, image('moss_stone.png'))
    L.new(N.new('ShaderNodeTexCoord').outputs['UV'], t.inputs[0])
    ton = N.new('ShaderNodeVectorMath')
    ton.operation = 'SCALE'
    ton.inputs['Scale'].default_value = .16
    L.new(t.outputs[0], ton.inputs[0])
    L.new(ton.outputs[0], mx.inputs['B'])
    L.new(mx.outputs['Result'], b.inputs['Base Color'])
    return m


def amber_mat():
    """灯籠の和紙の面。電球の色で、中心が明るい"""
    m, nt, out = mat_base('LampGlass')
    N, L = nt.nodes, nt.links
    t = tex_node(nt, image('lantern_white.png'))
    geo = N.new('ShaderNodeTexCoord')
    sp = N.new('ShaderNodeSeparateXYZ')
    L.new(geo.outputs['UV'], sp.inputs[0])
    s_ = N.new('ShaderNodeMath')
    s_.operation = 'SINE'
    mu = N.new('ShaderNodeMath')
    mu.operation = 'MULTIPLY'
    L.new(sp.outputs['Y'], mu.inputs[0])
    mu.inputs[1].default_value = math.pi * 2.0
    L.new(mu.outputs[0], s_.inputs[0])
    ab = N.new('ShaderNodeMath')
    ab.operation = 'ABSOLUTE'
    L.new(s_.outputs[0], ab.inputs[0])
    g = N.new('ShaderNodeMapRange')
    g.inputs['To Min'].default_value = .75
    g.inputs['To Max'].default_value = 1.9
    L.new(ab.outputs[0], g.inputs['Value'])
    e = N.new('ShaderNodeEmission')
    v = N.new('ShaderNodeVectorMath')
    v.operation = 'MULTIPLY'
    L.new(t.outputs[0], v.inputs[0])
    v.inputs[1].default_value = (1, .36, .07)
    L.new(v.outputs[0], e.inputs[0])
    L.new(g.outputs[0], e.inputs[1])
    L.new(e.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def crest_mat():
    """笠木の紋。画像の白い形だけを金で写す"""
    m, nt, out = mat_base('ToriiCrest')
    N, L = nt.nodes, nt.links
    t = tex_node(nt, image('mon.png'), 'CLIP')
    b = N.new('ShaderNodeBsdfPrincipled')
    b.inputs['Base Color'].default_value = (.85, .6, .25, 1)
    b.inputs['Metallic'].default_value = 1
    b.inputs['Roughness'].default_value = .35
    b.inputs['Emission Color'].default_value = (1, .55, .2, 1)
    b.inputs['Emission Strength'].default_value = .25
    tr = N.new('ShaderNodeBsdfTransparent')
    ms = N.new('ShaderNodeMixShader')
    L.new(t.outputs[0], ms.inputs[0])
    L.new(tr.outputs[0], ms.inputs[1])
    L.new(b.outputs[0], ms.inputs[2])
    L.new(ms.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def cut_mat(name, img, tone, k=.1):
    """切り抜いた葉。透明度は画像の A。裏から少し光を通す"""
    m, nt, out = mat_base(name)
    N, L = nt.nodes, nt.links
    t = tex_node(nt, image(img))
    t.image.alpha_mode = 'STRAIGHT'
    u_s = N.new('ShaderNodeUVMap')
    u_s.uv_map = 'S'
    sp = N.new('ShaderNodeSeparateXYZ')
    L.new(u_s.outputs[0], sp.inputs[0])
    lum = N.new('ShaderNodeMapRange')
    lum.inputs['To Min'].default_value = .55
    lum.inputs['To Max'].default_value = 1.25
    L.new(sp.outputs['X'], lum.inputs['Value'])
    v = N.new('ShaderNodeVectorMath')
    v.operation = 'SCALE'
    L.new(t.outputs[0], v.inputs[0])
    mx = N.new('ShaderNodeMath')
    mx.operation = 'MULTIPLY'
    L.new(lum.outputs[0], mx.inputs[0])
    mx.inputs[1].default_value = tone
    L.new(mx.outputs[0], v.inputs['Scale'])
    b = N.new('ShaderNodeBsdfPrincipled')
    tb = N.new('ShaderNodeVectorMath')  # 絵の青緑を抜く
    tb.operation = 'MULTIPLY'
    L.new(v.outputs[0], tb.inputs[0])
    tb.inputs[1].default_value = (1.0, .66, .42)
    L.new(tb.outputs[0], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = .6
    b.inputs['Specular IOR Level'].default_value = .15
    add_air(m, False)
    em = N.new('ShaderNodeMix')  # 絵の陰影が暗い所でも読めるよう、絵の色を少し光らせる
    em.data_type = 'RGBA'
    em.blend_type = 'ADD'
    em.inputs[0].default_value = 1
    em2 = N.new('ShaderNodeVectorMath')
    em2.operation = 'SCALE'
    em2.inputs['Scale'].default_value = k
    L.new(v.outputs[0], em2.inputs[0])
    tn = N.new('ShaderNodeVectorMath')
    tn.operation = 'MULTIPLY'
    L.new(em2.outputs[0], tn.inputs[0])
    tn.inputs[1].default_value = (1.0, .55, .3)
    L.new(tn.outputs[0], b.inputs['Emission Color'])
    b.inputs['Emission Strength'].default_value = 1.0
    tr = N.new('ShaderNodeBsdfTransparent')
    ms = N.new('ShaderNodeMixShader')
    L.new(t.outputs['Alpha'], ms.inputs[0])
    L.new(tr.outputs[0], ms.inputs[1])
    L.new(b.outputs[0], ms.inputs[2])
    L.new(ms.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def wet_stone():
    """小ぶりの濡れた石。地は暗く、灯りは凹凸の頂と水の膜で細かく割れて、石ごとに途切れる。
    UV は実寸(m)。'S' は石ごとの乱数 2 個、'E' は (縁の近さ 0..1, 乱数)。法線は視線の水平方向にだけ傾け、床すれすれの視点でも反射が左右へ飛ばない"""
    m, nt, out = mat_base('WetStone')
    N, L = nt.nodes, nt.links
    b = N.new('ShaderNodeBsdfPrincipled')
    L.new(b.outputs[0], out.inputs[0])
    uv = N.new('ShaderNodeTexCoord').outputs['UV']
    geo = N.new('ShaderNodeNewGeometry')

    def layer(name):
        n = N.new('ShaderNodeUVMap')
        n.uv_map = name
        s = N.new('ShaderNodeSeparateXYZ')
        L.new(n.outputs[0], s.inputs[0])
        return s.outputs['X'], s.outputs['Y']

    def op(kind, x, y=None, clamp=False):
        n = N.new('ShaderNodeMath')
        n.operation = kind
        n.use_clamp = clamp
        for i, a in enumerate((x, y)):
            if isinstance(a, (int, float)):
                n.inputs[i].default_value = a
            elif a is not None:
                L.new(a, n.inputs[i])
        return n.outputs[0]

    def vm(kind, x, y=None, scale=None):
        n = N.new('ShaderNodeVectorMath')
        n.operation = kind
        for i, a in enumerate((x, y)):
            if isinstance(a, tuple):
                n.inputs[i].default_value = a
            elif a is not None:
                L.new(a, n.inputs[i])
        if isinstance(scale, (int, float)):
            n.inputs['Scale'].default_value = scale
        elif scale is not None:
            L.new(scale, n.inputs['Scale'])
        return n.outputs['Value'] if kind == 'DOT_PRODUCT' else n.outputs[0]

    def ramp(v, a0, a1, b0, b1):
        r = N.new('ShaderNodeMapRange')
        r.clamp = True
        for k, x in (('From Min', a0), ('From Max', a1), ('To Min', b0), ('To Max', b1)):
            r.inputs[k].default_value = x
        L.new(v, r.inputs['Value'])
        return r.outputs[0]

    r1, r2 = layer('S')
    edge, r3 = layer('E')
    off = N.new('ShaderNodeCombineXYZ')  # 石ごとに絵をずらす。灯りの像がここで切れる
    L.new(op('MULTIPLY', r1, 7.3), off.inputs['X'])
    L.new(op('MULTIPLY', r2, 5.1), off.inputs['Y'])
    placed = vm('ADD', uv, off.outputs[0])

    def tile(name, size, data=True, src=None):
        t = tex_node(nt, image(name, data=data))
        L.new(vm('SCALE', src or placed, None, 1 / size), t.inputs[0])
        return t.outputs[0]

    height = tile('cobble_height.png', STONE_FINE)
    # 地の色。低い所と縁は黒ずむ
    shade = op('MULTIPLY', ramp(height, .15, .7, .45, 1.15), ramp(edge, .35, .85, 1, .015))
    lum = op('MULTIPLY', ramp(r1, 0, 1, STONE_LUM[0], STONE_LUM[1]), shade)
    L.new(vm('SCALE', tile('cobble_albedo.png', 1.15, False), None, lum), b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = .62
    b.inputs['Specular IOR Level'].default_value = 0  # 光は水の膜だけが映す。粗い鏡面は反射の元を全面へ広げる
    # 水の膜。石の中でも石ごとでも変わる
    wet = tile('wet_blotch.png', 1.7)
    lw = N.new('ShaderNodeLayerWeight')
    lw.inputs[0].default_value = .5
    graze = ramp(lw.outputs['Facing'], .84, .97, 1, COAT_GRAZE)
    w = op('MULTIPLY', ramp(wet, .22, .7, .2, 1), ramp(r3, 0, 1, .2, 1.1))
    w = op('MULTIPLY', w, ramp(tile('cobble_soft.png', STONE_FINE), .3, .66, .35, 1.1))  # 頂だけ光り、くぼみは暗い
    w = op('MULTIPLY', w, ramp(edge, .15, .75, 1, .02))
    steep = ramp(lw.outputs['Facing'], .55, .8, .4, 1)  # 見下ろすほど弱い。手前の像が足元まで続かない
    L.new(op('MULTIPLY', op('MULTIPLY', op('MULTIPLY', w, graze), steep), COAT_W, True), b.inputs['Coat Weight'])
    b.inputs['Coat IOR'].default_value = 1.45
    L.new(op('ADD', ramp(wet, .2, .72, COAT_R[1], COAT_R[0]), op('MULTIPLY', r2, .05)), b.inputs['Coat Roughness'])
    # 地の法線は凹凸をそのまま使う
    fine = tile('cobble_n.png', STONE_FINE)
    coarse = tile('cobble_n.png', STONE_COARSE)
    nm = N.new('ShaderNodeNormalMap')
    L.new(fine, nm.inputs['Color'])
    nm.inputs['Strength'].default_value = .9
    L.new(nm.outputs[0], b.inputs['Normal'])
    # 水膜の法線。向きは視線から決めるので、どの視点でも同じ計算になる
    inc = N.new('ShaderNodeSeparateXYZ')
    L.new(geo.outputs['Incoming'], inc.inputs[0])
    flat = N.new('ShaderNodeCombineXYZ')
    L.new(inc.outputs['X'], flat.inputs['X'])
    L.new(inc.outputs['Y'], flat.inputs['Y'])
    t_ = vm('NORMALIZE', flat.outputs[0])
    side = vm('CROSS_PRODUCT', t_, (0, 0, 1))

    def slope(c):
        s = N.new('ShaderNodeSeparateXYZ')
        L.new(c, s.inputs[0])
        d = N.new('ShaderNodeCombineXYZ')
        L.new(op('SUBTRACT', s.outputs['X'], .5), d.inputs['X'])
        L.new(op('SUBTRACT', s.outputs['Y'], .5), d.inputs['Y'])
        return d.outputs[0]

    ds = vm('ADD', vm('SCALE', slope(fine), None, TILT_FINE), vm('SCALE', slope(coarse), None, TILT_COARSE))
    along = op('ADD', vm('DOT_PRODUCT', ds, t_), op('MULTIPLY', op('SUBTRACT', r3, .5), .16))  # 石ごとの傾きで像が石の境で切れる
    bent = vm('ADD', geo.outputs['Normal'], vm('SCALE', t_, None, along))
    bent = vm('ADD', bent, vm('SCALE', side, None, op('MULTIPLY', vm('DOT_PRODUCT', ds, side), .22)))
    L.new(vm('NORMALIZE', bent), b.inputs['Coat Normal'])
    m.cycles.emission_sampling = 'NONE'
    return m


def paper_mat(name, color, k, crest=True, even=.36):
    """提灯の和紙。紙の全面が同じ色で光り、竹の骨と紋だけが暗い。画像は骨の濃淡と紋の形に使う"""
    m, nt, out = mat_base(name)
    N, L = nt.nodes, nt.links
    uv = N.new('ShaderNodeTexCoord')
    t = tex_node(nt, image('lantern_white.png'))
    sp = N.new('ShaderNodeSeparateXYZ')
    L.new(uv.outputs['UV'], sp.inputs[0])
    rib = N.new('ShaderNodeMapRange')  # 骨の濃さ
    rib.inputs['From Min'].default_value = .35
    rib.inputs['From Max'].default_value = .75
    rib.inputs['To Min'].default_value = .62
    rib.inputs['To Max'].default_value = 1.0
    L.new(t.outputs[0], rib.inputs['Value'])

    def op(kind, a, b=None):
        n = N.new('ShaderNodeMath')
        n.operation = kind
        for i, x in enumerate((a, b)):
            if x is None:
                continue
            if isinstance(x, (int, float)):
                n.inputs[i].default_value = x
            else:
                L.new(x, n.inputs[i])
        return n.outputs[0]

    glow = op('ADD', even, op('MULTIPLY', 1.1 - even, op('SINE', op('MULTIPLY', sp.outputs['Y'], math.pi))))
    v = op('MULTIPLY', op('MULTIPLY', rib.outputs[0], glow), k)
    if crest:  # 紋は胴の表と裏に 1 つずつ
        cm = N.new('ShaderNodeCombineXYZ')
        L.new(op('ADD', op('MULTIPLY', op('SUBTRACT', op('FRACT', op('MULTIPLY', sp.outputs['X'], 2)), .5), 2.5), .5), cm.inputs['X'])
        L.new(op('ADD', op('MULTIPLY', op('SUBTRACT', sp.outputs['Y'], .48), 2.6), .5), cm.inputs['Y'])
        mon = tex_node(nt, image('mon.png'), 'CLIP')
        L.new(cm.outputs[0], mon.inputs[0])
        v = op('MULTIPLY', v, op('SUBTRACT', 1, op('MULTIPLY', mon.outputs[0], .5)))
    e = N.new('ShaderNodeEmission')
    e.inputs[0].default_value = color
    L.new(v, e.inputs[1])
    L.new(e.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def spark_mat(name, col_a, col_b, k, flat=False):
    """花火の筋。UV の U は筋の根元 0 から先端 1、V は筋ごとの乱数。
    物体の色で動かす: R が開いた長さ(0..1)、G が明るさ(0..1)"""
    m, nt, out = mat_base(name)
    N, L = nt.nodes, nt.links
    uv = N.new('ShaderNodeTexCoord')
    sp = N.new('ShaderNodeSeparateXYZ')
    L.new(uv.outputs['UV'], sp.inputs[0])
    oi = N.new('ShaderNodeObjectInfo')
    sc = N.new('ShaderNodeSeparateColor')
    L.new(oi.outputs['Color'], sc.inputs[0])

    def op(kind, a, b=None, clamp=False):
        n = N.new('ShaderNodeMath')
        n.operation = kind
        n.use_clamp = clamp
        for i, x in enumerate((a, b)):
            if x is None:
                continue
            if isinstance(x, (int, float)):
                n.inputs[i].default_value = x
            else:
                L.new(x, n.inputs[i])
        return n.outputs[0]

    u, v = sp.outputs['X'], sp.outputs['Y']
    # 先端より外は消す。先端は明るく、根元へ向けて暗くなる
    head = op('MULTIPLY', op('LESS_THAN', u, sc.outputs['Red']), 1.0)
    tail = op('POWER', op('ADD', op('DIVIDE', u, op('MAXIMUM', sc.outputs['Red'], .02)), .0), 2.6, False)
    core = op('MULTIPLY', op('POWER', op('SUBTRACT', 1, u, True), 8, True), 0 if flat else .025)
    root = op('ADD', op('ADD', op('MULTIPLY', tail, .35 if flat else .92), .65 if flat else .018), core)
    # 輝きの点。長い筋の画像を、筋ごとにずらして重ねる
    cm = N.new('ShaderNodeCombineXYZ')
    L.new(op('MULTIPLY', u, .75), cm.inputs['X'])
    L.new(v, cm.inputs['Y'])
    gl = tex_node(nt, image('spark.png'))
    L.new(cm.outputs[0], gl.inputs[0])
    glit = op('ADD', op('MULTIPLY', gl.outputs[0], 1.8), .3)
    mix = N.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    L.new(op('ADD', op('MULTIPLY', op('MAXIMUM', op('SUBTRACT', u, .78), 0), 3.5), op('GREATER_THAN', v, .72), True), mix.inputs[0])  # 先の 2 割と粒だけ桃
    mix.inputs['A'].default_value = col_a
    mix.inputs['B'].default_value = col_b
    e = N.new('ShaderNodeEmission')
    L.new(mix.outputs['Result'], e.inputs[0])
    L.new(op('MULTIPLY', op('MULTIPLY', head, op('MULTIPLY', root, glit)), op('MULTIPLY', sc.outputs['Green'], k)), e.inputs[1])
    tr = N.new('ShaderNodeBsdfTransparent')
    ad = N.new('ShaderNodeAddShader')
    L.new(e.outputs[0], ad.inputs[0])
    L.new(tr.outputs[0], ad.inputs[1])
    L.new(ad.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


# ---- 空と遠景 ----
def sky():
    # 空は大きな円筒と天井。左右は鏡映しで繋げる
    m, nt, out = mat_base('Sky')
    N, L = nt.nodes, nt.links
    t = tex_node(nt, image('sky.png'), 'EXTEND')
    t.extension = 'MIRROR'
    e = N.new('ShaderNodeEmission')
    e.inputs[1].default_value = 1.0
    add_ = N.new('ShaderNodeMix')  # 画像の青は濃すぎるので、薄い空気の色を足す
    add_.data_type = 'RGBA'
    add_.blend_type = 'ADD'
    add_.inputs[0].default_value = 1
    L.new(t.outputs[0], add_.inputs['A'])
    add_.inputs['B'].default_value = (.0085, .04, .05, 1)
    R, n = 420.0, 72

    def height(py):  # 目標の行 py に写る、空の円筒の高さ
        d_ = ray(600, py)
        return CAM.z + d_.z * R / math.hypot(d_.x, d_.y)

    geo = N.new('ShaderNodeNewGeometry')
    sz = N.new('ShaderNodeSeparateXYZ')
    L.new(geo.outputs['Position'], sz.inputs[0])
    col = add_.outputs['Result']
    for y0, y1, c_ in ((60, 340, (.035, .055, .165, 1)), (340, 415, (.02, .031, .08, 1))):
        r_ = N.new('ShaderNodeMapRange')
        r_.inputs['From Min'].default_value = height(y1)
        r_.inputs['From Max'].default_value = height(y0)
        r_.inputs['To Min'].default_value = 1
        r_.inputs['To Max'].default_value = 0
        L.new(sz.outputs['Z'], r_.inputs['Value'])
        mx = N.new('ShaderNodeMix')
        mx.data_type = 'RGBA'
        L.new(r_.outputs[0], mx.inputs[0])
        L.new(col, mx.inputs['A'])
        mx.inputs['B'].default_value = c_
        col = mx.outputs['Result']
    L.new(col, e.inputs[0])
    L.new(e.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    b = B()
    rows = [[(R * math.cos(TAU * j / n) * c, R * math.sin(TAU * j / n) * c, -30 + (380 + 200 * (1 - c * c)) * h) for j in range(n)]
            for h, c in ((0, 1), (.6, 1), (1, 1), (1.05, .7), (1.1, .25))]
    b.grid(rows, closed=True, us=6, vs=1.0, flip=True)
    o = b.obj('Sky', [m])
    o.visible_shadow = False
    o.visible_glossy = False  # 濡れた床が空で青く霞まないよう、映り込みは下の暗い世界色にする
    w = bpy.data.worlds.new('W')
    w.use_nodes = True
    bg = next(x for x in w.node_tree.nodes if x.type == 'BACKGROUND')
    bg.inputs[0].default_value = (.03, .027, .055, 1)
    bg.inputs[1].default_value = 1.0
    bpy.context.scene.world = w
    # 遠くの杉の森。空の手前の板
    m2, nt2, out2 = mat_base('FarForest')
    N2, L2 = nt2.nodes, nt2.links
    t2 = tex_node(nt2, image('treeline_a.png'), 'EXTEND')
    t2.extension = 'MIRROR'
    t2.image.alpha_mode = 'STRAIGHT'
    e2 = N2.new('ShaderNodeEmission')
    e2.inputs[1].default_value = .12
    L2.new(t2.outputs[0], e2.inputs[0])
    tr = N2.new('ShaderNodeBsdfTransparent')
    ms = N2.new('ShaderNodeMixShader')
    L2.new(t2.outputs['Alpha'], ms.inputs[0])
    L2.new(tr.outputs[0], ms.inputs[1])
    L2.new(e2.outputs[0], ms.inputs[2])
    L2.new(ms.outputs[0], out2.inputs[0])
    m2.cycles.emission_sampling = 'NONE'
    b2 = B()
    rows = [[(150 * math.cos(TAU * j / n), 150 * math.sin(TAU * j / n), z) for j in range(n)] for z in (-6, 84)]
    b2.grid(rows, closed=True, us=5, vs=1.0, flip=True)
    o2 = b2.obj('FarForest', [m2])
    o2.visible_shadow = False


def pave_mesh(name, stones, mat, rim, inner, seed):
    """stones は (x, y, 幅, 奥行き) の列。石 1 個を格子にする。rim は縁から測った頂点の列の距離(m)で、0 は目地へ落ちる壁の上端。
    輪郭は角を丸めてから揺らし、石ごとに傾ける"""
    rng = np.random.default_rng(seed)
    st = np.array(stones)
    n = len(st)
    rim = np.array(rim)
    M = 2 * len(rim) + inner
    gap = rng.uniform(.004, .008, n)[:, None, None]
    hw, hh = st[:, 2, None, None] / 2 - gap, st[:, 3, None, None] / 2 - gap

    def axis(half):
        a = half[:, 0]
        t = np.linspace(0, 1, inner + 2)[1:-1]
        start = -a + rim[None]
        mid = -(a - rim[-1]) * (1 - 2 * t)[None]
        return np.concatenate([start, mid, -start[:, ::-1]], 1)

    X = np.repeat(axis(hw)[:, :, None], M, 2)
    Y = np.repeat(axis(hh)[:, None, :], M, 1)
    r = np.minimum(rng.uniform(.03, .07, n)[:, None, None], hh * .8)
    dx, dy = np.maximum(np.abs(X) - (hw - r), 0), np.maximum(np.abs(Y) - (hh - r), 0)
    ln, mx = np.hypot(dx, dy), np.maximum(dx, dy)
    f = np.where(ln > 0, mx / np.maximum(ln, 1e-6), 1)
    corner = (dx > 0) & (dy > 0)
    dist = np.minimum(hw - np.abs(X), hh - np.abs(Y))
    X, Y = np.where(corner, np.sign(X) * (hw - r + dx * f), X), np.where(corner, np.sign(Y) * (hh - r + dy * f), Y)
    # 輪郭の揺れ。内側へ縮むだけなので隣の石に刺さらない
    ang = np.arctan2(Y / hh, X / hw)
    amp = rng.uniform(.002, .005, n)[:, None, None]
    ph = rng.uniform(0, TAU, (4, n))[:, :, None, None]
    wob = amp * (1.25 + .8 * np.sin(ang * 3 + ph[0]) + .35 * np.sin(ang * 5 + ph[1]) + .25 * np.sin(ang * 11 + ph[2]) + .15 * np.sin(ang * 23 + ph[3]))
    wob = wob * np.clip(1 - dist / .08, 0, 1)
    X, Y = X - wob * np.cos(ang), Y - wob * np.sin(ang)
    bev = rng.uniform(.022, .042, n)[:, None, None]
    E = np.clip(1 - dist / bev, 0, 1)
    tilt = rng.normal(0, .0035, (2, n))[:, :, None, None]
    Z = rng.normal(0, .0025, n)[:, None, None] + tilt[0] * X / hw + tilt[1] * Y / hh
    Z = Z + rng.uniform(.006, .016, n)[:, None, None] * (1 - (X / hw) ** 2) * (1 - (Y / hh) ** 2)
    Z = Z - rng.uniform(.011, .02, n)[:, None, None] * (1 - np.sqrt(np.clip(1 - E ** 2, 0, 1)))
    Z = np.where(dist < 1e-6, -.055, Z)
    rot = rng.normal(0, .007, n)[:, None, None]
    x = st[:, 0, None, None] + st[:, 2, None, None] / 2 + X - rot * Y + rng.normal(0, .002, n)[:, None, None]
    y = st[:, 1, None, None] + st[:, 3, None, None] / 2 + Y + rot * X + rng.normal(0, .004, n)[:, None, None]
    v = np.stack([x, y, Z], -1).reshape(-1, 3).astype(np.float32)
    q = np.array([(i * M + j, (i + 1) * M + j, (i + 1) * M + j + 1, i * M + j + 1) for i in range(M - 1) for j in range(M - 1)])
    Q = len(q)
    faces = (q[None] + (np.arange(n) * M * M)[:, None, None]).reshape(-1)
    me = bpy.data.meshes.new(name)
    me.vertices.add(n * M * M)
    me.vertices.foreach_set('co', v.ravel())
    me.loops.add(len(faces))
    me.loops.foreach_set('vertex_index', faces.astype(np.int32))
    me.polygons.add(n * Q)
    me.polygons.foreach_set('loop_start', np.arange(n * Q, dtype=np.int32) * 4)
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', [True] * (n * Q))
    me.uv_layers.new(name='UVMap').uv.foreach_set('vector', v[:, :2][faces].ravel())
    rs = np.repeat(rng.random((n, 3)), M * M, axis=0)
    me.uv_layers.new(name='S').uv.foreach_set('vector', rs[:, :2][faces].astype(np.float32).ravel())
    ee = np.stack([E.reshape(-1), rs[:, 2]], 1)
    me.uv_layers.new(name='E').uv.foreach_set('vector', ee[faces].astype(np.float32).ravel())
    me.materials.append(mat)
    me.update()
    return add(name, me)


def pavers(mat, dirt):
    """不揃いな小ぶりの石。列は左右で共通で、縦の目地の位置を列ごとにずらす。手前の 3 列だけ左右で列の高さが違う(目標の位置)"""
    rng = np.random.default_rng(5)
    cut = lambda py: G(470, py).y

    def fill(y0, y1, lo, hi):
        n = max(1, round((y1 - y0) / ((lo + hi) / 2)))
        w = rng.uniform(.8, 1.2, n)
        e = y0 + (y1 - y0) * np.concatenate([[0], np.cumsum(w) / w.sum()])
        return list(zip(e[:-1], e[1:]))

    def stagger(rows):
        out, s = [], 0.0
        for r in rows:
            while True:
                t = rng.uniform(-.1, .1)
                if abs(t - s) > .045:
                    break
            s = t
            out.append((r, .05 + s))
        return out

    back = stagger(fill(-34, cut(1790), .3, .44))
    front = stagger([(cut(1300), cut(1235))] + fill(cut(1235), STAIR_Y0, .36, .5))
    seam = .145  # 手前の 3 列の縦の目地
    left = [(cut(1790), cut(1475)), (cut(1475), cut(1365)), (cut(1365), cut(1300))]
    right = [(cut(1790), cut(1430)), (cut(1430), cut(1300))]
    near, far = [], []
    for sg, mid in ((-1, left), (1, right)):
        for (y0, y1), s in back + [(r, seam) for r in mid] + front:
            x = s
            while abs(x - .1) < 15:
                w = rng.uniform(.46, .92)
                (near if abs(x - .1) < 8 else far).append((x if sg > 0 else x - w, y0, w, y1 - y0))
                x += sg * w
    tufts = [(s_ + rng.normal(0, .014), y_, rng.uniform(-.03, -.012)) for (y0, y1), s_ in back + [(r, seam) for r in left] + front if -9 < y0 < 6 for y_ in rng.uniform(y0, y1, int((y1 - y0) * 45))]
    instance_verts('MossTufts', tufts, sphere_mesh('MossTuft', .0095, pbr('MossTuft', (.09, .11, .025, 1), .8, spec=.1, emit=(.2, .22, .05, 1), emit_k=.05), 1))
    pave_mesh('Pavers', near, mat, (0, .002, .008, .018, .032, .055), 7, 6)
    pave_mesh('PaversFar', far, mat, (0, .018, .05), 3, 7)
    g = B()
    g.grid([[(-15.5, -34, -.026), (15.5, -34, -.026)], [(-15.5, STAIR_Y0, -.026), (15.5, STAIR_Y0, -.026)]], us=31 / .55, vs=41 / .55)
    g.obj('Joints', [dirt])


def ground_h(x, y):
    ax = abs(x)
    t = max(0.0, min(1.0, (y - (STAIR_Y0 + .1)) / (STAIR_Y1 - STAIR_Y0 - .1)))
    z = TERRACE * t * t * (3 - 2 * t) - .05
    if y < STAIR_Y0 + 1:
        s = max(0.0, min(1.0, (ax - 9.0) / 14.0))
        z = max(z, 2.2 * s * s * (3 - 2 * s) - .06)
    if ax > 9.5 or y > STAIR_Y1 + 13:
        z += .9 * noise.noise(Vector((x * .09, y * .09, 1.3)))
    return z


def terrain(mat):
    b = B()
    xs = [-90 + i * 1.5 for i in range(121)]
    ys = [-80 + i * 1.5 for i in range(121)]
    rows = [[(x, y, ground_h(x, y)) for x in xs] for y in ys]
    b.grid(rows, us=70, vs=70)
    b.obj('Terrain', [mat])


# ---- 鳥居 ----
def torii(name, mats, at, k=1.0):
    """朱の鳥居。k で全体の大きさを変える。柱は内へ傾き、笠木は端が反る。mats は (朱, 黒, 台石)"""
    cx, cy = at
    b = B()
    W0, W1, TOP = 2.9 * k, 2.68 * k, 7.24 * k
    leanx = (W1 - W0) / TOP
    for sg in (-1, 1):
        c = (cx + sg * W0, cy, 0)
        lean = (sg * leanx, 0)
        b.lathe([(.001, .05 * k), (.40 * k, .05 * k), (.385 * k, TOP * .55), (.355 * k, TOP), (.001, TOP)], 32, c, 0, us=1.5, vs=2.4 * k, lean=lean)
        # 根巻は粗い暗い石
        b.lathe([(.53 * k, .28 * k), (.53 * k, .9 * k), (.45 * k, .96 * k), (.4 * k, .96 * k)], 24, (c[0], cy, 0), 3, us=2, lean=lean)
        b.lathe([(.001, 0), (.82 * k, 0), (.82 * k, .12 * k), (.66 * k, .3 * k), (.001, .3 * k)], 12, (c[0], cy, 0), 2, us=2, smooth=False)
    nuki = lambda x: (x * k + cx, cy, (6.19 - .044 * x) * k)  # 貫は右下がり
    b.beam([nuki(x) for x in (-4.2, 0, 4.2)], None, (.13 * k, .23 * k), 0, tex=3.4, r=.02 * k)
    for sg in (-1, 1):
        b.box(nuki(sg * 3.15), (.3 * k, .38 * k, .56 * k), 0, tex=3.4)
    b.box((cx, cy, 6.8 * k), (.62 * k, .24 * k, .84 * k), 0, tex=3.4)

    def lift(u, tilt):
        return k * (.16 * abs(u) ** 2.4 + .2 * abs(u) ** 9 - tilt * u)

    def pts(z, half, tilt):
        return [(cx + u * half, cy, z * k + lift(u, tilt)) for u in [i / 20 - 1 for i in range(41)]]

    for sg in (-1, 1):  # 柱の上の台輪
        b.lathe([(.4 * k, TOP - .3 * k), (.44 * k, TOP - .28 * k), (.44 * k, TOP - .1 * k), (.38 * k, TOP - .06 * k)], 28, (cx + sg * W1, cy, 0), 1, us=2)
    b.beam(pts(7.36, 4.55 * k, .24), None, (.28 * k, .2 * k), 0, tex=3.4, r=.04 * k)
    b.beam([(x_ + .05 * k, y_, z_) for x_, y_, z_ in pts(7.76, 4.74 * k, .42)], None, (.58 * k, .25 * k), 1, tex=1.2, r=.08 * k)
    return b.obj(name, mats)


# ---- 石灯籠と灯り ----
def square_prof(b, c, prof, mat, us=2.0):
    """四角い断面の積み上げ。prof は (半分の幅, 高さ)"""
    b.lathe([(a * math.sqrt(2), z) for a, z in prof], 4, c, mat, smooth=False, us=us, ph=math.pi / 4)


def stone_lantern(b, g, c, s=1.0, st=0):
    """四角い笠の石灯籠。b に石を足し、g に火袋の光る面を足す"""
    x, y = c
    C = (x, y, 0)
    h, s = s, s * .8  # 高さの倍率と幅の倍率
    square_prof(b, C, [(.54 * s, 0), (.54 * s, .28 * h), (.5 * s, .31 * h), (.001, .31 * h)], st)
    square_prof(b, C, [(.42 * s, .31 * h), (.42 * s, .62 * h), (.38 * s, .66 * h), (.001, .66 * h)], st)
    square_prof(b, C, [(.3 * s, .66 * h), (.25 * s, .86 * h), (.24 * s, 1.0 * h), (.25 * s, 1.26 * h), (.31 * s, 1.5 * h), (.001, 1.5 * h)], st)
    for i in range(2):  # 竿の彫りの線
        z = (.96 + i * .3) * h
        square_prof(b, C, [(.265 * s, z), (.265 * s, z + .03 * h), (.001, z + .03 * h)], st, us=1)
    square_prof(b, C, [(.3 * s, 1.5 * h), (.41 * s, 1.56 * h), (.41 * s, 1.72 * h), (.33 * s, 1.76 * h), (.001, 1.76 * h)], st)
    z0, z1 = 1.76 * h, 2.14 * h
    a = .28 * s
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.box((x + sx * a, y + sy * a, (z0 + z1) / 2), (.07 * s, .07 * s, z1 - z0), st, tex=.6)
    for i in range(3):
        off = (i - 1) * a * .55
        for sg in (-1, 1):
            b.box((x + off, y + sg * a, (z0 + z1) / 2), (.018 * s, .03 * s, z1 - z0), st, tex=.6)
            b.box((x + sg * a, y + off, (z0 + z1) / 2), (.03 * s, .018 * s, z1 - z0), st, tex=.6)
    for k in (.33, .66):
        z = z0 + (z1 - z0) * k
        for sg in (-1, 1):
            b.box((x, y + sg * a, z), (2 * a, .03 * s, .018 * s), st, tex=.6)
            b.box((x + sg * a, y, z), (.03 * s, 2 * a, .018 * s), st, tex=.6)
    square_prof(g, C, [(a * .96, z0), (a * .96, z1)], 0, us=1)
    b.grid(roof_rows(.62 * s, .62 * s, .03 * s, z1 + .06 * h, z1 + .5 * h, (x, y), m=8, sori=.32 * h, sag=.72, p=6), closed=True, mat=st, us=2.4, vs=.7, flip=True)
    square_prof(b, C, [(.52 * s, z1), (.6 * s, z1 + .05 * h), (.6 * s, z1 + .08 * h)], st)
    b.lathe([(.001, z1 + .45 * h), (.2 * s, z1 + .5 * h), (.13 * s, z1 + .58 * h), (.24 * s, z1 + .67 * h), (.14 * s, z1 + .76 * h), (.17 * s, z1 + .82 * h), (.1 * s, z1 + .9 * h), (.001, z1 + .95 * h)], 12, C, st, us=1)


def post_lamp_mesh(red, dark, glow):
    """朱の柱の上の灯籠。朱の枠の火袋に和紙の面、反った黒い屋根、宝珠"""
    b = B()
    b.lathe([(.05, 0), (.05, 1.28)], 10, mat=0, us=1, vs=2)
    b.box((0, 0, 1.3), (.22, .22, .04), 0, tex=.5)
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.box((sx * .095, sy * .095, 1.5), (.025, .025, .38), 0, tex=.5)
    for z in (1.33, 1.67):
        for sg in (-1, 1):
            b.box((0, sg * .095, z), (.2, .018, .02), 0, tex=.5)
            b.box((sg * .095, 0, z), (.018, .2, .02), 0, tex=.5)
    b.box((0, 0, 1.5), (.175, .175, .35), 2, tex=.5)
    b.grid(roof_rows(.27, .27, .012, 1.7, 1.96, (0, 0), m=6, sori=.07, sag=.85, p=4), closed=True, mat=1, us=2, flip=True)
    b.lathe([(.001, 1.69), (.27, 1.69)], 4, mat=1, smooth=False, ph=math.pi / 4)
    b.lathe([(.03, 1.94), (.035, 1.97), (.015, 2.02), (.001, 2.05)], 8, mat=1)
    return b.mesh('PostLamp', [red, dark, glow])


def lantern_mesh(paper, cap, tassel):
    """吊り和提灯。原点が吊り点。下ぶくれの紙に竹の骨の波、黒い口輪、下に房"""
    b = B()
    H, R = .62, .195
    top = -.09
    prof = []
    n = 44
    for i in range(n + 1):
        t = i / n
        r = R * math.sin(math.pi * (.13 + .74 * t)) ** .55 * (1 + .1 * (.5 - t)) * (1 + .014 * math.cos(t * TAU * 15))
        prof.append((r, top - H + H * t))
    b.lathe(prof, 26, us=1, mat=0)
    bz = top - H
    b.lathe([(.001, bz - .035), (.086, bz - .035), (.092, bz + .012), (.075, bz + .03)], 14, mat=1)
    b.lathe([(.075, top - .02), (.1, top - .01), (.1, top + .03), (.012, top + .036)], 14, mat=1)
    b.lathe([(.005, top + .03), (.005, 0)], 5, mat=1)
    b.lathe([(.005, bz - .24), (.005, bz - .03)], 5, mat=2)
    b.lathe([(.001, bz - .34), (.022, bz - .3), (.012, bz - .22), (.001, bz - .2)], 8, mat=2)
    return b.mesh('Lantern', [paper, cap, tassel])


def hang_lanterns(name, keys, pts, meshes, rope, size=1.0, drop=.1, extra=None, wire_r=.012):
    """縄の通る点の列 pts の各点に提灯を吊る。pts は提灯の吊り点。extra は縄だけが通る端の点"""
    pts = [Vector(p) for p in pts]
    line = ([Vector(extra[0])] if extra else []) + pts + ([Vector(extra[1])] if extra else [])
    dense = []
    for a, c in zip(line, line[1:]):
        for i in range(8):
            t = i / 8
            dense.append(a + (c - a) * t + Vector((0, 0, -.12 * (a - c).length / 2 * 4 * t * (1 - t) * .5)))
    dense.append(line[-1])
    wb = B()
    wb.tube(dense, wire_r, 5)
    wb.obj(name + 'Rope', [rope])
    for i, p in enumerate(pts):
        o = add(f'{name}{i}', meshes[i % len(meshes)], None, p, (0, 0, i * 1.3), size)
        keys['sway'].append((o, i * .9 + p.x))


# ---- 石段 ----
def stairs(mats):
    """石段。1 段が幅の違う石の並びで、段鼻は丸く、手すりと親柱が両脇に下りる。mats は (段の石, 手すりの石)"""
    rng = random.Random(3)
    b = B()
    n = 18
    run = (STAIR_Y1 - STAIR_Y0) / n
    rise = TERRACE / n
    for i in range(n):
        y0 = STAIR_Y0 + i * run
        z = (i + 1) * rise
        half = STAIR_W0 + (STAIR_W1 - STAIR_W0) * i / (n - 1)
        b.box((0, y0 + (STAIR_Y1 - y0) / 2 + .01, (z - .07) / 2), (half * 2, STAIR_Y1 - y0, z - .07), 1, tex=1.5)
        x = -half
        while x < half - .02:  # 1 段の石。長さと高さが少しずつ違う
            w = min(half - x, rng.uniform(.55, 1.15))
            if half - x - w < .3:
                w = half - x
            dz, dy = rng.uniform(-.008, .008), rng.uniform(-.012, .012)
            pts = [(x + .006, y0 + dy, z - .025 + dz), (x + w - .006, y0 + dy, z - .025 + dz)]
            b.beam(pts, None, (.04, .036), 0, tex=1.5, r=.03)  # 段鼻
            b.box((x + w / 2, y0 + .14 + dy, z - .03 + dz), (w - .012, .28, .06), 1, tex=1.5)
            x += w
    # 一番下の広い段
    b.box((0, STAIR_Y0 - .16, .05), (STAIR_W0 * 2 + .46, .34, .1), 0, tex=1.5)
    b.obj('Stairs', mats[:2])
    f = B()
    for sg in (-1, 1):
        x0 = sg * (STAIR_W0 + .17)
        x1 = sg * (STAIR_W1 + .17)
        H = .62

        def rail(t):
            return Vector((x0 + (x1 - x0) * t, STAIR_Y0 + (STAIR_Y1 - STAIR_Y0) * t, TERRACE * t))

        # 袖の石の壁と笠石。上に親柱を 4 本
        rows = [[rail(j / 8) + Vector((sg * .05, 0, -.5)), rail(j / 8) + Vector((sg * .05, 0, H - .1))] for j in range(9)]
        f.grid(rows, mat=0, us=3, vs=.7, flip=sg > 0)
        rows = [[rail(j / 8) + Vector((-sg * .05, 0, 0)), rail(j / 8) + Vector((-sg * .05, 0, H - .1))] for j in range(9)]
        f.grid(rows, mat=0, us=3, vs=.7, flip=sg < 0)
        f.beam([rail(t) + Vector((0, 0, H)) for t in (0, 1)], None, (.075, .06), 0, tex=1.0, r=.025)
        for t in (0, .34, .67, 1):
            p = rail(t)
            r = .095 if t else .12
            h = (H + .24) if t else 1.0
            f.box((p.x, p.y, p.z + h / 2), (r * 2, r * 2, h), 0, tex=1.0)
            square_prof(f, (p.x, p.y, p.z), [(r + .02, h), (r + .05, h + .05), (r * .7, h + .14), (.001, h + .17)], 0, us=1)
        # 下の玉垣。親柱と横の桟
        y = STAIR_Y0 - .12
        posts = [sg * (STAIR_W0 + .5 + i * .42) for i in range(9)]
        for x in posts:
            f.box((x, y, .58), (.2, .17, 1.08), 0, tex=1.0)
            square_prof(f, (x, y, 0), [(.11, 1.12), (.13, 1.16), (.07, 1.24), (.001, 1.26)], 0, us=1)
        c = (posts[0] + posts[-1]) / 2
        L = abs(posts[-1] - posts[0])
        f.box((c, y, .93), (L, .1, .13), 0, tex=1.0)
        f.box((c, y, .46), (L, .07, .09), 0, tex=1.0)
        f.box((c, y, .09), (L + .4, .34, .18), 0, tex=1.0)
        # 上の玉垣
        y = STAIR_Y1 + .1
        posts = [sg * (STAIR_W1 + .4 + i * .55) for i in range(6)]
        for x in posts:
            f.box((x, y, TERRACE + .42), (.17, .15, .86), 0, tex=1.0)
        c = (posts[0] + posts[-1]) / 2
        f.box((c, y, TERRACE + .72), (abs(posts[-1] - posts[0]), .08, .11), 0, tex=1.0)
    f.obj('Fence', [mats[2]])


def bank(mats):
    """石段の両脇の苔の斜面と岩。mats は (土、岩)"""
    rng = random.Random(6)
    g = B()
    for sg in (-1, 1):
        xs = [sg * (1.9 + i * .3) for i in range(46)]
        ys = [6.95 + j * .3 for j in range(20)]
        rows = []
        for y in ys:
            rows.append([(x, y, ground_h(x, y) + .1 + .14 * noise.noise(Vector((x * .9, y * .9, 4.0))) + .05 * noise.noise(Vector((x * 3, y * 3, 2.0)))) for x in xs])
        g.grid(rows, us=14, vs=6, flip=sg < 0)
    g.obj('Bank', [mats[0]])
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
    for v in bm.verts:
        n_ = noise.noise(v.co * 1.7 + Vector((3, 1, 2))) * .32 + noise.noise(v.co * 4.0) * .12
        v.co *= 1 + n_
    me = bpy.data.meshes.new('Rock')
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    uv = me.uv_layers.new(name='UVMap')
    for lp in me.loops:
        c = me.vertices[lp.vertex_index].co
        uv.uv[lp.index].vector = (c.x * .7 + c.y * .4, c.z * .7 + c.y * .4)
    me.materials.append(mats[1])
    for i in range(70):
        sg = rng.choice((-1, 1))
        x, y = sg * rng.uniform(2.3, 7.5), rng.uniform(7.25, 11.6)
        s_ = rng.uniform(.16, .46)
        o = add(f'Rock{i}', me, None, (x, y, ground_h(x, y) + s_ * .35), (rng.uniform(0, 3), rng.uniform(0, 3), rng.uniform(0, 3)))
        o.scale = (s_ * rng.uniform(.9, 1.5), s_, s_ * rng.uniform(.6, .9))


# ---- 社殿 ----
def roof_rows(a0, b0, ridge, z_e, z_r, c, m=14, sori=.5, sag=1.6, p=20):
    """四方に流れる反った屋根の格子。a0、b0 は軒の半分の幅と奥行き。ridge は棟の半分の長さ"""
    cx, cy = c
    rows = []
    for i in range(m + 1):
        t = i / m
        a = a0 + (ridge - a0) * t
        bb = b0 * (1 - t) + .02 * t
        z = z_e + (z_r - z_e) * t ** sag
        row = []
        for s, (x0, y0, x1, y1) in enumerate(((-a, -bb, a, -bb), (a, -bb, a, bb), (a, bb, -a, bb), (-a, bb, -a, -bb))):
            for j in range(p):
                u = j / p
                x, y = x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
                corner = (abs(x) / max(a, 1e-3)) * (abs(y) / max(bb, 1e-3))
                row.append((cx + x * (1 + .05 * corner ** 3), cy + y * (1 + .05 * corner ** 3), z + sori * (1 - t) ** 2 * corner ** 4))
        rows.append(row)
    return rows


def hall():
    """社殿。入母屋の大屋根、その前の千鳥の破風と唐破風の 3 段。寸法は目標の画素から逆算した。答えは (本体, 光る窓, 電球の点, 綱の高さ)"""
    wood, red, dark, gold, tile, door, carve, step, lat = range(9)
    b = B()
    g = B()
    yp, yw, y1 = 13.0, 14.3, 19.4  # 向拝の柱、本体の正面、本体の背面
    fl = 3.46
    hw = 2.75
    cy = (yw + y1) / 2
    # 基壇と床
    b.box((0, (yp + y1) / 2 - .1, (TERRACE + fl) / 2), (hw * 2 + 1.2, y1 - yp + 1.2, fl - TERRACE + .02), step, tex=1.5)
    # 本体の壁
    for (x0, y_0), (x1_, y_1) in (((-hw, y1), (hw, y1)), ((hw, yw), (hw, y1)), ((-hw, y1), (-hw, yw))):
        b.grid([[(x0, y_0, fl), (x1_, y_1, fl)], [(x0, y_0, fl + 3.3), (x1_, y_1, fl + 3.3)]], mat=wood, us=4, vs=2)
    b.grid([[(-hw, yw, fl), (hw, yw, fl)], [(-hw, yw, fl + 3.3), (hw, yw, fl + 3.3)]], mat=dark, us=4, vs=2, flip=False)
    # 柱。黒ずんだ古い木
    for x in (-1.5, 1.5):
        b.lathe([(.17, 0), (.15, 2.98)], 14, (x, yp, fl), wood, us=1, vs=1.6)
        for z in (.45, 2.72):
            b.lathe([(.19, z - .05), (.19, z + .05)], 14, (x, yp, fl), gold, us=1)
        b.box((x, (yp + yw) / 2, fl + 2.55), (.16, yw - yp, .22), dark, tex=1.5)
    for x in (-2.75, -1.5, 1.5, 2.75):
        b.lathe([(.16, 0), (.14, 3.3)], 12, (x, yw, fl), wood, us=1, vs=1.6)
    # 貫と虹梁
    b.box((0, yp, 5.9), (3.5, .16, .24), dark, tex=1.5)
    b.box((0, yp, 6.42), (3.8, .18, .3), wood, tex=1.5)
    b.box((0, yw - .1, 6.5), (hw * 2, .2, .28), dark, tex=1.5)
    for x in (-1.0, 0, 1.0):
        b.box((x, yp, 6.18), (.3, .12, .22), carve, tex=.6)
    # 中央の扉まわり。下の格子の窓と 2 つの灯り
    for x, w_ in ((-.95, .78), (.95, .78)):
        b.grid([[(x - w_ / 2, yw - .05, fl + .16), (x + w_ / 2, yw - .05, fl + .16)], [(x - w_ / 2, yw - .05, fl + 2.1), (x + w_ / 2, yw - .05, fl + 2.1)]], mat=lat, flip=False, us=.45, vs=.9)
    b.grid([[(-.56, yw - .05, fl + .1), (.56, yw - .05, fl + .1)], [(-.56, yw - .05, fl + 1.9), (.56, yw - .05, fl + 1.9)]], mat=lat, us=.4, vs=.9)
    for x in (-2.2, 2.2):  # 脇の格子窓
        b.grid([[(x - .42, yw - .05, fl + .5), (x + .42, yw - .05, fl + .5)], [(x - .42, yw - .05, fl + 2.3), (x + .42, yw - .05, fl + 2.3)]], mat=lat, flip=False, us=.45, vs=.9)
    for x in (-1.37, .98):  # 細長い行灯
        g.box((x, yp + .25, fl + 1.1), (.3, .2, .82), 0, tex=1)
        b.box((x, yp + .25, fl + 1.53), (.36, .26, .05), dark, tex=1)
        b.box((x, yp + .25, fl + .67), (.36, .26, .05), dark, tex=1)
        b.box((x, yp + .25, fl + .3), (.05, .05, .6), dark, tex=1)
    # 賽銭箱と奥の暗がり
    b.box((0, yp - .2, fl + .24), (1.5, .55, .48), dark, tex=1)
    b.box((0, yp - .2, fl + .5), (1.66, .66, .05), dark, tex=1)
        # 手すりと縁
    b.box((0, (yp + yw) / 2, fl + .02), (hw * 2 + .5, yw - yp + .3, .08), wood, tex=1.6)
    # 大屋根。軒、瓦、棟
    ye, yb = yp + .15, y1 + 1.0
    cr = (ye + yb) / 2
    br = (yb - ye) / 2
    z_e, z_r = 6.82, 10.3
    sag = 1.22
    b.grid(roof_rows(3.42, br, 3.05, z_e, z_r, (0, cr), m=16, sori=.5, sag=sag), closed=True, mat=tile, us=20, vs=3.3, flip=True)
    b.grid(roof_rows(3.42, br, 3.05, z_e - .14, z_r - .14, (0, cr), m=4, sori=.5, sag=sag), closed=True, mat=dark, us=14, vs=2)
    rows = roof_rows(3.42, br, 3.05, z_e, z_r, (0, cr), m=16, sori=.5, sag=sag)
    b.tube(rows[0] + [rows[0][0]], .05, 5, dark)
    for sg in (-1, 1):  # 四隅の降り棟
        pts = [(sg * (3.46 + (3.05 - 3.46) * i / 8), ye + (cr - ye) * i / 8 + .0, z_e + .3 * (1 - i / 8) ** 2 + (z_r - z_e) * (i / 8) ** sag + .08) for i in range(9)]
        b.beam(pts, None, (.06, .09), dark, tex=1.2)
    ridge = [(x_, cr, z_r + .08 + .24 * (abs(x_) / 3.3) ** 2.4) for x_ in [-3.3 + i * .22 for i in range(31)]]  # 棟は端で緩く反る
    b.beam(ridge, None, (.14, .17), dark, tex=1.5, r=.05)
    for sg in (-1, 1):  # 棟の端の鬼瓦
        b.box((sg * 3.3, cr, z_r + .4), (.2, .4, .62), dark, tex=1)
        b.box((sg * 3.36, cr, z_r + .74), (.28, .3, .12), dark, tex=1)

    def main_y(z):
        t = max(0.0, (z - z_e) / (z_r - z_e)) ** (1 / sag)
        return ye + t * br

    # 千鳥の破風
    py, ph, ghw, gz = yp + .02, 9.1, 2.15, 7.5

    def rake(u):
        return ph - (ph - gz) * u ** .72 + .1 * u ** 8  # 破風の線は上が急で、下で緩く反る

    for sg in (-1, 1):
        rows = []
        for i in range(13):
            u = i / 12
            x, z = sg * ghw * u, rake(u) + .1
            yb_ = main_y(z) + .12
            rows.append([(x * (1 - .06 * j / 6), py + (yb_ - py) * j / 6, z + .03 * j) for j in range(7)])
        b.grid(rows, mat=tile, us=2, vs=2.6, flip=sg < 0)
        pts = [(sg * ghw * i / 16 * 1.03, py - .1, rake(i / 16) + .06) for i in range(17)]
        b.beam(pts, None, (.075, .16), dark, tex=1.5, r=.03)
        b.beam([(p[0], p[1] - .09, p[2] + .05) for p in pts[::2]], None, (.022, .022), gold, tex=1.5, r=.008)
    xs = [-ghw + i * ghw / 10 for i in range(21)]
    b.grid([[(x, py, rake(abs(x) / ghw) - .08) for x in xs], [(x, py, gz - .1) for x in xs]], mat=carve, flip=True, us=1, vs=.82)
    # 懸魚と棟飾り
    b.lathe([(.001, -.04), (.34, -.04), (.34, .04), (.001, .04)], 6, (0, 0, 0), carve, smooth=False)  # 下で向きを変える
    k_ = len(b.v) - 4 * 6
    for i in range(k_, len(b.v)):  # 六角の懸魚を正面へ向ける
        vx, vy, vz = b.v[i]
        b.v[i] = (vx, py - .18 + vz, ph - .66 + vy)
    b.box((0, py - .1, ph + .12), (.22, .24, .3), dark, tex=1)
    square_prof(b, (0, py, ph + .25), [(.2, 0), (.16, .22), (.06, .42), (.001, .5)], dark, us=1)
    b.beam([(0, py, ph + .08), (0, main_y(ph) + .2, ph + .12)], None, (.09, .1), dark, tex=1.5, r=.03)
    # 唐破風
    ky, kh = yp - .35, 2.7
    kz = 6.86

    def wave(x):
        u = min(1.0, abs(x) / kh)
        return kz + .92 * ((math.cos(u * math.pi) + 1) / 2) ** 1.2 + .1 * u ** 7

    kxs = [-kh + i * kh / 18 for i in range(37)]
    for j, (dy, dz) in enumerate(((0, .1),)):
        rows = [[(x, ky + (yp + 1.05 - ky) * k / 8, wave(x) + dz + 1.3 * (k / 8) ** 1.3 * (1 - .75 * abs(x) / kh)) for x in kxs] for k in range(9)]
        b.grid(rows, mat=tile, us=4, vs=1.2, flip=True)
    b.beam([(x, ky - .03, wave(x)) for x in kxs], None, (.09, .19), dark, tex=1.5, r=.03)
    b.beam([(x, ky - .12, wave(x) + .06) for x in kxs[::2]], None, (.02, .02), gold, tex=1.5, r=.008)
    b.grid([[(x, ky + .06, wave(x) - .08) for x in kxs], [(x, ky + .06, 6.56) for x in kxs]], mat=carve, us=2.4, vs=.5, flip=True)
    b.box((0, ky - .08, wave(0) - .3), (.9, .05, .3), dark, tex=1)  # 中央の懸魚
    b.box((0, ky - .11, wave(0) - .3), (.76, .04, .22), carve, tex=.7)
    b.box((0, ky - .13, wave(0) - .46), (.2, .04, .16), gold, tex=1)
    b.grid([[(x, ky, 6.56) for x in (-kh, kh)], [(x, yw, 6.56) for x in (-kh, kh)]], mat=dark, flip=True)  # 軒裏
    b.grid([[(x, ye - .05, z_e - .14) for x in (-3.4, 3.4)], [(x, yw, 6.8) for x in (-3.4, 3.4)]], mat=dark, flip=True)
    # 組物の金具と垂木
    for sg in (-1, 1):
        for x in (1.2, 1.95, 2.7):
            b.box((sg * x, ye + .05, 6.6), (.16, .24, .16), gold if x == 1.95 else dark, tex=1)
    bulbs = [(-3.1 + i * .124, yp - .42, 6.0 + .16 * (abs(-3.1 + i * .124) / 3.1) ** 4) for i in range(51)]
    return b, g, bulbs, ky


def shimenawa(mats, y, z, half):
    """注連縄と紙垂と中央の房。mats は (縄, 紙)"""
    b = B()
    n = 60
    pts = [(-half + 2 * half * i / n, y, z - .32 * 4 * (i / n) * (1 - i / n)) for i in range(n + 1)]

    def r0(t):
        return .04 + .075 * math.sin(math.pi * t) ** .8

    for tw in range(3):  # 3 本の縄をより合わせる
        a0 = tw * TAU / 3
        tp = [(p[0], p[1] + .55 * r0(i / n) * math.cos(a0 + i * .75), p[2] + .55 * r0(i / n) * math.sin(a0 + i * .75)) for i, p in enumerate(pts)]
        b.tube(tp, lambda t: r0(t) * .62, 8, 0, us=1, vs=12)
    s = B()
    for x in (-.84, -.5, .34, .7):  # 紙垂は折れて下へ広がる
        t = (x + half) / (2 * half)
        zt = z - .32 * 4 * t * (1 - t) - .1
        seg, w = .075, .03
        rows = []
        for j in range(7):
            off = (.5 - (j % 2)) * w * .75
            ww = w * (1 + j * .1)
            rows.append([(x - ww + off, y - .012 * (j % 2), zt - seg * j), (x + ww + off, y - .012 * (j % 2), zt - seg * j)])
        s.grid(rows, smooth=False)
    # 中央の白い房と綱
    s.lathe([(.001, 0), (.03, -.03), (.05, -.16), (.07, -.34), (.001, -.34)], 10, (-.05, y, z - .36), us=1)
    b.lathe([(.008, -1.62), (.008, -.4)], 6, (-.05, y, z - .36), 0, us=1, vs=4)
    b.obj('Rope', [mats[0]])
    s.obj('Shide', [mats[1]])


# ---- 屋台 ----
def stall(name, loc, side, L, mats, bulbs, seed=0, H=3.4, dep=2.9, top=1.1, cl=None, end=False, far=False, fr=0.0):
    """屋台。loc は通り側の縁の中央の地面の点、side は通りの向き(+1 は +X 向き)。L は庇の長さ(Y)。
    cl は台の長さ。end があれば手前の妻に縞の垂れと幕を付ける"""
    x0, y0 = loc
    rng = random.Random(seed)
    stripe, skirt, wood, shelf, dark = range(5)
    b = B()
    back = x0 - side * dep
    cl = cl or L
    cy = y0 - (L - cl) / 2

    def X(x):
        return x0 - side * x  # 通りの縁からの距離

    ribs = max(3, round(L / 1.6))
    for i in range(ribs + 1):
        y = y0 - L / 2 + L * i / ribs
        if i in (0, ribs) or i == ribs // 2:
            b.beam([(X(.2), y, 0), (X(.2), y, H - .05)], None, (.05, .05), wood, tex=.8, r=.015)
            b.beam([(back, y, 0), (back, y, H + .75)], None, (.05, .05), wood, tex=.8, r=.015)
        b.beam([(X(.0), y, H + .02), (back, y, H + .86)], None, (.025, .03), wood, tex=.8, r=.01)

    def roof_z(t, j):
        u = (j / 56 * ribs) % 1  # 骨の間で布がたわむ
        return H + .04 + .9 * t - .09 * math.sin(math.pi * u) * math.sin(math.pi * min(1, t * 1.1 + .05)) ** .5

    rows = []
    for i in range(13):
        t = i / 12
        rows.append([(x0 + side * .32 - side * (dep + .5) * t, y0 + (j / 56 - .5) * L * 1.02, roof_z(t, j)) for j in range(57)])
    b.grid(rows, mat=stripe, us=L / 2.4, vs=.5, flip=side > 0)
    # 前の垂れ。裾が半円に波打つ
    sc = max(6, round(L * 2.1))
    rows = []
    for k in range(4):
        d = .1 * k
        z_t = H + .04 - d * .9
        row = []
        for j in range(113):
            sag_ = .09 * abs(math.sin(j / 112 * math.pi * sc)) if k == 3 else 0
            row.append((x0 + side * (.34 + .01 * k), y0 + (j / 112 - .5) * L * 1.02, z_t + sag_ * -1 - (.04 * math.sin(j * .55) if k else 0)))
        rows.append(row)
    b.grid(rows, mat=stripe, us=L / 2.4, vs=.16, flip=side < 0)
    # 台と幕
    rows = []
    for z in (.03, top - .03):
        rows.append([(X(.3 + fr) + side * .02 * math.sin(j * 1.4), cy + (j / 24 - .5) * cl, z) for j in range(25)])
    b.grid(rows, mat=skirt, us=cl / 2.4, vs=.45, flip=side < 0)
    b.box((X(.6 + fr), cy, top + .01), (.82, cl + .1, .07), wood, tex=1)
    b.box((X(.72 + fr), cy, top / 2), (.7, cl, top - .02), dark, tex=1)
    # 奥の棚の絵と上の布
    b.grid([[(back + side * .04, y0 + (j - .5) * L, z) for j in (0, 1)] for z in (.3, 3.1)], mat=shelf, flip=side > 0)
    b.grid([[(back + side * .03, y0 + (j - .5) * L, z) for j in (0, 1)] for z in (3.1, H + 1.0)], mat=stripe, flip=side > 0, us=L / 2.4, vs=.4)
    b.box((back - side * .03, y0, .15), (.04, L, .3), dark, tex=1)
    for sy in (-1, 1):
        b.box(((x0 + back) / 2, y0 + sy * L / 2, .6), (dep, .03, 1.2), dark, tex=1)
    if far:  # 奥の妻は店の中身の棚。通りの手前から見える
        yf = y0 + L / 2 - .02
        b.grid([[(X(.1 + t * (dep - .2)), yf, z) for t in (0, 1)] for z in (top - .1, H + .55)], mat=shelf, flip=side > 0)
        b.box(((x0 + back) / 2, yf + .03, top / 2), (dep, .04, top), dark, tex=1)
    if end:  # 手前の妻。庇の下の縞の垂れと、台の横の幕
        ye = y0 - L / 2 - .02
        n_ = 40
        rows = []
        for k in range(3):
            row = []
            for j in range(n_ + 1):
                t = j / n_
                sag_ = .1 * abs(math.sin(t * math.pi * 7)) if k == 2 else 0
                z_t = H + .04 + .9 * t if k == 0 else H - .26 * k - sag_
                row.append((x0 + side * .3 - side * (dep + .4) * t, ye, z_t))
            rows.append(row)
        b.grid(rows, mat=stripe, us=(dep + .4) / 2.4, vs=.3, flip=side > 0)
        rows = [[(X(.3 + fr + t * (dep - .3 - fr)), cy - cl / 2 - .02 + .02 * math.sin(t * 9), z) for t in [i / 10 for i in range(11)]] for z in (.03, top - .03)]
        b.grid(rows, mat=skirt, us=(dep - .3) / 2.4, vs=.45, flip=side < 0)
    # 庇の下の電球
    for i in range(int(L / 1.3)):
        bulbs.append((X(.42), y0 - L / 2 + .6 + i * 1.3, H - .25))
    # 品物。鉢と束
    g = B()
    for i in range(int(cl * 3)):
        y = cy - cl / 2 + .25 + i * (cl - .5) / max(1, int(cl * 3) - 1)
        kind = rng.randrange(3)
        cx = X(.56 + rng.uniform(-.12, .12))
        if kind == 0:
            g.lathe([(.001, 0), (.09, .02), (.14, .1), (.13, .1), (.001, .05)], 10, (cx, y, top + .045), rng.randrange(3))
        elif kind == 1:
            for k in range(11):
                tip = (cx + rng.uniform(-.09, .09), y + rng.uniform(-.09, .09), top + .46 + rng.uniform(-.1, .08))
                g.tube([(cx + rng.uniform(-.02, .02), y + rng.uniform(-.02, .02), top + .04), tip], .008, 3, 3)
            g.lathe([(.075, 0), (.075, .2)], 8, (cx, y, top + .045), 1)
        else:
            g.box((cx, y, top + .1), (.2, .2, .13), rng.randrange(3), tex=1)
    b.obj(name, mats)
    return g


# ---- 杉 ----
def quad_cloud(name, quads, mat, seed=1):
    """枝の絵を貼った四角形の列を 1 つのメッシュにする。UV 'S' は 1 枚ごとの乱数"""
    rng = np.random.default_rng(seed)
    N = len(quads)
    v = np.array(quads, np.float32).reshape(-1, 3)
    me = bpy.data.meshes.new(name)
    me.vertices.add(N * 4)
    me.vertices.foreach_set('co', v.ravel())
    me.loops.add(N * 4)
    me.loops.foreach_set('vertex_index', np.arange(N * 4, dtype=np.int32))
    me.polygons.add(N)
    me.polygons.foreach_set('loop_start', np.arange(N, dtype=np.int32) * 4)
    me.update(calc_edges=True)
    flip = rng.random(N) < .5
    base = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float32)
    uv = np.tile(base, (N, 1, 1))
    uv[flip, :, 1] = 1 - uv[flip, :, 1]
    me.uv_layers.new(name='UVMap').uv.foreach_set('vector', uv.ravel())
    rnd = np.repeat(rng.random((N, 2)), 4, axis=0).astype(np.float32)
    me.uv_layers.new(name='S').uv.foreach_set('vector', rnd.ravel())
    me.materials.append(mat)
    return add(name, me)


def trees(mats):
    """杉の木立。幹はメッシュ。枝 1 本に、枝の絵の面を 3 枚組む(外へ下がる面と、左右に垂れる面)。
    target に写る木は、空の開口へ入らないよう外へ押し出す"""
    rng = random.Random(11)
    trunks = B()
    quads = []

    def in_window(x, y, H, Rmax, z0, t0, taper):
        """木の冠が目標の空の開口(上端 x=375-835、y=300 で 425-800、y=430 まで)に入るか"""
        for i in range(9):
            t = t0 + (1 - t0) * i / 8
            z = z0 + H * t
            R = Rmax * (1 - t) ** taper + .3
            px, py = project(Vector((x, y, z)))
            d = (Vector((x, y, z)) - CAM).dot(FWD)
            if py > 430:
                continue
            k = max(0.0, min(1.0, py / 300))
            lo, hi = 375 + 50 * k, 835 - 35 * k
            r_px = R * F_PX / d * 1.2  # 枝の先まで開口の外に収める
            if px + r_px > lo and px - r_px < hi:
                return True
        return False

    def tree(x, y, H, r0, dense=1.0, Rk=.11, t0=.3, keep=False, taper=.5):
        z0 = ground_h(x, y) - .2
        Rmax = H * Rk
        if not keep and y > 0:
            sign = -1 if project(Vector((x, y, z0 + H * .7)))[0] < 605 else 1
            for _ in range(80):
                if not in_window(x, y, H, Rmax, z0, t0, taper):
                    break
                x += sign * .4
        lx, ly = rng.uniform(-.012, .012), rng.uniform(-.012, .012)
        rows = []
        ph = rng.uniform(0, TAU)
        n = 16
        for i in range(17):
            t = i / 16
            z = H * t ** 1.3
            r = r0 * (1 - t) ** .75 * (1 + .55 * math.exp(-z / 1.2)) + .02
            row = []
            for j in range(n):
                a = TAU * j / n
                flare = 1 + .3 * math.exp(-z / 1.0) * math.cos(5 * a + ph) + .05 * math.cos(9 * a + ph * 2) + .03 * math.cos(17 * a + ph)
                row.append((x + lx * z + r * flare * math.cos(a), y + ly * z + r * flare * math.sin(a), z0 + z))
            rows.append(row)
        trunks.grid(rows, closed=True, us=max(1, round(r0 * 2.5)), vs=H / 3.5)
        z = H * t0
        while z < H * .99:
            t = z / H
            L = Rmax * (1 - t) ** taper + .3
            branches = 3 + int(4 * min(1, L / 2.0) * rng.uniform(.8, 1.2) * max(.6, dense))
            a0 = rng.uniform(0, TAU)
            for bi in range(branches):
                a = a0 + TAU * (bi + rng.uniform(-.28, .28)) / branches
                ln = L * rng.uniform(.65, 1.15) * (1.45 if rng.random() < .16 else 1)  # たまに長い枝が飛び出す
                d = Vector((math.cos(a), math.sin(a), 0))
                w = Vector((-d.y, d.x, 0))
                root = Vector((x + lx * z, y + ly * z, z0 + z)) + d * r0 * .3 * (1 - t)
                tip = root + d * ln + Vector((0, 0, -.16 * ln))
                if r0 > .5 and rng.random() < .35:
                    trunks.tube([root, root + d * ln * .55 + Vector((0, 0, -.12 * ln)), tip], lambda u: r0 * .05 * (1 - u) + .012, 4, 0)
                hw = ln * rng.uniform(.34, .46)
                # 外へ下がる面。下から見上げたときの塊
                quads.append((root - w * hw, tip - w * hw, tip + w * hw, root + w * hw))
                # 左右に垂れる面
                for sg in (-1, 1):
                    r2 = root + w * sg * hw * .5
                    t2 = tip + w * sg * hw * .75
                    dr = Vector((0, 0, -ln * .46)) + w * sg * ln * .1
                    quads.append((r2 + dr * .15, t2 + dr * .15, t2 + dr, r2 + dr))
            z += rng.uniform(.9, 1.5) * (H / 26) / max(.75, dense)

    # 手前の太い幹。葉は上の方だけ
    for px, py, Y, H, r0, dn, t0 in ((50, 200, 12.0, 37, 2.6, .6, .62), (195, 420, 17.5, 34, 1.15, .6, .55), (-90, 300, 8.0, 34, 1.3, .7, .45), (1000, 300, 10.0, 34, 1.3, .8, .45)):
        p = P(px, py, Y)
        tree(p.x, Y, H, r0, dn, .15, t0)
    # 開口の縁を作る木。内側に置くと、ちょうど縁まで押し出される
    for px, Y, H, r0, dn in ((470, 24.0, 62, 1.0, .9), (440, 32.0, 66, 1.0, .9), (390, 19.0, 60, 1.0, .9), (760, 26.0, 62, .95, .75), (800, 20.0, 60, .95, .7), (740, 34.0, 66, .9, .75)):
        p = P(px, 900, Y)
        tree(p.x, Y, H, r0, dn, .11)
    # 社殿の裏の尖った杉。頂点の画素から高さを決める
    for px, tip, Y, r0, rk in ((470, 282, 40.0, .85, .3), (590, 372, 38.0, .75, .34), (660, 425, 33.0, .6, .36), (725, 392, 36.0, .6, .34)):
        p = P(px, tip, Y)
        tree(p.x, Y, p.z - ground_h(p.x, Y) + .2, r0, 1.1, rk, .22, keep=True, taper=.8)
    # 鳥居の左右の奥を埋める低い木
    for px, Y, H in ((130, 22.0, 30), (250, 21.0, 24), (300, 26.0, 20), (160, 30.0, 30), (690, 21.0, 11), (745, 24.0, 14), (780, 21.0, 12), (50, 13.0, 20), (105, 17.0, 24), (30, 22.0, 26), (845, 15.0, 22), (900, 19.0, 24), (800, 28.0, 20), (870, 14.0, 13), (760, 15.5, 9.5), (280, 14.5, 10)):
        p = P(px, 900, Y)
        tree(p.x, Y, H, .62, .8, .17, .2)
    for i in range(16):  # 周りの森
        x = -46 + i * 6 + rng.uniform(-2, 2)
        if -2 < x < 22:
            continue
        tree(x, rng.uniform(40, 56), rng.uniform(27, 36), .75, .55)
    for side in (-1, 1):
        for i in range(22):
            y = -48 + i * 4.2 + rng.uniform(-1.5, 1.5)
            x = rng.uniform(10.5, 16)
            if y > 3 and side < 0:
                continue
            tree(side * x, y, rng.uniform(27, 35), rng.uniform(.65, .95), .65)
        for i in range(14):
            y = -46 + i * 8 + rng.uniform(-3, 3)
            tree(side * rng.uniform(19, 36), y, rng.uniform(26, 34), .8, .5)
    for i in range(14):  # 奥の参道の果て
        tree(-30 + i * 4.6 + rng.uniform(-1, 1), rng.uniform(-46, -38), rng.uniform(26, 33), .8, .6)
    trunks.obj('CedarTrunks', [mats[0]])
    quad_cloud('CedarLeaves', quads, mats[1], seed=2)


def bushes(mat):
    """石段の脇の低木。枝の絵の面を低く重ねる"""
    rng = random.Random(4)
    quads = []
    spots = [(sg * x, y) for sg in (-1, 1) for x, y in ((2.7, 8.2), (3.5, 8.8), (4.6, 8.3), (6.2, 8.8), (2.8, 9.7), (4.0, 10.1), (5.6, 10.0), (3.0, 11.2), (4.8, 11.0), (6.2, 11.6), (7.6, 9.4), (8.2, 11.2))]
    for x, y in spots:
        z = ground_h(x, y)
        for i in range(5):
            a = rng.uniform(0, TAU)
            s_ = rng.uniform(.55, .95)
            d = Vector((math.cos(a), math.sin(a), 0)) * s_
            w = Vector((-d.y, d.x, 0)) * .5
            c = Vector((x + rng.uniform(-.3, .3), y + rng.uniform(-.3, .3), z + rng.uniform(.4, .75)))
            quads.append((c - w, c + d - w + Vector((0, 0, -.4)), c + d + w + Vector((0, 0, -.4)), c + w))
    quad_cloud('Bushes', quads, mat, seed=3)


# ---- 花火 ----
def burst_mesh(name, mat, seed, kind):
    """開いた形の花火。筋は細い三角の管で、どの方向から見ても立体。長さと曲がりを 1 本ずつ変え、先端に星の粒が付く。
    UV の U は筋の根元から先端へ進み、V は筋の乱数"""
    rng = random.Random(seed)
    b = B()
    count = 270 if kind == 0 else 240

    def streak(pts, r_fn, v_):
        M = len(pts) - 1
        rows = []
        for j, p in enumerate(pts):
            q = (pts[min(j + 1, M)] - pts[max(j - 1, 0)]).normalized()
            n1 = q.orthogonal().normalized()
            n2 = q.cross(n1)
            r = r_fn(j / M)
            rows.append([p + (n1 * math.cos(TAU * k / 3) + n2 * math.sin(TAU * k / 3)) * r for k in range(3)])
        base = len(b.v)
        for row in rows:
            b.v.extend(tuple(p) for p in row)
        for j in range(M):
            for k in range(3):
                k2 = (k + 1) % 3
                a0, b0, c0, d0 = base + j * 3 + k, base + j * 3 + k2, base + (j + 1) * 3 + k2, base + (j + 1) * 3 + k
                b.face((a0, b0, c0, d0), [(j / M, v_), (j / M, v_), ((j + 1) / M, v_), ((j + 1) / M, v_)], 0, False)

    for i in range(count):
        d = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
        ln = rng.uniform(.84, 1.08) if rng.random() < .76 else rng.uniform(.4, .84)
        curl = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))) * .07
        ln *= 1 - .3 * abs(d.z) ** 3  # 真上と真下の線が伸びて写る分
        pts = []
        M = 10
        for j in range(M + 1):
            t = j / M
            s = .13 + .87 * (1 - (1 - t) ** 2.0)
            droop = (.05 if kind == 0 else .1) * t ** 2.2
            pts.append(d * (s * ln) + curl * t * t - Vector((0, 0, droop)))
        v_ = rng.random()
        wd = rng.uniform(1.0, 1.9)
        streak(pts, lambda t: (.0058 * (1 - t) ** .8 + .0011) * wd, v_)
        if rng.random() < .55:  # 先端で散る星の粒。乱数を .72 より上にして桃と紫にする
            for _ in range(4):
                q = pts[-1] + Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))) * .05
                e = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized() * .008
                streak([q - e, q, q + e], lambda t: .0062, rng.uniform(.74, .99))
    for i in range(5):  # 中心の小さな白い芯
        d = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
        ln = rng.uniform(.02, .07)
        streak([d * (ln * j / 4) for j in range(5)], lambda t: .0036, rng.random() * .7)
    return b.mesh(name, [mat])


def stem_mesh(name, mat):
    """打ち上げの筋。高さ 0..1"""
    b = B()
    rows = []
    M = 24
    for j in range(M + 1):
        t = j / M
        r = .0036 - .0022 * t  # 上ほど細い
        x = .004 * math.sin(t * 9)
        rows.append([(x + r * math.cos(TAU * k / 3), r * math.sin(TAU * k / 3), t) for k in range(3)])
    for row in rows:
        b.v.extend(row)
    for j in range(M):
        for k in range(3):
            k2 = (k + 1) % 3
            b.face((j * 3 + k, j * 3 + k2, (j + 1) * 3 + k2, (j + 1) * 3 + k), [(j / M, .3), (j / M, .3), ((j + 1) / M, .3), ((j + 1) / M, .3)], 0, False)
    return b.mesh(name, [mat])


def fireworks(ctx):
    """花火。開花の瞬間を拍の時刻に合わせる。frame 1 は打ち上げ済みの満開にして、静止画でも開いて見える"""
    fps = ctx.fps
    beats = [t for t in ctx.beats]
    pal = [((1, .6, .2, 1), (1, .36, .44, 1)), ((1, .66, .3, 1), (.7, .36, .9, 1)), ((1, .58, .2, 1), (.8, .36, .8, 1)), ((1, .68, .32, 1), (1, .42, .5, 1))]
    mats = [spark_mat(f'Spark{i}', a, b, 2.2) for i, (a, b) in enumerate(pal)]
    meshes = [burst_mesh(f'Burst{i}', mats[i], 7 + i, i % 2) for i in range(4)]
    stem_m = stem_mesh('Stem', spark_mat('SparkStem', (1, .95, .85, 1), (.8, .86, 1, 1), 1.8, True))
    d = 136.0
    hero = P(684, 245, CAM.y + d)
    R0 = 214 / F_PX * d
    # 打ち上げる場所。+Y(本命)、左右、後ろ
    sites = [(hero, R0), ((-62, 92, 84), 24.0), ((76, 70, 92), 24.0), ((-20, -125, 92), 26.0), ((58, 96, 112), 19.0), ((-96, -30, 88), 24.0), ((90, -60, 96), 24.0)]
    pool = []
    for i, (p, r) in enumerate(sites):
        for j in range(2):
            o = add(f'Burst{i}_{j}', meshes[(i + j * 2) % 4], None, p, (0, 0, 0), r)
            o.scale.y, o.scale.z = r * .7, r * .68  # 見上げでは奥行きも上下に写るので、奥行きと上下を縮める
            o.visible_shadow = False
            o.visible_diffuse = False
            o.color = (0, 0, 0, 1)
            st = add(f'Stem{i}_{j}', stem_m, None, (p[0] - r * .09, p[1], p[2] - r * 1.76), (0, 0, 0), r * 3.0)
            st.scale.z = r * 1.3  # 上端を本体の中まで伸ばす
            st.visible_shadow = False
            st.visible_diffuse = False
            st.color = (0, 0, 0, 1)
            for x in (o, st):
                x.hide_render = True
                x.keyframe_insert('hide_render', frame=-60)
            pool.append((o, st, i))

    def key_color(o, f, r, g):
        o.color = (r, g, 0, 1)
        o.keyframe_insert('color', frame=f)

    def key_show(o, f, shown):
        o.hide_render = not shown
        o.keyframe_insert('hide_render', frame=f)

    def fire(item, t, first=False):
        o, st, _ = item
        f = 1 + t * fps
        rise = .45 * fps
        for x in (o, st):  # 光っていない間は描かない。細い管を抜けるレイが透過の回数を使い切らないように
            key_show(x, f - rise - 2, True)
            key_show(x, f + 2.45 * fps, False)
        if not first:
            key_color(st, f - rise - 1, 0, 0)
            key_color(o, f - 1, 0, 0)
        key_color(st, f - rise, .02, 1)
        key_color(st, f, 1, 1)
        key_color(st, f + .9 * fps, 1, 1)
        key_color(st, f + 2.0 * fps, 1, 0)
        key_color(o, f, .02, 1)
        key_color(o, f + .2 * fps, .72, 1)
        key_color(o, f + .55 * fps, .96, 1)
        key_color(o, f + 1.1 * fps, 1, .62)
        key_color(o, f + 2.3 * fps, 1, 0)

    # frame 1 は開いて 0.6 秒後。本命の 1 発目は負の時刻に打つ
    fire(pool[0], -.6, True)
    used = {id(pool[0][0]): -.6}
    flashes = []
    step = 4
    for n, i in enumerate(range(0, len(beats), step)):
        t = beats[i]
        if t < .4:
            continue
        # 本命は毎回、ほかの場所は順番に重ねる
        cand = [pool[n % 2]]
        other = 2 + (n * 5) % (len(pool) - 2)  # 7 回で全方向を回る
        cand.append(pool[other])
        for it in cand:
            if used.get(id(it[0]), -9) + 2.4 > t:
                it = pool[(pool.index(it) ^ 1)]
            fire(it, t)
            used[id(it[0])] = t
        flashes.append(t)
    return flashes


def key_flash(sun, flashes, fps, base, peak):
    """花火の瞬間に場面全体をわずかに照らす"""
    sun.data.energy = base
    sun.data.keyframe_insert('energy', frame=1)
    for t in flashes:
        f = 1 + t * fps
        sun.data.energy = base
        sun.data.keyframe_insert('energy', frame=f - 1)
        sun.data.energy = peak
        sun.data.keyframe_insert('energy', frame=f + 2)
        sun.data.energy = base
        sun.data.keyframe_insert('energy', frame=f + .9 * fps)


# ---- 動き ----
def sway(keys, last, fps):
    """提灯の揺れ。吊り点で回る。周期は 1 個ずつ少し違う"""
    for o, ph in keys['sway']:
        rng = random.Random(int(ph * 100))
        per = rng.uniform(2.4, 3.4) * fps
        amp_x, amp_y = math.radians(rng.uniform(3.5, 6.5)), math.radians(rng.uniform(1.5, 3.0))
        base = o.rotation_euler.copy()
        n = int(last / (per / 2)) + 3
        for i in range(n):
            f = 1 + i * per / 2 - (ph % 2) / 2 * per
            s = 1 if i % 2 else -1
            o.rotation_euler = (base.x + amp_x * s, base.y, base.z)
            o.keyframe_insert('rotation_euler', index=0, frame=f)
            f2 = f + per * .22
            o.rotation_euler = (base.x, base.y + amp_y * s, base.z)
            o.keyframe_insert('rotation_euler', index=1, frame=f2)
        o.rotation_euler = base


def fireflies(last, fps):
    """蛍。木の際から飛び、ゆっくり明滅する。物体の色の R が明るさ"""
    rng = random.Random(21)
    m, nt, out = mat_base('Firefly')
    oi = nt.nodes.new('ShaderNodeObjectInfo')
    sc = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(oi.outputs['Color'], sc.inputs[0])
    mul = nt.nodes.new('ShaderNodeMath')
    mul.operation = 'MULTIPLY'
    nt.links.new(sc.outputs['Red'], mul.inputs[0])
    mul.inputs[1].default_value = 60.0
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[0].default_value = (.8, 1, .22, 1)
    nt.links.new(mul.outputs[0], e.inputs[1])
    nt.links.new(e.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    me = sphere_mesh('FireflyP', .014, m, 1)
    fixed = [(270, 395, 18), (360, 180, 22), (660, 600, 30), (760, 560, 26), (880, 640, 15), (938, 612, 14), (925, 438, 20), (500, 700, 28), (620, 380, 34), (240, 300, 24), (205, 880, 12), (900, 760, 13), (300, 720, 20), (150, 620, 12), (820, 700, 16), (760, 300, 30), (850, 520, 18), (920, 300, 22), (50, 770, 14), (395, 640, 30)]
    pts = [P(px, py, CAM.y + d) for px, py, d in fixed]
    for _ in range(46):
        side = rng.choice((-1, 1))
        pts.append(Vector((side * rng.uniform(3.8, 9), rng.uniform(-16, 14), rng.uniform(.5, 4.6))))
    for i, p in enumerate(pts):
        o = add(f'Firefly{i}', me, None, p)
        o.visible_shadow = False
        o.visible_diffuse = False
        per = rng.uniform(.9, 1.5) * fps
        n = int(last / per) + 3
        ph = rng.uniform(0, TAU)
        spd = rng.uniform(.8, 1.5)
        c = Vector(p)
        q = Vector(p)
        vel = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-.3, .3)))
        for k in range(n):
            f = 1 + k * per
            o.location = q
            o.keyframe_insert('location', frame=f)
            b = .35 + .65 * max(0.0, math.sin(k * .9 * spd + ph)) ** 2
            o.color = (b, 0, 0, 1)
            o.keyframe_insert('color', frame=f)
            vel = (vel + Vector((rng.gauss(0, .6), rng.gauss(0, .6), rng.gauss(0, .25))) + (c - q) * .12) * .75
            q = q + vel * .38
        o.location = c


def smoke(keys):
    """靄の層。社殿の裏と右の木の前に広い板を置き、ゆっくり流す"""
    def cloud(name, img, col, k, alpha):
        m, nt, out = mat_base(name)
        N, L = nt.nodes, nt.links
        t = tex_node(nt, image(img), 'EXTEND')
        e = N.new('ShaderNodeEmission')
        e.inputs[0].default_value = col
        e.inputs[1].default_value = k
        tr = N.new('ShaderNodeBsdfTransparent')
        ms = N.new('ShaderNodeMixShader')
        gm = N.new('ShaderNodeMath')
        gm.operation = 'MULTIPLY'
        L.new(t.outputs[0], gm.inputs[0])
        gm.inputs[1].default_value = alpha
        L.new(gm.outputs[0], ms.inputs[0])
        L.new(tr.outputs[0], ms.inputs[1])
        L.new(e.outputs[0], ms.inputs[2])
        L.new(ms.outputs[0], out.inputs[0])
        m.cycles.emission_sampling = 'NONE'
        return m

    b = B()
    b.grid([[(-1, 0, -.67), (1, 0, -.67)], [(-1, 0, .67), (1, 0, .67)]])
    fog = b.mesh('Mist', [cloud('Mist', 'mist.png', (.42, .4, .56, 1), .45, .9)])
    wisp = b.mesh('Wisp', [cloud('Wisp', 'smoke.png', (.5, .46, .5, 1), .22, .4)])
    mists = [(P(490, 670, 24.0), 9), (P(610, 660, 25.0), 7), (P(380, 680, 25.0), 6), (P(815, 455, 16.0), 6), (P(860, 540, 13.0), 3.5), (P(800, 400, 18.0), 5), (P(850, 480, 15.0), 4), (P(230, 640, 26.0), 6)]
    for i, (p, sc) in enumerate(mists):
        o = add(f'Mist{i}', fog, None, p, (0, math.pi / 2 if 3 <= i <= 6 else 0, 0), sc)  # 右の木の前の靄は縦に立てる
        o.visible_shadow = False
        o.visible_glossy = False
        keys['drift'].append(o)
    for i, (x, y, z, sc) in enumerate(((-30, 6, 16, 22), (30, -6, 16, 22))):
        o = add(f'MistFar{i}', fog, None, (x, y, z), (0, 0, math.pi / 2 if i < 2 else 0), sc)
        o.visible_shadow = False
        o.visible_glossy = False
    for i, (x, y, z, sc) in enumerate(((-7.4, 3.5, 3.4, 1.4), (-7.3, -7, 3.6, 1.6), (7.6, 6.6, 3.2, 1.4), (7.5, -11, 3.5, 1.6))):
        o = add(f'Wisp{i}', wisp, None, (x, y, z), (0, .4 * i, 0), sc)
        o.visible_shadow = False
        o.visible_glossy = False
        keys['drift'].append(o)


def drift(keys, last, fps):
    for i, o in enumerate(keys['drift']):
        z0, x0 = o.location.z, o.location.x
        o.keyframe_insert('location', index=2, frame=1)
        o.location.z = z0 + .14 * o.scale.x * last / fps / 15
        o.location.x = x0 + .1 * o.scale.x * (1 if i % 2 else -1) * last / fps / 15
        o.keyframe_insert('location', index=2, frame=last)
        o.keyframe_insert('location', index=0, frame=last)
        o.location.z, o.location.x = z0, x0
        o.keyframe_insert('location', index=0, frame=1)


def refl_mat(name, color, k, reach=4.5):
    """遠くから来たレイにだけ光り、近くの物の映り込みには写らない発光"""
    m, nt, out = mat_base(name)
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[0].default_value = color
    e.inputs[1].default_value = k
    lp = nt.nodes.new('ShaderNodeLightPath')
    gt = nt.nodes.new('ShaderNodeMath')
    gt.operation = 'GREATER_THAN'
    gt.inputs[1].default_value = reach
    nt.links.new(lp.outputs['Ray Length'], gt.inputs[0])
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    mx = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(gt.outputs[0], mx.inputs[0])
    nt.links.new(tr.outputs[0], mx.inputs[1])
    nt.links.new(e.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def glossy_only(o):
    o.visible_camera = o.visible_diffuse = o.visible_shadow = o.visible_transmission = False


def reflection_lights(lanterns):
    """カメラには写らず、濡れた床の映り込みにだけ写る発光体。提灯と灯籠の真の位置に置くので、映り込みが灯りの真下に出る。
    lanterns は吊り提灯の位置と色の番号の列"""
    pal = [refl_mat('ReflCream', (1, .56, .26, 1), 24.0, 2.5), refl_mat('ReflRed', (1, .09, .04, 1), 54.0, 2.5), refl_mat('ReflGold', (1, .44, .15, 1), 24.0, 2.5), refl_mat('ReflFill', (1, .5, .24, 1), 12.0, 2.5), refl_mat('ReflFillC', (1, .46, .2, 1), 2.0, 2.5)]
    b = B()
    for x, y, z, mi in lanterns:
        b.lathe([(.001, -.75), (.27, -.58), (.35, -.28), (.35, .05), (.23, .2), (.001, .25)], 8, (x, y, z), mi)
    for x, y, h in ((-3.05, 3.6, 2.1), (3.13, 3.6, 2.1), (-1.37, 13, 4.6), (.98, 13, 4.6), (0, 13.2, 5.0)):
        b.lathe([(.001, 0), (.42, .15), (.42, .75), (.001, .95)], 8, (x, y, h - .45), 2)
    for pxy in ((342, 950), (362, 912), (376, 880), (635, 950), (609, 915), (594, 885)):  # 石段の脇の灯籠
        p = P(pxy[0], pxy[1], 8.0 if pxy[1] > 930 else 9.5)
        b.lathe([(.001, -.3), (.28, 0), (.001, .3)], 6, tuple(p), 2)
    for (x, y, z, w) in ((-5.6, 5.8, 2.3, 1.2), (6.4, 7.6, 2.2, 1.1)):  # 屋台の奥の灯り
        b.grid([[(x - w, y, z - .7), (x + w, y, z - .7)], [(x - w, y, z + .7), (x + w, y, z + .7)]], mat=2)
    for px, py, mi in ((620, 1260, 2), (820, 1350, 2), (130, 1435, 1), (660, 1340, 1)):  # 縦に伸びる灯りの像の元
        g_ = G(px, py)
        d_ = g_ - CAM
        c_ = g_ + Vector((d_.x, d_.y, -d_.z)) * ((4.4 - g_.y) / d_.y)
        b.lathe([(.001, -.9), (.26, -.8), (.3, 0), (.26, .8), (.001, .9)], 8, tuple(c_), mi)
    for x in (-2.85, 2.85):  # 鳥居の柱のすぐ手前の面。柱の映りが床に黒い帯を作らない
        b.grid([[(x - .5, 4.55, .1), (x + .5, 4.55, .1)], [(x - .5, 4.55, 4.6), (x + .5, 4.55, 4.6)]], mat=3)
    b.grid([[(-2.3, 6.6, .1), (2.3, 6.6, .1)], [(-2.3, 6.6, 4.6), (2.3, 6.6, 4.6)]], mat=4)  # 石段の前の面。中央の列も暗くなり過ぎない
    o = b.obj('ReflShapes', pal)
    glossy_only(o)
    # 映るのは濡れた床だけ。鳥居や石段の艶には映さない
    wet = bpy.data.collections.new('WetFloor')
    for n_ in ('Pavers', 'PaversFar'):
        wet.objects.link(bpy.data.objects[n_])
    o.light_linking.receiver_collection = wet


def compositor():
    """順に、弱いシャープ、灯りのにじみ、色の調整。どの視点でも同じ処理"""
    s = bpy.context.scene
    nt = bpy.data.node_groups.new('Glow', 'CompositorNodeTree')
    s.compositing_node_group = nt
    N, L = nt.nodes, nt.links
    rl = N.new('CompositorNodeRLayers')
    sh = N.new('CompositorNodeFilter')
    sh.inputs['Type'].default_value = 'Box Sharpen'
    sh.inputs['Factor'].default_value = .02
    L.new(rl.outputs['Image'], sh.inputs['Image'])
    g = N.new('CompositorNodeGlare')
    g.inputs['Type'].default_value = 'Bloom'
    g.inputs['Quality'].default_value = 'Medium'
    g.inputs['Threshold'].default_value = .8
    g.inputs['Smoothness'].default_value = .4
    g.inputs['Strength'].default_value = .55
    g.inputs['Saturation'].default_value = 1.15
    g.inputs['Size'].default_value = .8
    L.new(sh.outputs[0], g.inputs['Image'])
    cb = N.new('CompositorNodeColorBalance')
    L.new(g.outputs['Image'], cb.inputs['Image'])
    nt.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    out = N.new('NodeGroupOutput')
    L.new(cb.outputs['Image'], out.inputs[0])
    s.render.use_compositing = True


def lights():
    def area(name, loc, rot, size, size_y, energy, color):
        li = bpy.data.lights.new(name, 'AREA')
        li.shape = 'RECTANGLE'
        li.size, li.size_y = size, size_y
        li.energy, li.color = energy, color
        o = add(name, li, None, loc, rot)
        o.visible_glossy = False
        o.visible_camera = False
        return o

    def point(name, loc, energy, color, r=.25):
        li = bpy.data.lights.new(name, 'POINT')
        li.energy, li.color = energy, color
        li.shadow_soft_size = r
        o = add(name, li, None, loc)
        o.visible_glossy = False
        o.visible_camera = False
        return o

    def spot(name, loc, aim, energy, color, deg, blend=.7):
        li = bpy.data.lights.new(name, 'SPOT')
        li.energy, li.color = energy, color
        li.spot_size, li.spot_blend = math.radians(deg), blend
        li.shadow_soft_size = .12
        o = add(name, li, None, loc)
        o.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        o.visible_glossy = False
        o.visible_camera = False

    down = (0, 0, 0)
    warm = (1, .62, .3)
    # 鳥居は下から暖色で照らす。笠木と貫の下面が明るい
    area('ToriiWash', (0, 4.1, .2), (math.radians(128), 0, 0), 7, .7, 18, (1, .66, .38))
    area('ToriiUp', (0, 2.6, 3.0), (math.radians(118), 0, 0), 7.5, .6, 60, (1, .64, .36))  # 貫と笠木の下面、柱の中ほど  # 幕に届かない幅
    # 提灯の列の下の暖色
    area('RowLeft', (-3.0, 0, 3.3), down, 1.5, 12, 34, warm)
    area('RowRight', (5.3, -1.5, 3.3), down, 1.5, 10, 34, warm)
    for sg in (-1, 1):
        area(f'RowRear{sg}', (sg * 3.2, -15, 3.7), down, 1.2, 18, 70, warm)
        area(f'StallRow{sg}', (sg * 5.0, -8, 2.9), (0, sg * math.radians(25), 0), .8, 26, 200, (1, .66, .36))
        point(f'BankLamp{sg}', (sg * 3.1, 10.6, 3.9), 34, (1, .55, .25), .3)
        point(f'StoneLamp{sg}', (sg * 3.1, 3.15, 2.0), 75 if sg < 0 else 6, (1, .6, .26), .2)
    point('StallL', (-5.3, 3.8, 2.9), 240, (1, .55, .24), .3)
    point('StallR', (7.2, 6.4, 2.6), 320, (1, .55, .24), .3)
    area('LowFront', (0, 1.5, .3), (math.radians(84), 0, 0), 9, .5, 70, (1, .58, .3))
    area('FenceWash', (0, 6.3, .25), (math.radians(80), 0, 0), 11, .6, 12, (1, .56, .26))
    # 石段は上から当て、段鼻の丸みに光を載せる。社殿は灯りを絞る
    area('Stair', (0, 12.2, 7.4), (math.radians(-6), 0, 0), 4.5, 2.2, 620, (1, .66, .36))
    spot('StairTop', (0, 5.6, 2.2), (0, 10.2, 3.4), 1900, (1, .66, .38), 46, 1.0)
    spot('PillarL', (-1.3, .8, 1.4), (-2.85, 5, 3.4), 300, (1, .62, .34), 16)
    area('RoofWash', (0, 8, 16.5), (math.radians(48), 0, 0), 10, 5, 1000, (.6, .68, .95))
    point('HallIn', (0, 12.3, 5.9), 30, (1, .55, .22), .3)
    area('HallFront', (0, 11.6, 5.2), (math.radians(68), 0, 0), 7, 1.2, 230, (1, .6, .3))  # 軒下と屋根の縁へ提灯の光が回る
    for nm, q, e_ in (('MidR', P(780, 760, 12.0), 60), ('MidR2', P(880, 790, 13.0), 40), ('MidL', P(250, 800, 13.0), 40)):
        point(nm, q + Vector((0, -.7, -.2)), e_, (1, .55, .25), .3)
    spot('TrunkL', (-4.6, 7.2, .6), P(55, 300, 12.0), 10000, (1, .55, .28), 34, 1.0)
    spot('TrunkL2', (-3.6, 9.5, 1.5), P(195, 420, 17.5), 6000, (1, .55, .28), 26, 1.0)
    # 空の青
    sun = bpy.data.lights.new('Moon', 'SUN')
    sun.energy, sun.color, sun.angle = .26, (.45, .55, 1), math.radians(4)
    o = add('Moon', sun, None, (0, 0, 50), (math.radians(40), math.radians(25), 0))
    o.visible_glossy = False
    flash = bpy.data.lights.new('Flash', 'SUN')
    flash.energy, flash.color, flash.angle = .0, (.85, .72, 1), math.radians(14)
    fl = add('Flash', flash, None, (0, 0, 60), (math.radians(-35), 0, 0))
    fl.visible_glossy = False
    # キャラ。顔を脚より明るくする
    spot('Top', (.25, MARK[1] - .3, 6.5), MARK, 90, (1, .8, .66), 34)
    spot('Face', (.3, MARK[1] - 3.3, 2.2), (0, MARK[1], 1.42), 300, (1, .84, .7), 20)
    spot('RimR', (2.3, 2.6, 2.5), (0, MARK[1], 1.38), 700, (1, .5, .2), 26)
    spot('RimL', (-2.4, 2.5, 2.6), (0, MARK[1], 1.38), 560, (1, .44, .2), 26)
    return fl


def build(ctx):
    global ASSETS
    ASSETS = ctx.assets
    s = bpy.context.scene
    s.view_settings.view_transform = 'Standard'
    s.view_settings.look = 'None'
    s.view_settings.exposure = .1
    c = s.cycles
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces, c.transparent_max_bounces = 4, 1, 1, 1, 16
    c.sample_clamp_indirect = 2.4  # 映り込みの強い点が被写界深度のぼけの中で粒に残らないように
    c.denoising_input_passes = 'RGB_ALBEDO'
    c.use_light_tree = True
    c.adaptive_threshold = .08
    c.light_sampling_threshold = .03
    c.filter_width = 1.25

    keys = {'sway': [], 'drift': []}
    sky()
    moss = pbr('Moss', img='moss_ground.png', rough=.8, tone=(.3, .34, .24, 1), bump=.05)
    dirt = pbr('Joint', img='moss_ground.png', rough=.9, tone=(.3, .3, .12, 1), bump=.02, spec=.1, emit_k=.06)
    pavers(wet_stone(), dirt)
    terrain(moss)

    paint = torii_mat()
    black = pbr('ToriiBlack', img='torii_paint.png', rough=.34, coat=.5, tone=(.11, .17, .25, 1), bump=.002)
    root = pbr('ToriiRoot', img='moss_stone.png', rough=.85, bump=.012, tone=(.13, .13, .11, 1), spec=.3)
    pedestal = pbr('MossStone', img='old_stone.png', rough=.62, bump=.012, tone=(.62, .6, .52, 1))
    light_stone = pbr('RailStone', img='old_stone.png', rough=.6, bump=.012, tone=(.55, .53, .46, 1))
    foot = foot_mat()
    torii('Torii', [paint, black, root, foot], (0, 5.0))
    torii('ToriiFar', [paint, black, root, foot], (0, -24.5), .72)
    crest = B()  # 笠木の中央の紋
    crest.grid([[(-.2, 4.81, 7.16), (.2, 4.81, 7.16)], [(-.2, 4.81, 7.56), (.2, 4.81, 7.56)]], mat=0)
    crest.obj('ToriiCrest', [crest_mat()])

    step = pbr('StepStone', img='flag_albedo.png', rough=.36, coat=.3, bump=.01, tone=(.42, .38, .33, 1))
    riser = pbr('StepRiser', img='flag_albedo.png', rough=.55, bump=.01, tone=(.24, .21, .17, 1))
    nose = pbr('StepNose', img='flag_albedo.png', rough=.5, coat=.1, bump=.006, tone=(.3, .26, .22, 1), emit_k=.02)
    stairs([nose, riser, light_stone])
    bank([moss, pedestal])
    tr = B()
    tr.box((0, (STAIR_Y1 + 32) / 2, TERRACE - .1), (34, 32 - STAIR_Y1, .2), 0, tex=1.5)
    tr.obj('Terrace', [step])

    wood = pbr('HallWood', img='wood_dark.png', rough=.5, bump=.006, tone=(.55, .46, .38, 1))
    red = pbr('HallRed', img='torii_smooth.png', rough=.45, coat=.2, tone=(.5, .34, .3, 1))
    dark = pbr('HallDark', img='wood_dark.png', rough=.5, tone=(.14, .12, .1, 1))
    gold = pbr('HallGold', (.75, .48, .18, 1), .35, 1.0, emit=(1, .5, .14, 1), emit_k=.05)
    tile = pbr('Tile', img='roof_tile.png', rough=.4, coat=.2, bump=.05, tone=(.74, .74, .76, 1))
    door = pbr('HallPlain', (.004, .003, .003, 1), .7, spec=.1)
    carve = pbr('Carving', img='carving.png', rough=.5, bump=.02, emit_k=.05, tone=(.34, .27, .2, 1))
    lat = emis('HallLattice', (1, .74, .62, 1), 1.3, img='hall_door.png')
    hb, hg, hall_bulbs, ky = hall()
    hb.obj('Hall', [wood, red, dark, gold, tile, door, carve, step, lat])
    amber = amber_mat()
    hg.obj('HallLamps', [amber])
    rope = pbr('Rope', img='rope.png', rough=.7, bump=.02, emit_k=.05, tone=(.62, .56, .45, 1))
    shide = pbr('Shide', (.92, .9, .84, 1), .6, emit=(1, .93, .8, 1), emit_k=.16)
    shimenawa([rope, shide], ky + .06, 5.95, 1.55)

    # 石灯籠
    sl, sg_ = B(), B()
    for sg in (-1, 1):
        stone_lantern(sl, sg_, (-3.05 if sg < 0 else 3.24, 3.6), .96 if sg < 0 else .9)
    for sg in (-1, 1):  # 通りの手前にも
        for y in (-13.0, -20.0):
            stone_lantern(sl, sg_, (sg * 3.9, y), .9)
    sl.obj('StoneLanterns', [pedestal])
    gl = sg_.obj('StoneLanternGlow', [amber])
    gl.visible_shadow = False
    box = B()
    p = P(130, 1116, 2.75)
    for i in range(4):
        box.box((p.x, p.y, .06 + i * .11), (.66, .46, .08), 0, tex=1)
    for sx in (-1, 1):
        box.box((p.x + sx * .3, p.y, .22), (.06, .48, .44), 0, tex=1)
    box.lathe([(.1, 0), (.11, .3)], 10, (p.x + .9, p.y - .35, 0), 0)
    box.obj('Crate', [pbr('Crate', img='wood_dark.png', rough=.6, tone=(1.1, .9, .7, 1), emit_k=.05)])

    # 柱の灯籠。石段の両脇と高台。(柱の足の画素, 灯りの高さの倍率)
    red2 = pbr('PostRed', img='torii_smooth.png', rough=.4, coat=.2, tone=(.85, .7, .65, 1), emit_k=.08)
    plm = post_lamp_mesh(red2, black, amber)
    posts = ((342, 1035, 1.32), (362, 990, 1.28), (376, 958, 1.2), (635, 1042, 1.32), (609, 995, 1.28), (594, 962, 1.2), (291, 1062, .75), (330, 925, 2.0), (615, 922, 2.0), (306, 930, 1.15), (650, 930, 1.15))
    for i, (px, py, k) in enumerate(posts):
        o = add(f'Post{i}', plm, None, on_ground(px, py), (0, 0, .3 * i), k)
        o.scale.z = k * .68

    for i, (px, py, Y) in enumerate(((780, 760, 12.0), (803, 790, 13.0), (845, 815, 13.5), (895, 815, 13.5), (248, 800, 13.5))):
        q = P(px, py, Y)
        g_ = ground_h(q.x, q.y)
        o = add(f'TallPost{i}', plm, None, (q.x, q.y, g_), (0, 0, .4 * i), 1.5)
        o.scale.z = (q.z - g_) / 1.5

    # 提灯
    wire = pbr('Wire', (.012, .011, .01, 1), .5, spec=.2)
    straw = pbr('StringRope', img='rope.png', rough=.7, tone=(.5, .44, .34, 1), emit_k=.12)
    cap = pbr('Cap', (.012, .01, .01, 1), .35)
    tassel = emis('Tassel', (1, .12, .05, 1), .7)
    p_red = paper_mat('PaperRed', (1, .07, .018, 1), 1.6)
    p_white = paper_mat('PaperWhite', (1, .68, .36, 1), 1.3, crest=False, even=.72)
    lan = [lantern_mesh(p_white, cap, tassel), lantern_mesh(p_red, cap, tassel)]
    refl = []
    rope_ends = []

    def row(name, pts, size=1.0, extra=None, start=0, wire_r=.012):
        mesh = lan[start:] + lan[:start]
        hang_lanterns(name, keys, pts, mesh, straw, size, extra=extra, wire_r=wire_r)
        for e_ in extra or ():  # 縄の端を支える竿
            rope_ends.append(Vector(e_))
        refl.extend((p_.x, p_.y, p_.z - .3, (start + i) % 2) for i, p_ in enumerate(map(Vector, pts)))

    # 左の列は目標の画素から置き、手前は同じ線を伸ばす
    left = [Px(px, py - 52 * (1 - i * .09), -3.05) for i, (px, py) in enumerate(((25, 475), (82, 567), (125, 637), (155, 680), (180, 715), (203, 745), (222, 772)))]
    pre = [left[0] + (left[0] - left[1]) * (k + 1) * .9 for k in range(10)]
    row('RowA', list(reversed(pre)) + left, extra=((-3.05, -16, 6.4), (-2.95, 7.5, 3.9)), start=len(pre) % 2)
    right_y = (4.9, 6.8, 8.7, 10.3, 12.0)
    right = [P(px, py - 40 + 3 * i, y) for i, (px, py, y) in enumerate(((920, 730, right_y[0]), (880, 755, right_y[1]), (845, 770, right_y[2]), (820, 780, right_y[3]), (790, 800, right_y[4])))]
    pre_r = [right[0] + (right[0] - right[1]) * (k + 1) * 1.0 for k in range(7)]
    row('RowB', list(reversed(pre_r)) + right, extra=((4.7, -13, 6.2), (5.0, 13.2, 4.9)), start=1)
    # 手前の見えない所から奥の列
    row('RowC', [(sg_x, y, 5.2) for sg_x, y in ((-3.3, -22), (-3.3, -20.5), (-3.3, -19), (3.3, -22), (3.3, -20.5), (3.3, -19))], extra=((-3.3, -24, 5.3), (3.3, -24, 5.3)))
    # 社殿の両脇の小さな提灯の幕
    for nm, a, c_, n in (('CurtainL', P(285, 836, 15.0), P(350, 856, 15.0), 11), ('CurtainR', P(612, 856, 15.0), P(700, 830, 15.0), 13)):
        pts = [tuple(a + (c_ - a) * ((i + .5) / n)) for i in range(n)]
        row(nm, pts, size=.5, extra=(a, c_), wire_r=.008)

    poles = B()
    for e_ in rope_ends:
        poles.lathe([(.045, ground_h(e_.x, e_.y) - .1 - e_.z), (.03, .14), (.001, .2)], 8, tuple(e_), 0, us=1, vs=3)
    poles.obj('RopePoles', [red2])

    # 屋台
    stripe = pbr('Stripe', img='stripe_clean.png', rough=.65, emit_k=.5, tone=(1, .84, .66, 1))
    skirt = pbr('Skirt', img='stripe_clean.png', rough=.7, emit_k=.02, tone=(.42, .3, .28, 1))
    counter = pbr('Counter', img='wood_dark.png', rough=.55, tone=(1.3, 1.05, .8, 1), emit_k=.1)
    box_d = pbr('StallDark', (.03, .025, .02, 1), .7)
    sh_a = emis('ShelfA', (1, 1, 1, 1), 1.7, img='stall_a.png')
    sh_b = emis('ShelfB', (1, 1, 1, 1), 1.8, img='stall_b.png')
    goods_m = [pbr('GoodA', (.9, .85, .75, 1), .4, emit_k=.5, emit=(1, .85, .65, 1)), pbr('GoodB', (.9, .3, .1, 1), .4, emit_k=.5, emit=(1, .35, .12, 1)), pbr('GoodC', (.15, .45, .6, 1), .4, emit_k=.5, emit=(.2, .6, .8, 1)), pbr('GoodD', (.8, .7, .5, 1), .5, emit_k=.4, emit=(.9, .75, .5, 1))]
    gb = B()
    bulbs = []
    stalls = [
        ('StallL0', (-4.45, 3.0), 1, 4.6, sh_a, 3.74, dict(top=1.78, cl=4.25, far=True)),
        ('StallR0', (5.7, 6.6), -1, 2.4, sh_b, 3.25, dict(top=1.15, end=True, far=True, fr=-.5)),
        ('StallL1', (-5.0, -2.7), 1, 5.2, sh_b, 3.4, {}),
        ('StallR1', (5.0, 2.3), -1, 5.0, sh_a, 3.4, dict(end=True)),
        ('StallL2', (-5.0, -8.2), 1, 5.0, sh_a, 3.4, {}),
        ('StallR2', (5.0, -3.3), -1, 5.4, sh_b, 3.4, {}),
        ('StallL3', (-5.0, -13.9), 1, 5.6, sh_b, 3.4, {}),
        ('StallR3', (5.0, -9.1), -1, 5.2, sh_a, 3.4, {}),
        ('StallL4', (-5.0, -19.6), 1, 5.0, sh_a, 3.4, {}),
        ('StallR4', (5.0, -14.9), -1, 5.4, sh_b, 3.4, {}),
    ]
    for i, (n_, loc, sd, L_, shelf, H, kw) in enumerate(stalls):
        g = stall(n_, loc, sd, L_, [stripe, skirt, counter, shelf, box_d], bulbs, seed=i, H=H, **kw)
        k = len(gb.v)
        gb.v.extend(g.v)
        gb.f.extend(tuple(q + k for q in f) for f in g.f)
        gb.uv.extend(g.uv)
        gb.mi.extend(g.mi)
        gb.sm.extend(g.sm)
        for j in range(2):  # 軒の提灯
            y = loc[1] + (j - .5) * L_ * .3
            pos_ = (loc[0] - sd * .1, y, H - .85)
            if i == 0:  # target で庇の中に入る 2 個
                pos_ = tuple(Px((20, 72)[j], 790, -5.25))
            o = add(f'{n_}Lan{j}', lan[(i + j) % 2], None, pos_, (0, 0, j), .78)
            keys['sway'].append((o, i * 1.7 + j))
    gb.obj('Goods', goods_m)
    for i, (px, py) in enumerate(((22, 915), (48, 925))):  # 目標で見える藁束
        c_ = Px(px, py, -5.0)
        st = B()
        rng = random.Random(i)
        for k in range(16):
            st.tube([(c_.x, c_.y, 1.46), (c_.x + rng.uniform(-.24, .24), c_.y + rng.uniform(-.24, .24), 1.46 + rng.uniform(.34, .58))], .01, 3)
        st.lathe([(.1, 0), (.12, .22)], 10, (c_.x, c_.y, 1.44), 1)
        st.obj(f'Straw{i}', [goods_m[3], goods_m[1]])
    bulb_m = emis('Bulb', (1, .62, .24, 1), 3.2)
    bp = B()
    bp.lathe([(.006, .03), (.006, .5)], 5)
    bulb_me = sphere_mesh('BulbP', .035, bulb_m, 2)
    bulb_me2 = bp.mesh('BulbCord', [wire])
    pts = bulbs + [tuple(Px(55, 905, -5.1)), tuple(P(935, 960, 6.3))]
    instance_verts('Bulbs', pts, bulb_me)
    instance_verts('BulbCords', pts, bulb_me2)
    instance_verts('HallBulbs', hall_bulbs, sphere_mesh('HallBulbP', .022, bulb_m, 1))

    trunk = pbr('CedarBark', img='bark.png', rough=.75, bump=.12, tone=(.9, .74, .62, 1))
    trunk.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 0
    add_air(trunk, False)
    leaf = cut_mat('CedarLeaf', 'clump_a.png', .8, .1)
    trees([trunk, leaf])
    bushes(cut_mat('BushLeaf', 'clump_a.png', .5, .05))

    smoke(keys)
    flash = lights()
    reflection_lights(refl)
    compositor()

    last = int(max(ctx.frames, (ctx.beats[-1] if ctx.beats else 30) * ctx.fps)) + 60
    flashes = fireworks(ctx)
    key_flash(flash, flashes, ctx.fps, 0.0, .12)
    sway(keys, last, ctx.fps)
    fireflies(last, ctx.fps)
    drift(keys, last, ctx.fps)

    look = CAM + FWD * 10
    return {
        'mark': MARK,
        'facing': 0,
        'bounds': ((-2.7, 2.7), (-6.4, 3.0), (0.12, 5.0)),
        'char_emission': 0.4,
        'beats_per_shot': 8,
        'views': {
            'target': {'loc': tuple(CAM), 'look': tuple(look), 'lens': F_PX / 1672 * 36, 'fstop': 1.5, 'focus': 7.0},
            'hold1': {'loc': (2.7, -3.6, 1.1), 'look': (0, 0, 1.0), 'lens': 35, 'fstop': 2.8},
            'hold2': {'loc': (-2.7, -1.2, 0.5), 'look': (0, 2, 1.5), 'lens': 28, 'fstop': 2.8},
            'back': {'loc': (0, 1.5, 1.2), 'look': (0, -8, 2.2), 'lens': 24, 'fstop': 2.8},
            'left': {'loc': (2.7, 0, 1.2), 'look': (-8, 0, 2.2), 'lens': 24, 'fstop': 2.8},
            'right': {'loc': (-2.7, 0, 1.2), 'look': (8, 0, 2.2), 'lens': 24, 'fstop': 2.8},
        },
    }
