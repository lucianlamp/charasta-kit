"""南の海の桟橋。座標は mark が原点で、桟橋の沖側が +Y、板の上面が z=0、水面が z=ZW。
陸は左(-X)と後ろ(-Y)を囲む入り江で、桟橋はその岸から沖へ伸びる。寸法は目標画像の消失点と柱の間隔から求めた。
カメラが動く範囲(y < 1.2)には柱も縄も置かない。空は 4 枚の絵を合わせた環境テクスチャ(assets/waterside/prep.py)。"""
import math
import random

import bpy
import numpy as np
from mathutils import Vector
from lib.studio import load_image

CAM = Vector((0, -3.9, 1.97))  # target のカメラ
LENS = 18.0
W, H = 941, 1672
F = LENS / 36 * H
HORIZON, VP_X = 678.0, 501.0  # 目標画像の地平線と、奥行きの消失点。VP_X は手前の板の線の傾きから求めた
TILT = math.atan((H / 2 - HORIZON) / F)
YAW = math.atan((VP_X - W / 2) / F * math.cos(TILT))
LOOK = Vector((-math.sin(YAW) * math.cos(TILT), math.cos(YAW) * math.cos(TILT), -math.sin(TILT)))
ROT = LOOK.to_track_quat('-Z', 'Y')
ZW = -0.85  # 水面の高さ
# 沖側の柱。(足元の画素 u, v、上端の v、太さの画素)。奥ほど細く低い
POSTS_L = ((288, 985, 736, 50), (391, 877, 736, 31), (435, 827, 732, 21), (458, 797, 726, 18), (471, 780, 719, 15))
POSTS_R = ((796, 977, 738, 48), (687, 850, 740, 25), (651, 809, 731, 18), (634, 792, 720, 15))
EDGE_L, EDGE_R = ((240, 1005), (470, 780)), ((857, 1005), (630, 780))  # 桟橋の縁の 2 点(手前、奥の端)
PIER_START = -47.0
BAY_C, BAY_R = (10.0, -2.0), 39.0  # 入り江の円。目標画像の岸の 2 点から求めた
GOLD = (1.0, .62, .3)
ASSETS = None


def ray(px, py):
    return ROT @ Vector(((px - W / 2) / F, (H / 2 - py) / F, -1))


def G(px, py, z):
    """目標画像の画素に写る、高さ z の面の上の点"""
    r = ray(px, py)
    return CAM + r * ((z - CAM.z) / r.z)


def A(px, py, d):
    """目標画像の画素に写り、カメラから +Y に d 離れた点"""
    r = ray(px, py)
    return CAM + r * (d / r.y)


SUN_DIR = ray(665, 654).normalized()


def edge(pair):
    p, q = G(*pair[0], 0), G(*pair[1], 0)
    b = (q.x - p.x) / (q.y - p.y)
    return p.x - b * p.y, b, q.y


_L, _R = edge(EDGE_L), edge(EDGE_R)
PIER_END = _L[2]


def x_left(y):
    return _L[0] + _L[1] * max(y, -4.0)  # カメラより陸の側は同じ幅


def x_right(y):
    return _R[0] + _R[1] * max(y, -4.0)


def link(o):
    bpy.context.scene.collection.objects.link(o)
    return o


