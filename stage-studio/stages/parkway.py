"""昼下がりの公園の並木道。道は Y 軸に沿ってまっすぐで、キャラは facing 0 の決まりのまま -Y へ歩く。
道は x=-1.8..1.8、舗装の面が z=0。ケヤキは TREE_STEP ごとに両側へ並ぶ。カメラが並走する x=1.95..3.7 の芝には何も立てない。
木は 5 種類のメッシュの使い回しで、0 番だけカラスの枝(PERCH)を持ち、その木はカラスの場所にだけ置く。空は assets/parkway/sky.png を折り返した環境テクスチャ。"""
import math
import random

import bpy
import numpy as np
from mathutils import Vector
from lib.studio import load_image

TAU = math.tau
ASSETS = None
ROAD = 1.8  # 道の半分の幅
KERB = .26  # 縁石の幅
CLEAR = 3.7  # 道の中心からこの距離までは、カメラのために低いものしか置かない
TREE_X, TREE_STEP, TREE_Y0 = 4.7, 7.0, 6.5  # 並木の位置
FAR = 196.0  # 並木の端
MARK = (0.0, 24.0, 0.0)  # 歩き始めの位置。-Y へ 80 m 以上歩ける
WALK_Y = (-60.0, 46.0)  # カメラと人が動ける道の範囲
CAM = Vector((0, 18.0, 1.18))  # target のカメラ
LENS, TILT = 19.4, math.radians(6.9)
SUN_DIR = Vector((-.05, -.5, 1.0)).normalized()  # 太陽へ向かう向き。-Y の後ろ寄りで、歩いてくる人の顔に当たる
LOCAL_PERCH = Vector((-2.05, 0, 7.1))  # 0 番の木のカラスの枝の先。木の根元からの位置で、-X が道の方
PERCH_TREES = ((13.5, 1), (-7.5, -1), (-28.5, 1))  # カラスの枝の木 (y, 道のどちら側か)


def link(o):
    bpy.context.scene.collection.objects.link(o)
    return o


def img(name, data=False):
    return load_image(ASSETS / name, data)


