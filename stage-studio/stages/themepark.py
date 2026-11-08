"""オリジナルのテーマパークの広場。夕暮れの濡れた石畳、カルーセル、観覧車、屋台、街灯、電球の列、風船、紙吹雪。

座標: 広場の中心(キャラの立つ位置)が原点、+Y がカルーセルの方向。寸法は目標画像から逆算した。
target の視点は高さ 1.25m、原点の 5.08m 手前、焦点距離 22.6mm(画像の 1672px に対して f=1050px、地平線は y=865)。
電球は 1 つのメッシュの複製(頂点インスタンス)で作り、発光面は光のサンプリングから外す。場面を照らすのは少数の光だけ。
"""
import math
import random

import bmesh
import bpy
import numpy as np
from mathutils import Vector, noise
from lib.studio import load_image

TAU = math.tau
F_PX = 1050.0  # 941x1672 の画像での焦点距離(px)
CAM = (0.0, -5.08, 1.25)
HORIZON = 865.0
GOLD = (.92, 0.54, 0.17, 1)
WARM = (1.0, 0.72, 0.36, 1)
ASSETS = None
MARK = (0.0, -1.1, 0.0)  # キャラの立つ位置。target で頭が木馬より上に出る距離


def P(px, py, d):
    """目標画像の画素 (px, py) に、カメラから奥行き d(m)で写る点"""
    return (CAM[0] + (px - 470.5) / F_PX * d, CAM[1] + d, CAM[2] + (HORIZON - py) / F_PX * d)


def G(px, py):
    """目標画像の画素に写る地面の点"""
    return P(px, py, CAM[2] * F_PX / (py - HORIZON))


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

    def grid(self, rows, closed=False, mat=0, smooth=True, us=1.0, vs=1.0, flip=False):
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
                if flip:
                    self.face((d, c, b, a), [(u0, v1), (u1, v1), (u1, v0), (u0, v0)], mat, smooth)
                else:
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
            rr = r(i / max(1, m - 1)) if callable(r) else r
            rows.append([tuple(pts[i] + (nor * math.cos(TAU * j / n) + bi * math.sin(TAU * j / n)) * rr) for j in range(n)])
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
    """pts の各点に proto_mesh の複製を置く。電球、手すりの細い柱など"""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(p) for p in pts], [], [])
    host = add(name, me, parent)
    host.instance_type = 'VERTS'
    host.show_instancer_for_render = False
    add(name + '_p', proto_mesh, host)
    return host


def instance_faces(name, items, proto_mesh, parent=None, seed=1):
    """items: (位置, 法線, 大きさ)。向きと大きさのある複製を、小さな三角形の面で指定する"""
    rng = random.Random(seed)
    v, f = [], []
    for p, n, s in items:
        n = Vector(n).normalized()
        a = n.orthogonal().normalized()
        b = n.cross(a)
        th = rng.uniform(0, TAU)
        a, b = a * math.cos(th) + b * math.sin(th), b * math.cos(th) - a * math.sin(th)
        p = Vector(p)
        k = len(v)
        leg = s * math.sqrt(2)
        v += [tuple(p), tuple(p + a * leg), tuple(p + b * leg)]
        f.append((k, k + 1, k + 2))
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], f)
    me.update()
    host = add(name, me, parent)
    host.instance_type = 'FACES'
    host.use_instance_faces_scale = True
    host.instance_faces_scale = 1.0
    host.show_instancer_for_render = False
    add(name + '_p', proto_mesh, host)
    return host


def leaf_cloud(name, pos, nor, size, mat):
    """葉を 1 枚の四角形ずつ 1 つのメッシュへ焼き込む。動かないので、コマごとの同期が要らない"""
    rng = np.random.default_rng(1)
    n = nor / np.linalg.norm(nor, axis=1, keepdims=True)
    t = np.cross(n, rng.normal(size=n.shape))
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    w = np.cross(n, t)
    sz = size[:, None]
    bend = n * sz * .35  # 葉先を下げて、中央の筋で折る
    v = np.stack([pos - t * sz - bend, pos - w * sz * .46 - bend * .2, pos + t * sz - bend, pos + w * sz * .46 - bend * .2], 1).reshape(-1, 3).astype(np.float32)
    N = len(pos)
    me = bpy.data.meshes.new(name)
    me.vertices.add(N * 4)
    me.vertices.foreach_set('co', v.ravel())
    me.loops.add(N * 4)
    me.loops.foreach_set('vertex_index', np.arange(N * 4, dtype=np.int32))
    me.polygons.add(N)
    me.polygons.foreach_set('loop_start', np.arange(N, dtype=np.int32) * 4)
    me.update(calc_edges=True)
    base = rng.uniform(.1, .8, (N, 2))
    quad = np.array([[0, .05], [.05, 0], [.1, .05], [.05, .1]], np.float32)
    uv = (base[:, None, :] + quad[None]).reshape(-1, 2).astype(np.float32)
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