def ss(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ---- メッシュ ----
def mesh(name, V, Q, mat, uv=None, smooth=False, tint=None):
    V, Q = np.asarray(V, np.float32).reshape(-1, 3), np.asarray(Q, np.int32).reshape(-1, 4)
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
    if uv is not None:
        me.uv_layers.new(name='UVMap').uv.foreach_set('vector', np.asarray(uv, np.float32)[Q.ravel()].ravel())
    if tint is not None:
        a = me.color_attributes.new('tint', 'FLOAT_COLOR', 'POINT')
        c = np.ones((len(V), 4), np.float32)
        c[:, :3] = np.asarray(tint, np.float32).reshape(-1, 1)
        a.data.foreach_set('color', c.ravel())
    me.materials.append(mat)
    return link(bpy.data.objects.new(name, me))


class Bag:
    """同じ材質の部品を 1 つのメッシュにまとめる"""

    def __init__(self):
        self.V, self.Q, self.UV, self.T, self.n = [], [], [], [], 0

    def add(self, V, Q, uv=None, tint=1.0):
        V = np.asarray(V, float).reshape(-1, 3)
        self.V.append(V)
        self.Q.append(np.asarray(Q, int).reshape(-1, 4) + self.n)
        self.UV.append(np.zeros((len(V), 2)) if uv is None else np.asarray(uv, float).reshape(-1, 2))
        self.T.append(np.broadcast_to(tint, len(V)).astype(float))
        self.n += len(V)

    def strip(self, rows, uv=None, tint=1.0, closed=False):
        """rows: (列, 行, 3) の点の並び。隣り合う点を四角形でつなぐ。closed は行の端をつなぐ"""
        rows = np.asarray(rows, float)
        a, b = rows.shape[:2]
        i, j = np.meshgrid(np.arange(a - 1), np.arange(b if closed else b - 1), indexing='ij')
        j2 = (j + 1) % b
        Q = np.stack([i * b + j, i * b + j2, (i + 1) * b + j2, (i + 1) * b + j], -1)
        self.add(rows.reshape(-1, 3), Q, uv, tint)

    def box(self, lo, hi, tex=1.0):
        (x0, y0, z0), (x1, y1, z1) = lo, hi
        V, Q, UV = [], [], []
        faces = [((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)), ((x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0)),
                 ((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)), ((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)),
                 ((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)), ((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1))]
        off = random.random()
        for k, f in enumerate(faces):
            p = np.array(f, float)
            e1, e2 = np.linalg.norm(p[1] - p[0]), np.linalg.norm(p[3] - p[0])
            V += list(p)
            UV += [(off, off), (off + e1 * tex, off), (off + e1 * tex, off + e2 * tex), (off, off + e2 * tex)]
            Q.append((4 * k, 4 * k + 1, 4 * k + 2, 4 * k + 3))
        self.add(V, Q, UV)

    def tube(self, pts, r, sides=8, tex=1.0, flip_uv=False):
        """折れ線に沿う管。r は定数か点ごとの配列"""
        pts = np.asarray(pts, float)
        r = np.broadcast_to(np.asarray(r, float), len(pts))
        d = np.gradient(pts, axis=0)
        d /= np.linalg.norm(d, axis=1, keepdims=True) + 1e-9
        ref = np.where(np.abs(d[:, 2:3]) > .9, [[1.0, 0, 0]], [[0, 0, 1.0]])
        a = np.cross(d, ref)
        a /= np.linalg.norm(a, axis=1, keepdims=True)
        b = np.cross(d, a)
        ang = np.arange(sides + 1) * math.tau / sides
        rows = pts[:, None] + r[:, None, None] * (np.cos(ang)[None, :, None] * a[:, None] + np.sin(ang)[None, :, None] * b[:, None])
        s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
        u, v = np.meshgrid(ang / math.tau, s * tex, indexing='xy')
        uv = np.stack([v, u] if flip_uv else [u, v], -1)
        self.strip(rows, uv)

    def obj(self, name, mat, smooth=False):
        t = np.concatenate(self.T)
        return mesh(name, np.concatenate(self.V), np.concatenate(self.Q), mat, np.concatenate(self.UV), smooth, t if (t != 1).any() else None)


# ---- シェーダー ----
class Sh:
    def __init__(self, name):
        self.m = bpy.data.materials.new(name)
        self.m.use_nodes = True
        self.t = self.m.node_tree
        self.t.nodes.clear()
        self.out = self.t.nodes.new('ShaderNodeOutputMaterial')
        self.m.cycles.emission_sampling = 'NONE'

    def n(self, kind, *inp, **named):
        """kind のノードを作る。inp は入力の順に、ソケットか値"""
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
        n = self.n('Math', a, b, operation=op, use_clamp=clamp)
        return n.outputs[0]

    def done(self, shader):
        self.t.links.new(shader, self.out.inputs[0])
        return self.m


def img(name, data=False):
    return load_image(ASSETS / name, data)


def gloss_wood(name, image, tone=1.0, rough=.5, bump=.35, hue=(1, 1, 1)):
    """UV で貼る木。tint は板ごとの濃さ"""
    s = Sh(name)
    uv = s.n('TexCoord').outputs['UV']
    c = s.tex(image, uv)
    b = s.n('Bump', Strength=bump, Distance=.02, Height=c[0])
    col = s.n('VectorMath', c[0], tuple(q * tone for q in hue), operation='MULTIPLY').outputs[0]
    return s.done(s.n('BsdfPrincipled', Base_Color=col, Roughness=rough, Normal=b.outputs[0]).outputs[0])


def deck_mat():
    """甲板。乾いた所は灰褐色、濡れた所は暗い。太陽の下の線に沿う濡れた帯だけ鏡面が強く、木目の法線と高さが反射を割る"""
    s = Sh('Deck')
    uv = s.n('TexCoord').outputs['UV']
    c = s.tex('wood_albedo.png', uv, ext='MIRROR')  # 折り返しで貼り付けの境を出さない
    h = s.tex('wood_height.png', uv, True, 'MIRROR')
    fine = s.tex('wood_height.png', s.n('Mapping', uv, Scale=(3.1, 2.3, 1), Location=(.37, .21, 0)).outputs[0], True, 'MIRROR')
    pos = s.n('NewGeometry').outputs['Position']
    wet = s.tex('wood_wet_soft.png', s.n('Mapping', pos, Scale=(.13, .13, .13)).outputs[0], True, 'MIRROR')[0]
    wet = s.n('MapRange', wet, .3, .68, 0.0, 1.0, clamp=True).outputs[0]
    blot = s.tex('wood_wet.png', s.n('Mapping', pos, Scale=(.5, 1.6, 1)).outputs[0], True, 'MIRROR')[0]
    t = s.n('Attribute', attribute_name='tint').outputs['Color']
    cracks = s.n('MapRange', h[0], .2, .55, .42, 1.0, clamp=True).outputs[0]  # 木目の溝を暗くする
    grey = s.n('RGBToBW', c[0]).outputs[0]
    dry = s.mix(.42, c[0], grey)
    dry = s.mix(.45, dry, (.33, .3, .27))  # 木肌の濃淡は目標より強くしない
    base = s.n('VectorMath', dry, (1.66, 1.46, .96), operation='MULTIPLY').outputs[0]
    base = s.n('VectorMath', base, t, operation='MULTIPLY').outputs[0]
    base = s.n('VectorMath', base, cracks, operation='MULTIPLY').outputs[0]
    base = s.mix(s.math('MULTIPLY', wet, .7), base, (.42, .3, .25), 'MULTIPLY')
    rough = s.n('MapRange', wet, 0.0, 1.0, .6, .28).outputs[0]
    height_ = s.math('ADD', h[0], s.math('MULTIPLY', fine[0], .35))
    grain = s.n('Bump', Strength=1.0, Distance=.016, Height=height_).outputs[0]
    p = s.n('BsdfPrincipled', Base_Color=base, Roughness=rough, Specular_IOR_Level=.24, Normal=grain,
            Coat_Weight=s.n('MapRange', wet, 0.0, 1.0, .1, .6).outputs[0], Coat_Roughness=.2, Coat_Normal=grain).outputs[0]
    # 濡れた板の太陽の光の道。水面の太陽の筋と同じ考えで、視線の方位が太陽の方位に近いほど光る。
    # 方位を木目の法線でずらすので反射は細かく割れ、太陽を背にした視線では出ない。ランプは使わない
    geo = s.n('NewGeometry').outputs
    I = s.n('SeparateXYZ', geo['Incoming']).outputs
    Nn = s.n('SeparateXYZ', grain).outputs
    vx = s.math('ADD', s.math('MULTIPLY', I['X'], -1), s.math('MULTIPLY', Nn['X'], .1))
    vx = s.math('SUBTRACT', vx, s.math('MULTIPLY', I['Z'], .05))  # 真下へ近づくほど筋が左へ倒れるので戻す
    vy = s.math('ADD', s.math('MULTIPLY', I['Y'], -1), s.math('MULTIPLY', Nn['Y'], .1))
    v = s.n('CombineXYZ', vx, vy, 0.0).outputs[0]
    v = s.n('VectorMath', v, operation='NORMALIZE').outputs[0]
    sd = Vector((SUN_DIR.x, SUN_DIR.y, 0)).normalized()
    c = s.n('VectorMath', v, tuple(sd), operation='DOT_PRODUCT').outputs['Value']
    lobe = s.math('POWER', s.math('MAXIMUM', c, 0.0), 750.0)
    ridge = s.n('MapRange', height_, .35, .75, .3, 1.0, clamp=True).outputs[0]  # 木目の高い所だけ濡れて光る
    patch = s.n('MapRange', blot, .15, .55, .25, 1.0, clamp=True).outputs[0]
    # 見下ろすほど強い。低い視線は水面のように白く飛ぶので抑える
    power = s.n('MapRange', I['Z'], .1, .3, .25, 2.1, clamp=True).outputs[0]
    glow = s.math('MULTIPLY', s.math('MULTIPLY', lobe, power), s.math('MULTIPLY', ridge, patch))
    e = s.n('Emission', (1, .46, .17), glow).outputs[0]
    return s.done(s.n('AddShader', p, e).outputs[0])


def scroll(mapping, speed, last):
    """mapping の位置を一定の速さで動かす。speed は 1 コマあたりの移動量"""
    sock = mapping.inputs['Location']
    sock.default_value = (0, 0, 0)
    sock.keyframe_insert('default_value', frame=1)
    sock.default_value = (speed[0] * last, speed[1] * last, 0)
    sock.keyframe_insert('default_value', frame=1 + last)
    sock.default_value = (0, 0, 0)


def water_mat(last, fps):
    """映り込みは強い波の法線、水の中が見える屈折は弱い波の法線で分け、海底が崩れないようにする"""
    s = Sh('Water')
    pos = s.n('NewGeometry').outputs['Position']
    h = None
    # (x の倍率, y の倍率, 向き, 速さ m/秒, 重み)。4 番目の層は横に長い遠くの波
    for sx, sy, ang, sp, wt in ((.11, .11, 18, (.13, .07), .5), (.31, .31, -33, (-.2, .15), .32), (.031, .031, 40, (.05, .03), .3), (.03, .34, 2, (.0, .1), .3), (.95, .95, 60, (.3, -.2), .07)):
        mp = s.n('Mapping', pos, Scale=(sx, sy, 1), Rotation=(0, 0, math.radians(ang)))
        scroll(mp, (sp[0] * sx / fps, sp[1] * sy / fps), last)
        t = s.tex('water_tile.png', mp.outputs[0], True)[0]
        t = s.math('MULTIPLY', t, wt)
        h = t if h is None else s.math('ADD', h, t)
    strong = s.n('Bump', Strength=1.0, Distance=.03, Height=h).outputs[0]
    weak = s.n('Bump', Strength=1.0, Distance=.005, Height=h).outputs[0]
    fres = s.n('Fresnel', 1.55, Normal=strong).outputs[0]
    ref = s.n('BsdfRefraction', (.93, 1, .97), 0.0, 1.33, Normal=weak).outputs[0]
    glo = s.n('BsdfGlossy', (1.12, 1.12, 1.14), 0.0, Normal=strong).outputs[0]
    return s.done(s.n('MixShader', fres, ref, glo).outputs[0])


def ground_mat(last, fps):
    """砂浜と海底。海底は水を通して見えるので、海底の絵、水の色、光の線を自己発光で作り、光線の数を増やさない"""
    s = Sh('Ground')
    pos = s.n('NewGeometry').outputs['Position']
    sep = s.n('SeparateXYZ', pos).outputs
    fine = s.tex('seabed.png', s.n('Mapping', pos, Scale=(.16, .16, 1)).outputs[0], ext='MIRROR')[0]
    wide = s.tex('seabed_map.png', s.n('Mapping', pos, Scale=(.03, .03, 1), Location=(.3, .15, 0)).outputs[0], ext='MIRROR')[0]
    wide = s.mix(.5, wide, (.85, .8, .7))  # 岩は明るい面の上の濃淡にする
    sand = s.mix(1.0, wide, fine, 'MULTIPLY')
    sand = s.n('VectorMath', sand, (1.5, 1.5, 1.5), operation='MULTIPLY').outputs[0]
    beach = s.tex('beach.png', s.n('Mapping', pos, Scale=(.09, .09, 1)).outputs[0], ext='MIRROR')[0]
    # 水の色: 浅いほど明るい青緑、深いほど暗い
    depth = s.n('MapRange', sep['Z'], ZW - .5, ZW - 2.9, 0, 1, clamp=True).outputs[0]
    deep = s.n('MapRange', sep['Z'], ZW - 2.2, ZW - 9, 0, 1, clamp=True).outputs[0]
    shore = s.n('MapRange', sep['Z'], ZW - .02, ZW - .55, 0, 1, clamp=True).outputs[0]
    tint = s.mix(depth, (.2, .7, .72), (.005, .2, .34))
    tint = s.mix(deep, tint, (.012, .1, .15))
    c = None
    for sc, ang, sp, wt in ((.17, 12, (.16, .09), .9), (.11, -28, (-.12, .1), .7)):
        mp = s.n('Mapping', pos, Scale=(sc, sc, 1), Rotation=(0, 0, math.radians(ang)))
        scroll(mp, (sp[0] * sc / fps, sp[1] * sc / fps), last)
        t = s.math('MULTIPLY', s.tex('caustics_tile.png', mp.outputs[0], True)[0], wt)
        c = t if c is None else s.math('ADD', c, t)
    c = s.n('MapRange', c, .16, .55, 0, 1, clamp=True).outputs[0]
    c = s.math('MULTIPLY', c, s.n('MapRange', sep['Z'], ZW - 2.6, ZW - 4.5, 1, 0, clamp=True).outputs[0])
    vary = s.tex('wood_wet_soft.png', s.n('Mapping', pos, Scale=(.09, .09, 1)).outputs[0], True, 'MIRROR')[0]
    c = s.math('MULTIPLY', c, s.n('MapRange', vary, .3, .7, .2, 1.3, clamp=True).outputs[0])  # 線に濃淡を付ける
    wet = s.mix(shore, (.95, .85, .7), tint)
    under = s.mix(1.0, sand, wet, 'MULTIPLY')
    glint = s.mix(c, under, (2.2, 1.75, 1.0), 'ADD')  # 光の線は明るく、少し金色
    glow = s.n('Emission', glint, .9).outputs[0]
    # 陸: 海から上がるほど乾き、茂みの奥は葉の色
    wet_sand = s.n('MapRange', sep['Z'], ZW + .05, ZW + .3, 0, 1, clamp=True).outputs[0]
    dry = s.n('BsdfDiffuse', s.mix(wet_sand, (.42, .33, .24), beach)).outputs[0]
    leaf = s.tex('palm_leaf.png', s.n('Mapping', pos, Scale=(.4, .4, 1)).outputs[0], ext='MIRROR')[0]
    green = s.n('BsdfDiffuse', s.mix(.8, leaf, (.05, .05, .02))).outputs[0]
    land = s.n('MixShader', s.n('MapRange', sep['Z'], .8, 1.5, 0, 1, clamp=True).outputs[0], dry, green).outputs[0]
    f = s.n('MapRange', sep['Z'], ZW - .01, ZW + .02, 0, 1, clamp=True).outputs[0]
    return s.done(s.n('MixShader', f, glow, land).outputs[0])


def card_mat(name, image, k, lift, ext='EXTEND'):
    """遠景の板。絵の色を自己発光で見せ、透明の所は抜く"""
    s = Sh(name)
    t = s.tex(image, None, ext=ext)
    t[0].node.image.alpha_mode = 'STRAIGHT'
    e = s.n('Emission', s.mix(lift[0], t[0], lift[1]), k).outputs[0]
    tr = s.n('BsdfTransparent').outputs[0]
    return s.done(s.n('MixShader', t[1], tr, e).outputs[0])


def leaf_mat(name, image, hue=(1, 1, 1), trans=.55, rim=.12):
    s = Sh(name)
    c = s.tex(image, s.n('TexCoord').outputs['UV'])[0]
    c = s.mix(1.0, c, hue, 'MULTIPLY')
    d = s.n('BsdfDiffuse', c).outputs[0]
    t = s.n('BsdfTranslucent', s.mix(.5, c, (.8, .6, .1))).outputs[0]
    g = s.n('BsdfGlossy', (1, .72, .42), .3).outputs[0]
    mx = s.n('MixShader', trans, d, t).outputs[0]
    return s.done(s.n('MixShader', rim, mx, g).outputs[0])


def curtain_mat():
    s = Sh('Curtain')
    c = s.tex('linen.png', s.n('TexCoord').outputs['UV'])[0]
    c = s.mix(.8, c, (1, .84, .74))
    d = s.n('BsdfDiffuse', c).outputs[0]
    t = s.n('BsdfTranslucent', c).outputs[0]
    mx = s.n('MixShader', .55, d, t).outputs[0]
    mx = s.n('AddShader', mx, s.n('Emission', (1, .8, .68), .3).outputs[0]).outputs[0]  # 薄い布は夕方の空の光を透かす
    tr = s.n('BsdfTransparent').outputs[0]
    return s.done(s.n('MixShader', .3, mx, tr).outputs[0])


def glass_mat():
    s = Sh('LanternGlass')
    g = s.n('BsdfGlossy', (1, 1, 1), .05).outputs[0]
    t = s.n('BsdfTransparent', (.98, .9, .78)).outputs[0]
    return s.done(s.n('MixShader', .16, t, g).outputs[0])


# ---- 地面と水 ----
def shore_s(x, y):
    """岸からの距離(陸が正)。入り江の円の外が陸で、沖に開いた向きでは岸が遠ざかる"""
    dx, dy = x - BAY_C[0], y - BAY_C[1]
    r = np.hypot(dx, dy)
    a = np.degrees(np.arctan2(dy, dx)) % 360  # 0 が +X、90 が +Y
    # 126 度(岬の先)から左、後ろを回り 325 度までが陸
    open_a = ss(112, 128, a) * (1 - ss(318, 338, a))
    spit = 3.5 * np.exp(-((a - 140) / 12) ** 2)  # ヤシの立つ岬
    return r - (BAY_R - spit + (1 - open_a) * 900)


def height(x, y):
    s = shore_s(x, y)
    r = np.hypot(x, y)
    bumps = .22 * np.sin(x * .13 + 1.3) * np.sin(y * .17 + .4) + .1 * np.sin(x * .41 + y * .23)
    # 桟橋の手前は砂の浅瀬で、沖へ行くほど深い
    shelf = .9 + 2.4 * ss(1, 15, y)
    sea = ZW - np.minimum(.085 * -s, shelf) - .07 * np.maximum(r - 62, 0) * (1 - ss(-40, -8, s)) + bumps * ss(-3, -14, s) * .45
    roll = .35 * np.sin(x * .11 + 2) * np.sin(y * .09) * ss(10, 20, s)  # 陸の起伏
    land = np.minimum(ZW + .22 * s, .45 + .02 * s) + .1 * np.maximum(s - 14, 0) + roll
    return np.where(s > 0, np.minimum(land, 3.0), sea)


def ground(mat):
    rs = np.concatenate([np.linspace(0, 90, 170)[:-1], 90 + (np.linspace(0, 1, 50) ** 2) * 860])
    n = 720
    a = np.linspace(0, math.tau, n, endpoint=False)
    x = np.outer(rs, np.cos(a))
    y = np.outer(rs, np.sin(a))
    z = height(x, y)
    b = Bag()
    b.strip(np.stack([x, y, z], -1), closed=True)
    o = b.obj('Ground', mat, True)
    return o


def water(mat):
    r = 960
    o = mesh('Water', [(-r, -r, ZW), (r, -r, ZW), (r, r, ZW), (-r, r, ZW)], [(0, 1, 2, 3)], mat)
    o.visible_shadow = False
    return o


def world():
    w = bpy.data.worlds.new('Sunset')
    w.use_nodes = True
    nt = w.node_tree
    bg = next(x for x in nt.nodes if x.type == 'BACKGROUND')
    e = nt.nodes.new('ShaderNodeTexEnvironment')
    e.image = img('sky_env.png')
    e.interpolation = 'Cubic'
    nt.links.new(e.outputs[0], bg.inputs[0])
    bg.inputs[1].default_value = 1.0
    bpy.context.scene.world = w
    w.cycles.sample_map_resolution = 2048


def sun():
    # 目に見える太陽は地平線の円盤。甲板の光は少し高い Sun ランプで作る
    d = SUN_DIR * 900
    a = d.normalized()
    r = 11.0
    ta = a.cross(Vector((0, 0, 1))).normalized()
    tb = ta.cross(a)
    n = 48
    rim = [d + (ta * math.cos(i * math.tau / n) + tb * math.sin(i * math.tau / n)) * r for i in range(n)]
    me = bpy.data.meshes.new('SunDisc')
    me.from_pydata([d] + rim, [], [(0, 1 + i, 1 + (i + 1) % n) for i in range(n)])
    s = Sh('SunDisc')
    me.materials.append(s.done(s.n('Emission', (1, .78, .42), 14).outputs[0]))
    o = link(bpy.data.objects.new('SunDisc', me))
    o.visible_shadow = o.visible_diffuse = False
    # 甲板の影を作る光。逆光で、影は手前へまっすぐ伸びる
    l = bpy.data.lights.new('Sun', 'SUN')
    l.energy, l.angle, l.color = 1.9, math.radians(.4), (1, .58, .32)
    lo = link(bpy.data.objects.new('Sun', l))
    k = ray(790, 640)
    lo.rotation_euler = Vector((k.x, k.y, .44 * math.hypot(k.x, k.y))).normalized().to_track_quat('Z', 'Y').to_euler()
    lo.visible_glossy = False
    # 遠い水に映る細い太陽の筋。太陽の方位に立てた帯で、カメラには写らず映り込みだけに出る
    rows, uv = [], []
    for j in range(9):
        t = j / 8
        el = math.radians(8 * t)
        p = (a * math.cos(el) + Vector((0, 0, math.sin(el)))) * 880
        hw = ta * (6 + 5 * t)
        rows.append([tuple(p - hw), tuple(p + hw)])
        uv.append([(0, t), (1, t)])
    gb = Bag()
    gb.strip(rows, uv)
    gs = Sh('SunGlint')
    f = gs.n('MapRange', gs.n('SeparateXYZ', gs.n('TexCoord').outputs['UV']).outputs['Y'], 0, 1, 9.0, 4.0).outputs[0]
    go = gb.obj('SunGlint', gs.done(gs.n('Emission', (1, .6, .28), f).outputs[0]))
    go.visible_camera = go.visible_shadow = go.visible_diffuse = go.visible_transmission = False
    # 岸を照らす光。東屋の影に入る砂と茂みに、夕方の空の明るさを足す
    sp = bpy.data.lights.new('Shore', 'SPOT')
    sp.energy, sp.color, sp.spot_size, sp.spot_blend, sp.shadow_soft_size = 5000, (1, .78, .5), math.radians(34), .6, 2.0
    spo = link(bpy.data.objects.new('Shore', sp))
    spo.location = (-13, 12, 8)
    spo.rotation_euler = (Vector((-20, 32, .5)) - spo.location).to_track_quat('-Z', 'Y').to_euler()
    spo.visible_glossy = False
    # 顔の側の空の明るさを足す広い面光。水面には映さない
    f = bpy.data.lights.new('Fill', 'AREA')
    f.shape, f.size, f.size_y = 'RECTANGLE', 9, 5
    f.energy, f.color = 200, (1, .78, .62)
    fo = link(bpy.data.objects.new('Fill', f))
    fo.location = (0, -8, 3.4)
    fo.rotation_euler = (Vector((0, 8, -2.4))).to_track_quat('-Z', 'Y').to_euler()
    fo.visible_glossy = False


def islands():
    """遠い島と山の板。位置は目標画像の画素から決める"""
    d = 780.0
    for image, name, u0, u1, v_top, mix_, hue in (('hill_a', 'hill', 208, 352, 618, .55, (.11, .07, .09)), ('hill_a', 'ridge', 322, 424, 656, .6, (.1, .06, .08)),
                                                  ('island_b', 'centre', 450, 577, 652, .75, (.07, .04, .06)), ('island_d', 'east', 692, 778, 663, .75, (.07, .04, .06)),
                                                  ('island_b', 'far', 825, 873, 665, .75, (.07, .04, .06))):
        p0, p1 = A(u0, HORIZON, d), A(u1, HORIZON, d)
        top = A(u0, v_top, d).z
        q = [(p0.x, p0.y, ZW - 2), (p1.x, p1.y, ZW - 2), (p1.x, p1.y, top), (p0.x, p0.y, top)]
        o = mesh(name, q, [(0, 1, 2, 3)], card_mat(name, image + '.png', .8, (mix_, hue)), [(0, 0), (1, 0), (1, 1), (0, 1)])
        o.visible_shadow = o.visible_diffuse = o.visible_glossy = False


def jungle():
    """陸の奥の森の板。入り江の円に沿わせて岬から後ろへ回す"""
    b = Bag()
    n = 90
    rows, uv = [], []
    for i in range(n + 1):
        t = i / n
        a = math.radians(152 + 176 * t)
        r = BAY_R + 34 + 8 * math.sin(t * 7)
        x, y = BAY_C[0] + r * math.cos(a), BAY_C[1] + r * math.sin(a)
        rows.append([(x, y, -1), (x, y, 3 + 22 * float(ss(0, .15, t) * ss(0, .1, 1 - t)))])
        uv.append([(t * 2, 0), (t * 2, 1)])
    b.strip(rows, uv)
    b.obj('Jungle', card_mat('Jungle', 'jungle_a.png', .75, (.16, (.5, .3, .42)), 'REPEAT')).visible_shadow = False
    # 目標の左の暗い森の塊
    d = 64.0
    b = Bag()
    rows, uv = [], []
    for i in range(61):
        t = i / 60
        u = -320 + 495 * t
        v = 440 + 16 * math.sin(u * .19) + 10 * math.sin(u * .43) + 145 * float(ss(90, 175, u)) + 200 * float(1 - ss(-320, -180, u))  # 両端は低くして、横の視点で板の縁を見せない
        bot, top_ = A(u, HORIZON + 60, d), A(u, v, d)
        rows.append([tuple(bot), tuple(top_)])
        uv.append([(t * .7, .1), (t * .7, .1 + .5 * (1 - .5 * float(ss(70, 170, u))))])
    b.strip(rows, uv)
    b.obj('Forest', card_mat('Forest', 'jungle_a.png', .55, (.18, (.07, .04, .018)), 'REPEAT')).visible_shadow = False


# ---- 桟橋 ----
def planks(b, x0, x1, y0, y1, seed, lo=.3, hi=.52, fix=()):
    """幅の違う板を y の方向に敷く。木目は x の向き。板は上面だけで、縁を少し不揃いにする。隙間の下は黒い板(呼ぶ側で置く)。
    x0, x1 は y から端の x を返す"""
    r = random.Random(seed)
    y = y0
    across = (.0, .03, .1, .9, .97, 1.0)
    wear = (.45, .8, 1, 1, .8, .45)  # 縁は摩耗して少し濃い
    fixed = sorted(G(470, v, 0).y for v in fix)  # 目標の継ぎ目の高さに板の境を合わせる
    while y < y1:
        w = min(r.uniform(lo, hi), y1 - y)
        near = [q for q in fixed if y + .18 < q < y + w + .2]
        if near:
            w = near[0] - y
        gap = r.uniform(.012, .024)
        mid = y + w / 2
        a, e = x0(mid) + r.uniform(-.015, .015), x1(mid) + r.uniform(-.015, .015)
        xs = np.linspace(a, e, 25)
        ph = [r.uniform(0, 6.28) for _ in range(5)]
        rows, uv, tint = [], [], []
        u0, v0, fl = r.uniform(0, 3), r.uniform(0, .45), r.choice([-1, 1])
        us, vs = r.uniform(2.6, 4.0), r.uniform(.3, .5)  # 板ごとに木目の太さが違う。節が等間隔に並ばない長さ
        tone = r.uniform(.6, 1.05)
        tilt = r.uniform(-.006, .006)
        for i, x in enumerate(xs):
            jit0 = .01 * math.sin(x * 1.3 + ph[0]) + .007 * math.sin(x * 5 + ph[1]) + .004 * math.sin(x * 17 + ph[2])
            jit1 = .01 * math.sin(x * 1.7 + ph[2]) + .007 * math.sin(x * 6 + ph[3]) + .004 * math.sin(x * 19 + ph[0])
            warp = .004 * math.sin(x * 1.3 + ph[4])
            row, ruv = [], []
            for f in across:
                yy = y + jit0 * (1 - f) + (w - gap + jit1) * f
                row.append((x, yy, warp + tilt * (yy - mid) - .014 * abs(2 * f - 1) ** 4))
                ruv.append(((x - a) / us + u0, v0 + (f if fl > 0 else 1 - f) * vs))
            rows.append(row)
            uv.append(ruv)
            tint.append(tuple(q * tone for q in wear))
        b.strip(rows, uv, np.array(tint).ravel())
        y += w


def post_rows(x, y, z0, z1, seed, r0=.19):
    """古い丸柱の点の並び。割れの溝があり、上は朽ちて丸い"""
    rr = random.Random(seed)
    zs = list(np.linspace(z0, z1 - .1, 18)) + [z1 - .07, z1 - .04, z1 - .015, z1]
    k = [1.0] * 18 + [.96, .84, .55, .001]
    n = 32
    ph = [rr.uniform(0, 6.28) for _ in range(3)]
    grooves = [(rr.uniform(0, 6.28), rr.uniform(.04, .09), rr.uniform(10, 18)) for _ in range(5)]
    rows, uv = [], []
    for z, s in zip(zs, k):
        row = []
        for j in range(n + 1):
            a = j / n * math.tau
            w = 1 + .06 * math.sin(a * 3 + ph[0]) + .04 * math.sin(a * 7 + ph[1] + z) + .04 * math.sin(z * 2 + ph[2])
            for g, depth, sharp in grooves:
                w -= depth * max(0, math.cos(a - g + .12 * math.sin(z * 3))) ** (sharp * 4)
            row.append((x + r0 * w * s * math.cos(a), y + r0 * w * s * math.sin(a), z + (z1 - z0 > 1) * .012 * (s < .9) * math.sin(a * 4 + ph[1])))
        rows.append(row)
        uv.append([(j / n * 1.0 + ph[0], z * .55) for j in range(n + 1)])
    return rows, uv


def rope_path(a, b, sag, n):
    a, b = np.asarray(a, float), np.asarray(b, float)
    t = np.linspace(0, 1, n)[:, None]
    p = a + (b - a) * t
    p[:, 2] -= sag * 4 * t[:, 0] * (1 - t[:, 0])
    return p


def rope(bag, path, r=.044, pitch=.2):
    """3 本の縒りの縄"""
    d = np.gradient(path, axis=0)
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    a = np.cross(d, [[.3, .1, .9]])
    a /= np.linalg.norm(a, axis=1, keepdims=True)
    b = np.cross(d, a)
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])
    for k in range(3):
        ph = s / pitch * math.tau + k * math.tau / 3
        bag.tube(path + r * .55 * (np.cos(ph)[:, None] * a + np.sin(ph)[:, None] * b), r * .55, 6, 2.0, True)