class Sh:
    def __init__(self, name):
        self.m = bpy.data.materials.new(name)
        self.m.use_nodes = True
        self.t = self.m.node_tree
        self.t.nodes.clear()
        self.out = self.t.nodes.new('ShaderNodeOutputMaterial')
        self.m.cycles.emission_sampling = 'NONE'

    def n(self, kind, *inp, **named):
        node = self.t.nodes.new('ShaderNode' + kind)
        for k, v in named.items():
            if hasattr(node, k):
                setattr(node, k, v)
            else:
                self.put(node.inputs[k.replace('_', ' ')], v)
        for i, v in enumerate(inp):
            if v is not None:
                self.put(node.inputs[i], v)
        return node

    def put(self, sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.t.links.new(v, sock)
        elif sock.type == 'RGBA' and isinstance(v, tuple) and len(v) == 3:
            sock.default_value = (*v, 1)
        else:
            sock.default_value = v

    def tex(self, name, vec=None, data=False, ext='REPEAT'):
        n = self.n('TexImage', extension=ext)
        n.image = img(name, data)
        if vec is not None:
            self.t.links.new(vec, n.inputs[0])
        return n.outputs

    def mix(self, f, a, b, blend='MIX'):
        m = self.t.nodes.new('ShaderNodeMix')
        m.data_type = 'RGBA'
        m.blend_type = blend
        for s, kind, v in (('Factor', 'VALUE', f), ('A', 'RGBA', a), ('B', 'RGBA', b)):
            self.put(next(i for i in m.inputs if i.name == s and i.type == kind), v)
        return next(o for o in m.outputs if o.type == 'RGBA')

    def math(self, op, a, b=None, clamp=False):
        return self.n('Math', a, b, operation=op, use_clamp=clamp).outputs[0]

    def air(self, shader):
        """カメラから遠いほど空気の色へ寄せる。道の奥の抜けを作る。切り抜きの材質では切り抜く前に掛ける"""
        d = self.n('CameraData').outputs['View Distance']
        f = self.n('MapRange', d, 45, 240, 0, .4, interpolation_type='SMOOTHSTEP').outputs[0]
        return self.n('MixShader', f, shader, self.n('Emission', (.66, .8, .9), 1.0).outputs[0]).outputs[0]

    def done(self, shader):
        self.t.links.new(self.air(shader), self.out.inputs[0])
        return self.m

    def cut(self, alpha, shader):
        """絵の A で切り抜いて仕上げる"""
        self.t.links.new(self.n('MixShader', alpha, self.n('BsdfTransparent').outputs[0], self.air(shader)).outputs[0], self.out.inputs[0])
        return self.m


def world_xy(s, scale, angle=0.0):
    """世界の水平の座標を scale m ごとに 1 周する UV にする"""
    p = s.n('NewGeometry').outputs['Position']
    return s.n('Mapping', p, None, (0, 0, angle), (1 / scale, 1 / scale, 1)).outputs[0]


# ---- メッシュ ----
class Bag:
    """同じ材質の部品を 1 つのメッシュにまとめる。uv は画素の座標、S は部品ごとの乱数"""
    def __init__(self):
        self.v, self.q, self.uv, self.s, self.mi = [], [], [], [], []

    def add(self, verts, quads, uv, s=.5, mat=0):
        k = len(self.v)
        self.v += [tuple(p) for p in verts]
        self.uv += [tuple(c) for c in uv]
        self.s += [s] * len(verts)
        self.q += [tuple(i + k for i in q) for q in quads]
        self.mi += [mat] * len(quads)

    def box(self, lo, hi, tex=1.0, s=.5):
        (x0, y0, z0), (x1, y1, z1) = lo, hi
        p = [(x, y, z) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
        for f, (a, b) in (((0, 1, 3, 2), (x1 - x0, y1 - y0)), ((4, 6, 7, 5), (x1 - x0, y1 - y0)), ((0, 4, 5, 1), (x1 - x0, z1 - z0)), ((2, 3, 7, 6), (x1 - x0, z1 - z0)), ((0, 2, 6, 4), (y1 - y0, z1 - z0)), ((1, 5, 7, 3), (z1 - z0, y1 - y0))):
            self.add([p[i] for i in f], [(0, 1, 2, 3)], [(0, 0), (a * tex, 0), (a * tex, b * tex), (0, b * tex)], s)

    def tube(self, pts, radii, sides=8, tex=1.0, lobes=None, s=.5):
        """pts の線に沿う管。lobes は (山の数, 大きさ, 位相) で、根元のうねりに使う"""
        pts = [Vector(p) for p in pts]
        n = len(pts)
        up = Vector((.31, .17, .93))
        rows, uv, v_ = [], [], 0.0
        wraps = max(1, round(radii[0] * 6.3 * tex))
        for i, p in enumerate(pts):
            d = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
            a = d.cross(up).normalized()
            b = a.cross(d)
            r = radii[i]
            if i:
                v_ += (p - pts[i - 1]).length * tex
            for j in range(sides + 1):
                t = TAU * j / sides
                k = 1.0
                if lobes:
                    k += lobes[1] * lobes[3](i / (n - 1)) * math.cos(lobes[0] * t + lobes[2])
                rows.append(tuple(p + (a * math.cos(t) + b * math.sin(t)) * r * k))
                uv.append((j / sides * wraps, v_))
        q = [(i * (sides + 1) + j, i * (sides + 1) + j + 1, (i + 1) * (sides + 1) + j + 1, (i + 1) * (sides + 1) + j) for i in range(n - 1) for j in range(sides)]
        self.add(rows, q, uv, s)

    def quad(self, a, b, c, d, s=.5, mat=0, flip=False):
        uv = [(0, 1), (1, 1), (1, 0), (0, 0)] if flip else [(0, 0), (1, 0), (1, 1), (0, 1)]
        self.add([a, b, c, d], [(0, 1, 2, 3)], uv, s, mat)

    def mesh(self, name, mats, smooth=False):
        V, Q = np.array(self.v, np.float32), np.array(self.q, np.int32)
        me = bpy.data.meshes.new(name)
        me.vertices.add(len(V))
        me.vertices.foreach_set('co', V.ravel())
        me.loops.add(Q.size)
        me.loops.foreach_set('vertex_index', Q.ravel())
        me.polygons.add(len(Q))
        me.polygons.foreach_set('loop_start', np.arange(0, Q.size, 4, np.int32))
        me.update(calc_edges=True)
        if smooth:
            me.polygons.foreach_set('use_smooth', np.ones(len(Q), bool))
        me.uv_layers.new(name='UVMap').uv.foreach_set('vector', np.array(self.uv, np.float32)[Q.ravel()].ravel())
        s = np.array(self.s, np.float32)[Q.ravel()]
        me.uv_layers.new(name='S').uv.foreach_set('vector', np.stack([s, s], 1).ravel())
        for m in mats:
            me.materials.append(m)
        me.polygons.foreach_set('material_index', np.array(self.mi, np.int32))
        return me

    def obj(self, name, mats, smooth=False):
        return link(bpy.data.objects.new(name, self.mesh(name, mats, smooth)))


def lathe(bag, x, y, z0, profile, sides=12, s=.5):
    """回転体。profile は (半径, 高さ) の列"""
    rows, uv = [], []
    for i, (r, h) in enumerate(profile):
        for j in range(sides + 1):
            t = TAU * j / sides
            rows.append((x + r * math.cos(t), y + r * math.sin(t), z0 + h))
            uv.append((j / sides, i / max(1, len(profile) - 1)))
    q = [(i * (sides + 1) + j, i * (sides + 1) + j + 1, (i + 1) * (sides + 1) + j + 1, (i + 1) * (sides + 1) + j) for i in range(len(profile) - 1) for j in range(sides)]
    bag.add(rows, q, uv, s)


# ---- 材質 ----
def bark_mat():
    s = Sh('Bark')
    uv = s.n('UVMap', uv_map='UVMap').outputs[0]
    t = s.n('Mapping', uv, None, None, (.7, .5, 1)).outputs[0]
    c = s.tex('bark_t.png', t)[0]
    h = s.n('RGBToBW', c).outputs[0]
    c = s.n('BrightContrast', c, .0, .05).outputs[0]
    c = s.mix(1, s.n('HueSaturation', .5, .5, 1, 1, c).outputs['Color'], (1.6, 1.42, 1.2), 'MULTIPLY')
    bump = s.n('Bump', Strength=.7, Distance=.08, Height=h).outputs[0]
    return s.done(s.n('AddShader', s.n('BsdfPrincipled', c, 0, .72, Normal=bump).outputs[0], s.n('Emission', c, .18).outputs[0]).outputs[0])


def leaf_mat(name, image, tone, trans=.45):
    """枝葉の塊の絵。透明度は絵の A、裏から日が透ける。S は 1 枚ごとの明るさの揺れ"""
    s = Sh(name)
    t = s.tex(image, s.n('UVMap', uv_map='UVMap').outputs[0], ext='CLIP')
    t[0].node.image.alpha_mode = 'STRAIGHT'
    alpha = s.n('MapRange', t[1], .3, .7, 0, 1).outputs[0]
    r = s.n('SeparateXYZ', s.n('UVMap', uv_map='S').outputs[0]).outputs[0]
    k = s.n('MapRange', r, 0, 1, tone * .7, tone * 1.15).outputs[0]
    hue = s.n('MapRange', r, 0, 1, .9, 1.06).outputs[0]
    c = s.n('BrightContrast', t[0], -.02, .28).outputs[0]
    c = s.n('VectorMath', s.mix(1, c, (1.2, 1.1, .42), 'MULTIPLY'), None, None, k, operation='SCALE').outputs[0]
    c = s.n('HueSaturation', .5 + .02 * 0, .92, hue, 1, c).outputs['Color']
    d = s.n('BsdfDiffuse', c).outputs[0]
    tr = s.n('BsdfTranslucent', s.mix(.45, c, (.75, .85, .12))).outputs[0]
    g = s.n('BsdfGlossy', (1, 1, .9), .38).outputs[0]
    body = s.n('MixShader', .03, s.n('MixShader', trans, d, tr).outputs[0], g).outputs[0]
    body = s.n('AddShader', body, s.n('Emission', c, .32).outputs[0]).outputs[0]  # 葉の塊の中の暗さを持ち上げる
    return s.cut(alpha, body)


def hedge_mat():
    """ツツジの葉。S は 1 枚ごとの色の揺れ"""
    s = Sh('HedgeLeaf')
    r = s.n('SeparateXYZ', s.n('UVMap', uv_map='S').outputs[0]).outputs[0]
    c = s.mix(r, (.02, .13, .02), (.16, .4, .05))
    d = s.n('BsdfDiffuse', c).outputs[0]
    body = s.n('MixShader', .2, s.n('MixShader', .3, d, s.n('BsdfTranslucent', c).outputs[0]).outputs[0], s.n('BsdfGlossy', (1, 1, 1), .3).outputs[0]).outputs[0]
    return s.done(s.n('AddShader', body, s.n('Emission', c, .3).outputs[0]).outputs[0])


def flower_mat():
    """ツツジの花。S で桃色から赤紫、たまに白"""
    s = Sh('HedgeFlower')
    r = s.n('SeparateXYZ', s.n('UVMap', uv_map='S').outputs[0]).outputs[0]
    c = s.mix(s.n('MapRange', r, .85, .9, 0, 1).outputs[0], s.mix(s.n('MapRange', r, .2, .24, 0, 1).outputs[0], (.95, .1, .05), s.mix(r, (.85, .03, .24), (.95, .2, .46))), (.95, .9, .92))
    uv = s.n('SeparateXYZ', s.n('UVMap', uv_map='UVMap').outputs[0]).outputs
    rim = s.n('MapRange', s.math('ADD', uv[0], uv[1]), .1, 1.1, 0, 1).outputs[0]
    c = s.mix(rim, s.mix(1, c, (.5, .2, .3), 'MULTIPLY'), s.mix(.1, c, (1, 1, 1)))
    body = s.n('MixShader', .35, s.n('BsdfDiffuse', c).outputs[0], s.n('BsdfTranslucent', c).outputs[0]).outputs[0]
    return s.done(s.n('AddShader', body, s.n('Emission', c, .3).outputs[0]).outputs[0])


def card_mat(name, image, k):
    """遠景の板。絵の色を自己発光で見せる"""
    s = Sh(name)
    t = s.tex(image, s.n('UVMap', uv_map='UVMap').outputs[0])
    t[0].node.image.alpha_mode = 'STRAIGHT'
    return s.cut(t[1], s.n('Emission', s.mix(.14, t[0], (.62, .78, .8)), k).outputs[0])


def gravel_mat():
    s = Sh('Gravel')
    a = s.tex('gravel_t.png', world_xy(s, 1.5))[0]
    b = s.tex('gravel_t.png', world_xy(s, 3.7, .7))[0]
    p = s.n('SeparateXYZ', s.n('NewGeometry').outputs['Position']).outputs
    noise = s.n('TexNoise', None, Scale=.33, Detail=5, Roughness=.55)
    s.t.links.new(s.n('NewGeometry').outputs['Position'], noise.inputs[0])
    n = s.n('MapRange', noise.outputs[0], .35, .65, 0, 1).outputs[0]
    c = s.mix(.5, a, b, 'SOFT_LIGHT')
    c = s.mix(n, s.mix(1, c, (.9, .86, .78), 'MULTIPLY'), s.mix(1, c, (1.08, 1.04, .98), 'MULTIPLY'))
    c = s.mix(1, s.n('BrightContrast', s.n('HueSaturation', .5, .6, 1, 1, c).outputs['Color'], 0, .32).outputs[0], (1.07, .98, 1.02), 'MULTIPLY')
    edge = s.n('MapRange', s.math('ABSOLUTE', p[0]), ROAD - .4, ROAD, 0, .3).outputs[0]
    c = s.mix(edge, c, s.mix(1, c, (.72, .66, .56), 'MULTIPLY'))
    h = s.n('RGBToBW', a).outputs[0]
    bump = s.n('Bump', Strength=.75, Distance=.012, Height=h).outputs[0]
    return s.done(s.n('AddShader', s.n('BsdfPrincipled', c, 0, .82, Normal=bump).outputs[0], s.n('Emission', c, .15).outputs[0]).outputs[0])


def ground_mat():
    """芝。木の根元だけ土になる。根元の位置は並木の周期から決める"""
    s = Sh('Lawn')
    a = s.tex('lawn_t.png', world_xy(s, 3.1))[0]
    b = s.tex('lawn_t.png', world_xy(s, 11.0, .5))[0]
    c = s.mix(1, s.mix(.45, a, b, 'SOFT_LIGHT'), (1.25, .9, .68), 'MULTIPLY')
    noise = s.n('TexNoise', None, Scale=.11, Detail=4, Roughness=.5)
    pos = s.n('NewGeometry').outputs['Position']
    s.t.links.new(pos, noise.inputs[0])
    c = s.mix(s.n('MapRange', noise.outputs[0], .35, .65, 0, .7).outputs[0], c, s.mix(1, c, (1.25, 1.2, .78), 'MULTIPLY'))
    p = s.n('SeparateXYZ', pos).outputs
    fine = s.n('TexNoise', None, Scale=3.0, Detail=4)
    s.t.links.new(pos, fine.inputs[0])
    dx = s.math('SUBTRACT', s.math('ABSOLUTE', p[0]), TREE_X)
    dy = s.math('SUBTRACT', s.math('FLOORED_MODULO', s.math('SUBTRACT', p[1], TREE_Y0 - TREE_STEP / 2), TREE_STEP), TREE_STEP / 2)
    d = s.math('SQRT', s.math('ADD', s.math('MULTIPLY', dx, dx), s.math('MULTIPLY', dy, dy)))
    d = s.math('ADD', d, s.math('MULTIPLY', fine.outputs[0], .7))
    far = s.n('MapRange', s.math('ABSOLUTE', p[1]), FAR - 2, FAR, 1, 0).outputs[0]
    f = s.math('MULTIPLY', s.n('MapRange', d, 1.35, 1.75, 1, 0).outputs[0], far)
    c = s.mix(f, c, s.tex('soil_t.png', world_xy(s, 2.4))[0])
    h = s.n('RGBToBW', a).outputs[0]
    return s.done(s.n('BsdfPrincipled', c, 0, .85, Normal=s.n('Bump', Strength=.6, Distance=.03, Height=h).outputs[0]).outputs[0])


def blade_mat():
    s = Sh('Blade')
    a = s.tex('lawn_t.png', world_xy(s, 3.1))[0]
    r = s.n('SeparateXYZ', s.n('UVMap', uv_map='S').outputs[0]).outputs[0]
    c = s.mix(1, a, s.n('CombineXYZ', *(s.n('MapRange', r, 0, 1, .85, 1.3).outputs[0],) * 3).outputs[0], 'MULTIPLY')
    c = s.mix(1, c, (1.62, 1.0, .72), 'MULTIPLY')
    d = s.n('BsdfDiffuse', c).outputs[0]
    body = s.n('MixShader', .35, d, s.n('BsdfTranslucent', s.mix(.5, c, (.7, .85, .2))).outputs[0]).outputs[0]
    return s.done(s.n('AddShader', body, s.n('Emission', c, .2).outputs[0]).outputs[0])


def pebble_mat():
    s = Sh('Pebble')
    r = s.n('SeparateXYZ', s.n('UVMap', uv_map='S').outputs[0]).outputs[0]
    c = s.mix(s.n('MapRange', r, .3, .7, 0, 1).outputs[0], (.34, .32, .3), (.56, .52, .47))
    c = s.mix(s.n('MapRange', r, .86, .9, 0, 1).outputs[0], c, (.34, .24, .16))
    return s.done(s.n('AddShader', s.n('BsdfPrincipled', c, 0, .55).outputs[0], s.n('Emission', c, .15).outputs[0]).outputs[0])


def stone_mat():
    s = Sh('Kerb')
    uv = s.n('UVMap', uv_map='UVMap').outputs[0]
    c = s.tex('granite_t.png', s.n('Mapping', uv, None, None, (1.1, 1.1, 1)).outputs[0])[0]
    r = s.n('SeparateXYZ', s.n('UVMap', uv_map='S').outputs[0]).outputs[0]
    k = s.n('MapRange', r, 0, 1, .66, 1.14).outputs[0]
    c = s.mix(1, c, s.n('CombineXYZ', k, k, k).outputs[0], 'MULTIPLY')
    c = s.mix(1, c, (1.25, 1.14, 1.0), 'MULTIPLY')
    body = s.n('BsdfPrincipled', c, 0, .62, Normal=s.n('Bump', Strength=.25, Distance=.004, Height=s.n('RGBToBW', c).outputs[0]).outputs[0]).outputs[0]
    return s.done(s.n('AddShader', body, s.n('Emission', c, .1).outputs[0]).outputs[0])


def wood_mat():
    s = Sh('BenchWood')
    c = s.mix(1, s.tex('bench_wood.png', s.n('UVMap', uv_map='UVMap').outputs[0])[0], (2.2, 1.9, 1.7), 'MULTIPLY')
    return s.done(s.n('BsdfPrincipled', c, 0, .45).outputs[0])


def paint_mat(name, col, rough=.34):
    s = Sh(name)
    return s.done(s.n('BsdfPrincipled', col, .55, rough).outputs[0])


def globe_mat():
    s = Sh('Globe')
    b = s.n('BsdfPrincipled', (.94, .94, .9), 0, .28, Emission_Color=(1, .97, .9), Emission_Strength=.28).outputs[0]
    return s.done(b)


# ---- 環境 ----
def world():
    """空の絵を方位 90 度ごとに折り返して全周へ敷く。絵の下端が地平線で、天頂の近くは絵の上端の青へ移す"""
    w = bpy.data.worlds.new('ParkSky')
    w.use_nodes = True
    t = w.node_tree
    bg = next(x for x in t.nodes if x.type == 'BACKGROUND')
    N, L = t.nodes, t.links

    def math_(op, a, b=None):
        n = N.new('ShaderNodeMath')
        n.operation = op
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, bpy.types.NodeSocket):
                L.new(v, n.inputs[i])
            else:
                n.inputs[i].default_value = v
        return n.outputs[0]

    tc = N.new('ShaderNodeTexCoord')
    nr = N.new('ShaderNodeVectorMath')
    nr.operation = 'NORMALIZE'
    L.new(tc.outputs['Generated'], nr.inputs[0])
    sep = N.new('ShaderNodeSeparateXYZ')
    L.new(nr.outputs[0], sep.inputs[0])
    az = math_('ARCTAN2', sep.outputs[0], sep.outputs[1])
    u = math_('PINGPONG', math_('ADD', math_('DIVIDE', az, math.pi / 4), .3), 1.0)
    el = math_('ARCSINE', math_('MAXIMUM', sep.outputs[2], 0))
    v = math_('MAXIMUM', math_('MINIMUM', math_('DIVIDE', el, .78), .97), .012)
    cmb = N.new('ShaderNodeCombineXYZ')
    L.new(u, cmb.inputs[0])
    L.new(v, cmb.inputs[1])
    e = N.new('ShaderNodeTexImage')
    e.image = img('sky.png')
    e.extension = 'EXTEND'
    L.new(cmb.outputs[0], e.inputs[0])
    pale = N.new('ShaderNodeMix')
    pale.data_type = 'RGBA'
    pale.blend_type = 'SCREEN'
    fac, a_, b_ = (next(i for i in pale.inputs if i.name == n_ and i.type == t_) for n_, t_ in (('Factor', 'VALUE'), ('A', 'RGBA'), ('B', 'RGBA')))
    fac.default_value = 1
    b_.default_value = (.02, .17, .3, 1)
    L.new(e.outputs[0], a_)
    # 絵の上端より高い所は雲の無い青へ移す
    top = N.new('ShaderNodeMix')
    top.data_type = 'RGBA'
    fac2, a2, b2 = (next(i for i in top.inputs if i.name == n_ and i.type == t_) for n_, t_ in (('Factor', 'VALUE'), ('A', 'RGBA'), ('B', 'RGBA')))
    rng_ = N.new('ShaderNodeMapRange')
    L.new(el, rng_.inputs[0])
    rng_.inputs['From Min'].default_value, rng_.inputs['From Max'].default_value = .5, .74
    L.new(rng_.outputs[0], fac2)
    L.new(next(o for o in pale.outputs if o.type == 'RGBA'), a2)
    b2.default_value = (.14, .44, .9, 1)
    # 地平線の近くは白く霞む
    low = N.new('ShaderNodeMix')
    low.data_type = 'RGBA'
    fac3, a3, b3 = (next(i for i in low.inputs if i.name == n_ and i.type == t_) for n_, t_ in (('Factor', 'VALUE'), ('A', 'RGBA'), ('B', 'RGBA')))
    rng2 = N.new('ShaderNodeMapRange')
    L.new(el, rng2.inputs[0])
    rng2.inputs['From Min'].default_value, rng2.inputs['From Max'].default_value = 0, .24
    rng2.inputs['To Min'].default_value, rng2.inputs['To Max'].default_value = .85, 0
    L.new(rng2.outputs[0], fac3)
    L.new(next(o for o in top.outputs if o.type == 'RGBA'), a3)
    b3.default_value = (.74, .86, .96, 1)
    L.new(next(o for o in low.outputs if o.type == 'RGBA'), bg.inputs[0])
    # カメラに写る空は絵の色のまま、地面を照らす空の光だけ強める
    lp = N.new('ShaderNodeLightPath')
    L.new(math_('ADD', 2.6, math_('MULTIPLY', lp.outputs['Is Camera Ray'], -1.6)), bg.inputs[1])
    bpy.context.scene.world = w
    w.cycles.sample_map_resolution = 1024


def sun():
    l = bpy.data.lights.new('Sun', 'SUN')
    l.energy, l.angle, l.color = 4.9, math.radians(.35), (1, .93, .78)
    o = link(bpy.data.objects.new('Sun', l))
    o.rotation_euler = SUN_DIR.to_track_quat('Z', 'Y').to_euler()


def compositor():
    s = bpy.context.scene
    nt = bpy.data.node_groups.new('Grade', 'CompositorNodeTree')
    s.compositing_node_group = nt
    N, L = nt.nodes, nt.links
    rl = N.new('CompositorNodeRLayers')
    g = N.new('CompositorNodeGlare')
    g.inputs['Type'].default_value = 'Bloom'
    g.inputs['Quality'].default_value = 'Medium'
    g.inputs['Threshold'].default_value = .98
    g.inputs['Smoothness'].default_value = .5
    g.inputs['Strength'].default_value = .25
    g.inputs['Size'].default_value = .75
    L.new(rl.outputs['Image'], g.inputs['Image'])
    nt.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    out = N.new('NodeGroupOutput')
    L.new(g.outputs['Image'], out.inputs[0])
    s.render.use_compositing = True


# ---- 地面 ----
def road(gravel, lawn, stone, pads):
    b = Bag()
    n = 40
    # 道の中央をわずかに高くする
    rows = [(x, y) for y in np.linspace(-FAR - 12, FAR + 12, n + 1) for x in np.linspace(-ROAD - .02, ROAD + .02, 9)]
    v = [(x, y, .012 * (1 - (x / ROAD) ** 2)) for x, y in rows]
    q = [(j * 9 + i, j * 9 + i + 1, (j + 1) * 9 + i + 1, (j + 1) * 9 + i) for j in range(n) for i in range(8)]
    b.add(v, q, [(x, y) for x, y in rows])
    for side, y in pads:  # ベンチの前の広がり
        x0, x1 = sorted((side * (ROAD - .02), side * 4.75))
        b.add([(x0, y - 1.5, .004), (x1, y - 1.5, .004), (x1, y + 1.5, .004), (x0, y + 1.5, .004)], [(0, 1, 2, 3)], [(0, 0), (1, 0), (1, 1), (0, 1)])
    b.obj('Path', [gravel], smooth=True)

    g = Bag()
    g.add([(-340, -340, -.012), (340, -340, -.012), (340, 340, -.012), (-340, 340, -.012)], [(0, 1, 2, 3)], [(0, 0), (1, 0), (1, 1), (0, 1)])
    g.obj('Lawn', [lawn])

    rng = random.Random(4)
    k = Bag()
    for side in (-1, 1):
        y = -FAR - 12
        while y < FAR + 12:
            x0, x1 = (ROAD, ROAD + KERB) if side > 0 else (-ROAD - KERB, -ROAD)
            prof = [(x0, -.05), (x0, .118), (x0 + .022, .14), (x1 - .022, .14), (x1, .118), (x1, -.05)]
            t, y0, y1 = rng.random(), y + .01, y + .69
            pts = [(px, yy, pz) for yy in (y0, y1) for px, pz in prof]
            n = len(prof)
            k.add(pts, [(i, i + 1, i + 1 + n, i + n) for i in range(n - 1)], [(a_, yy * 1.2) for yy in (y0, y1) for a_ in (0, .2, .23, .47, .5, .7)], t)
            k.add([(x0, y0, -.05), (x1, y0, -.05), (x1, y0, .14), (x0, y0, .14), (x0, y1, -.05), (x1, y1, -.05), (x1, y1, .14), (x0, y1, .14)], [(0, 1, 2, 3), (5, 4, 7, 6)], [(0, 0), (.3, 0), (.3, .2), (0, .2)] * 2, t)
            y += .7
    k.obj('Kerb', [stone])


def pebbles(mat):
    """道の小石の 1 区画(幅は道いっぱい、長さ 3 m)。手前のカメラの近くだけ敷く"""
    rng = np.random.default_rng(12)
    n = 14000
    x, y = rng.uniform(-ROAD + .03, ROAD - .03, n), rng.uniform(-1.5, 1.5, n)
    r = rng.gamma(3.0, .0016, n).clip(.0025, .013)
    z = .012 * (1 - (x / ROAD) ** 2) + r * .1
    a = rng.uniform(0, TAU, n)
    corner = np.array([[sx, sy, sz] for sz in (-1, 1) for sy in (-1, 1) for sx in (-1, 1)], np.float32)
    faces = ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3))
    b = Bag()
    c0, s0 = np.cos(a), np.sin(a)
    k = rng.uniform(.75, 1.3, (n, 1, 3)) * corner[None] * np.array([1, .8, .5], np.float32)
    px = k[..., 0] * c0[:, None] - k[..., 1] * s0[:, None]
    py = k[..., 0] * s0[:, None] + k[..., 1] * c0[:, None]
    v = np.stack([x[:, None] + px * r[:, None], y[:, None] + py * r[:, None], z[:, None] + k[..., 2] * r[:, None]], 2).reshape(-1, 3)
    b.v, b.uv = v.tolist(), [(0, 0)] * len(v)
    b.s = np.repeat(rng.random(n), 8).tolist()
    b.q = [tuple(i * 8 + q for q in f_) for i in range(n) for f_ in faces]
    b.mi = [0] * len(b.q)
    me = b.mesh('Pebbles', [mat], True)
    for j in range(-23, 19):
        o = link(bpy.data.objects.new('Pebbles', me))
        o.location = (0, j * 3.0 + 1.5, 0)
        o.rotation_euler = (0, 0, (j % 2) * math.pi)