def pbr(name, color=(0.8, 0.8, 0.8, 1), rough=0.5, metal=0.0, img=None, spec=0.5, coat=0.0, emit=None, emit_k=0.0, obj_color=False):
    m, nt, out = mat_base(name)
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], out.inputs[0])
    b.inputs['Base Color'].default_value = color
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    b.inputs['Specular IOR Level'].default_value = spec
    b.inputs['Coat Weight'].default_value = coat
    b.inputs['Coat Roughness'].default_value = 0.08
    src = None
    if img:
        t = tex_node(nt, image(img))
        src = t.outputs[0]
        nt.links.new(src, b.inputs['Base Color'])
    if obj_color:
        oi = nt.nodes.new('ShaderNodeObjectInfo')
        src = oi.outputs['Color']
        nt.links.new(src, b.inputs['Base Color'])
    if emit is not None or (emit_k and src is not None):
        if emit is not None:
            b.inputs['Emission Color'].default_value = emit
        else:
            nt.links.new(src, b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = emit_k
    m.cycles.emission_sampling = 'NONE'
    return m


def emis(name, color, k, img=None, attr=None):
    m, nt, out = mat_base(name)
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[0].default_value = color
    e.inputs[1].default_value = k
    nt.links.new(e.outputs[0], out.inputs[0])
    if img:
        nt.links.new(tex_node(nt, image(img)).outputs[0], e.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def bulb_palette(name, cols, k):
    """複製ごとに色の違う電球。Object Info の Random で色を選ぶ"""
    m, nt, out = mat_base(name)
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[1].default_value = k
    oi = nt.nodes.new('ShaderNodeObjectInfo')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    cr = ramp.color_ramp
    while len(cr.elements) > 1:
        cr.elements.remove(cr.elements[-1])
    cr.elements[0].position = 0
    cr.elements[0].color = cols[0]
    for i, c in enumerate(cols[1:], 1):
        cr.elements.new(i / len(cols)).color = c
    nt.links.new(oi.outputs['Random'], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], e.inputs[0])
    nt.links.new(e.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def bulb_amber(name, k):
    """丸い琥珀色の電球。正面は白に近く、縁は橙"""
    m, nt, out = mat_base(name)
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[1].default_value = k
    lw = nt.nodes.new('ShaderNodeLayerWeight')
    lw.inputs[0].default_value = .5
    mx = nt.nodes.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    nt.links.new(lw.outputs['Facing'], mx.inputs[0])
    mx.inputs['A'].default_value = (1, .5, .12, 1)
    mx.inputs['B'].default_value = (1, .38, .05, 1)
    nt.links.new(mx.outputs['Result'], e.inputs[0])
    nt.links.new(e.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def led_mat(name, stops, k):
    """スポークの光の階調。UV の v が中心から外への位置"""
    m, nt, out = mat_base(name)
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[1].default_value = k
    uv = nt.nodes.new('ShaderNodeTexCoord')
    sp = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    cr = ramp.color_ramp
    cr.elements[0].position, cr.elements[0].color = stops[0]
    cr.elements[1].position, cr.elements[1].color = stops[-1]
    for pos, c in stops[1:-1]:
        cr.elements.new(pos).color = c
    nt.links.new(uv.outputs['UV'], sp.inputs[0])
    nt.links.new(sp.outputs['Y'], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], e.inputs[0])
    nt.links.new(e.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def wet_stone(name, img, normal_img, height_img=None, metal=.25, tone=.36, spec=.5, coat=1.0, per_stone=True, gamma=1.0, near_coat=.42):
    """濡れた石。粗さは水膜の画像を 2 つの大きさで重ねて決め、乾いた石と水膜を分ける。
    per_stone の UV 'S' は石ごとの乱数で、明度、色味、粗さを 1 枚ずつ変える。
    コートは法線の画像をつながず、視線が浅い所だけ強くする。真上に近い所では石の模様が見える"""
    m, nt, out = mat_base(name)
    N = nt.nodes
    L = nt.links
    b = N.new('ShaderNodeBsdfPrincipled')
    L.new(b.outputs[0], out.inputs[0])
    uv = N.new('ShaderNodeTexCoord')
    col = tex_node(nt, image(img))
    L.new(uv.outputs['UV'], col.inputs[0])
    geo = N.new('ShaderNodeNewGeometry')
    sc = N.new('ShaderNodeVectorMath')
    sc.operation = 'SCALE'
    sc.inputs['Scale'].default_value = 1 / 13.0
    L.new(geo.outputs['Position'], sc.inputs[0])
    pud = tex_node(nt, image('puddle_s.png', data=True))
    L.new(sc.outputs[0], pud.inputs[0])
    sc2 = N.new('ShaderNodeVectorMath')
    sc2.operation = 'SCALE'
    sc2.inputs['Scale'].default_value = 1 / 2.9
    L.new(geo.outputs['Position'], sc2.inputs[0])
    pud2 = tex_node(nt, image('puddle_s.png', data=True))
    L.new(sc2.outputs[0], pud2.inputs[0])
    film = N.new('ShaderNodeMath')
    film.operation = 'MAXIMUM'
    L.new(pud.outputs[0], film.inputs[0])
    fm = N.new('ShaderNodeMath')
    fm.operation = 'MULTIPLY'
    L.new(pud2.outputs[0], fm.inputs[0])
    fm.inputs[1].default_value = .72
    L.new(fm.outputs[0], film.inputs[1])

    def remap(a, c):
        r = N.new('ShaderNodeMapRange')
        r.inputs['To Min'].default_value = a
        r.inputs['To Max'].default_value = c
        L.new(film.outputs[0], r.inputs['Value'])
        return r.outputs[0]

    dk = N.new('ShaderNodeMix')
    dk.data_type = 'RGBA'
    dk.blend_type = 'MULTIPLY'
    dk.inputs[0].default_value = 1
    L.new(col.outputs[0], dk.inputs['A'])
    dk.inputs['B'].default_value = (tone, tone, tone, 1)
    if gamma != 1.0:  # 暗い石をさらに暗く、赤を濃くする
        gm = N.new('ShaderNodeGamma')
        gm.inputs[1].default_value = gamma
        L.new(col.outputs[0], gm.inputs[0])
        L.new(gm.outputs[0], dk.inputs['A'])
    base = dk.outputs['Result']
    rough_in = remap(.36, .1)
    if per_stone:
        u_s = N.new('ShaderNodeUVMap')
        u_s.uv_map = 'S'
        sp = N.new('ShaderNodeSeparateXYZ')
        L.new(u_s.outputs[0], sp.inputs[0])
        lum = N.new('ShaderNodeMapRange')
        lum.inputs['To Min'].default_value = .3
        lum.inputs['To Max'].default_value = 1.9
        L.new(sp.outputs['X'], lum.inputs['Value'])
        d2 = N.new('ShaderNodeMix')
        d2.data_type = 'RGBA'
        d2.blend_type = 'MULTIPLY'
        d2.inputs[0].default_value = 1
        L.new(base, d2.inputs['A'])
        hue = N.new('ShaderNodeValToRGB')  # 石ごとに黒、紺、赤、灰へ振り分ける
        cr = hue.color_ramp
        cr.interpolation = 'CONSTANT'
        cr.elements[0].position, cr.elements[0].color = 0, (.3, .3, .34, 1)
        cr.elements[1].position, cr.elements[1].color = .3, (.28, .42, 1.1, 1)
        cr.elements.new(.52).color = (1.5, .42, .28, 1)
        cr.elements.new(.8).color = (.95, .9, .92, 1)
        L.new(sp.outputs['Y'], hue.inputs[0])
        d3 = N.new('ShaderNodeVectorMath')
        d3.operation = 'SCALE'
        L.new(hue.outputs[0], d3.inputs[0])
        L.new(lum.outputs[0], d3.inputs['Scale'])
        L.new(d3.outputs[0], d2.inputs['B'])
        base = d2.outputs['Result']
        ro = N.new('ShaderNodeMath')  # 石ごとの粗さ
        ro.operation = 'MULTIPLY_ADD'
        L.new(sp.outputs['X'], ro.inputs[0])
        ro.inputs[1].default_value = .18
        L.new(rough_in, ro.inputs[2])
        rough_in = ro.outputs[0]
    L.new(base, b.inputs['Base Color'])
    m.cycles.emission_sampling = 'NONE'
    gl = N.new('ShaderNodeMath')  # 暗い粒ほど粗くして、光を細かく散らす
    gl.operation = 'MULTIPLY_ADD'
    gl.use_clamp = True
    L.new(col.outputs[0], gl.inputs[0])
    gl.inputs[1].default_value = -0.3  # 石の明るい粒は滑らかで、灯りを細かく映す
    L.new(rough_in, gl.inputs[2])
    L.new(gl.outputs[0], b.inputs['Roughness'])
    b.inputs['Metallic'].default_value = metal
    b.inputs['Specular IOR Level'].default_value = spec
    lw = N.new('ShaderNodeLayerWeight')
    lw.inputs[0].default_value = .5
    vw = N.new('ShaderNodeMapRange')  # 視線の浅さ。真上に近いほど 0
    vw.inputs['From Min'].default_value = .6
    vw.inputs['From Max'].default_value = .86
    vw.inputs['To Min'].default_value = near_coat
    vw.inputs['To Max'].default_value = 1
    L.new(lw.outputs['Facing'], vw.inputs['Value'])
    cw = N.new('ShaderNodeMath')
    cw.operation = 'MULTIPLY'
    L.new(remap(.18 * coat, .72 * coat), cw.inputs[0])
    L.new(vw.outputs[0], cw.inputs[1])
    L.new(cw.outputs[0], b.inputs['Coat Weight'])
    L.new(remap(.14, .035), b.inputs['Coat Roughness'])
    b.inputs['Coat IOR'].default_value = 1.6
    nrm = tex_node(nt, image(normal_img, data=True))
    nsc = N.new('ShaderNodeVectorMath')
    nsc.operation = 'SCALE'
    nsc.inputs['Scale'].default_value = 20.0
    L.new(uv.outputs['UV'], nsc.inputs[0])
    L.new(nsc.outputs[0], nrm.inputs[0])
    nm = N.new('ShaderNodeNormalMap')
    L.new(nrm.outputs[0], nm.inputs['Color'])
    L.new(remap(.8, .12), nm.inputs['Strength'])
    final = nm.outputs[0]
    if height_img:
        h = tex_node(nt, image(height_img, data=True))
        L.new(uv.outputs['UV'], h.inputs[0])
        bu = N.new('ShaderNodeBump')
        bu.inputs['Strength'].default_value = 1.0
        bu.inputs['Distance'].default_value = 0.008
        L.new(h.outputs[0], bu.inputs['Height'])
        L.new(nm.outputs[0], bu.inputs['Normal'])
        final = bu.outputs[0]
    L.new(final, b.inputs['Normal'])
    # 水膜のうねり。コートの法線だけを低周波で揺らし、光の帯を横へつなげる
    sw = N.new('ShaderNodeVectorMath')
    sw.operation = 'SCALE'
    sw.inputs['Scale'].default_value = 1 / .4
    L.new(geo.outputs['Position'], sw.inputs[0])
    ws = tex_node(nt, image('puddle_s.png', data=True))
    L.new(sw.outputs[0], ws.inputs[0])
    wb = N.new('ShaderNodeBump')
    wb.inputs['Strength'].default_value = 1.0
    wb.inputs['Distance'].default_value = .006
    L.new(ws.outputs[0], wb.inputs['Height'])
    fn = N.new('ShaderNodeNormalMap')  # 小さな凹凸。灯りを細かい光の点に割る
    fn.inputs['Strength'].default_value = .16
    L.new(nrm.outputs[0], fn.inputs['Color'])
    L.new(fn.outputs[0], wb.inputs['Normal'])
    L.new(wb.outputs[0], b.inputs['Coat Normal'])
    return m


# ---- 空と遠景 ----
def sky():
    n, rows = 128, 24
    v, f = [], []
    for i in range(rows + 1):
        el = math.radians(-4 + 94 * (i / rows) ** 1.3)
        for j in range(n + 1):
            az = -math.pi + TAU * j / n  # 0 が +Y
            R = 700
            v.append((R * math.cos(el) * math.sin(az), R * math.cos(el) * math.cos(az), R * math.sin(el)))
    for i in range(rows):
        for j in range(n):
            f.append(((i) * (n + 1) + j, (i) * (n + 1) + j + 1, (i + 1) * (n + 1) + j + 1, (i + 1) * (n + 1) + j))
    me = bpy.data.meshes.new('Sky')
    me.from_pydata(v, [], f)
    me.update()
    la, lb, lc, ld = (me.uv_layers.new(name=x) for x in ('A', 'B', 'C', 'D'))

    def ss(a, c, x):
        t = max(0.0, min(1.0, (x - a) / (c - a)))
        return t * t * (3 - 2 * t)

    for p in me.polygons:
        for li, vi in zip(p.loop_indices, p.vertices):
            i, j = vi // (n + 1), vi % (n + 1)
            el = -4 + 94 * (i / rows) ** 1.3
            az = -180 + 360 * j / n
            aza = abs(az)
            vv = min((el + 4) / 54, 1)
            folded = az if aza <= 90 else math.copysign(180 - aza, az)  # 前と後ろは同じ画像
            la.uv[li].vector = (folded / 100 + .5, vv)
            lb.uv[li].vector = ((aza - 90) / 100 + .5, vv)
            lc.uv[li].vector = (ss(32, 50, aza) * (1 - ss(130, 148, aza)), ss(42, 50, el))
            ld.uv[li].vector = (1 - ss(29, 40, el), 0)
    m, nt, out = mat_base('Sky')
    N, L = nt.nodes, nt.links
    e = N.new('ShaderNodeEmission')
    L.new(e.outputs[0], out.inputs[0])
    ta = tex_node(nt, image('sky_main.png'), 'EXTEND')
    tb = tex_node(nt, image('sky_back.png'), 'EXTEND')
    for t, u in ((ta, 'A'), (tb, 'B')):
        uvn = N.new('ShaderNodeUVMap')
        uvn.uv_map = u
        L.new(uvn.outputs[0], t.inputs[0])
    uc = N.new('ShaderNodeUVMap')
    uc.uv_map = 'C'
    sp = N.new('ShaderNodeSeparateXYZ')
    L.new(uc.outputs[0], sp.inputs[0])
    m1 = N.new('ShaderNodeMix')
    m1.data_type = 'RGBA'
    L.new(sp.outputs['X'], m1.inputs[0])
    L.new(ta.outputs[0], m1.inputs['A'])
    L.new(tb.outputs[0], m1.inputs['B'])
    m2 = N.new('ShaderNodeMix')
    m2.data_type = 'RGBA'
    L.new(sp.outputs['Y'], m2.inputs[0])
    L.new(m1.outputs['Result'], m2.inputs['A'])
    m2.inputs['B'].default_value = (0.16, 0.17, 0.5, 1)
    gr = N.new('ShaderNodeMix')  # 画像の濃い赤と紺を夕暮れの空気でやわらげる
    gr.data_type = 'RGBA'
    gr.inputs[0].default_value = .3
    L.new(m2.outputs['Result'], gr.inputs['A'])
    gr.inputs['B'].default_value = (.72, .58, .84, 1)
    ud = N.new('ShaderNodeUVMap')
    ud.uv_map = 'D'
    sd = N.new('ShaderNodeSeparateXYZ')
    L.new(ud.outputs[0], sd.inputs[0])
    bf = N.new('ShaderNodeMath')
    bf.operation = 'MULTIPLY'
    L.new(sd.outputs['X'], bf.inputs[0])
    bf.inputs[1].default_value = .16
    sc_ = N.new('ShaderNodeMix')  # 低い空は暗い雲を持ち上げ、桃と橙へ寄せる
    sc_.data_type = 'RGBA'
    sc_.blend_type = 'SCREEN'
    L.new(bf.outputs[0], sc_.inputs[0])
    L.new(gr.outputs['Result'], sc_.inputs['A'])
    sc_.inputs['B'].default_value = (.74, .22, .38, 1)
    L.new(sc_.outputs['Result'], e.inputs[0])
    e.inputs[1].default_value = 1.1
    m.cycles.emission_sampling = 'NONE'
    me.materials.append(m)
    o = add('Sky', me)
    o.visible_shadow = False
    o.visible_glossy = False  # 濡れた床が空で白く霞まないよう、映り込みは下の暗い世界色にする
    w = bpy.data.worlds.new('W')
    w.use_nodes = True
    bg = next(x for x in w.node_tree.nodes if x.type == 'BACKGROUND')
    bg.inputs[0].default_value = (0.07, 0.05, 0.15, 1)
    bg.inputs[1].default_value = 1.0
    bpy.context.scene.world = w


def plate_mat(name, img, k, haze=None):
    """遠景の板。haze があれば、下ほど強く夕暮れの空気を混ぜる"""
    m, nt, out = mat_base(name)
    N, L = nt.nodes, nt.links
    t = tex_node(nt, image(img), 'EXTEND')
    t.image.alpha_mode = 'STRAIGHT'
    e = N.new('ShaderNodeEmission')
    e.inputs[1].default_value = k
    src = t.outputs[0]
    if haze:
        gm = N.new('ShaderNodeGamma')  # 暗部を締めて灯りを立てる
        gm.inputs[1].default_value = 1.3
        L.new(src, gm.inputs[0])
        src = gm.outputs[0]
        uv = N.new('ShaderNodeTexCoord')
        sp = N.new('ShaderNodeSeparateXYZ')
        L.new(uv.outputs['UV'], sp.inputs[0])
        f = N.new('ShaderNodeMapRange')
        f.inputs['To Min'].default_value = .16
        f.inputs['To Max'].default_value = .03
        L.new(sp.outputs['Y'], f.inputs['Value'])
        mx = N.new('ShaderNodeMix')
        mx.data_type = 'RGBA'
        L.new(f.outputs[0], mx.inputs[0])
        L.new(src, mx.inputs['A'])
        mx.inputs['B'].default_value = haze
        src = mx.outputs['Result']
    L.new(src, e.inputs[0])
    tr = N.new('ShaderNodeBsdfTransparent')
    mx2 = N.new('ShaderNodeMixShader')
    L.new(t.outputs[1], mx2.inputs[0])
    L.new(tr.outputs[0], mx2.inputs[1])
    L.new(e.outputs[0], mx2.inputs[2])
    L.new(mx2.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def far_view():
    # 丘の上の街。目標の城と同じ位置(px 30..430、y 210..640)に写る板
    haze = (.62, .38, .55, 1)
    d = 170.0
    y = CAM[1] + d
    x0, x1 = P(-290, 0, d)[0], P(760, 0, d)[0]
    z0, z1 = P(0, 868, d)[2], P(0, 165, d)[2]
    b = B()
    b.grid([[(x0, y, z0), (x1, y, z0)], [(x0, y, z1), (x1, y, z1)]])
    b.obj('Town', [plate_mat('Town', 'town_a.png', 1.5, haze)]).visible_shadow = False
    d_ = np.load(ASSETS / 'town_dots.npz')  # 街の窓の灯り
    pts = [(x0 + (x1 - x0) * u, y - .6, z0 + (z1 - z0) * v) for u, v in zip(d_['u'].tolist(), d_['v'].tolist()) if u < .66]
    tl = emis('TownLight', (1, .55, .16, 1), 2.4)
    rt = random.Random(2)
    for i, r_ in enumerate((.13, .22, .38)):  # 建物ごとに灯りの大きさを変える
        instance_verts(f'TownLights{i}', [q for q in pts if rt.random() < (.5, .34, .16)[i]], sphere_mesh(f'TownLight{i}', r_, tl, 1))
    # 丘の裾。板の下と左右の切れ目を隠し、どの視点でも街が斜面の上にあるようにする
    m = B()
    xs = [(-440 + 880 * i / 96) for i in range(97)]
    cx = (x0 + x1) / 2
    top = [10 * math.exp(-((x - cx) / 185) ** 2) + 3 + 2 * noise.noise(Vector((x / 24, 3.1, 0))) for x in xs]
    m.grid([[(x, y - 3, -1) for x in xs], [(x, y - 3, t * .55) for x, t in zip(xs, top)], [(x, y - 3, t) for x, t in zip(xs, top)]], us=30, vs=2)
    o = m.obj('Mound', [emis('Mound', (.03, .03, .035, 1), 1.0)])
    o.visible_shadow = False
    # 遠い木立と屋根の帯。広場を一周させる
    b = B()
    n = 96
    r = 230
    rows = [[(r * math.cos(TAU * j / n), r * math.sin(TAU * j / n), z) for j in range(n + 1)] for z in (-2, 46)]
    b.grid(rows, us=12)
    o = b.obj('FarBand', [plate_mat('FarBand', 'farband_a.png', 0.8)])
    o.visible_shadow = False
    bpy.data.materials['FarBand'].node_tree.nodes['Image Texture'].extension = 'MIRROR'
    apron = B()
    apron.lathe([(36, 0.05), (700, 0.05)], n=64)
    apron.obj('Apron', [pbr('Apron', (0.02, 0.03, 0.025, 1), 0.8, spec=0.2)])


# ---- 地面 ----
def floor():
    """敷石は 2 段。手前は大きな石、メダリオンの周りと奥は細かい石の同心の帯"""
    rng = random.Random(7)
    dark = wet_stone('StoneDark', 'stone_dark.png', 'stone_n.png')
    warm = wet_stone('StoneWarm', 'stone_warm.png', 'stone_n.png')
    cream = wet_stone('StoneCream', 'stone_cream.png', 'stone_n.png', tone=.55)
    bs = [B(), B(), B()]
    stone_uv = [[], [], []]

    def stone(r0_, r1_, a0, a1, big, ox=0.0, oy=0.0):
        g = .008 if big else .006
        r0, r1 = r0_ + g, r1_ - g
        rm = (r0 + r1) / 2
        da = g / rm
        e = .014 if big else .009
        drop = .011 if big else .007
        rs = (r0, r0 + e, r1 - e, r1)
        cols = 6 if big else 4
        de = e / rm
        ang = [a0 + da] + [a0 + da + de + (a1 - a0 - 2 * da - 2 * de) * i / (cols - 3) for i in range(cols - 2)] + [a1 - da]
        dz = rng.uniform(-.0015, .0015) + (.012 if big else 0)
        ru, rv = rng.random(), rng.random()
        am = (a0 + a1) / 2
        tilt = rng.uniform(-.002, .002)
        tx, ty = tilt * math.cos(am), tilt * math.sin(am)
        cx, cy = ox + rm * math.cos(am), oy + rm * math.sin(am)
        k = rng.choices((0, 1, 2), (.16, .5, .34))[0]
        b = bs[k]
        s1, s2 = rng.random(), rng.random()
        base = len(b.v)
        for i, rr in enumerate(rs):
            for j, a in enumerate(ang):
                x, y = ox + rr * math.cos(a), oy + rr * math.sin(a)
                edge = i in (0, 3) or j in (0, cols - 1)
                b.v.append((x, y, dz + tx * (x - cx) + ty * (y - cy) - (drop if edge else 0)))
        for i in range(3):
            for j in range(cols - 1):
                q = [base + i * cols + j, base + i * cols + j + 1, base + (i + 1) * cols + j + 1, base + (i + 1) * cols + j]
                b.face(tuple(q), [(b.v[t][0] / 2.0 + ru, b.v[t][1] / 2.0 + rv) for t in q], 0, False)
                stone_uv[k] += [s1, s2] * 4

    # 手前の大きな石: 中心を奥へずらした浅い弧の列
    oy_, r_a, r_b = 3.6, 6.32, 10.5

    def in_rows(x, y):
        return y < 0 and r_a < math.hypot(x, y - oy_) < r_b

    ra = r_a
    for w in (.39, .42, .45, .48, .5, .52, .54, .56, .58):
        n_ = round(TAU * (ra + w / 2) / .64)
        o_ = rng.uniform(0, TAU / n_)
        for k in range(n_):
            a0, a1 = o_ + TAU * k / n_, o_ + TAU * (k + 1) / n_
            am = (a0 + a1) / 2
            if oy_ + (ra + w / 2) * math.sin(am) < 0:
                stone(ra, ra + w, a0, a1, True, 0.0, oy_)
        ra += w
    r = 2.06
    for w, L in ((.17, .24), (.17, .24)):  # メダリオンの周りの細い帯
        n = round(TAU * r / L)
        o = rng.uniform(0, TAU)
        for k in range(n):
            stone(r, r + w, o + TAU * k / n, o + TAU * (k + 1) / n, False)
        r += w
    while r < 36:
        w = .52 if r < 6 else (.72 if r < 12 else 1.0)
        n = max(10, round(TAU * (r + w / 2) / (.92 if r < 6 else (1.2 if r < 12 else 1.5))))
        o = rng.uniform(0, TAU)
        for k in range(n):
            a0, a1 = o + TAU * k / n, o + TAU * (k + 1) / n
            am = ((a0 + a1) / 2) % TAU
            if r > 16 and not .72 < am < 2.42:  # 芝の下
                continue
            nr = 2 if r < 6 else (3 if r < 20 else 2)
            na = max(2, round((r + w / 2) * (a1 - a0) / (.34 if r < 20 else .6)))
            for i in range(nr):
                ro = rng.uniform(0, 1) / na * (a1 - a0) * (i % 2)
                for j in range(na):
                    a_ = (a0 + (a1 - a0) * j / na, a0 + (a1 - a0) * (j + 1) / na)
                    if all(in_rows(q_ * math.cos(t_), q_ * math.sin(t_)) for q_ in (r + w * i / nr, r + w * (i + 1) / nr) for t_ in a_):
                        continue
                    stone(r + w * i / nr, r + w * (i + 1) / nr, a0 + (a1 - a0) * j / na, a0 + (a1 - a0) * (j + 1) / na, False)
        r += w
    for b, su, m, nm in zip(bs, stone_uv, (cream, dark, warm), ('FloorCream', 'FloorDark', 'FloorWarm')):
        me = b.mesh(nm, [m])
        me.uv_layers.new(name='S').uv.foreach_set('vector', su)
        add(nm, me)
    # 目地
    gr = B()
    gr.lathe([(0.01, -0.02), (37, -0.02)], n=64)
    gr.obj('Grout', [pbr('Grout', (0.012, 0.01, 0.012, 1), 0.6, spec=0.3)])
    # 中央のメダリオン。周りの石と同じ高さ
    d = B()
    rr = 2.052
    n = 96
    rows = [[(q * math.cos(TAU * j / n), q * math.sin(TAU * j / n), z) for j in range(n)] for q, z in ((.002, 0), (.6, 0), (1.2, 0), (1.8, 0), (rr - .012, 0), (rr, 0))]
    d.grid(rows, closed=True, smooth=False)
    d.uv = [(x * 0.489 / rr + 0.5, y * 0.489 / rr + 0.5) for f in d.f for x, y, z in (d.v[i] for i in f)]
    d.obj('Mosaic', [wet_stone('Mosaic', 'mosaic.png', 'stone_n.png', 'mosaic_h.png', .0, .62, .08, .7, False, 1.8, .5)])


# ---- 小物 ----
def horse_mesh():
    """image_gen の木馬の輪郭から prep.py が起こしたメッシュ。塗りの画像と形が必ず一致する"""
    d = np.load(ASSETS / 'horse_mesh.npz')
    me = bpy.data.meshes.new('Horse')
    me.from_pydata(d['v'].tolist(), [], d['f'].tolist())
    me.update()
    uv = me.uv_layers.new(name='UVMap')
    loops = np.zeros(len(me.loops), dtype=np.int32)
    me.loops.foreach_get('vertex_index', loops)
    uv.uv.foreach_set('vector', d['uv'][loops].ravel())
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.update()
    return me


def goods_meshes(mat, stick):
    """売り台の品。瓶、背の高い瓶、綿あめ、棒付き飴、段のケーキ"""
    res = []
    b = B()
    b.lathe([(.001, 0), (.09, 0), (.1, .03), (.1, .2), (.07, .24), (.075, .27), (.001, .28)], n=12)
    res.append(b.mesh('GoodJar', [mat]))
    b = B()
    b.lathe([(.001, 0), (.06, 0), (.07, .04), (.07, .42), (.04, .47), (.05, .5), (.001, .51)], n=12)
    res.append(b.mesh('GoodTall', [mat]))
    b = B()
    b.lathe([(.008, 0), (.008, .3)], n=6, mat=1)
    b.lathe([(.001, .26), (.1, .3), (.15, .4), (.16, .5), (.12, .6), (.05, .66), (.001, .67)], n=12)
    res.append(b.mesh('GoodCandy', [mat, stick]))
    b = B()
    b.lathe([(.007, 0), (.007, .34)], n=6, mat=1)
    b.grid([[(.13 * q * math.cos(TAU * j / 16), .012 if q < 1 else 0, .44 + .13 * q * math.sin(TAU * j / 16)) for j in range(16)] for q in (.01, .9, 1)], closed=True)
    res.append(b.mesh('GoodLolly', [mat, stick]))
    b = B()
    b.lathe([(.001, 0), (.17, 0), (.17, .1), (.12, .11), (.12, .2), (.075, .21), (.075, .29), (.001, .3)], n=16)
    res.append(b.mesh('GoodCake', [mat]))
    return res


def flower_protos(n=6):
    """花の複製。1 つの花びらの形に、花の画像の 1 区画を貼る。透過は使わない"""
    m, nt, out = mat_base('Flower')
    bd = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bd.inputs['Roughness'].default_value = 0.45
    t = tex_node(nt, image('flowers.png'))
    uvn = nt.nodes.new('ShaderNodeTexCoord')
    nt.links.new(uvn.outputs['UV'], t.inputs[0])
    nt.links.new(t.outputs[0], bd.inputs['Base Color'])
    nt.links.new(t.outputs[0], bd.inputs['Emission Color'])
    bd.inputs['Emission Strength'].default_value = 0.2
    nt.links.new(bd.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    res = []
    for c in range(n):
        cu, cv = (c % 4 + 0.5) / 4, ((c // 4) * 2 + 0.5) / 4  # 4x4 の区画から選ぶ
        b = B()
        ns = 10
        rows = []
        for rq in (0.02, 0.45, 0.8, 1.0):
            rows.append([(rq * (1 + .16 * math.cos(5 * TAU * j / ns)) * math.cos(TAU * j / ns), rq * (1 + .16 * math.cos(5 * TAU * j / ns)) * math.sin(TAU * j / ns), 0.5 * rq * rq - 0.25 if rq else 0) for j in range(ns)])
        b.grid(rows, closed=True)
        b.uv = [(cu + x / 8.5, cv + y / 8.5) for f in b.f for x, y, z in (b.v[i] for i in f)]
        res.append(b.mesh(f'Flower{c}', [m]))
    return res


class Flowers:
    """花と葉をためて、種類ごとに 1 つの複製にまとめる"""

    def __init__(self, iron):
        self.leaf = pbr('Leaf', (0.2, 0.3, 0.2, 1), 0.4, img='leaf.png', emit_k=0.1)
        self.protos = flower_protos()
        self.items = [[] for _ in self.protos]
        self.leaves = []
        self.rng = random.Random(3)
        self.blob = B()
        self.hw = B()
        self.iron = iron

    def ball(self, c, r, count, fs, trail=False):
        """葉の下地と、その表面の花と葉。fs は花の大きさ。trail で下へ垂れる"""
        rng = self.rng
        c = Vector(c)
        sq = rng.uniform(.75, 1.1)
        rows = []
        for i in range(7):
            el = math.pi * (i / 6 - 0.5)
            row = []
            for j in range(12):
                az = TAU * j / 12
                rad = r * (.8 + .5 * noise.noise(Vector((c.x + j * .9, c.y + i * .9, c.z))))
                row.append(tuple(c + Vector((math.cos(el) * math.cos(az) * rad, math.cos(el) * math.sin(az) * rad, math.sin(el) * rad * sq))))
            rows.append(row)
        self.blob.grid(rows, closed=True, us=2, vs=1)
        for _ in range(count):
            n = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
            p = c + Vector((n.x * r, n.y * r, n.z * r * sq * (1.5 if trail and n.z < 0 else 1)))
            kinds = rng.choices(range(len(self.protos)), (2, 5, 3, 1, 3, 1))[0]
            self.items[kinds].append((tuple(p), tuple(n + Vector((rng.uniform(-.4, .4), rng.uniform(-.4, .4), rng.uniform(-.4, .4)))), rng.uniform(.7, 1.25) * fs))
            if rng.random() < .8:
                n2 = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
                self.leaves.append((tuple(c + n2 * r * rng.uniform(.95, 1.2)), tuple(n2), rng.uniform(.8, 1.3) * fs * 1.1))

    def clump(self, c, r, count, fs=.05):
        """不揃いな花の塊"""
        rng = self.rng
        c = Vector(c)
        for _ in range(6):
            o = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-.5, .7))) * r * .62
            self.ball(c + o, r * rng.uniform(.42, .68), count // 6, fs)

    def basket(self, c, r, post=None, fs=.05):
        """吊り花かご。鉄の籠と鎖、不揃いな花と垂れる葉。post は腕の根元の xy"""
        rng = self.rng
        c = Vector(c)
        self.hw.lathe([(.001, -r * .62), (r * .4, -r * .6), (r * .78, -r * .32), (r * .9, 0), (r * .92, r * .06), (r * .86, r * .03)], n=14, c=tuple(c))
        top = c + Vector((0, 0, r * 1.5))
        for i in range(3):
            a = TAU * i / 3 + .4
            self.hw.tube([c + Vector((math.cos(a) * r * .88, math.sin(a) * r * .88, .06)), top], .012, 4)
        if post:
            p0 = Vector((post[0], post[1], top.z - .05))
            self.hw.tube([p0, (p0 + top) / 2 + Vector((0, 0, .1)), top], .03, 5)
        for _ in range(6):
            o = Vector((rng.uniform(-.85, .85), rng.uniform(-.85, .85), rng.uniform(.0, .55))) * r
            self.ball(c + o, r * rng.uniform(.38, .6), 230, fs * .68)
        for _ in range(5):  # 垂れる枝
            a = rng.uniform(0, TAU)
            for k in range(3):
                self.ball(c + Vector((math.cos(a) * r * .86, math.sin(a) * r * .86, -r * .12 - k * r * .34)), r * (.2 - k * .03), 16, fs * .8, True)

    def finish(self):
        self.blob.obj('FlowerLeaves', [self.leaf])
        self.hw.obj('Baskets', [self.iron])
        for i, (it, pm) in enumerate(zip(self.items, self.protos)):
            if it:
                instance_faces(f'Flowers{i}', it, pm, seed=i)
        lp = B()
        lp.grid([[(-1, 0, 0), (0, -.55, .15), (1, 0, 0)], [(-1, 0, 0), (0, .55, .15), (1, 0, 0)]])
        lp.uv = [(x * .12 + .3, y * .12 + .3) for f in lp.f for x, y, z in (lp.v[i] for i in f)]
        instance_faces('BasketLeaves', self.leaves, lp.mesh('BasketLeafP', [self.leaf]))


def lamp_mesh(iron, gold, glass):
    """飾り街灯 1 本。高さ約 10m。太い鋳鉄の柱で、腕は +X"""
    b = B()
    b.lathe([(.5, 0), (.5, .2), (.38, .28), (.38, .6), (.26, .8), (.24, 1.1), (.19, 1.35), (.18, 2.0), (.25, 2.06), (.25, 2.18), (.17, 2.3), (.15, 4.4), (.2, 4.46), (.2, 4.56), (.14, 4.66), (.12, 8.25), (.16, 8.32), (.09, 8.5)], n=20)
    cx = 0.47
    arm = [(cx * t, 0, 8.3 + .3 * math.sin(t * math.pi * .62)) for t in [i / 12 for i in range(13)]]
    b.tube(arm, .04, 6)
    spiral = [(0.25 + .08 * (1 - a / 12) * math.cos(a), 0, 8.02 + .08 * (1 - a / 12) * math.sin(a)) for a in [i * .4 for i in range(29)]]
    b.tube(spiral, .016, 5, mat=1)
    b.lathe([(.001, 8.5), (.1, 8.52), (.13, 8.6), (.09, 8.66)], n=12, c=(cx, 0, 0), mat=1)
    b.lathe([(.09, 8.66), (.21, 9.02), (.25, 9.3), (.21, 9.44)], n=14, c=(cx, 0, 0), mat=2)
    for i in range(8):
        a = TAU * i / 8
        b.tube([(cx + rr * math.cos(a), rr * math.sin(a), z) for rr, z in ((.095, 8.66), (.215, 9.02), (.255, 9.3), (.215, 9.44))], .012, 5, mat=0)
    b.lathe([(.29, 9.44), (.3, 9.47), (.14, 9.62), (.05, 9.76), (.07, 9.8), (.03, 9.86), (.045, 9.9), (.001, 10.04)], n=14, c=(cx, 0, 0), mat=0)
    # 鋳物の飾り: 灯りの下の輪、柱頭の葉、腕の下の渦巻き
    b.tube([(cx + .17 * math.cos(TAU * j / 12), .17 * math.sin(TAU * j / 12), 8.78) for j in range(12)], .018, 4, mat=1, closed=True)
    b.tube([(cx + .3 * math.cos(TAU * j / 14), .3 * math.sin(TAU * j / 14), 9.46) for j in range(14)], .022, 4, mat=1, closed=True)
    for i in range(6):
        a = TAU * i / 6
        b.tube([(r_ * math.cos(a), r_ * math.sin(a), z) for r_, z in ((.13, 7.7), (.2, 7.85), (.24, 8.02), (.17, 8.1))], .018, 4)
    for sx in (-1,):  # 反対の腕にも小さな灯り
        ax = [(sx * .42 * t, 0, 7.75 + .25 * math.sin(t * 2.0)) for t in (i / 10 for i in range(11))]
        b.tube(ax, .03, 6)
        b.lathe([(.06, 7.98), (.15, 8.2), (.17, 8.4), (.13, 8.5)], n=10, c=(-.42, 0, 0), mat=2)
        b.lathe([(.19, 8.5), (.08, 8.64), (.02, 8.72), (.001, 8.8)], n=10, c=(-.42, 0, 0), mat=0)
    return b.mesh('Lamp', [iron, gold, glass])


def petal_mat():
    """濡れて張り付いた花びら。光が透け、1 枚ごとに薄い色へ寄せる"""
    m = pbr('Petal', img='petal.png', rough=.22, coat=.7, emit_k=.03)
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    t = next(n for n in nt.nodes if n.type == 'TEX_IMAGE')
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    oi = nt.nodes.new('ShaderNodeObjectInfo')
    mx = nt.nodes.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    nt.links.new(oi.outputs['Random'], mx.inputs[0])
    nt.links.new(t.outputs[0], mx.inputs['A'])
    mx.inputs['B'].default_value = (.95, .78, .76, 1)
    nt.links.new(mx.outputs['Result'], b.inputs['Base Color'])
    tl = nt.nodes.new('ShaderNodeBsdfTranslucent')
    nt.links.new(mx.outputs['Result'], tl.inputs[0])
    ms = nt.nodes.new('ShaderNodeMixShader')
    ms.inputs[0].default_value = .38
    nt.links.new(b.outputs[0], ms.inputs[1])
    nt.links.new(tl.outputs[0], ms.inputs[2])
    nt.links.new(ms.outputs[0], out.inputs[0])
    return m


def leaf_mat():
    """木の葉。1 枚ごとに明るさと色味を変える"""
    m = pbr('TreeLeaf', img='leaf.png', rough=.45)
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    t = next(n for n in nt.nodes if n.type == 'TEX_IMAGE')
    oi = nt.nodes.new('ShaderNodeUVMap')
    oi.uv_map = 'S'
    sp = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(oi.outputs[0], sp.inputs[0])
    mx = nt.nodes.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    mx.blend_type = 'MULTIPLY'
    mx.inputs[0].default_value = 1
    nt.links.new(t.outputs[0], mx.inputs['A'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    cr = ramp.color_ramp
    cr.elements[0].color = (.5, .7, .42, 1)
    cr.elements[1].color = (2.2, 1.7, .6, 1)
    cr.elements.new(.45).color = (.75, 1.3, .55, 1)
    nt.links.new(sp.outputs['X'], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], mx.inputs['B'])
    nt.links.new(mx.outputs['Result'], b.inputs['Base Color'])
    nt.links.new(mx.outputs['Result'], b.inputs['Emission Color'])
    b.inputs['Emission Strength'].default_value = .28
    return m


def petal_mesh(seed, mat):
    """不揃いな輪郭で、縁が丸まった花びら"""
    b = B()
    ofs = Vector((seed * 3.1, seed * 1.7, 0))
    rows = []
    for q in (.02, .4, .75, 1):
        row = []
        for j in range(14):
            a = TAU * j / 14
            k = 1 + .34 * noise.noise(Vector((math.cos(a), math.sin(a), 0)) * 1.2 + ofs)
            x, y = q * k * math.cos(a) * (1 + .18 * math.cos(a)), q * k * .74 * math.sin(a)
            row.append((x, y, .02 + .1 * (x * x * .55 + y * y) * (.6 + .4 * math.sin(seed * 2.1 + x * 2))))
        rows.append(row)
    b.grid(rows, closed=True)
    b.uv = [(x * .5 + .5, y * .5 + .5) for f in b.f for x, y, z in (b.v[i] for i in f)]
    return b.mesh(f'Petal{seed}', [mat])


def lantern_glass():
    """灯りの硝子。正面は明るく、縁は橙"""
    m, nt, out = mat_base('LampGlass')
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[1].default_value = 3.0
    lw = nt.nodes.new('ShaderNodeLayerWeight')
    lw.inputs[0].default_value = .55
    mx = nt.nodes.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    nt.links.new(lw.outputs['Facing'], mx.inputs[0])
    mx.inputs['A'].default_value = (1, .7, .32, 1)
    mx.inputs['B'].default_value = (1, .28, .02, 1)
    nt.links.new(mx.outputs['Result'], e.inputs[0])
    nt.links.new(e.outputs[0], out.inputs[0])
    m.cycles.emission_sampling = 'NONE'
    return m


def catenary(a, b, sag, n):
    a, b = Vector(a), Vector(b)
    return [a.lerp(b, t) - Vector((0, 0, sag * 4 * t * (1 - t))) for t in (i / n for i in range(n + 1))]


def scroll(b, c, t, u, r, flip, turns=1.7):
    """面の上の渦巻き。c が外の端、t と u が面の向き"""
    pts = []
    for i in range(30):
        q = i / 29
        a = TAU * turns * q
        rr = r * (1 - q * .9)
        pts.append(c + t * flip * (r - rr * math.cos(a)) + u * rr * math.sin(a))
    b.tube(pts, lambda q: .034 * (1 - .65 * q), 5)


# ---- 大物 ----
def carousel(ctx, mats, center, keys):
    gold, goldd, ivory, bulb_a, bulb_b = mats['gold'], mats['goldd'], mats['ivory'], mats['bulb_a'], mats['bulb_b']
    cx, cy = center
    base = B()
    base.lathe([(.01, 0), (7.1, 0), (7.1, .18), (6.9, .22), (6.9, .36), (.01, .36)], n=64, mat=0)
    base.obj('CarBase', [pbr('CarBase', (.1, .05, .05, 1), .3, spec=.6)], loc=(cx, cy, 0))
    rot = add('CarRot', None, loc=(cx, cy, 0))
    paint = pbr('Horse', (.9, .9, .9, 1), .24, img='horse.png', coat=1, emit_k=.34)
    hm = horse_mesh()
    hm.materials.append(paint)
    deck = B()
    deck.lathe([(.01, .42), (6.75, .42), (6.75, .52), (.01, .52)], n=64)
    deck.lathe([(6.75, .4), (6.8, .4), (6.8, .56), (6.75, .56)], n=64, mat=1)
    deck.obj('Deck', [pbr('Deck', (.45, .2, .12, 1), .3, spec=.7), gold], rot)

    # 馬と柱
    poles = B()
    poles.lathe([(.042, 0), (.042, 4.72)], n=8)
    helix = [(.052 * math.cos(a), .052 * math.sin(a), a * .045) for a in [i * .35 for i in range(300)] if a * .045 < 4.72]
    poles.tube(helix, .012, 4)
    pole_mesh = poles.mesh('Pole', [gold])
    pole_pts, horses = [], []
    for ring_r, count, offs, sc, hz in ((5.9, 12, 0.13, 1.32, .52), (4.4, 12, .0, 1.15, .52), (3.0, 8, .3, .72, 1.86)):
        for i in range(count):
            a = TAU * (i + offs) / count
            x, y = ring_r * math.cos(a), ring_r * math.sin(a)
            pole_pts.append((x, y, .52))
            h = add(f'Horse{len(horses)}', hm, rot, (x, y, hz), (0, 0, a + math.pi / 2), sc)
            horses.append(h)
    # 上の段(内側の手すり付きの通路)
    ctr = B()
    ctr.lathe([(3.3, .5), (3.3, 1.72)], n=48, us=4)
    ctr.lathe([(2.5, 1.86), (2.5, 5.0)], n=48, us=3)
    ctr.lathe([(3.3, 1.72), (3.5, 1.76), (3.5, 1.86), (2.5, 1.86)], n=48, mat=1)
    ctr.obj('Core', [pbr('Core', img='core.png', rough=.3, emit_k=.3), gold], rot)
    for i in range(12):
        a = TAU * (i + .5) / 12
        pole_pts.append((3.45 * math.cos(a), 3.45 * math.sin(a), .52))
    instance_verts('Poles', pole_pts, pole_mesh, rot)
    rail = B()
    n = 72
    for r_, z in ((3.48, 2.7), (3.48, 1.95)):
        rail.tube([(r_ * math.cos(TAU * j / n), r_ * math.sin(TAU * j / n), z) for j in range(n)], .03, 6, closed=True)
    rail.obj('InnerRail', [gold], rot)
    bal = B()
    bal.lathe([(.016, 0), (.03, .2), (.016, .4), (.03, .6), (.016, .75)], n=6)
    instance_verts('Balusters', [(3.48 * math.cos(TAU * j / 90), 3.48 * math.sin(TAU * j / 90), 1.95) for j in range(90)], bal.mesh('Bal', [goldd]), rot)
    # 天井と軒
    roof = B()
    roof.lathe([(6.95, 5.22), (6.6, 5.26), (5, 5.5), (2.4, 5.1), (.01, 6.0)], n=64, mat=0)
    roof.obj('Ceil', [pbr('Ceil', (.09, .03, .025, 1), .4)], rot)
    cr = B()  # 暗い天井の金の放射と輪
    for i in range(24):
        a = TAU * i / 24
        cr.tube([(r_ * math.cos(a), r_ * math.sin(a), z) for r_, z in ((6.6, 5.24), (5, 5.48), (2.5, 5.12))], .028, 5)
    for r_, z in ((6.3, 5.27), (4.2, 5.33), (2.8, 5.14)):
        cr.tube([(r_ * math.cos(TAU * j / 96), r_ * math.sin(TAU * j / 96), z) for j in range(96)], .03, 5, closed=True)
    cr.obj('CeilRibs', [gold], rot)
    fas = B()
    fas.lathe([(6.98, 5.2), (7.06, 5.2), (7.06, 5.42), (6.98, 5.46), (7.0, 5.62), (7.08, 5.66), (7.08, 5.92), (6.9, 5.96)], n=96, smooth=False)
    fas.obj('Fascia', [gold], rot)
    # 冠: 直線の 10 面の絵の板と、連続した金枠
    N = 10
    pa, pb, frame, top_b = B(), B(), B(), []
    rP = 6.86
    zb, zt = 5.96, 7.16
    corner = [Vector((rP * math.cos(TAU * i / N), rP * math.sin(TAU * i / N), 0)) for i in range(N + 1)]
    for i in range(N):
        c0, c1 = corner[i], corner[i + 1]
        arch = lambda t: .42 * math.sin(math.pi * t) ** .8  # 各面の上辺は弧
        ts = [.03 + .94 * j / 12 for j in range(13)]
        (pa if i % 2 == 0 else pb).grid([[tuple(c0.lerp(c1, t) + Vector((0, 0, zb + (zt + arch(t) - zb) * v_))) for t in ts] for v_ in (0, .5, 1)], vs=.8, flip=True)
        rad = (c0 + c1).normalized()
        tan = (c1 - c0).normalized()
        up = Vector((0, 0, 1))
        wid = (c1 - c0).length
        base_p = (c0 + c1) / 2 + rad * .1
        # 枠: 上下の梁と、継ぎ目の柱
        for dz_, th in ((.03, .085), (.17, .045)):
            frame.tube([c0.lerp(c1, t) + rad * .1 + Vector((0, 0, zt + arch(t) + dz_)) for t in [j / 16 for j in range(17)]], th, 6)
        frame.tube([c0 + rad * .1 + Vector((0, 0, zb + .03)), c1 + rad * .1 + Vector((0, 0, zb + .03))], .07, 6)
        inset = .17
        rect = [(-wid / 2 + inset, zb + .12), (wid / 2 - inset, zb + .12), (wid / 2 - inset, zt - .12), (-wid / 2 + inset, zt - .12)]
        frame.tube([base_p + tan * x + up * z for x, z in rect], .03, 5, closed=True)
        # 渦巻きと上の飾り
        scroll(frame, base_p - tan * (wid / 2 - .22) + up * (zb + .22), tan, up, .2, 1)
        scroll(frame, base_p + tan * (wid / 2 - .22) + up * (zb + .22), tan, up, .2, -1)
        scroll(frame, base_p - tan * (wid / 2 - .22) + up * (zt - .3), tan, up, .15, 1)
        scroll(frame, base_p + tan * (wid / 2 - .22) + up * (zt - .3), tan, up, .15, -1)
        scroll(frame, base_p - tan * .62 + up * (zt + .62), tan, up, .24, 1)
        scroll(frame, base_p + tan * .62 + up * (zt + .62), tan, up, .24, -1)
        frame.lathe([(.001, zt + .5), (.18, zt + .6), (.26, zt + .76), (.2, zt + .9), (.07, zt + 1.0), (.12, zt + 1.08), (.001, zt + 1.28)], n=8, c=tuple((c0 + c1) / 2 + rad * .06))
        p0 = corner[i] * 1.012
        frame.lathe([(.001, 5.9), (.17, 5.96), (.13, 6.12), (.16, 6.6), (.13, 7.1), (.24, 7.3), (.1, 7.7), (.18, 7.95), (.08, 8.2), (.11, 8.3), (.001, 8.62)], n=10, c=(p0.x, p0.y, 0))
        for t in (.1, .2, .3, .4, .5, .6, .7, .8, .9):
            q = c0.lerp(c1, t) + rad * .17
            top_b.append((q.x, q.y, zt + arch(t) + .16))
            top_b.append((q.x, q.y, zb + .02))
        top_b.append((p0.x * 1.03, p0.y * 1.03, 8.05))
    pa.obj('PanelA', [pbr('PanelA', img='panel.png', rough=.3, emit_k=.4)], rot)
    pb.obj('PanelB', [pbr('PanelB', img='panel2.png', rough=.3, emit_k=.4)], rot)
    frame.obj('CrownFrame', [gold], rot)

    # 屋根
    tent = B()
    prof = [(6.5, 6.9), (5.0, 7.25), (4.1, 7.8), (3.3, 8.5), (2.5, 9.3), (1.8, 10.15), (1.15, 11.05), (.6, 11.9), (.12, 12.55)]
    tent.lathe(prof, n=96, smooth=True, us=4)
    tent.obj('Tent', [pbr('Tent', img='canopy.png', rough=.35, emit_k=.55)], rot)
    fin = B()
    fin.lathe([(.14, 12.4), (.3, 12.48), (.32, 12.54), (.12, 12.62), (.22, 12.72), (.25, 12.78), (.2, 12.84), (.09, 12.92), (.15, 12.98), (.07, 13.04), (.03, 13.3), (.05, 13.34), (.07, 13.4), (.05, 13.46), (.001, 13.62)], n=16)
    fin.obj('Finial', [gold], rot)
    ribs = []
    for i in range(16):
        a = TAU * i / 16
        pts = [(r_ * math.cos(a), r_ * math.sin(a), z) for r_, z in prof]
        rb = B()
        rb.tube(pts, .05, 5)
        rb.obj(f'Rib{i}', [gold], rot)
        for s in range(len(pts) - 1):
            p0, p1 = Vector(pts[s]), Vector(pts[s + 1])
            for t in (.5,):
                p = p0.lerp(p1, t) + Vector((math.cos(a), math.sin(a), .4)).normalized() * .06
                ribs.append(tuple(p))

    # 電球
    A, Bb = [], []
    for r_, z, cnt in ((7.12, 5.31, 190), (7.14, 5.79, 190), (6.0, 5.2, 120), (6.9, 5.12, 170), (7.1, 5.55, 150)):
        for j in range(cnt):
            a = TAU * j / cnt
            (A if j % 2 else Bb).append((r_ * math.cos(a), r_ * math.sin(a), z))
    for i in range(24):  # 天井の放射の列
        a = TAU * i / 24
        for j in range(13):
            q = j / 12
            r_ = 2.7 + q * 3.9
            z = 5.18 + .3 * (1 - abs(q - .55) * 1.8)
            (A if j % 2 else Bb).append((r_ * math.cos(a), r_ * math.sin(a), z))
    for i in range(16):  # 柱の間の下がり弧
        a0, a1 = TAU * i / 16, TAU * (i + 1) / 16
        for j in range(1, 13):
            t = j / 13
            a = a0 + (a1 - a0) * t
            (A if j % 2 else Bb).append((6.72 * math.cos(a), 6.72 * math.sin(a), 4.92 - .35 * math.sin(math.pi * t)))
    for j in range(60):  # 床の縁
        a = TAU * j / 60
        (A if j % 2 else Bb).append((6.82 * math.cos(a), 6.82 * math.sin(a), .6))
    A.extend(top_b)
    Bb.extend(ribs)
    instance_verts('CarBulbA', A, sphere_mesh('BulbA', .04, bulb_a, 2), rot)
    instance_verts('CarBulbB', Bb, sphere_mesh('BulbB', .04, bulb_b, 2), rot)
    keys['rot'].append((rot, 2, TAU / 22.0))
    keys['bob'] += [(h, .13 * (1 if i % 2 else -1), 2.2, i * .9) for i, h in enumerate(horses)]

    # 柵(回らない)
    fence = B()
    rf, n = 7.75, 96
    rows_z = (.16, .24, 1.26, 1.34)
    for z in rows_z:
        fence.tube([(rf * math.cos(TAU * j / n), rf * math.sin(TAU * j / n), z) for j in range(n)], .017, 6, closed=True)
    fence.obj('FenceRail', [gold], loc=(cx, cy, 0))
    bal2 = B()
    bal2.lathe([(.011, 0), (.011, 1.08)], n=5)
    bal2.lathe([(.02, .44), (.034, .54), (.02, .64)], n=6)
    instance_verts('FenceBars', [(cx + rf * math.cos(TAU * j / 420), cy + rf * math.sin(TAU * j / 420), .2) for j in range(420)], bal2.mesh('FBar', [goldd]))
    post = B()
    post.lathe([(.13, 0), (.13, .16), (.08, .24), (.06, 1.4), (.095, 1.46), (.095, 1.54), (.045, 1.62), (.065, 1.74), (.001, 1.9)], n=10)
    pm = post.mesh('FPost', [mats['iron']])
    pts = []
    for i in range(16):
        a = TAU * (i + .5) / 16
        pts.append((cx + rf * math.cos(a), cy + rf * math.sin(a), 0))
    instance_verts('FencePosts', pts, pm)


def truss(b, p0, p1, off, n, r):
    """2 本の主材を斜めの材でつないだ支柱"""
    p0, p1, off = Vector(p0), Vector(p1), Vector(off)
    a0, a1, c0, c1 = p0 + off * .4, p1 + off, p0 - off * .4, p1 - off
    b.tube([a0, a1], r, 6)
    b.tube([c0, c1], r, 6)
    for i in range(n):
        t0, t1 = i / n, (i + 1) / n
        b.tube([a0.lerp(a1, t0), c0.lerp(c1, (t0 + t1) / 2)], r * .4, 4)
        b.tube([c0.lerp(c1, (t0 + t1) / 2), a0.lerp(a1, t1)], r * .4, 4)


def wheel(ctx, mats, keys):
    """斜めから見た観覧車。外周の電球が主役で、スポークは白い鉄の線と点列"""
    c = Vector(P(658, 372, 60))
    R = 14.6
    yaw = add('WheelYaw', None, loc=tuple(c), rot=(0, 0, math.radians(-36)))
    host = add('WheelRot', None, yaw)
    white = pbr('WheelWhite', (.72, .7, .76, 1), .35, emit=(1, .92, .95, 1), emit_k=.02)
    gold = mats['gold']
    n = 24
    w = 1.5
    b = B()
    for sd in (-1, 1):  # 二重のリムとトラス
        ring = lambda rr, y_: [(rr * math.cos(TAU * j / 96), y_, rr * math.sin(TAU * j / 96)) for j in range(96)]
        b.tube(ring(R, sd * w), .06, 6, closed=True)
        b.tube(ring(R - .62, sd * w), .06, 6, closed=True)
        zig = [((R - (.62 if j % 2 else 0)) * math.cos(TAU * j / 192), sd * w, (R - (.62 if j % 2 else 0)) * math.sin(TAU * j / 192)) for j in range(192)]
        b.tube(zig, .03, 4, closed=True)
        b.tube(ring(R * .62, sd * w), .06, 5, closed=True)
        b.tube(ring(R * .36, sd * w), .05, 5, closed=True)
        for i in range(n * 2):
            a = TAU * (i + .5) / (n * 2)
            b.tube([(1.3 * math.cos(a), sd * w * .4, 1.3 * math.sin(a)), ((R - .62) * math.cos(a), sd * w, (R - .62) * math.sin(a))], .075 if i % 2 else .04, 5)
    for i in range(32):
        a = TAU * i / 32
        b.tube([(R * math.cos(a), -w, R * math.sin(a)), (R * math.cos(a), w, R * math.sin(a))], .05, 4)
    for i in range(14):  # ゴンドラの腕
        a0_ = TAU * i / 14 + math.pi / 2
        b.tube([((R - .62) * math.cos(a0_), 0, (R - .62) * math.sin(a0_)), ((R + .9) * math.cos(a0_), 0, (R + .9) * math.sin(a0_))], .06, 5)
    b.obj('WheelFrame', [white], host)
    # スポークの LED の点列。桃、紫、水色、金
    cols = [(1, .45, .06, 1), (1, .1, .5, 1), (.45, .14, 1, 1), (.14, .6, 1, 1)]
    wm = [emis(f'Wheel{i}', c_, 1.05) for i, c_ in enumerate(cols)]
    keys['wheel'] += wm
    order = [(1, 2, 3), (3, 2, 1), (2, 1, 3), (1, 3, 2)]
    groups = [[] for _ in cols]
    for i in range(n):
        a = TAU * (i + .5) / n
        seq = order[i % 4]
        p0, p1 = Vector((2.7 * math.cos(a), -w * .4 - .14, 2.7 * math.sin(a))), Vector(((R - .7) * math.cos(a), -w - .14, (R - .7) * math.sin(a)))
        for j in range(36):
            t = j / 35
            k = seq[min(2, int(t * 3))]
            groups[k].append(tuple(p0.lerp(p1, t)))
    for i, (g_, m_) in enumerate(zip(groups, wm)):
        instance_verts(f'WheelLed{i}', g_, sphere_mesh(f'WL{i}', .12, m_, 1), host)
    # ハブ: 金の円盤と放射の輪
    hub = B()
    for yy in (-1.05, 1.05):
        hub.grid([[(r_ * math.cos(TAU * j / 48), yy, r_ * math.sin(TAU * j / 48)) for j in range(48)] for r_ in (.01, .6, .68, 1.1, 1.3)], closed=True, flip=yy < 0)
    hub.lathe([(.55, -1.05), (.55, 1.05)], n=24)
    for i in range(24):
        a = TAU * i / 24
        hub.tube([(.7 * math.cos(a), -1.08, .7 * math.sin(a)), (2.3 * math.cos(a), -1.08 - .1, 2.3 * math.sin(a))], .03, 4)
    hub.tube([(2.3 * math.cos(TAU * j / 48), -1.18, 2.3 * math.sin(TAU * j / 48)) for j in range(48)], .05, 5, closed=True)
    hub.obj('Hub', [gold], host)
    # 外周の電球が主役
    rim_a, rim_b = bulb_amber('WheelRimA', 1.1), bulb_amber('WheelRimB', 1.1)
    rim_c = emis('WheelRimC', (.6, .3, 1, 1), 1.1)
    keys['wheel'] += [rim_a, rim_b, rim_c]
    rg = [[], [], []]
    for sd in (-1, 1):
        for j in range(300):
            a = TAU * j / 300
            rg[(0, 1, 0, 2)[j % 4]].append(((R + .12) * math.cos(a), sd * w - .06, (R + .12) * math.sin(a)))
    for i, (g_, m_) in enumerate(zip(rg, (rim_a, rim_b, rim_c))):
        instance_verts(f'WheelBulb{i}', g_, sphere_mesh(f'WB{i}', .075, m_, 2), host)
    # ゴンドラ。淡い青と桃の丸屋根の小屋で、窓枠のある窓が光る
    walls = [pbr(f'GondWall{i}', c_, .3, .4, coat=.6, emit=c_, emit_k=.14) for i, c_ in enumerate(((.03, .08, .3, 1), (.25, .05, .2, 1)))]
    frm = pbr('GondFrame', (.04, .04, .06, 1), .3)
    wn = emis('GondWin', (1, .5, .16, 1), .62)
    tops = [pbr(f'GondRoof{i}', c_, .25, coat=1, emit=c_, emit_k=.4) for i, c_ in enumerate(((.04, .16, .55, 1), (.55, .1, .3, 1)))]
    meshes = []
    for ti, top_m in enumerate(tops):
        gg = B()
        gg.lathe([(.001, -1.5), (.8, -1.5), (.98, -1.42), (1.02, -1.3), (1.02, -1.08)], n=20, mat=1)
        gg.lathe([(1.02, -1.08), (1.02, -.42)], n=20, mat=2)
        gg.lathe([(1.02, -.42), (1.02, -.2), (1.2, -.14)], n=20, mat=1)
        gg.lathe([(1.2, -.14), (1.16, -.06), (1.02, .22), (.8, .5), (.5, .7), (.18, .84), (.04, .9)], n=20, mat=0)
        for rr, z, t in ((1.05, -1.08, .03), (1.05, -.42, .03), (1.2, -.14, .04), (.98, -1.42, .03)):
            gg.tube([(rr * math.cos(TAU * j / 28), rr * math.sin(TAU * j / 28), z) for j in range(28)], t, 5, mat=3, closed=True)
        for i in range(12):  # 窓枠
            a = TAU * (i + .5) / 12
            gg.tube([(1.05 * math.cos(a), 1.05 * math.sin(a), -1.08), (1.05 * math.cos(a), 1.05 * math.sin(a), -.42)], .05, 4, mat=4)
        for i in range(8):
            a = TAU * (i + .5) / 8
            gg.tube([(r_ * math.cos(a), r_ * math.sin(a), z) for r_, z in ((1.18, -.1), (.84, .5), (.3, .82))], .014, 4, mat=3)
        gg.lathe([(.07, .86), (.1, .94), (.05, 1.02), (.001, 1.18)], n=8, mat=3)
        meshes.append(gg.mesh(f'Gondola{ti}', [top_m, walls[ti], wn, gold, frm]))
    for i in range(14):
        a = TAU * i / 14 + math.pi / 2
        o = add(f'Gond{i}', meshes[i % 2], host, ((R + .9) * math.cos(a), 0, (R + .9) * math.sin(a) - .55))
        o.scale = (1.3, 1.3, 1.3)
        keys['counter'].append(o)
    keys['rot'].append((host, 1, TAU / 48.0))
    # トラスの支柱。観覧車と同じ向きに置く
    leg = B()
    leg.lathe([(.3, -2.9), (.3, 2.9)], n=16)
    leg.v[:] = [(x, z, y) for x, y, z in leg.v]
    top = lambda s_: (0, s_ * 2.7, 0)
    for s_ in (-1, 1):
        for dx in (-1, 1):
            truss(leg, top(s_), (dx * 12.5, s_ * 6.5, -c.z), (1.2, 0, 0), 15, .3)
        truss(leg, (-6.4, s_ * 4.4, -c.z * .5), (6.4, s_ * 4.4, -c.z * .5), (0, 0, .5), 7, .1)
    for dx in (-8.5, -4.5, 4.5, 8.5):  # 下半分の白い梁の扇
        leg.tube([(dx * .06, -3.0, -1), (dx, -5.2, -c.z)], .16, 6)
    leg.obj('WheelLegs', [pbr('WheelLegWhite', (.55, .62, .78, 1), .35, emit=(.62, .72, 1, 1), emit_k=.1)], yaw)


def stall(name, loc, yaw, w, d, stripe, shelf, mats, seed=0, H=2.9, rh=3.9):
    """縞の屋台。正面は -Y(ローカル)。"""
    rng = random.Random(seed)
    root = add(name, None, loc=loc, rot=(0, 0, yaw))
    b = B()  # 0: 布 1: 金 2: 棚 3: 木 4: 白い台 5: 紐
    # 正面の台(縞の腰板)
    b.grid([[(-w / 2 + i * w / 8, -d / 2, z) for i in range(9)] for z in (0, 1.0)], us=2.0, mat=0)
    b.grid([[(-w / 2, -d / 2 + i * d / 4, z) for i in range(5)] for z in (0, 1.0)], us=1.0, mat=0, flip=True)
    b.grid([[(w / 2, -d / 2 + i * d / 4, z) for i in range(5)] for z in (0, 1.0)], us=1.0, mat=0)
    b.box((0, -d / 2 + .2, 1.03), (w, .44, .06), 3)
    b.box((0, -d / 2 + .004, .04), (w, .012, .08), 1)
    # 奥の棚と箱: 背板、板の厚みのある側壁、天板
    b.grid([[(-w / 2 + .05, d / 2 - .1, z), (w / 2 - .05, d / 2 - .1, z)] for z in (.9, H)], mat=2, flip=True)
    b.box((0, d / 2 + .03, H / 2), (w + .12, .1, H), 3)
    by = d / 2 + .086
    b.grid([[(-w / 2 + i * w / 8, by, z) for i in range(9)] for z in (.12, H - .1)], us=2.0, flip=True)  # 裏板の縞
    for i in range(int(w / .55) + 2):  # 板の継ぎ目と木の枠
        b.box((-w / 2 + i * w / (int(w / .55) + 1), by + .012, H / 2), (.045, .024, H), 3)
    for z_ in (.06, 1.05, H - .04):
        b.box((0, by + .03, z_), (w + .14, .05, .1), 3)
    for sx in (-1, 1):
        b.box((sx * (w / 2 + .03), d * .3, 1.0 + (H - 1.0) / 2), (.08, d * .4, H - 1.0), 3)
        sx_ = sx * (w / 2 + .075)
        b.grid([[(sx_, d * .1 + d * .4 * i / 4, z) for i in range(5)] for z in (1.0, H)], us=1.0, flip=sx < 0)  # 側面の縞
        for z_ in (1.04, H - .05):  # 板の縁
            b.box((sx * (w / 2 + .08), d * .3, z_), (.03, d * .42, .07), 1)
        b.box((sx * (w / 2 + .08), d * .1, (1.0 + H) / 2), (.03, .06, H - 1.0), 1)
    b.box((0, d * .12, H + .03), (w + .12, d * .8, .08), 3)
    # 片流れの日よけ。奥が高く、前へ下がる
    x0, x1 = -.5 * w - .2, .5 * w + .2
    y0, y1 = -d / 2 - .85, d / 2 + .02
    ridge = lambda q: H + q * (rh - H)
    th = .05
    uu = 2.0 * w / 4
    qs = (0, .25, .5, .75, 1)
    b.grid([[(x0 + (x1 - x0) * i / 10, y0 + q * (y1 - y0), ridge(q)) for i in range(11)] for q in qs], us=uu)
    b.grid([[(x0 + (x1 - x0) * i / 10, y0 + q * (y1 - y0), ridge(q) - th) for i in range(11)] for q in qs], us=uu, flip=True, mat=3)
    for x, fl_ in ((x0, True), (x1, False)):
        b.grid([[(x, y0 + q * (y1 - y0), ridge(q) - z) for q in qs] for z in (th, 0)], us=.3, vs=.04, flip=fl_)
    # 骨組み
    for t_ in [i / 8 for i in range(9)]:  # 木の垂木
        x = x0 + (x1 - x0) * t_
        b.tube([(x, y0, H - .03 - th), (x, y1, rh - th - .03)], .034, 4, mat=3)
    b.tube([(x0, y0 + .02, H - .05), (x1, y0 + .02, H - .05)], .026, 5, mat=1)
    b.tube([(x0, y1 - .05, rh - .08), (x1, y1 - .05, rh - .08)], .03, 5, mat=1)
    # 軒の波形の垂れ
    vs = 14
    for i in range(vs):
        xa = x0 + (x1 - x0) * i / vs
        xb = x0 + (x1 - x0) * (i + 1) / vs
        rows = []
        for q in (0, .33, .66, 1):
            rows.append([(xa + (xb - xa) * t, y0 - .004, H - q * (.36 + .22 * math.sin(math.pi * t))) for t in (0, .25, .5, .75, 1)])
        b.grid(rows, mat=0, us=1 / vs * uu)
        n0 = len(b.uv) - 12 * 4
        for k in range(n0, len(b.uv)):
            u, v = b.uv[k]
            b.uv[k] = (u + i / vs * uu, .9)
    # 柱
    for x in (-w / 2 - .02, w / 2 + .02):
        b.lathe([(.04, .95), (.04, H - .02)], n=8, c=(x, -d / 2 - .02, 0), mat=1)
    # 裏に積んだ箱と樽
    for i in range(int(w * 1.4)):
        x = -w / 2 + .25 + rng.uniform(0, w - .5)
        y = d / 2 + rng.uniform(.42, .85)
        if rng.random() < .5:
            sz = rng.uniform(.34, .5)
            b.box((x, y, sz / 2), (sz, sz, sz), 3, rng.uniform(-.3, .3))
            if rng.random() < .5:
                b.box((x, y, sz + .14), (.28, .28, .28), 3, rng.uniform(-.5, .5))
        else:
            b.lathe([(.001, 0), (.2, 0), (.25, .3), (.2, .6), (.001, .6)], n=12, c=(x, y, 0), mat=3)
            for z_, r_ in ((.14, .232), (.46, .232)):
                b.tube([(x + r_ * math.cos(TAU * j / 12), y + r_ * math.sin(TAU * j / 12), z_) for j in range(12)], .012, 4, mat=5, closed=True)
    # 飾り玉の紐はこの中で足す
    balls = []
    for i in range(int(w * 2.4)):
        sz = rng.uniform(.09, .15)
        x = -w / 2 + .3 + i / (w * 2.4) * (w - .5)
        y = -d / 2 + .25
        z = H - rng.uniform(.5, 1.0)
        balls.append((x, y, z, sz, rng.choice(mats['pastels'])))
        b.tube([(x, y, z + sz * .9), (x, y, ridge((y - y0) / (y1 - y0)) - th)], .004, 3, mat=5)
    b.obj(name + 'Body', [stripe, mats['gold'], pbr(name + 'Shelf', img=shelf, rough=.4, emit_k=.2), mats['wood'], mats['ivory'], mats['wire']], root)
    # 電球
    bl = []
    for i in range(46):
        t = i / 45
        bl.append((x0 + (x1 - x0) * t, y0 - .03, H - .02))
    for i in range(36):
        t = i / 35
        x = -w / 2 + w * t
        bl.append((x, -d / 2 + .1, H - .06 - .1 * abs(math.sin(t * 9 * math.pi))))
    for i in range(30):
        t = i / 29
        bl.append((-w / 2 + w * t, .1, H - .1 - .1 * abs(math.sin(t * 7 * math.pi))))
    instance_verts(name + 'Bulbs', bl, sphere_mesh(name + 'BM', .026, mats['bulb_a'], 2), root)
    # 売り台の品。形と高さをばらつかせ、前後の 2 列に並べる
    k = 0
    for row_y, cnt in ((-d / 2 + .1, int(w * 3.4)), (-d / 2 + .3, int(w * 2.4))):
        for i in range(cnt):
            g = rng.choice(mats['goods'])
            o = add(f'{name}Good{k}', g, root, (-w / 2 + .18 + (i + rng.uniform(-.3, .3)) / cnt * (w - .36), row_y + rng.uniform(-.05, .05), 1.06), (0, 0, rng.uniform(0, TAU)), rng.uniform(.75, 1.45))
            o.color = rng.choice(mats['pastels'])
            k += 1
    for i, (x, y, z, sz, c) in enumerate(balls):
        ball = add(f'{name}Ball{i}', mats['ball_mesh'], root, (x, y, z), scale=sz)
        ball.color = c
    li = bpy.data.lights.new(name + 'L', 'AREA')
    li.shape = 'RECTANGLE'
    li.size, li.size_y = w, .8
    li.energy = 60 * w
    li.color = (1, .68, .36)
    lo = add(name + 'Li', li, root, (0, -.3, H - .08), (0.25, 0, 0))
    lo.visible_glossy = False
    lo.visible_camera = False
    return root


def tent(name, loc, r, h, mat, gold, glow):
    """カルーセルの後ろの小さな丸いテント"""
    b = B()
    b.lathe([(r, 0), (r, h * .5)], n=20, us=3, mat=2)
    b.lathe([(r * 1.08, h * .47), (r * .7, h * .68), (r * .3, h * .86), (.03, h)], n=20, us=4)
    b.lathe([(.05, h), (.09, h * 1.03), (.001, h * 1.1)], n=6, mat=1)
    b.obj(name, [mat, gold, glow], loc=loc)


def tree(pos, h, core, trunk, seed, lv, shrub=False):
    """細かい葉の集まりの木。枝の先に小枝の房を置き、房ごとに葉の複製を散らす。
    輪郭は葉の粒だけで決まる"""
    rng = np.random.default_rng(seed)
    b = B()
    x, y = pos
    base = Vector((x, y, 0))
    tip = Vector((x + rng.uniform(-.3, .3), y + rng.uniform(-.3, .3), h * (.42 if not shrub else .2)))
    if not shrub:
        b.tube([base, base.lerp(tip, .6), tip], lambda t: .022 * h * (1 - t * .55), 7, mat=1)
    lobes = 2 if shrub else int(rng.integers(5, 8))
    if not shrub:  # 太い枝
        for k_ in range(3):
            a = rng.uniform(0, TAU)
            end = Vector((x + math.cos(a) * h * .3, y + math.sin(a) * h * .3, h * rng.uniform(.68, .82)))
            b.tube([tip - Vector((0, 0, h * .06)), tip.lerp(end, .5) + Vector((0, 0, h * .05)), end], lambda t: .013 * h * (1 - t * .65), 6, mat=1)
    for i in range(lobes):
        a = rng.uniform(0, TAU)
        spread = h * rng.uniform(.08, .34)
        cc = Vector((x + math.cos(a) * spread, y + math.sin(a) * spread, h * rng.uniform(.5, .9) if not shrub else h * .45))
        r = h * rng.uniform(.17, .27) * (1.4 if shrub else 1)
        sq = np.array([rng.uniform(.9, 1.25), rng.uniform(.9, 1.25), rng.uniform(.62, .85)])
        if not shrub:  # 枝
            mid = tip.lerp(cc, .55) + Vector((rng.uniform(-.4, .4), rng.uniform(-.4, .4), rng.uniform(-.2, .4)))
            b.tube([tip, mid, tip.lerp(cc, .92)], lambda t: .009 * h * (1 - t * .7), 5, mat=1)
        nc = int(22 + 20 * r * r)
        d = rng.normal(size=(nc, 3))
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        rad = rng.uniform(.45, 1.12, (nc, 1)) ** .7
        ctr = np.array(cc)[None] + d * rad * sq * r
        ml = 16
        idx = np.repeat(np.arange(nc), ml)
        sig = .07 + .05 * r
        lv[0].append(ctr[idx] + rng.normal(size=(nc * ml, 3)) * sig)
        lv[1].append(d[idx] + rng.normal(size=(nc * ml, 3)) * .75)
        lv[2].append(rng.uniform(.06, .095, nc * ml) * (1.25 if not shrub else .8))
    b.obj(f'Tree{seed}', [core, trunk])


# ---- 動き ----
def linear(obj_or_data):
    ad = obj_or_data.animation_data
    if not ad or not ad.action:
        return
    a = ad.action
    if a.layers:
        for bag in a.layers[0].strips[0].channelbags:
            for fc in bag.fcurves:
                for k in fc.keyframe_points:
                    k.interpolation = 'LINEAR'


def spin(obj, axis, speed, last):
    obj.rotation_euler[axis] = 0
    obj.keyframe_insert('rotation_euler', index=axis, frame=1)
    obj.rotation_euler[axis] = speed * last / 30
    obj.keyframe_insert('rotation_euler', index=axis, frame=last + 1)
    linear(obj)
    obj.rotation_euler[axis] = 0


def key_flash(node_input, data, beats, fps, base, peak, offset, step=2, last=None):
    """拍で明るくなり、次の拍までに戻る明滅"""
    for i, t in enumerate(beats):
        if i % step != offset:
            continue
        f = 1 + t * fps
        node_input.default_value = peak
        node_input.keyframe_insert('default_value', frame=f)
        node_input.default_value = base
        node_input.keyframe_insert('default_value', frame=f + fps * .22)


def animate(ctx, keys, mats):
    fps = ctx.fps
    beats = ctx.beats
    last = int(max(ctx.frames, (beats[-1] if beats else 30) * fps)) + 60
    for o, ax, speed in keys['rot']:
        spin(o, ax, speed, last)
    for o in keys['counter']:  # ゴンドラは水平を保つ
        spin(o, 1, -TAU / 48.0, last)
    for o, amp, sec, ph in keys['bob']:
        z0 = o.location.z
        per = sec * fps
        n = int(last / (per / 2)) + 2
        for i in range(n):
            f = 1 + i * per / 2 - (ph / TAU * per) % (per / 2)
            o.location.z = z0 + amp * (1 if (i % 2) else -1)
            o.keyframe_insert('location', index=2, frame=f)
        o.location.z = z0
    e_a = mats['bulb_a'].node_tree.nodes['Emission'].inputs[1]
    e_b = mats['bulb_b'].node_tree.nodes['Emission'].inputs[1]
    b0 = e_a.default_value
    key_flash(e_a, mats['bulb_a'], beats, fps, b0, b0 * 1.5, 0)
    key_flash(e_b, mats['bulb_b'], beats, fps, b0, b0 * 1.5, 1)
    for m, off in zip(keys['wheel'], (0, 1, 0, 1, 0, 1)):
        i = m.node_tree.nodes['Emission'].inputs[1]
        b1 = i.default_value
        key_flash(i, m, beats, fps, b1, b1 * 1.6, off)


def refl_mat(name, color, k, reach=4.5):
    """遠くから来たレイにだけ光り、近くの金属の映り込みには写らない発光"""
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


def reflection_lights(keys):
    """カメラには写らず、濡れた床の映り込みにだけ写る発光体。
    床の粗さで電球の点の明るさが薄まるので、柱の形の光と、頭上の電球の並びを足して金色の筋と玉ボケを作る"""
    cx, cy = 0, 22.3
    m1 = refl_mat('ReflWarm', (1, .3, .04, 1), 7)
    m3 = refl_mat('ReflBand', (1, .34, .06, 1), .25)
    b = B()
    rngb = random.Random(4)
    for i in range(46):
        a = TAU * i / 46
        b.lathe([(.09, .5), (.09, rngb.uniform(9, 15))], n=6, c=(cx + 7.0 * math.cos(a), cy + 7.0 * math.sin(a), 0))
    b.lathe([(7.2, 5.1), (7.2, 6.0)], n=64, c=(cx, cy, 0), mat=1)
    for x, y, h in ((-4.89, 7.45, 11), (G(830, 950)[0], G(830, 950)[1], 7), (G(782, 943)[0], G(782, 943)[1], 5.5), (G(140, 935)[0], G(140, 935)[1], 5.5), (-7, 10.5, 3.5), (6.7, 7.5, 3.3)):
        b.lathe([(.16, 1), (.16, h)], n=6, c=(x, y, 0))
    glossy_only(b.obj('ReflBars', [m1, m3]))
    # 手前の床が映す上空の光。金を主に、桃、紫、青の大きな面を置く
    pm = B()
    for (x, z, sx, sz), mi in zip(((-9, 16, 7, 4), (0, 18, 9, 5), (9, 16, 7, 4), (-3, 24, 6, 3), (6, 24, 7, 3), (14, 19, 4, 5)), (0, 0, 0, 1, 2, 3)):
        pm.grid([[(x - sx, 19, z - sz), (x + sx, 19, z - sz)], [(x - sx, 19, z + sz), (x + sx, 19, z + sz)]], mat=mi, flip=True)
    glossy_only(pm.obj('ReflSky', [refl_mat('ReflSkyGold', (1, .4, .08, 1), .16, 15), refl_mat('ReflSkyPink', (1, .25, .6, 1), .4, 15), refl_mat('ReflSkyVio', (.5, .28, 1, 1), .9, 15), refl_mat('ReflSkyBlue', (.22, .45, 1, 1), 1.6, 15)]))
    rng = random.Random(9)
    # 手前の濡れた石に写る、芯の明るい光の点
    for name_, col_, cnt, k_ in (('ReflDotsG', (1, .42, .08, 1), 130, 19), ('ReflDotsP', (1, .25, .55, 1), 22, 22), ('ReflDotsB', (.3, .45, 1, 1), 120, 40), ('ReflDotsV', (.6, .3, 1, 1), 60, 28)):
        pts = [(rng.uniform(-14, 14), rng.uniform(10, 18), rng.uniform(7, 22)) for _ in range(cnt)]
        host = instance_verts(name_, pts, sphere_mesh(name_ + 'P', .3, refl_mat(name_ + 'M', col_, k_, 15)))
        glossy_only(host)
        glossy_only(host.children[0])


def compositor():
    """順に、弱いシャープ、電球のにじみ、色の調整。どの視点でも同じ処理"""
    s = bpy.context.scene
    nt = bpy.data.node_groups.new('Glow', 'CompositorNodeTree')
    s.compositing_node_group = nt
    N, L = nt.nodes, nt.links
    rl = N.new('CompositorNodeRLayers')
    sh = N.new('CompositorNodeFilter')
    sh.inputs['Type'].default_value = 'Box Sharpen'
    sh.inputs['Factor'].default_value = .05
    L.new(rl.outputs['Image'], sh.inputs['Image'])
    img = sh.outputs[0]
    g = N.new('CompositorNodeGlare')
    g.inputs['Type'].default_value = 'Bloom'
    g.inputs['Quality'].default_value = 'Medium'
    g.inputs['Threshold'].default_value = .72
    g.inputs['Smoothness'].default_value = .4
    g.inputs['Strength'].default_value = .62
    g.inputs['Saturation'].default_value = 1.1
    g.inputs['Size'].default_value = .84
    L.new(img, g.inputs['Image'])
    cb = N.new('CompositorNodeColorBalance')
    L.new(g.outputs['Image'], cb.inputs['Image'])
    gain_col = [i for i in cb.inputs if i.name == 'Gain' and i.type == 'RGBA'][0]
    gain_col.default_value = (1.0, .97, .88, 1)  # 青を抑えて暖色へ
    [i for i in cb.inputs if i.name == 'Lift' and i.type == 'VALUE'][0].default_value = -.018  # 暗部の薄い膜を締める
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
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces, c.transparent_max_bounces = 4, 2, 2, 2, 6
    c.sample_clamp_indirect = 30.0
    c.use_light_tree = True
    c.adaptive_threshold = .035
    c.filter_width = 1.0  # 既定の 1.5 より細部が約 8% 残る。ノイズ除去の入力、OIDN、サンプル数では変わらなかった

    keys = {'rot': [], 'counter': [], 'bob': [], 'wheel': []}
    mats = {
        'gold': pbr('Gold', GOLD, .26, 1.0, emit=(1, .5, .12, 1), emit_k=.06),
        'goldd': pbr('GoldDark', (.8, .42, .13, 1), .35, 1.0, emit=(1, .42, .1, 1), emit_k=.07),
        'iron': pbr('Iron', (.008, .008, .01, 1), .28, 0, spec=.5),
        'wire': pbr('Wire', (.004, .004, .005, 1), .5, spec=.2),
        'ivory': pbr('Ivory', (.88, .8, .7, 1), .4),
        'wood': pbr('Wood', rough=.5, img='wood_plank.png', emit_k=.06),
        'bulb_a': bulb_amber('BulbWarmA', 1.25),
        'bulb_b': bulb_amber('BulbWarmB', 1.25),
    }
    mats['pastels'] = [(1, .42, .6, 1), (.95, .6, .75, 1), (.4, .68, .92, 1), (1, .68, .3, 1), (.68, .48, .92, 1), (.95, .3, .35, 1)]
    ball_m = pbr('Pastel', rough=.25, obj_color=True, coat=.8, emit_k=.25)
    mats['goods'] = goods_meshes(ball_m, mats['ivory'])
    mats['ball_mesh'] = sphere_mesh('Ball', 1.0, ball_m, 2)

    sky()
    far_view()
    floor()
    carousel(ctx, mats, (0, 22.3), keys)
    wheel(ctx, mats, keys)

    fl = Flowers(mats['iron'])
    glass = lantern_glass()
    lamp = lamp_mesh(mats['iron'], mats['gold'], glass)
    anchors = []

    def lamp_at(x, y, yaw=0, sc=1.0, hang=True):
        add('Lamp', lamp, None, (x, y, 0), (0, 0, yaw), sc)
        anchors.append((x, y))
        if hang:
            d = Vector((math.cos(yaw), math.sin(yaw), 0)) * 0.6 * sc
            fl.basket((x + d.x, y + d.y, 6.1 * sc), .5 * sc, (x, y))

    # 目標に写る街灯。左の大きい 1 本、左中の 2 本、右の 3 本
    side = -math.pi / 2  # 腕をカメラへ向けると、灯りが柱の真上に写る
    pL, pLm, pRm, pRr = (-5.42, 7.45), G(136, 932)[:2], G(782, 943)[:2], P(905, 950, 24)[:2]
    lamp_at(*pL, 0, 1.13, False)
    lamp_at(*G(168, 935)[:2], side, .72, False)
    lamp_at(*pLm, side, .78, False)
    lamp_at(*G(830, 950)[:2], side, .85, False)
    lamp_at(*pRm, side, .6, False)
    lamp_at(*pRr, side, 1.12, False)
    fl.basket(P(40, 460, 12.6), .8, pL)
    fl.basket(P(115, 672, 19.6), .78, pLm)
    fl.basket(P(780, 670, 16.8), .62, pRm)
    fl.basket(P(888, 570, 24), 1.15, pRr)
    # 広場の後ろと横
    for a in (200, 235, 270, 305, 340, 165, 15):
        x, y = 13 * math.cos(math.radians(a)), 13 * math.sin(math.radians(a))
        lamp_at(x, y, math.radians(a) + math.pi, .8)

    pink = pbr('StripePink', img='stripe_pink.png', rough=.5, emit_k=.28)
    blue = pbr('StripeBlue', img='stripe_blue.png', rough=.5, emit_k=.28)
    stall('StallL', (-6.6, 11.0, 0), math.radians(58), 2.7, 2.3, pink, 'shelf_pink.png', mats, 1, 3.05, 4.85)
    stall('StallR', (7.2, 8.6, 0), math.radians(-58), 2.8, 2.3, blue, 'shelf_blue.png', mats, 2, 2.85, 4.5)
    stall('StallFarL', (-11.5, 25, 0), 0, 3.6, 2.2, blue, 'shelf_blue.png', mats, 3)
    stall('StallFarR', (10.5, 26, 0), 0, 3.6, 2.2, pink, 'shelf_pink.png', mats, 4)
    # 後ろ側の屋台
    stall('StallBack1', (-7.5, -10.5, 0), math.radians(180 + 18), 4.2, 2.3, blue, 'shelf_pink.png', mats, 5)
    stall('StallBack2', (7.5, -10.5, 0), math.radians(180 - 18), 4.2, 2.3, pink, 'shelf_blue.png', mats, 6)
    stall('StallSideL', (-12.5, 1.5, 0), math.radians(-90), 4.2, 2.3, pink, 'shelf_blue.png', mats, 7)
    stall('StallSideR', (12.5, 0.5, 0), math.radians(90), 4.2, 2.3, blue, 'shelf_pink.png', mats, 8)

    # カルーセルの後ろの小さなテントと遠くの灯り
    tent_b = pbr('TentBlue', img='tent.png', rough=.5, emit_k=.3)
    tent_p = pbr('TentPink', img='stripe_pink.png', rough=.5, emit_k=.3)
    glow = emis('TentGlow', (1, .6, .25, 1), .9)
    for i, (px, top, d, m_) in enumerate(((150, 780, 32, tent_b), (92, 800, 36, tent_p), (800, 785, 32, tent_p), (858, 800, 37, tent_b), (720, 815, 40, tent_b), (225, 815, 40, tent_p))):
        q = P(px, top, d)
        tent(f'Tent{i}', (q[0], q[1], 0), 1.9, q[2], m_, mats['gold'], glow)
    rngl = random.Random(21)
    far = []
    for _ in range(6):
        x0_, y0_, z0_ = rngl.uniform(-30, 30), rngl.uniform(40, 62), rngl.uniform(2, 7)
        L_ = rngl.uniform(10, 22)
        for j in range(26):
            t = j / 25
            far.append((x0_ + L_ * t, y0_ + 3 * t, z0_ - 1.2 * 4 * t * (1 - t)))
    instance_verts('FarLights', far, sphere_mesh('FarLight', .1, mats['bulb_b'], 2))

    # 花の鉢
    urn = B()
    urn.lathe([(.001, 0), (.36, 0), (.36, .08), (.27, .14), (.25, .22), (.33, .28), (.34, .72), (.31, .76), (.31, .82), (.37, .88), (.4, .98), (.36, 1.03), (.001, 1.03)], n=24)
    um = urn.mesh('Urn', [pbr('Urn', img='stone_cream.png', rough=.5, emit_k=.05)])
    plinth = [G(202, 934)[:2], G(750, 942)[:2]]
    for x, y in plinth + [(-8.5, 3.0), (8.5, 3.5), (0, -13.5), (-4, -12.5), (4, -12.5), (-9, -6), (9, -6)]:
        add('Urn', um, None, (x, y, 0), scale=1.0)
        fl.clump((x, y, 1.3), .62, 620, .034)

    # 広場の縁: 開口以外を縁石と鉄の柵で区切り、外を芝にする
    curb, lawn = B(), B()
    for k in range(90):
        a0, a1 = TAU * k / 90, TAU * (k + 1) / 90
        am = (a0 + a1) / 2
        if 0.72 < am < 2.42:  # +Y 側の開口
            continue
        ca, sa_, cb, sb_ = math.cos(a0), math.sin(a0), math.cos(a1), math.sin(a1)
        curb.grid([[(r_ * ca, r_ * sa_, z), (r_ * cb, r_ * sb_, z)] for r_, z in ((15.0, -.02), (15.0, .2), (15.05, .24), (15.4, .24), (15.45, .2), (15.45, -.02))], smooth=False, us=1, vs=.3)
        lawn.grid([[(r_ * ca, r_ * sa_, .08), (r_ * cb, r_ * sb_, .08)] for r_ in (15.4, 36.5)], us=1, vs=5)
    curb.obj('Curb', [wet_stone('CurbStone', 'stone_warm.png', 'stone_n.png', tone=.5, per_stone=False)])
    lawn.obj('Lawn', [pbr('Lawn', (.1, .14, .1, 1), .7, img='leaf.png', spec=.2)])
    rail = B()
    rp = []
    for k in range(90):
        am = TAU * (k + .5) / 90
        if 0.72 < am < 2.42:
            continue
        rp.append((15.25 * math.cos(am), 15.25 * math.sin(am), .24))
        rail.tube([(15.25 * math.cos(TAU * k / 90 + d_), 15.25 * math.sin(TAU * k / 90 + d_), .95) for d_ in (0, TAU / 180, TAU / 90)], .02, 5)
    rail.obj('EdgeRail', [mats['iron']])
    bar = B()
    bar.lathe([(.02, 0), (.02, .72), (.04, .78), (.001, .9)], n=6)
    instance_verts('EdgeBars', rp, bar.mesh('EdgeBar', [mats['iron']]))

    # 木
    leaf = leaf_mat()
    core = pbr('TreeCore', (.006, .012, .01, 1), .8, spec=.1)
    bark = pbr('Bark', (.05, .035, .03, 1), .6)
    rng = random.Random(11)
    leaves = ([], [], [])
    for i in range(56):
        a = rng.uniform(0, TAU)
        r_ = rng.uniform(18.5, 44)
        x, y = r_ * math.cos(a), r_ * math.sin(a)
        if y > -3 and abs(x) < .5 * (y + 5.08) + 2:  # 目標の視野に入れない
            continue
        tree((x, y), rng.uniform(6, 11), core, bark, i, leaves)
    for k in range(34):  # 柵の外の低木
        a = rng.uniform(0, TAU)
        if not .72 < a < 2.42:
            tree((rng.uniform(16.2, 17.8) * math.cos(a), rng.uniform(16.2, 17.8) * math.sin(a)), rng.uniform(1.2, 2.0), core, bark, 200 + k, leaves, True)
    # 丘の裾の木。低く、回転木馬の裏で丘へつなぐ
    for i, (px, py, d, h) in enumerate(((60, 760, 40, 7), (130, 770, 44, 8), (205, 760, 42, 7), (300, 770, 46, 8), (560, 720, 44, 10), (640, 700, 40, 10), (700, 690, 38, 10), (750, 690, 36, 10), (800, 700, 36, 10), (850, 720, 38, 9), (240, 700, 40, 10), (180, 700, 38, 10))):
        tree(P(px, py, d)[:2], h, core, bark, 100 + i, leaves)
    # 遠い林。地平線の板の縁を隠す
    for i in range(26):
        a = rng.uniform(0, TAU)
        r_ = rng.uniform(44, 66)
        x, y = r_ * math.cos(a), r_ * math.sin(a)
        if y > -3 and abs(x) < .5 * (y + 5.08) + 2:
            continue
        tree((x, y), rng.uniform(9, 14), core, bark, 300 + i, leaves)
    leaf_cloud('TreeLeaves', np.concatenate(leaves[0]), np.concatenate(leaves[1]), np.concatenate(leaves[2]), leaf)

    # 電球の列
    sa, sb = bulb_amber('StringA', 1.2), bulb_amber('StringB', 1.2)
    keys['wheel'] += [sa, sb]
    bulb_big = sphere_mesh('StringBulb', .07, sa, 3)
    bulb_big2 = sphere_mesh('StringBulb2', .07, sb, 3)
    wire = mats['wire']
    strings = [
        # 左の街灯から上を通る列。右の端は画面の外の柱
        (P(60, 62, 12.3), P(1100, -300, 14.0), 1.5, 30),
        # 三角旗の列。左の街灯から右奥の街灯まで
        (P(14, 205, 12.3), P(892, 460, 26), 2.4, 74),
        (P(80, 618, 34), P(270, 640, 34), .5, 26),
        (P(690, 640, 34), P(905, 610, 34), .5, 26),
        (P(150, 735, 34), P(235, 745, 34), .2, 10),
        (P(725, 735, 34), P(830, 740, 34), .2, 10),
    ]
    for a in (195, 240, 300, 345):
        p0 = (13 * math.cos(math.radians(a)), 13 * math.sin(math.radians(a)), 7.7)
        p1 = (13 * math.cos(math.radians(a + 40)), 13 * math.sin(math.radians(a + 40)), 7.7)
        strings.append((p0, p1, 1.0, 22))
    strings.append(((-10.4, -7.5, 7.7), (10.4, -7.5, 7.7), 1.2, 44))
    strings.append(((-11, 4, 8.4), (-5.2, 7.5, 9.0), .5, 16))
    strings.append(((-10.4, -7.5, 7.7), (-5.2, 7.5, 9.0), 1.0, 30))
    strings.append(((10.4, -7.5, 7.7), (5.5, 5.0, 8.0), 1.0, 30))
    wb = B()
    A, Bb = [], []
    done = []
    for a, b, sag, n in strings:
        pts = catenary(a, b, sag, n * 3)
        wb.tube(pts, .012, 5)
        for i in range(0, len(pts), 3):
            q = pts[min(len(pts) - 1, i + rng.choice((-1, 0, 0, 1)) if i else 0)]
            (A if (i // 3) % 2 else Bb).append(tuple(q - Vector((0, 0, .07))))
            wb.tube([q, q - Vector((0, 0, .04))], .018, 5)  # 口金
        for e in (a, b):  # 電線の端には必ず支えを置く
            e = Vector(e)
            if any(math.hypot(e.x - ax, e.y - ay) < 1.3 for ax, ay in anchors + done):
                continue
            done.append((e.x, e.y))
            add('Lamp', lamp, None, (e.x, e.y, 0), (0, 0, side), e.z / 9.0)  # 端は街灯で受ける
    wb.obj('Wires', [wire])
    instance_verts('StringA', A, bulb_big)
    instance_verts('StringB', Bb, bulb_big2)

    # 三角旗: 桃、水色、黄の小旗
    cols = [(1, .46, .68, 1), (.42, .78, .95, 1), (1, .82, .3, 1)]
    fm2 = [pbr(f'Flag{i}', c, .5, emit=c, emit_k=.14) for i, c in enumerate(cols)]
    flag = B()

    def pennants(pts, step, width, drop):
        for k, i in enumerate(range(0, len(pts) - 1, step)):
            p0, p1 = pts[i], pts[min(i + step, len(pts) - 1)]
            p1 = p0.lerp(p1, width)
            mid = (p0 + p1) / 2 - Vector((0, 0, drop))
            n_ = len(flag.v)
            flag.v += [tuple(p0), tuple(p1), tuple(mid)]
            flag.face((n_, n_ + 1, n_ + 2), [(0, 1), (1, 1), (.5, 0)], k % 3, False)

    a, b_, sag, n = strings[1]
    pennants(catenary(a, b_, sag, 120)[:13], 2, .88, .62)
    pennants(catenary(*strings[4][:3], 24), 2, .9, .42)
    pennants(catenary(*strings[5][:3], 24), 2, .9, .42)
    flag.obj('Pennants', fm2)

    # 風船
    bal = B()
    bal.lathe([(.001, -1.0), (.05, -.98), (.3, -.86), (.62, -.5), (.82, -.05), (.84, .25), (.72, .55), (.42, .8), (.001, .9)], n=20)
    bal.lathe([(.001, -1.1), (.07, -1.1), (.02, -.98)], n=6)
    glossy = pbr('Balloon', rough=.14, obj_color=True, coat=1, emit_k=.3)
    bm = bal.mesh('Balloon', [glossy])
    str_b = B()
    str_b.tube([(.05 * math.sin(t * 7), 0, -1.1 - t * 1.5) for t in (i / 12 for i in range(13))], .008, 3)
    sm = str_b.mesh('BalString', [wire])
    pink_, blue_, lilac = (.95, .16, .42, 1), (.1, .38, .85, 1), (.55, .34, .85, 1)
    balloons = [  # 画素の x, y, 奥行き, 写る幅(px), 色
        (178, 8, 15, 36, pink_), (150, 28, 15, 18, lilac), (132, 190, 13, 32, pink_), (175, 207, 13, 33, blue_),
        (62, 352, 13, 38, lilac), (106, 377, 14, 14, pink_), (55, 565, 13, 30, pink_), (35, 570, 13.5, 20, lilac), (228, 165, 30, 10, pink_),
        (197, 145, 30, 8, lilac), (398, 345, 34, 13, blue_), (420, 402, 34, 14, pink_), (828, 413, 22, 36, blue_), (846, 410, 23, 24, lilac),
        (140, 118, 32, 9, blue_), (870, 102, 36, 7, pink_), (260, 120, 44, 7, blue_), (320, 60, 48, 6, lilac), (395, 190, 46, 7, pink_), (30, 290, 40, 8, blue_),
        (925, 240, 44, 11, lilac), (900, 330, 48, 9, pink_), (360, 300, 50, 8, lilac), (110, 80, 46, 9, pink_), (432, 130, 52, 9, blue_), (590, 60, 56, 8, pink_),
        (300, 40, 52, 8, pink_), (70, 130, 50, 8, lilac), (250, 300, 48, 8, blue_), (440, 250, 54, 8, pink_), (470, 60, 54, 7, lilac), (40, 240, 46, 9, pink_), (640, 30, 58, 7, blue_), (920, 130, 50, 8, pink_),
        (150, 420, 40, 14, lilac), (235, 395, 42, 13, pink_), (320, 440, 44, 12, blue_), (90, 470, 38, 13, blue_), (270, 500, 44, 11, lilac),
    ]
    for i, (px, py, d, wd, col) in enumerate(balloons):
        o = add(f'Balloon{i}', bm, None, P(px, py, d), (0, 0, i), wd / 2 / F_PX * d / .84)
        o.color = col
        add(f'BalS{i}', sm, o)
        keys['bob'].append((o, .12, 5.0 + i % 3, i))

    # 床の花びら。3 つの形に分けて不揃いにする
    pm_ = petal_mat()
    items = [[], [], []]
    fixed = [(105, 1458), (150, 1476), (292, 1482), (86, 1478), (778, 1490), (798, 1583), (760, 1486), (548, 1340), (740, 1325), (820, 1268), (300, 1290), (630, 1290), (146, 1405), (838, 1402), (40, 1670), (850, 1610), (200, 1605)]
    for px, py in fixed:
        items[rng.randrange(3)].append((tuple(Vector(G(px, py)) + Vector((0, 0, .002))), (rng.uniform(-.12, .12), rng.uniform(-.12, .12), 1), rng.uniform(.04, .075)))
    for _ in range(240):
        a, r_ = rng.uniform(0, TAU), 1.8 + rng.uniform(0, 1) ** .7 * 12
        items[rng.randrange(3)].append(((r_ * math.cos(a), r_ * math.sin(a), .002), (rng.uniform(-.12, .12), rng.uniform(-.12, .12), 1), rng.uniform(.026, .05)))
    for i, it in enumerate(items):
        instance_faces(f'Petals{i}', it, petal_mesh(i + 1, pm_), seed=i)

    # 紙吹雪。上下に繰り返す並びを落とすと、継ぎ目なく回せる
    H = 4.5
    conf = B()
    conf.grid([[(-1, y_, .35 * math.sin(y_ * 2.4)) for y_ in ()] or [(-1, -.32, 0), (1, -.32, 0)], [(-1, 0, .2), (1, 0, .2)], [(-1, .32, 0), (1, .32, 0)]])
    pal = [pbr(f'Conf{i}', c, .4, emit=c, emit_k=.14) for i, c in enumerate(((1, .36, .6, 1), (1, .72, .24, 1), (.34, .74, .9, 1), (.66, .44, 1, 1)))]
    last = int(max(ctx.frames, (ctx.beats[-1] if ctx.beats else 30) * ctx.fps)) + 60
    for gi, m in enumerate(pal):
        grp = []
        for _ in range(34):
            x, y, z = rng.uniform(-12, 12), rng.uniform(-9, 13), rng.uniform(0, H)
            n = (rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))
            sz = rng.uniform(.014, .022)
            grp += [((x, y, z + k * H), n, sz) for k in (0, 1)]
        me = conf.mesh(f'Conf{gi}', [m])
        host = instance_faces(f'Confetti{gi}', grp, me, seed=gi)
        per = (H / (.55 + gi * .07)) * ctx.fps
        for k in range(int(last / per) + 2):  # H 落ちるごとに元の高さへ戻す。並びは H 周期なので継ぎ目が見えない
            host.location.z = 0
            host.keyframe_insert('location', index=2, frame=1 + k * per)
            host.location.z = -H
            host.keyframe_insert('location', index=2, frame=1 + (k + 1) * per - .01)
        host.location.z = 0
        linear(host)

    fl.finish()

    # 光
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

    area('FloorWash', (0, 12.5, 6.5), (math.radians(-62), 0, 0), 26, 7, 70, (1, .5, .22))  # カルーセルから床へ落ちる暖色
    area('CarGlow', (0, 15.0, 3.2), (math.radians(82), 0, 0), 13, 5, 26, (1, .55, .22))
    point('CarIn1', (0, 22.3, 4.2), 700, (1, .66, .34), .6)
    point('CarIn2', (0, 17.5, 4.6), 34, (1, .66, .34), .4)
    area('Key', (-1.5, -4.5, 6.0), (math.radians(40), math.radians(-8), 0), 7, 5, 55, (1, .78, .72))

    def spot(name, loc, aim, energy, color, deg, blend=.7):
        li = bpy.data.lights.new(name, 'SPOT')
        li.energy, li.color = energy, color
        li.spot_size, li.spot_blend = math.radians(deg), blend
        li.shadow_soft_size = .12
        o = add(name, li, None, loc)
        o.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        o.visible_glossy = False
        o.visible_camera = False

    # キャラの顔を脚より明るくする暖色の正面の光と、カルーセル側の橙の縁光
    spot('Top', (.25, MARK[1] - .3, 6.5), MARK, 130, (1, .8, .66), 34)  # 足元の接地影
    spot('Face', (.3, MARK[1] - 3.3, 2.1), (0, MARK[1], 1.42), 460, (1, .84, .68), 19)
    spot('RimR', (2.1, 3.1, 2.5), (0, MARK[1], 1.38), 1500, (1, .5, .16), 26)
    spot('RimL', (-2.3, 2.9, 2.6), (0, MARK[1], 1.38), 1100, (1, .44, .14), 26)
    area('Rim', (2.5, 6, 5), (math.radians(-55), 0, math.radians(15)), 6, 3, 300, (1, .6, .78))
    point('LampL', P(60, 100, 12.5), 1500, (1, .66, .3), .3)
    point('LampR', (G(832, 950)[0], G(832, 950)[1], 7.3), 500, (1, .7, .36), .3)

    reflection_lights(keys)
    compositor()
    animate(ctx, keys, mats)

    return {
        'mark': MARK,
        'facing': 0,
        'bounds': ((-6.5, 6.5), (-6.9, 6.0), (0.1, 5.0)),
        'char_emission': 0.42,
        'beats_per_shot': 8,
        'views': {
            'target': {'loc': CAM, 'look': (0, 0, 1.39), 'lens': 22.6, 'fstop': 1.6, 'focus': 5.0},
            'hold1': {'loc': (3.4, -3.2, 1.1), 'look': (0, 0, 1.0), 'lens': 35, 'fstop': 2.8},
            'hold2': {'loc': (-3.2, -1.2, 0.5), 'look': (0, 2, 1.5), 'lens': 28, 'fstop': 2.8},
            'back': {'loc': (0, 4.5, 1.2), 'look': (0, -8, 2.2), 'lens': 24, 'fstop': 2.8},
            'left': {'loc': (4.5, 0, 1.2), 'look': (-8, 0, 2.2), 'lens': 24, 'fstop': 2.8},
            'right': {'loc': (-4.5, 0, 1.2), 'look': (8, 0, 2.2), 'lens': 24, 'fstop': 2.8},
        },
    }