def lantern_mesh(iron, glass, flame):
    """黒い鉄枠の角ランタン。原点は吊り輪"""
    i = Bag()
    w, h, top = .1, .4, .13
    for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        i.tube([(sx * w, sy * w, -h), (sx * w, sy * w, -top)], .012, 6)
    i.box((-w * 1.3, -w * 1.3, -h - .035), (w * 1.3, w * 1.3, -h))
    i.box((-w * 1.15, -w * 1.15, -top - .02), (w * 1.15, w * 1.15, -top))
    rows = [[(sx * w * q, sy * w * q, -top + (1.3 - q) * .13) for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1))] for q in (1.3, .2)]
    i.strip(rows, closed=True)
    a = np.linspace(0, math.tau, 13)
    i.tube(np.stack([.04 * np.cos(a), 0 * a, -.02 + .04 * np.sin(a)], 1), .009, 6)
    g = Bag()
    q = [(-w, -w), (w, -w), (w, w), (-w, w), (-w, -w)]
    for (x0, y0), (x1, y1) in zip(q[:-1], q[1:]):
        g.add([(x0, y0, -h), (x1, y1, -h), (x1, y1, -top), (x0, y0, -top)], [(0, 1, 2, 3)])
    c = Bag()
    c.tube([(0, 0, -h), (0, 0, -.3)], .02, 8)
    return [i.obj('LanternIron', iron), g.obj('LanternGlass', glass), c.obj('LanternFlame', flame)]