def blades(mat, pads):
    """短い芝の葉の 1 区画(3 m 四方)を作り、並走するカメラの足元へ敷く"""
    rng = np.random.default_rng(3)
    N_ = 13000
    x, y = rng.uniform(-1.5, 1.5, N_), rng.uniform(-1.5, 1.5, N_)
    a = rng.uniform(0, TAU, N_)
    h = rng.uniform(.045, .085, N_)
    w = rng.uniform(.0035, .0065, N_)
    lean = rng.uniform(.2, .6, N_) * h
    dx, dy = np.cos(a), np.sin(a)
    px, py = -dy * w, dx * w
    v = np.stack([x - px, y - py, 0 * x, x + px, y + py, 0 * x, x + dx * lean + px * .3, y + dy * lean + py * .3, h, x + dx * lean - px * .3, y + dy * lean - py * .3, h], 1).reshape(-1, 3)
    b = Bag()
    b.v, b.uv = v.tolist(), np.tile([[0, 0], [1, 0], [1, 1], [0, 1]], (N_, 1)).tolist()
    b.s = np.repeat(rng.random(N_), 4).tolist()
    b.q = [(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 3) for i in range(N_)]
    b.mi = [0] * N_
    me = b.mesh('Blades', [mat])
    for side in (-1, 1):
        for xc in (ROAD + KERB + 1.5, ROAD + KERB + 4.5):
            for j in range(-30, 31):
                if xc < 4 and any(sd == side and abs(j * 3.0 + 1.5 - c) < 1 for sd, c in pads):
                    continue
                o = link(bpy.data.objects.new('Blades', me))
                o.location = (side * xc, j * 3.0 + 1.5, -.012)
                o.rotation_euler = (0, 0, (j % 4) * math.pi / 2)