def pier(m, last):
    deck = Bag()
    planks(deck, x_left, x_right, PIER_START, PIER_END, 5, fix=(1040, 1095, 1195, 1290, 1390, 1565))
    # 目標の手前左の、板の面に入った幅広の朽ちた 2 本の材
    Q = [G(u, v, .002) for u, v in ((232, 1566), (318, 1566), (388, 1384), (322, 1384))]
    for f0, f1 in ((0, .49), (.51, 1)):
        c = [Q[0].lerp(Q[1], f0), Q[0].lerp(Q[1], f1), Q[3].lerp(Q[2], f1), Q[3].lerp(Q[2], f0)]
        top = [[tuple(c[0].lerp(c[3], t / 12).lerp(c[1].lerp(c[2], t / 12), e / 6) + Vector((.004 * math.sin(t * 2.1 + f0 * 7), 0, 0))) for e in range(7)] for t in range(13)]
        deck.strip(top, [[(t / 12 * .9 + f0 * 2, e / 6 * .3 + .2 + f0) for e in range(7)] for t in range(13)], np.tile((.3, .75, .95, 1, .95, .75, .3), 13))
    deck.obj('Deck', m['deck'])

    beam = Bag()
    st = (PIER_START, -4.0, PIER_END)
    under = Bag()
    under.strip([[(x_left(y), y, -.03), (x_right(y), y, -.03)] for y in st])
    under.obj('DeckUnder', m['gap'])
    for x in (-1.3, -.45, .45, 1.3):
        beam.box((x - .07, PIER_START, -.32), (x + .07, PIER_END, -.09), .6)
    # 縁の板
    beam.strip([[(x_left(y) - .02, y, -.2), (x_left(y) - .02, y, -.03)] for y in st], [[(0, y * .4), (.2, y * .4)] for y in st])
    beam.strip([[(x_right(y) + .02, y, -.2), (x_right(y) + .02, y, -.03)] for y in st], [[(0, y * .4), (.2, y * .4)] for y in st])
    beam.box((x_left(PIER_END) - .02, PIER_END, -.2), (x_right(PIER_END) + .02, PIER_END + .05, -.02), .6)

    post = Bag()
    left, right, n = [], [], 0
    for src, out in ((POSTS_L, left), (POSTS_R, right)):
        for u, v, vt, wd in src:
            p = G(u, v, 0)
            d = p.y - CAM.y
            top = A(u, vt, d).z
            rr = wd / 2 * d / F
            r, uv = post_rows(p.x, p.y, ZW - 1.6, top, n, rr)
            post.strip(r, uv)
            out.append((p.x, p.y, top, rr))
            n += 1
    back = [-7.0 - 6.0 * k for k in range(7)]  # 陸の側。カメラの範囲より遠い所から
    for sx, xf, out in ((-1, x_left, left), (1, x_right, right)):
        rail = []
        for y in back:
            x = xf(y) - sx * .22
            r, uv = post_rows(x, y, ZW - 1.6, 1.4, n, .17)
            post.strip(r, uv)
            rail.append((x, y, 1.4, .17))
            n += 1
        out.append(None)
        out += rail
    for y in (-4.0, -1.1):  # カメラの範囲は甲板の下だけの杭
        for xf, sx in ((x_left, -1), (x_right, 1)):
            r, uv = post_rows(xf(y) - sx * .22, y, ZW - 1.6, -.1, n, .17)
            post.strip(r, uv)
            n += 1
    for y in [p[1] for p in left if p] + [-4.0, -1.1]:  # 横の梁。目標と同じく甲板の縁から張り出す
        beam.box((x_left(y) - .17, y - .1, -.17), (x_right(y) + .17, y + .1, -.035), .6)
        beam.box((x_left(y), y - .08, -.45), (x_right(y), y + .08, -.32), .6)
        post.tube([(x_left(y) + .2, y, -.34), (x_right(y) - .2, y, ZW - .1)], .05, 6, .55)
        post.tube([(x_right(y) - .2, y, -.34), (x_left(y) + .2, y, ZW - .1)], .05, 6, .55)
    # 右の手前の柱から沖の係留杭へ伸びる縄。杭はカメラの範囲の外
    pile = (3.9, 1.5, .85)
    r, uv = post_rows(pile[0], pile[1], ZW - 1.6, pile[2], n, .17)
    post.strip(r, uv)
    post.obj('Posts', m['post'], True)
    beam.obj('Beams', m['beam'])

    # 縄。柱ごとに 1 巻きして次の柱へ渡す。ランタンは縄から吊る
    rb, iron = Bag(), Bag()
    hooks = []
    for col, ts in ((left, (.22, .38, 0, 0)), (right, (.27, .42, 0))):
        for i, (pa, pb) in enumerate(zip(col[:-1], col[1:])):
            if pa is None or pb is None:
                continue
            za, zb = pa[2] - .2, pb[2] - .2
            sag = .25 * math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / 3.2
            path = rope_path((pa[0], pa[1], za), (pb[0], pb[1], zb), sag, 90)
            rope(rb, path)
            t = ts[i] if i < len(ts) else (.5 if (i % 2) else 0)
            if t:
                hooks.append(tuple(path[int(t * 89)]))
        for p in col:
            if p is None:
                continue
            a = np.linspace(0, math.tau, 50)
            rope(rb, np.stack([p[0] + (p[3] + .004) * np.cos(a), p[1] + (p[3] + .004) * np.sin(a), p[2] - .2 + 0 * a], 1), .02, .1)
    p0 = right[0]
    rope(rb, rope_path((p0[0], p0[1], p0[2] - .2), pile, .14, 110))
    rb.obj('Rope', m['rope'], True)

    # 吊りランタン
    parts = lantern_mesh(m['nail'], m['glass'], m['flame'])
    objs = []
    for i, h in enumerate(hooks):
        root = link(bpy.data.objects.new(f'Lantern{i}', None))
        root.location = (h[0], h[1], h[2] - .05)
        for p in parts:
            o = link(bpy.data.objects.new(f'{p.name}.{i}', p.data))
            o.parent = root
        objs.append(root)
    for p in parts:
        bpy.data.objects.remove(p)

    # 釘: 板の端に平らな暗い頭
    nail = Bag()
    r = random.Random(3)
    y = PIER_START
    while y < PIER_END:
        y += r.uniform(.3, .5)
        for x in (x_left(y) + .1 + r.uniform(0, .05), x_right(y) - .1 - r.uniform(0, .05)):
            for dy in (.05, .24):
                a = np.linspace(0, math.tau, 8)[:-1]
                nail.add(np.stack([x + .02 * np.cos(a), y + dy + .02 * np.sin(a), .0035 + 0 * a], 1)[[0, 1, 2, 3, 3, 4, 5, 6]], [(0, 1, 2, 3), (4, 5, 6, 7)])

    for u, v in ((95, 1240), (15, 1330), (60, 1270), (230, 1210), (300, 1300), (150, 1345), (40, 1400), (280, 1200)):
        c = G(u, v, 0)
        a = np.linspace(0, math.tau, 8)[:-1]
        nail.add(np.stack([c.x + .024 * np.cos(a), c.y + .024 * np.sin(a), .0035 + 0 * a], 1)[[0, 1, 2, 3, 3, 4, 5, 6]], [(0, 1, 2, 3), (4, 5, 6, 7)])
    nail.obj('Nails', m['nail'])

    # 深い節の穴。位置は目標画像の画素と、桟橋全体へ散らした分
    knot = Bag()
    spots = [G(u, v, 0) for u, v in ((215, 1140), (525, 1250), (175, 1468), (370, 1645))]
    for c in spots:
        sx, sy = r.uniform(.12, .15), r.uniform(.05, .06)
        knot.add([(c.x - sx, c.y - sy, .006), (c.x + sx, c.y - sy, .006), (c.x + sx, c.y + sy, .006), (c.x - sx, c.y + sy, .006)], [(0, 1, 2, 3)], [(0, 0), (1, 0), (1, 1), (0, 1)])
    knot.obj('Knots', m['knot'])
    return objs


def slab(b, q, z0, z1, tex=.5):
    """四隅 q(xy)の厚い板"""
    rows = [[(x, y, z0) for x, y in q], [(x, y, z1) for x, y in q]]
    b.strip(rows, [[(0, 0), (tex, 0), (0, 0), (tex, 0)], [(0, .2), (tex, .2), (0, .2), (tex, .2)]], closed=True)
    b.add(rows[-1], [(0, 1, 2, 3)], [(0, 0), (tex, 0), (tex, tex), (0, tex)])


def roof(b, q, eave, apex, over):
    """四隅 q の四角い葺き屋根。軒は葺きの端が波打つ"""
    c = (sum(x for x, _ in q) / 4, sum(y for _, y in q) / 4)
    big = [(c[0] + (x - c[0]) * over, c[1] + (y - c[1]) * over) for x, y in q]
    for k in range(4):
        (x0, y0), (x1, y1) = big[k], big[(k + 1) % 4]
        rows, uv = [], []
        for j in range(31):
            t = j / 30
            row, ruv = [], []
            for i in range(25):
                f = i / 24
                x, y = x0 + (x1 - x0) * f, y0 + (y1 - y0) * f
                z = eave + (apex - eave) * t ** 1.15 + .05 * math.sin(f * 40) * (1 - t) - .05 * ((t * 7) % 1) * (1 - t)  # 葺きの段
                row.append((x + (c[0] - x) * t, y + (c[1] - y) * t, z))
                ruv.append((f * 1.4 + k * .3, t * .9))
            rows.append(row)
            uv.append(ruv)
        b.strip(rows, uv)