# ---- 木 ----
def curve(p, d, L, n, wander, rng, lift=0.0):
    """p から d の向きへ伸びる曲がった線"""
    pts, d = [Vector(p)], Vector(d).normalized()
    for _ in range(n):
        d = (d + Vector((rng.gauss(0, wander), rng.gauss(0, wander), rng.gauss(0, wander) + lift))).normalized()
        pts.append(pts[-1] + d * (L / n))
    return pts, d


def tree_mesh(idx, mats):
    """ケヤキ。幹は低い所で太い枝に分かれ、箒の形に広がる。ローカルの -X が道の側"""
    rng = random.Random(100 + idx)
    b = Bag()
    leaves = Bag()
    perch = LOCAL_PERCH if idx == 0 else None
    tips = []

    def grow(p, d, L, r, lvl):
        steps = (7, 7, 6, 5)[lvl]
        pts, end = curve(p, d, L, steps, (.09, .13, .16, .2)[lvl], rng, (.03, .04, .05, .02)[lvl])
        lim = -(TREE_X - 3.3)  # 太い枝も道の真上へ出さない
        for p_ in pts:
            lim_z = lim - 2.2 * min(1, max(0, p_.z - 12) / 6)
            if p_.x < lim_z:
                p_.x = lim_z + (p_.x - lim_z) * .2
        r1 = r * (.42 if lvl == 3 else .62)
        radii = [r + (r1 - r) * (i / steps) ** .7 for i in range(steps + 1)]
        b.tube(pts, radii, (10, 8, 6, 4)[lvl], .8)
        if lvl == 3:
            tips.append((pts[len(pts) // 2], pts[-1], end))
            return
        for k in range((3, 3, 3)[lvl] + (rng.random() < .4)):
            a = TAU * (k + rng.uniform(-.2, .2)) / 3
            side = end.cross(Vector((.2, .4, .9))).normalized()
            side2 = end.cross(side)
            nd = end + (side * math.cos(a) + side2 * math.sin(a)) * rng.uniform(.55, 1.05)
            nd.z += .15
            q = pts[steps] if k == 0 else pts[rng.randint(steps // 2, steps - 1)]  # 1 本目は先端から続ける
            if k == 0:
                nd = end + (nd - end) * .4
            if lvl < 2 or q.z > 3:
                grow(q, nd, L * rng.uniform(.56, .72), r1 * (.86 if k == 0 else rng.uniform(.5, .7)), lvl + 1)

    # 幹
    trunk_h = rng.uniform(5.2, 9.0)
    pts = [Vector((0, 0, -.1))]
    lean = Vector((rng.uniform(-.03, .03), rng.uniform(-.03, .03), 1)).normalized()
    for i in range(10):
        lean = (lean + Vector((rng.gauss(0, .045), rng.gauss(0, .045), 0))).normalized()
        pts.append(pts[-1] + lean * trunk_h / 10)
    r0 = rng.uniform(.42, .52)
    radii = [r0 * (.94 + .34 * math.exp(-z * 3.5)) * (1 - .34 * z) for z in np.linspace(0, 1, 11)]
    radii[-1] *= .3  # 太い枝の根元の中で細って終わる
    radii[-2] *= .7
    b.tube(pts, radii, 18, .8, (5, .13, rng.uniform(0, 6), lambda t: math.exp(-t * 4) + .25))
    limbs = rng.randint(2, 4)
    low = pts[rng.randint(5, 7)]  # 幹の途中から出る細めの枝。木ごとの形の違いを作る
    side_a = rng.uniform(0, TAU)
    grow(low, Vector((math.cos(side_a), math.sin(side_a), 1.0)), rng.uniform(4.2, 5.4), r0 * .3, 1)
    for k in range(limbs):
        a = TAU * (k + rng.uniform(-.18, .18)) / limbs + .4
        out = Vector((math.cos(a), math.sin(a), 0))
        # 道へ向かう太い枝は立て、外へ向かう枝は寝かせる
        rise = rng.uniform(.7, 1.2) + (.5 if out.x < 0 else 0)
        grow(pts[-2] - lean * rng.uniform(0, .4), out + Vector((0, 0, rise)), rng.uniform(5.8, 7.2), r0 * .58, 0)
    if perch:  # カラスの枝。幹の上の方から道へ張り出し、足場のあたりは水平にする。葉を付けない。立った枝だと横から見て鳥が幹にしがみついて見える
        s0 = min(pts, key=lambda q: abs(q.z - (perch.z - .6)))
        mid = Vector((s0.x + (perch.x - s0.x) * .4, .1, perch.z - .1))  # 幹の近くで立ち上がり、足場の手前から水平になる
        out = Vector((perch.x - mid.x, perch.y - mid.y, 0)).normalized()
        tip = [perch + out * .3 + Vector((0, .02, .02)), perch + out * .6 + Vector((0, .05, .06)), perch + out * .85 + Vector((0, .08, .13))]  # 足場の先も細って伸びる。切り口を見せない
        tube = [s0 + (mid - s0) * t for t in (0, .35, .7, 1)] + [mid + (perch - mid) * t for t in (.35, .7, 1)] + tip
        b.tube(tube, [.15, .12, .095, .08, .068, .058, .05, .036, .02, .006], 8, .8)

    for mid, tip, d in tips:
        if rng.random() > .36:  # 葉の塊の間を空ける。ここを通る日が道の木漏れ日になる
            continue
        limit = -(TREE_X - 3.9) if rng.random() < .92 else -(TREE_X - 3.2)
        for _ in range(6):
            k = rng.random()
            c = mid + (tip - mid) * k + Vector((rng.gauss(0, .55), rng.gauss(0, .55), rng.gauss(.25, .4)))
            if c.z < 5.2:
                continue
            if c.x < limit - 3.0 * min(1, max(0, c.z - 13) / 6) + 1.1:
                continue  # 板の幅の分だけ内側で切る。低い所は道の真上を空け、高い所は閉じて細い空の帯を残す
            if perch and (c - perch).length < 1.5:
                continue
            w = rng.uniform(1.2, 1.75)
            # 互いに直角な 2 枚で組む。上向きだけだと低いカメラから板が寝て見える
            n = (Vector((rng.gauss(0, .5), rng.gauss(0, 1), rng.gauss(.15, .4)))).normalized()
            t = (d - n * d.dot(n)).normalized()
            s = n.cross(t)
            u, v = t * w, s * w * .667
            tone = rng.random()
            leaves.quad(c - u - v, c + u - v, c + u + v, c - u + v, tone, rng.random() < .3, rng.random() < .5)
            leaves.quad(c - u - n * w * .6, c + u - n * w * .6, c + u + n * w * .6, c - u + n * w * .6, tone, rng.random() < .3, rng.random() < .5)
    for _ in range(26):
        c = Vector((rng.uniform(1.3, 5.0), rng.uniform(-3.8, 3.8), rng.uniform(3.4, 6.2)))
        n = Vector((rng.gauss(0, .5), rng.gauss(0, 1), rng.gauss(.15, .3))).normalized()
        t = n.cross(Vector((0, 0, 1))).normalized()
        u, v = t * rng.uniform(1.1, 1.6), n.cross(t) * .8
        tone = rng.random()
        leaves.quad(c - u - v, c + u - v, c + u + v, c - u + v, tone, rng.random() < .3, rng.random() < .5)
    return b.mesh(f'Tree{idx}', mats[:1]), leaves.mesh(f'Leaves{idx}', mats[1:3])


def dapple(mat):
    """道の上の木漏れ日を作る枝葉の影。カメラにも照り返しにも写らず、日の光だけを遮る。空の帯を塞がずに細かい影を落とせる"""
    rng = random.Random(77)
    b = Bag()
    for _ in range(int((FAR * 2 + 40) * 21)):
        c = Vector((rng.uniform(-4.5, 4.5), rng.uniform(-FAR - 20, FAR + 20), rng.uniform(7, 10)))
        a = rng.gauss(0, .4)  # 影が道を横切る帯になるよう、長い辺を X に寄せる
        w = rng.uniform(.5, 1.1)
        u = Vector((math.cos(a), math.sin(a), 0)) * w
        v = Vector((-math.sin(a), math.cos(a), 0)) * w * .4
        b.quad(c - u - v, c + u - v, c + u + v, c - u + v, .5)
    o = b.obj('Dapple', [mat])
    o.visible_camera = o.visible_diffuse = o.visible_glossy = o.visible_transmission = False
    return o


def sway(objs, dapple_obj, last, fps):
    """風で樹冠と道の木漏れ日がゆっくり動く"""
    rng = random.Random(3)
    for o in objs:
        per, ph = rng.uniform(4, 6.5) * fps, rng.uniform(0, 1)
        amp = math.radians(rng.uniform(.14, .26))
        base = o.rotation_euler.copy()
        for i in range(int(last / (per / 2)) + 3):
            o.rotation_euler = (base.x + amp * (1 if i % 2 else -1), base.y, base.z)
            o.keyframe_insert('rotation_euler', index=0, frame=1 + (i - ph) * per / 2)
        o.rotation_euler = base
    per = 5.2 * fps
    for i in range(int(last / (per / 2)) + 3):
        dapple_obj.location.y = .07 * (1 if i % 2 else -1)
        dapple_obj.keyframe_insert('location', index=1, frame=1 + i * per / 2)


def trees(mats):
    variants = [tree_mesh(i, mats) for i in range(5)]
    perch_at = {(y, side) for y, side in PERCH_TREES}
    rng = random.Random(21)

    crowns = []

    def place(x, y, rot, v, scale=1.0):
        for me in variants[v]:
            o = link(bpy.data.objects.new(me.name, me))
            o.location = (x, y, 0)
            o.rotation_euler = (0, 0, rot)
            o.scale = (scale, scale, scale)
        if WALK_Y[0] - 40 < y < WALK_Y[1] + 40 and abs(x) < 6:
            crowns.append(o)  # 葉の方。カメラの近くの木だけ揺らす

    k = int((FAR + TREE_Y0) / TREE_STEP)
    for j in range(-k, k):
        y = TREE_Y0 + j * TREE_STEP
        for side in (-1, 1):
            # ローカルの -X が道を向くよう、右の列をそのまま、左の列を 180 度回す
            rot = 0 if side > 0 else math.pi
            v = 0 if (y, side) in perch_at else rng.randint(1, 4)
            place(side * TREE_X, y, rot, v, 1.0 if v == 0 else rng.uniform(.94, 1.08))
    for side in (-1, 1):  # 芝生の奥の木
        for _ in range(110):
            place(side * rng.uniform(13, 44), rng.uniform(-FAR, FAR), rng.uniform(0, TAU), rng.randint(1, 4), rng.uniform(.7, 1.0))
    return crowns


def hedge(mats):
    """低いツツジの丸い刈り込み。楕円の殻に小さな葉と花の面を並べる。中は暗い塊"""
    meshes = []
    for idx in range(3):
        rng = np.random.default_rng(40 + idx)
        L, W, H = 1.2, .5, .78
        core = Bag()
        n, m = 14, 8
        v = [(L * .94 * math.cos(TAU * i / n) * math.cos(math.pi / 2 * j / m), W * .94 * math.sin(TAU * i / n) * math.cos(math.pi / 2 * j / m), H * .94 * math.sin(math.pi / 2 * j / m)) for j in range(m + 1) for i in range(n + 1)]
        core.add(v, [(j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i) for j in range(m) for i in range(n)], [(0, 0)] * len(v))
        cards = Bag()
        a = rng.uniform(0, TAU, 5200)
        z = rng.uniform(.02, 1, 5200) ** .75
        lump = 1 + .05 * np.sin(a * 5 + idx) * np.cos(z * 9 + idx * 2)
        rr = np.sqrt(1 - z * z) * lump
        for i in range(len(a)):
            p = Vector((math.cos(a[i]) * rr[i] * L, math.sin(a[i]) * rr[i] * W, z[i] * H * lump[i]))
            nr = (Vector((p.x / L ** 2, p.y / W ** 2, p.z / H ** 2)).normalized() + Vector(rng.normal(0, .55, 3))).normalized()
            t = nr.cross(Vector(rng.normal(0, 1, 3))).normalized()
            u = nr.cross(t)
            if rng.random() < (.03, .09, .22)[idx]:  # 花は 2 枚の四角で作る六角形
                r = rng.uniform(.034, .046)
                col = rng.random()
                cen = p + nr * .012
                for k in range(5):  # 中心から開く 5 枚の花びら。UV の和が中心からの距離
                    b_ = k * TAU / 5
                    d_ = t * math.cos(b_) + u * math.sin(b_)
                    e_ = t * -math.sin(b_) + u * math.cos(b_)
                    cards.quad(cen, cen + d_ * r * .62 - e_ * r * .36 + nr * .012, cen + d_ * r + nr * .02, cen + d_ * r * .62 + e_ * r * .36 + nr * .012, col, 1)
            else:
                wl, wd = rng.uniform(.03, .045), rng.uniform(.012, .018)
                cards.quad(p - t * wl, p - u * wd, p + t * wl, p + u * wd, rng.random(), 0)
        meshes.append((core.mesh(f'HedgeCore{idx}', mats[:1], True), cards.mesh(f'HedgeLeaves{idx}', mats[1:3])))
    return meshes


def place_hedges(meshes, skip):
    rng = random.Random(9)
    step = TREE_STEP / 3
    y = -FAR
    while y < FAR:
        y += step
        for side in (-1, 1):
            if any(side == sd and abs(y - c) < 2.2 for sd, c in skip):
                continue
            dy, turn, sx, sz = rng.uniform(-.2, .2), rng.uniform(-.05, .05) + (rng.random() < .5) * math.pi, rng.uniform(.95, 1.15), rng.uniform(.9, 1.1)
            for me in meshes[rng.randint(0, 2)]:
                o = link(bpy.data.objects.new(me.name, me))
                o.location = (side * (CLEAR + .46), y + dy, -.01)
                o.rotation_euler = (0, 0, math.pi / 2 + turn)
                o.scale = (sx, 1.0, sz)


def lamp_mesh(paint, globe):
    b = Bag()
    lathe(b, 0, 0, 0, [(.2, 0), (.2, .1), (.16, .14), (.16, .2), (.125, .26), (.11, .8), (.13, .84), (.13, .9), (.085, .98), (.075, 1.9), (.1, 1.94), (.075, 1.98), (.06, 4.26), (.1, 4.3), (.085, 4.38), (.12, 4.44), (.13, 4.48)], 14)
    me = b.mesh('Lamp', [paint], True)
    g = Bag()
    prof = [(.255 * math.sin(t), 4.74 - .255 * math.cos(t)) for t in np.linspace(.1, 3.04, 12)]
    lathe(g, 0, 0, 0, prof, 18)
    me2 = g.mesh('LampGlobe', [globe], True)
    return me, me2


def bench_mesh(wood, steel):
    """ローカルの -X が座る人の前"""
    w = Bag()
    for k in range(4):  # 座面
        w.box((-.28 + k * .125, -.9, .43 - k * .004), (-.28 + k * .125 + .11, .9, .46 - k * .004), 1.2)
    for k in range(3):  # 背
        z = .58 + k * .13
        x = .23 + k * .035
        w.box((x, -.9, z), (x + .03, .9, z + .105), 1.2)
    me = w.mesh('Bench', [wood])
    f = Bag()
    for y in (-.82, .82):
        f.tube([(-.3, y, 0), (-.28, y, .2), (-.3, y, .42), (.2, y, .42), (.28, y, .58), (.34, y, .9)], [.018] * 6, 6)
        f.tube([(.25, y, 0), (.2, y, .2), (.2, y, .42)], [.018] * 3, 6)
        f.tube([(-.28, y, .42), (-.3, y, .6), (-.1, y, .62), (.22, y, .62)], [.016] * 4, 6)
    return me, f.mesh('BenchFrame', [steel], True)


def far_cards(mat):
    """遠い木立の板。芝生の果てをぐるりと囲む"""
    b = Bag()
    rng = random.Random(5)
    for x, y0, y1 in ((52, -250, 250), (-52, -250, 250)):
        y = y0
        while y < y1:
            w, h = rng.uniform(50, 66), rng.uniform(23, 27)
            b.add([(x, y, -.5), (x, y + w, -.5), (x, y + w, h), (x, y, h)], [(0, 1, 2, 3)], [(0, 0), (w / 90, 0), (w / 90, 1), (0, 1)])
            y += w * .9
    for y in (250, -250):
        x = -110
        while x < 110:
            w, h = rng.uniform(70, 90), rng.uniform(24, 30)
            b.add([(x, y, -.5), (x + w, y, -.5), (x + w, y, h), (x, y, h)], [(0, 1, 2, 3)], [(0, 0), (w / 90, 0), (w / 90, 1), (0, 1)])
            x += w * .9
    o = b.obj('FarTrees', [mat])
    o.visible_shadow = False


def build(ctx):
    global ASSETS
    ASSETS = ctx.assets
    s = bpy.context.scene
    s.view_settings.view_transform = 'Standard'
    s.view_settings.look = 'None'
    c = s.cycles
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces, c.transparent_max_bounces = 6, 2, 1, 2, 32
    c.sample_clamp_indirect = 6.0
    c.use_light_tree = True
    c.adaptive_threshold = .04
    c.filter_width = 1.0

    world()
    sun()
    bark = bark_mat()
    leaf = [leaf_mat('Leaf', 'clump_a.png', 1.28), leaf_mat('LeafUnder', 'under_a.png', 1.15)]
    sway(trees([bark, *leaf]), dapple(leaf[0]), max(ctx.frames, 480), ctx.fps)

    pads = [(1, 31.5), (-1, -1.5), (1, -31.5), (-1, 55.5), (1, 82.5), (-1, -58.5), (1, 109.5), (-1, -85.5), (1, -112.5), (-1, 136.5)]  # ベンチ (側, y)
    road(gravel_mat(), ground_mat(), stone_mat(), pads)
    pebbles(pebble_mat())
    blades(blade_mat(), pads)
    core = Sh('HedgeCore')
    core = core.done(core.n('BsdfDiffuse', (.015, .04, .015)).outputs[0])
    place_hedges(hedge([core, hedge_mat(), flower_mat()]), pads)

    paint = paint_mat('LampPaint', (.012, .075, .06))
    lamp, globe = lamp_mesh(paint, globe_mat())
    for side, y0 in ((1, 25.9), (-1, 37.6)):
        for k in range(-11, 9):
            for me in (lamp, globe):
                o = link(bpy.data.objects.new(me.name, me))
                o.location = (side * (CLEAR + .1), y0 + k * 21, 0)
    bw, bf = bench_mesh(wood_mat(), paint)
    for side, y in pads:
        for me in (bw, bf):
            o = link(bpy.data.objects.new(me.name, me))
            o.location = (side * 4.15, y, 0)
            o.rotation_euler = (0, 0, 0 if side > 0 else math.pi)
    far_cards(card_mat('FarTrees', 'treeline_a.png', 1.0))
    compositor()

    perches = [(side * (TREE_X + LOCAL_PERCH.x), y, LOCAL_PERCH.z + .05) for y, side in PERCH_TREES]
    look = CAM + Vector((0, math.cos(TILT), math.sin(TILT))) * 10
    mx, my = MARK[:2]
    return {
        'mark': MARK,
        'facing': 0,
        'bounds': ((-3.6, 3.6), (WALK_Y[0], WALK_Y[1]), (.12, 5.0)),
        'char_emission': .3,
        'beats_per_shot': 8,
        'perches': perches,  # カラスの足元の位置
        'views': {
            'target': {'loc': tuple(CAM), 'look': tuple(look), 'lens': LENS, 'fstop': 4.0, 'focus': 9.0},
            'hold1': {'loc': (3.0, my - 3.4, 1.1), 'look': (0, my, 1.0), 'lens': 35, 'fstop': 2.8},
            'hold2': {'loc': (-2.8, my - 1.2, .5), 'look': (0, my + 2, 1.4), 'lens': 28, 'fstop': 2.8},
            'back': {'loc': (0, my + 3.6, 1.25), 'look': (0, my - 8, 1.5), 'lens': 24, 'fstop': 2.8},
            'left': {'loc': (3.4, my, 1.2), 'look': (-8, my, 2.0), 'lens': 24, 'fstop': 2.8},
            'right': {'loc': (-3.4, my, 1.2), 'look': (8, my, 2.0), 'lens': 24, 'fstop': 2.8},
        },
    }