def curtain_mesh(name, p0, p1, z_top, z_bot, pull, mat, seed, blow=(0, 0)):
    """上辺が p0 から p1 で、布は p0 の柱へ束ねる。pull は束ねる高さ(0..1)。blow は裾が風で流れる向きと量"""
    r = random.Random(seed)
    nu, nv = 44, 34
    p0, p1 = np.array(p0, float), np.array(p1, float)
    side = p1 - p0
    width = np.linalg.norm(side)
    tang = side / width
    nor = np.array((tang[1], -tang[0]))
    blow = np.array(blow, float)
    UV = []
    ph = r.uniform(0, 6.28)
    base, wa, wb = [], [], []
    for j in range(nv + 1):
        t = j / nv
        z = z_top + (z_bot - z_top) * t
        waist = math.exp(-((t - pull) / .2) ** 2)
        above = 1 - min(1, t / pull)  # 束ねる高さより上は幕の形に開く
        below = max(0, (t - pull) / (1 - pull))
        open_w = .2 + .85 * above ** .6 + .5 * below
        for i in range(nu + 1):
            s = i / nu
            pleat = (.05 + .1 * (1 - waist)) * math.sin(s * 30 + ph + t * 2) * s ** .4
            belly = .22 * above * math.sin(s * math.pi) * (1 - above)  # 布の重みの垂れとふくらみ
            pos = p0 + tang * (s * open_w * width) + nor * (pleat + belly) + blow * below ** 2 * (.5 + .5 * s)
            base.append((*pos, z + .5 * np.linalg.norm(blow) * below ** 3 * s))
            UV.append((s * 3, t * 3))
            free = .25 * above + below ** 1.3
            wa.append(nor * free * .34 * math.sin(s * 5 + t * 4) + nor * free * .2)
            wb.append(nor * free * -.22 * math.sin(s * 8 - t * 5 + 1) + tang * free * .2 * math.sin(t * 6))
    Q = [((j) * (nu + 1) + i, j * (nu + 1) + i + 1, (j + 1) * (nu + 1) + i + 1, (j + 1) * (nu + 1) + i) for j in range(nv) for i in range(nu)]
    o = mesh(name, base, Q, mat, UV, True)
    o.shape_key_add(name='Basis')
    arr = np.array(base)
    for nm, d in (('a', wa), ('b', wb)):
        k = o.shape_key_add(name=nm)
        d3 = np.column_stack([np.array(d)[:, 0], np.array(d)[:, 1], np.zeros(len(d))])
        k.data.foreach_set('co', (arr + d3).astype(np.float32).ravel())
    return o


def cabana(m, keys):
    """目標の左の、角をこちらへ向けた開放の四本柱の東屋と、水の上へ伸びる小桟橋。寸法は目標の画素から"""
    floor = .5
    eave, apex = 5.7, 7.35

    def W(u, d):
        p = A(u, HORIZON, d)
        return (p.x, p.y)
    n, r, l = W(168, 33), W(226, 37), W(78, 37.5)
    f = (l[0] + r[0] - n[0], l[1] + r[1] - n[1])
    q = [n, r, f, l]
    x_end = W(360, 30.5)[0]
    yn, yf = CAM.y + 30.5, CAM.y + 41
    deck = Bag()
    fl = lambda y: W(118, 33)[0] + (W(52, 41)[0] - W(118, 33)[0]) * max(0, min(1, (y - yn) / (yf - yn)))
    x_cut = lambda y: W(358, y - CAM.y)[0]  # 目標の右端の画素で切る
    planks(deck, fl, x_cut, yn, yf, 8, .22, .34)
    deck.obj('CabanaDeck', m['deck']).location.z = floor
    under = Bag()
    under.strip([[(fl(y), y, floor - .03), (x_cut(y), y, floor - .03)] for y in (yn, yf)])
    under.strip([[(fl(y), y, floor - .25), (fl(y), y, floor - .03)] for y in (yn, yf)])
    under.strip([[(fl(yn), yn, floor - .25), (x_end, yn, floor - .25)], [(fl(yn), yn, floor - .03), (x_end, yn, floor - .03)]])
    under.obj('CabanaUnder', m['nail'])
    wood, post = Bag(), Bag()
    k = 300
    for u in (302, 325, 353):  # 小桟橋の脚
        for d in (33.5, 39):
            x, y = W(u, d)
            rw, uv = post_rows(x, y, -2.4, floor + (1.3 if d < 35 else 1.0), k, .1)
            post.strip(rw, uv)
            k += 1
    for u in (236, 264, 276, 316):  # 手すりの柱
        x, y = W(u, 33.5)
        rw, uv = post_rows(x, y, floor, floor + 1.3, k, .075)
        post.strip(rw, uv)
        k += 1
    y_r = W(300, 33.5)[1]
    for z in (floor + 1.25, floor + .75):
        post.tube([(W(236, 33.5)[0], y_r, z), (W(353, 33.5)[0], y_r, z)], .04, 6, .55)
    fend = Bag()  # 白い緩衝材
    for u in (210, 255):
        x, y = W(u, 30.3)
        fend.tube(rope_path((x, y, floor - .05), (x, y, -.75), 0, 8), [.03, .08, .11, .12, .12, .11, .08, .03], 10)
    fend.obj('Fenders', m['cushion'], True)
    for u, d in ((60, 41), (120, 41), (180, 41), (120, 34), (180, 34)):
        x, y = W(u, d)
        rw, uv = post_rows(x, y, -2.2, floor, k, .13)
        post.strip(rw, uv)
        k += 1
    pillar = Bag()
    for x, y in q:
        pillar.tube([(x, y, floor), (x, y, eave + .05)], .15, 10, .55)
    for a, b in zip(q, q[1:] + q[:1]):
        pillar.tube([(*a, eave), (*b, eave)], .2, 6, .55)
    pillar.obj('CabanaPillars', m['beam'], True)
    post.obj('CabanaWood', m['post'], True)
    rf = Bag()
    roof(rf, q, eave + .05, apex, 1.36)
    rf.obj('Roof', m['thatch'], True)
    # ベッドと枕
    c = (sum(x for x, _ in q) / 4, sum(y for _, y in q) / 4)
    inner = [(c[0] + (x - c[0]) * .84, c[1] + (y - c[1]) * .84) for x, y in q]
    frame, soft = Bag(), Bag()
    slab(frame, inner, floor, floor + .42)
    slab(soft, [(c[0] + (x - c[0]) * .78, c[1] + (y - c[1]) * .78) for x, y in q], floor + .42, floor + .68, .3)
    plinth = Bag()  # 床の下の木の基壇
    slab(plinth, [(c[0] + (x - c[0]) * 1.1, c[1] + (y - c[1]) * 1.1) for x, y in q], -.2, floor - .02)
    plinth.obj('Plinth', m['post'])
    frame.obj('BedFrame', m['post'])
    back_a, back_b = inner[2], inner[3]
    for t in (.28, .72):
        bx = back_a[0] + (back_b[0] - back_a[0]) * t
        by = back_a[1] + (back_b[1] - back_a[1]) * t
        hw = 1.0
        d = ((back_b[0] - back_a[0]), (back_b[1] - back_a[1]))
        ln = math.hypot(*d)
        d = (d[0] / ln * hw, d[1] / ln * hw)
        toward = ((c[0] - bx) * .4, (c[1] - by) * .4)
        rows = [[(bx - d[0] + toward[0], by - d[1] + toward[1], floor + .7), (bx + d[0] + toward[0], by + d[1] + toward[1], floor + .7)],
                [(bx - d[0], by - d[1], floor + 1.5), (bx + d[0], by + d[1], floor + 1.5)]]
        soft.strip(rows, [[(0, 0), (1, 0)], [(0, 1), (1, 1)]])
    soft.obj('Cushion', m['cushion'], True)
    # 奥は閉じた布
    back_cloth = Bag()
    for a, b in ((q[2], q[1]), (q[2], q[3])):
        for off in (0, .12):
            back_cloth.strip([[(a[0], a[1] + off, floor), (b[0], b[1] + off, floor)], [(a[0], a[1] + off, eave), (b[0], b[1] + off, eave)]], [[(0, 0), (3, 0)], [(0, 3), (3, 3)]])
    back_cloth.obj('BackCloth', gloss_wood('BackCloth', 'linen.png', .3, .9, .1, (1, .78, .62)), True)
    # カーテン。柱ごとに左右へ。布は柱へ束ね、東の角の 1 枚は風で外へ流れる
    for i, (a, b, d) in enumerate(((q[j], q[(j + 1) % 4], q[(j + 3) % 4]) for j in range(4))):
        wind = (3.2, -1.4) if i == 1 else (0, 0)
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        mid2 = ((a[0] + d[0]) / 2, (a[1] + d[1]) / 2)
        keys['curtains'].append(curtain_mesh(f'Curtain{i}a', a, mid, eave - .05, floor + .05, .6, m['curtain'], i * 2, wind))
        keys['curtains'].append(curtain_mesh(f'Curtain{i}b', a, mid2, eave - .05, floor + .05, .55, m['curtain'], i * 2 + 1))
    # 奥の小屋
    hx, hy = W(38, 46)
    hq = [(hx - 2.1, hy - 2.0), (hx + 2.1, hy - 2.0), (hx + 2.1, hy + 2.0), (hx - 2.1, hy + 2.0)]
    hut = Bag()
    for x, y in hq:
        hut.tube([(x, y, .4), (x, y, 5.5)], .12, 8, .55)
    hut.obj('HutWood', m['beam'], True)
    hr = Bag()
    roof(hr, hq, 5.4, 7.0, 1.4)
    hr.obj('HutRoof', m['thatch'], True)


# ---- ヤシと茂み ----
def frond_mesh(name, mat, seed, L=4.3):
    """葉 1 枚。付け根が原点で +X へ伸び、垂れる。小葉は本物の細い面"""
    r = random.Random(seed)
    b = Bag()
    n = 50
    droop = r.uniform(.75, 1.05)
    # 軸の曲線
    S = np.linspace(0, 1, n)
    x = L * (S - .22 * S ** 3)
    z = L * (.3 * S - droop * .55 * S ** 2.4)
    y = .16 * np.sin(S * 3) * r.uniform(-1, 1)
    axis = np.stack([x, y, z], 1)
    b.tube(axis, .022 * (1 - S) + .004, 4, .4)
    tang = np.gradient(axis, axis=0)
    tang /= np.linalg.norm(tang, axis=1, keepdims=True)
    side = np.cross(tang, [[0, 0, 1.0]])
    side /= np.linalg.norm(side, axis=1, keepdims=True)
    up = np.cross(side, tang)
    for i in range(3, n):
        s = S[i]
        ln = 1.05 * math.sin(min(1, s * 1.05) * math.pi * .93 + .1) ** .7 + .12
        for sd in (-1, 1):
            if r.random() < .05:
                continue
            ang = sd * (1.05 - .55 * s) + r.uniform(-.08, .08)
            d0 = side[i] * math.sin(ang) * 1.0 + tang[i] * math.cos(ang)
            hang = r.uniform(.15, .35) + .5 * s
            rows, uv = [], []
            for k in range(5):
                t = k / 4
                q = axis[i] + d0 * ln * t + (up[i] * (.16 * sd * 0 + .14) * t - np.array((0, 0, hang * ln)) * t * t)
                w = .044 * math.sin(min(1, t * 1.1 + .08) * math.pi) ** .6
                rows.append([q - tang[i] * w, q + tang[i] * w])
                u0 = r.random()
                uv.append([(t * .9 + u0, .1), (t * .9 + u0, .16)])
            b.strip(rows, uv)
    return b.obj(name, mat)


def palm(m, base, H_, lean, ax, fronds, keys, seed, hero, size=3.4):
    """base の足元から高さ H_ のヤシ。hero は葉 1 枚ずつ揺らす"""
    r = random.Random(seed)
    t = np.linspace(0, 1, 18)
    x = base[0] + lean * t ** 2.6 * math.cos(ax)
    y = base[1] + lean * t ** 2.6 * math.sin(ax)
    z = base[2] + H_ * t
    rad = .2 * (1 - .45 * t) + .1 * np.exp(-t * 14)
    b = Bag()
    b.tube(np.stack([x, y, z], 1), rad, 10, .4)
    tip = (x[-1], y[-1], z[-1])
    b.obj(f'Trunk{seed}', m['bark'], True)
    crown = link(bpy.data.objects.new(f'Crown{seed}', None))
    crown.location = tip
    n = r.randint(25, 30)
    entries = []
    for i in range(n):
        a = i * 2.39996 + r.uniform(-.2, .2)
        layer = 1 - i / n
        pitch = -math.radians(62 * layer - 12) + r.uniform(-.12, .12)  # 若い葉は上へ
        pivot = link(bpy.data.objects.new(f'Frond{seed}.{i}', fronds[i % len(fronds)].data))
        pivot.parent = crown
        pivot.rotation_euler = (0, pitch, a)
        s = r.uniform(.92, 1.12) * size / 3.4
        pivot.scale = (s, s, s)
        entries.append(pivot)
    keys['crowns'].append((crown, r.uniform(0, 6)))
    if hero:
        keys['fronds'] += [(p, r.uniform(0, 6)) for p in entries]
    return crown


def bush_mesh(name, mat, seed):
    """幅の広い葉の塊。原点の周りに 1 m ほど"""
    r = random.Random(seed)
    b = Bag()
    for _ in range(800):
        c = np.array([r.gauss(0, .55), r.gauss(0, .55), abs(r.gauss(.45, .35))])
        d = np.array([c[0] * .7 + r.uniform(-.6, .6), c[1] * .7 + r.uniform(-.6, .6), r.uniform(-.1, .9)])
        d /= np.linalg.norm(d)
        s = np.cross(d, (0, 0, 1))
        s /= np.linalg.norm(s) + 1e-6
        ln, w = r.uniform(.12, .24), r.uniform(.035, .06)
        rows, uv = [], []
        for k in range(5):
            t = k / 4
            q = c + d * ln * t - np.array((0, 0, .3 * ln)) * t * t
            ww = w * math.sin(min(1, t * .97 + .02) * math.pi) ** .7
            rows.append([q - s * ww, q, q + s * ww])
            uv.append([(.32, .08 + .84 * t), (.5, .08 + .84 * t), (.68, .08 + .84 * t)])
        b.strip(rows, uv)
    return b.obj(name, mat, True)


def rocks(m):
    b = Bag()
    r = random.Random(9)
    # 目標の波打ち際に並ぶ丸い岩(画素、半径)
    spots = [(G(u, v, ZW + .2), q) for u, v, q in ((16, 744, .42), (36, 748, .36), (56, 752, .3), (90, 752, .42), (122, 750, .45), (150, 752, .34), (172, 750, .42), (196, 746, .36), (216, 748, .3))]
    for _ in range(26):
        a = math.radians(r.uniform(132, 325))
        R_ = BAY_R + r.uniform(-1, 3)
        spots.append((Vector((BAY_C[0] + R_ * math.cos(a), BAY_C[1] + R_ * math.sin(a), ZW)), r.uniform(.7, 1.7)))
    for c, q in spots:
        sx, sy, sz = q * r.uniform(1.0, 1.4), q * r.uniform(1.0, 1.4), q * r.uniform(.6, .85)
        c = Vector((c.x, c.y, max(float(height(np.float64(c.x), np.float64(c.y))), ZW) + .4 * q))
        ph = [r.uniform(0, 6.28) for _ in range(4)]
        th = np.linspace(0, math.pi, 12)[:, None]
        ga = np.linspace(0, math.tau, 19)[None, :]
        k = 1 + .12 * np.sin(ga * 3 + ph[0] + th * 2) + .07 * np.sin(ga * 5 + ph[1] + th * 5) + .06 * np.sin(th * 7 + ph[2])
        k[:, -1] = k[:, 0]
        rows = np.stack([c.x + sx * k * np.sin(th) * np.cos(ga), c.y + sy * k * np.sin(th) * np.sin(ga), c.z + sz * k * np.cos(th)], -1)
        uv = np.stack(np.broadcast_arrays(ga / 3, th), -1)
        b.strip(rows, uv)
    b.obj('Rocks', m['rock'], True)


def shore_plants(m, keys):
    fronds = [frond_mesh(f'FrondProto{i}', m['leaf'], i) for i in range(5)]
    protos = [bush_mesh(f'BushProto{i}', m['bush'], 20 + i) for i in range(3)]
    # 目標画像に写るヤシ。(冠の画素、奥行き、足元までの横のずれ、冠の半径)。足元は岬の上
    hero = [((45, 215), 25, 5.6, 4.0), ((205, 425), 36, 3.0, 4.5), ((40, 425), 31, 5.0, 3.4), ((98, 540), 41, 1.2, 2.3)]
    for i, ((u, v), d, ln, size) in enumerate(hero):
        c = A(u, v, d)
        x, y = c.x - ln, c.y
        z = float(height(np.float64(x), np.float64(y)))
        palm(m, (x, y, z), c.z - z, ln, 0.0, fronds, keys, i, True, size)
    r = random.Random(4)
    pts = []
    for i in range(46):
        a = math.radians(r.uniform(128, 322))
        R_ = BAY_R + r.uniform(5, 26)
        x, y = BAY_C[0] + R_ * math.cos(a), BAY_C[1] + R_ * math.sin(a)
        if abs(x) < 6 or (x > -32 and y > 12):  # 桟橋の道と、目標の空の抜けを空ける
            continue
        pts.append((x, y))
        z = float(height(np.float64(x), np.float64(y)))
        palm(m, (x, y, z), r.uniform(7, 16), r.uniform(.6, 4), r.uniform(0, 6.28), fronds, keys, 10 + i, False, r.uniform(2.4, 3.8))
    for i in range(170):
        a = math.radians(r.uniform(124, 326))
        R_ = BAY_R + r.uniform(5.5, 30)
        x, y = BAY_C[0] + R_ * math.cos(a), BAY_C[1] + R_ * math.sin(a)
        if abs(x) < 6 or (x > -24 and y > 12):
            continue
        o = link(bpy.data.objects.new(f'Bush{i}', protos[i % 3].data))
        s = r.uniform(1.6, 3.8)
        o.location = (x, y, float(height(np.float64(x), np.float64(y))) - .1)
        o.scale = (s, s, s * r.uniform(.8, 1.2))
        o.rotation_euler = (0, 0, r.uniform(0, 6.28))
    for i, (u, d, s) in enumerate(((4, 37, 2.3), (34, 37, 2.1), (60, 38, 1.8), (-20, 36, 2.4), (16, 42, 2.0), (48, 43, 1.9), (80, 43, 1.8), (-6, 34, 1.5), (22, 34, 1.4))):  # 目標の東屋の左の茂み
        c = A(u, HORIZON, d)
        o = link(bpy.data.objects.new(f'BushNear{i}', protos[i % 3].data))
        o.location, o.scale, o.rotation_euler = (c.x, c.y, .45), (s * 1.3, s * 1.3, s), (0, 0, i * 2.1)
    for i in range(7):  # 桟橋が陸へ届く先
        o = link(bpy.data.objects.new(f'BushBack{i}', protos[i % 3].data))
        o.location, o.scale, o.rotation_euler = (-9 + 3 * i, -58 - (i % 2), 1.6), (3.4, 3.4, 3.2), (0, 0, i * 1.7)
    for p in fronds + protos:
        bpy.context.scene.collection.objects.unlink(p)


# ---- 動き ----
def wave(t, phase, period):
    return math.sin(t / period * math.tau + phase) + .5 * math.sin(t / period * 2.3 * math.tau + phase * 1.7) + .3 * math.sin(t / period * .37 * math.tau + phase * .6)


def animate(ctx, keys, last):
    fps = ctx.fps
    beat = ctx.beats[1] - ctx.beats[0] if len(ctx.beats) > 1 else .5
    step = 10
    frames = list(range(1, last + 2, step))
    period = 8 * beat  # 風の周期は 8 拍。葉は曲に合わせてゆっくり振れる
    for o, ph in keys['fronds']:
        base_p, base_z = o.rotation_euler[1], o.rotation_euler[2]
        for f in frames:
            t = (f - 1) / fps
            o.rotation_euler[1] = base_p + .05 * wave(t, ph, period * .5)
            o.rotation_euler[2] = base_z + .03 * wave(t, ph + 2, period * .7)
            o.keyframe_insert('rotation_euler', index=1, frame=f)
            o.keyframe_insert('rotation_euler', index=2, frame=f)
    for o, ph in keys['crowns']:
        for f in frames[::2]:
            t = (f - 1) / fps
            o.rotation_euler[0] = .018 * wave(t, ph, period)
            o.rotation_euler[1] = .024 * wave(t, ph + 1, period * 1.3)
            o.keyframe_insert('rotation_euler', frame=f)
    for i, o in enumerate(keys['curtains']):
        kb = o.data.shape_keys.key_blocks
        for f in frames:
            t = (f - 1) / fps
            kb['a'].value = .5 + .45 * math.sin(t / (period * .45) * math.tau + i * 1.3)
            kb['b'].value = .5 + .45 * math.sin(t / (period * .31) * math.tau + i * 2.1)
            kb['a'].keyframe_insert('value', frame=f)
            kb['b'].keyframe_insert('value', frame=f)
    for i, o in enumerate(keys['lanterns']):  # ランタンは風で少し振れる
        for f in frames[::2]:
            t = (f - 1) / fps
            o.rotation_euler[0] = .04 * math.sin(t / (period * .6) * math.tau + i)
            o.rotation_euler[1] = .03 * math.sin(t / (period * .47) * math.tau + i * 2)
            o.keyframe_insert('rotation_euler', frame=f)
    # 灯りは拍で少し強まる
    fl = keys['flame']
    for b in ctx.beats:
        f = 1 + b * fps
        if f > last:
            break
        fl.default_value = 2.0
        fl.keyframe_insert('default_value', frame=f)
        fl.default_value = 1.3
        fl.keyframe_insert('default_value', frame=f + beat * fps * .6)


def compositor():
    s = bpy.context.scene
    nt = bpy.data.node_groups.new('Grade', 'CompositorNodeTree')
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
    g.inputs['Threshold'].default_value = .95
    g.inputs['Smoothness'].default_value = .4
    g.inputs['Strength'].default_value = .5
    g.inputs['Saturation'].default_value = 1.15
    g.inputs['Size'].default_value = .8
    L.new(sh.outputs[0], g.inputs['Image'])
    nt.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    out = N.new('NodeGroupOutput')
    L.new(g.outputs['Image'], out.inputs[0])
    s.render.use_compositing = True


def knot_mat():
    s = Sh('Knot')
    t = s.tex('knot_a.png', s.n('TexCoord').outputs['UV'], ext='EXTEND')
    t[0].node.image.alpha_mode = 'STRAIGHT'
    g = s.n('RGBToBW', t[0]).outputs[0]  # 色は下の板のまま、節の濃淡だけ載せる
    p = s.n('BsdfDiffuse', s.mix(1.0, (.2, .13, .09), g, 'MULTIPLY')).outputs[0]
    return s.done(s.n('MixShader', t[1], s.n('BsdfTransparent').outputs[0], p).outputs[0])


def materials():
    flame = Sh('Flame')
    em = flame.n('Emission', (1, .55, .2), 1.3)
    nail = Sh('Nail')
    m = {
        'deck': deck_mat(),
        'knot': knot_mat(),
        'gap': gloss_wood('Gap', 'post_wood.png', .1, .9, .1, (1, .62, .4)),
        'nail': nail.done(nail.n('BsdfDiffuse', (.012, .009, .007)).outputs[0]),
        'post': gloss_wood('Post', 'post_wood.png', .4, .6, 1.6),
        'beam': gloss_wood('Beam', 'post_wood.png', .16, .7, 1.2),
        'rope': gloss_wood('Rope', 'rope.png', 1.9, .8, .6, (1, .97, .8)),
        'bark': gloss_wood('Bark', 'palm_bark.png', .4, .85, 1.2),
        'rock': gloss_wood('Rock', 'rock.png', 1.5, .6, 1.5),
        'thatch': gloss_wood('Thatch', 'thatch.png', .09, 1.0, 1.5),
        'leaf': leaf_mat('PalmLeaf', 'palm_leaf.png', (.2, .19, .1), .22, .2),
        'bush': leaf_mat('Bush', 'bush_leaf.png', (3.2, 3.0, 1.0), .5),
        'curtain': curtain_mat(),
        'glass': glass_mat(),
        'iron': gloss_wood('Iron', 'rock.png', .06, .5, .3),
        'flame': flame.done(em.outputs[0]),
        'cushion': gloss_wood('Cushion', 'linen.png', 1.5, .8, .1),
    }
    return m, em.inputs[1]


def build(ctx):
    global ASSETS
    ASSETS = ctx.assets
    s = bpy.context.scene
    s.view_settings.view_transform = 'Standard'
    s.view_settings.look = 'None'
    c = s.cycles
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces, c.transparent_max_bounces = 5, 2, 2, 3, 6
    c.sample_clamp_indirect = 20.0
    c.use_light_tree = True
    c.adaptive_threshold = .04
    c.filter_width = 1.0
    bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
    last = max(ctx.frames, 480)

    world()
    sun()
    m, flame_power = materials()
    keys = {'fronds': [], 'crowns': [], 'curtains': [], 'lanterns': [], 'flame': flame_power}
    ground(ground_mat(last, ctx.fps))
    w = water(water_mat(last, ctx.fps))
    islands()
    jungle()
    keys['lanterns'] = pier(m, last)
    cabana(m, keys)
    rocks(m)
    shore_plants(m, keys)
    animate(ctx, keys, last)
    compositor()

    return {
        'mark': (0, 0, 0),
        'facing': 0,
        'bounds': ((-6.0, 6.0), (-6.4, 1.15), (0.12, 4.6)),  # y の上限より先に柱がある
        'char_emission': 0.42,
        'beats_per_shot': 8,
        'views': {
            'target': {'loc': tuple(CAM), 'look': tuple(CAM + LOOK * 4), 'lens': LENS, 'fstop': 1.4, 'focus': 7.0},
            'hold1': {'loc': (3.4, -3.0, 1.1), 'look': (0, 0, 1.0), 'lens': 35, 'fstop': 2.8},
            'hold2': {'loc': (-3.2, -1.2, 0.5), 'look': (0, 2, 1.5), 'lens': 28, 'fstop': 2.8},
            'back': {'loc': (0, 1.1, 1.3), 'look': (0, -8, 1.6), 'lens': 24, 'fstop': 2.8},
            'left': {'loc': (5, 0.5, .9), 'look': (-8, 0, 2.0), 'lens': 24, 'fstop': 2.8},
            'right': {'loc': (-5, 0.5, .9), 'look': (8, 0, 2.0), 'lens': 24, 'fstop': 2.8},
        },
    }
