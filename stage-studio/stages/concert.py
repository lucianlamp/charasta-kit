"""アリーナのコンサートステージ。目標画像と同じ構図になるよう、部品の多くを target の画素位置と奥行きから置く(P)。
光線は加算の円すいメッシュ、煙はカメラを向く板、客席は点の光のメッシュ。座標は mark が原点で、ステージの奥が +Y。"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from lib.studio import load_image

CAM = Vector((0, -9.3, 3.0))  # target のカメラ
LENS = 16.0
W, H = 941, 1672  # 目標画像の画素数
F = LENS / 36 * H
TILT = math.atan(49 / F)  # 地平線が 885 画素になる上向きの角度
CYAN, PINK, BLUE = (0.015, 0.29, 0.8), (1.0, 0.05, 0.42), (0.02, 0.2, 0.9)
SIDE_BOX = (100, 280, 610, 980)  # 左右の LED の絵が覆う範囲(左の板の画素 u0, u1, v0, v1)
SIDE_LED = {}
# 床の形: 2 つの円の重なり。手前の弧と奥の弧
FRONT_Y, FRONT_R = -5.45, 14.6
REAR_Y, REAR_R = 5.80, 28.0
RISER = 0.55
MARK = (0, -0.8, 1.0)  # キャラの立つ位置と、光を向ける高さ


def P(u, v, d):
    """目標画像の画素 (u, v) に写り、カメラから +Y に d 離れた世界の点"""
    a, b = (u - W / 2) / F, (H / 2 - v) / F
    c, s = math.cos(TILT), math.sin(TILT)
    ray = Vector((a, c - b * s, s + b * c))
    return CAM + ray * (d / ray.y)


def front_y(x):
    return FRONT_Y + FRONT_R - math.sqrt(max(FRONT_R ** 2 - x * x, 0)) + 0.03 * min(1.0, (x / 2.1) ** 2)


def rear_y(x):
    return REAR_Y - REAR_R + math.sqrt(max(REAR_R ** 2 - x * x, 0))


def link(o):
    bpy.context.scene.collection.objects.link(o)
    return o


def rays(o, shadow=True, diffuse=True):
    o.visible_shadow, o.visible_diffuse = shadow, diffuse
    return o


# ---- メッシュ ----
def quads(name, V, Q, mat, uv=None, smooth=False):
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
    me.materials.append(mat)
    return link(bpy.data.objects.new(name, me))


class Bag:
    """細い管をまとめて 1 つのメッシュにする"""

    def __init__(self):
        self.V, self.Q, self.n = [], [], 0

    def add(self, V, Q):
        self.V.append(V)
        self.Q.append(Q + self.n)
        self.n += len(V)

    def tubes(self, A, B, r, sides=4):
        A, B = np.asarray(A, float).reshape(-1, 3), np.asarray(B, float).reshape(-1, 3)
        d = B - A
        d /= np.linalg.norm(d, axis=1, keepdims=True) + 1e-9
        ref = np.where(np.abs(d[:, 2:3]) > 0.9, [[1.0, 0, 0]], [[0, 0, 1.0]])
        a = np.cross(d, ref)
        a /= np.linalg.norm(a, axis=1, keepdims=True)
        b = np.cross(d, a)
        ang = np.arange(sides) * 2 * math.pi / sides + math.pi / 4
        off = r * (np.cos(ang)[None, :, None] * a[:, None] + np.sin(ang)[None, :, None] * b[:, None])
        V = np.concatenate([A[:, None] + off, B[:, None] + off], 1).reshape(-1, 3)
        k = np.arange(sides)
        one = np.stack([k, (k + 1) % sides, (k + 1) % sides + sides, k + sides], 1)
        Q = (one[None] + (np.arange(len(A)) * 2 * sides)[:, None, None]).reshape(-1, 4)
        self.add(V, Q)

    def line(self, pts, r, sides=6):
        pts = np.asarray(pts, float)
        self.tubes(pts[:-1], pts[1:], r, sides)

    def box(self, pts8):
        """pts8: 手前の 4 点と奥の 4 点(同じ順)"""
        self.add(np.asarray(pts8, float), np.array([[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]))

    def build(self, name, mat):
        return quads(name, np.concatenate(self.V), np.concatenate(self.Q), mat)


def grid(fn, nu, nv):
    """fn(s, t) -> 点。s, t は 0..1。頂点、四角形、UV を返す"""
    V, UV = [], []
    for j in range(nv + 1):
        for i in range(nu + 1):
            s, t = i / nu, j / nv
            V.append(tuple(fn(s, t)))
            UV.append((s, t))
    Q = [(j * (nu + 1) + i, j * (nu + 1) + i + 1, (j + 1) * (nu + 1) + i + 1, (j + 1) * (nu + 1) + i) for j in range(nv) for i in range(nu)]
    return V, Q, UV


def bilinear(q, s, t):
    """q: 左下、右下、右上、左上"""
    a, b = q[0].lerp(q[1], s), q[3].lerp(q[2], s)
    return a.lerp(b, t)


# ---- シェーダー ----
class Mat:
    def __init__(self, name):
        self.m = bpy.data.materials.new(name)
        self.m.use_nodes = True
        self.t = self.m.node_tree
        self.t.nodes.clear()
        self.out = self.t.nodes.new('ShaderNodeOutputMaterial')
        self.m.cycles.emission_sampling = 'NONE'

    def n(self, kind, **props):
        node = self.t.nodes.new(kind)
        for k, v in props.items():
            setattr(node, k, v)
        return node

    def put(self, sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.t.links.new(v, sock)
        elif isinstance(v, bpy.types.Node):
            self.t.links.new(v.outputs[0], sock)
        else:
            sock.default_value = v

    def f(self, op, a, b=None, c=None, clamp=False):
        node = self.n('ShaderNodeMath', operation=op, use_clamp=clamp)
        for i, x in enumerate((a, b, c)):
            if x is not None:
                self.put(node.inputs[i], x)
        return node.outputs[0]

    def vec(self, op, a, b=None, scale=None):
        node = self.n('ShaderNodeVectorMath', operation=op)
        self.put(node.inputs[0], a)
        if b is not None:
            self.put(node.inputs[1], b)
        if scale is not None:
            self.put(node.inputs['Scale'], scale)
        return node.outputs[0]

    def rgb(self, op, a, b, fac=1.0):
        node = self.n('ShaderNodeMix', data_type='RGBA', blend_type=op)
        self.put(node.inputs['Factor'] if 'Factor' in node.inputs else node.inputs[0], fac)
        self.put(node.inputs[6], a)
        self.put(node.inputs[7], b)
        return node.outputs[2]

    def image(self, path, vector=None, data=False, extension='REPEAT'):
        tex = self.n('ShaderNodeTexImage', extension=extension)
        tex.image = load_image(path, data)
        if vector is not None:
            self.put(tex.inputs[0], vector)
        return tex

    def uv(self):
        return self.n('ShaderNodeTexCoord').outputs['UV']

    def _split(self, v):
        node = self.n('ShaderNodeSeparateXYZ')
        self.put(node.inputs[0], v)
        return node.outputs

    def join(self, x, y, z=0.0):
        node = self.n('ShaderNodeCombineXYZ')
        for i, c in enumerate((x, y, z)):
            self.put(node.inputs[i], c)
        return node.outputs[0]

    def emission(self, color, strength=1.0):
        node = self.n('ShaderNodeEmission')
        self.put(node.inputs[0], color)
        self.put(node.inputs[1], strength)
        return node.outputs[0]

    def finish(self, shader):
        self.t.links.new(shader, self.out.inputs[0])
        return self.m


def clock_group():
    """時間と拍の値をまとめた節。ここだけにキーフレームを打ち、全部の材質がこれを読む"""
    g = bpy.data.node_groups.new('Clock', 'ShaderNodeTree')
    out = g.nodes.new('NodeGroupOutput')
    for name, val in (('t', 0.0), ('pulse_a', 0.5), ('pulse_b', 0.5)):
        g.interface.new_socket(name, in_out='OUTPUT', socket_type='NodeSocketFloat')
        n = g.nodes.new('ShaderNodeValue')
        n.name = name
        n.outputs[0].default_value = val
        g.links.new(n.outputs[0], out.inputs[name])
    return g


def clock(m, g):
    n = m.n('ShaderNodeGroup')
    n.node_tree = g
    return n.outputs


def line_core(m, dist, width, glow):
    """線からの距離 → 芯の 1 と周りのにじみ"""
    core = m.f('LESS_THAN', dist, width)
    soft = m.f('EXPONENT', m.f('DIVIDE', m.f('MULTIPLY', dist, -1.0), glow))
    return m.f('ADD', core, m.f('MULTIPLY', soft, 0.35))


def led_material(name, img, sparks, bolts_img, clk, lines, strength=1.0, lift=(0.1, 0.07, 0.2), tint=((1, 1, 1), (1, 1, 1)), bottom=(0, 0, 0), zoom=1.0):
    """LED 壁。image_gen の絵を時間でゆがめ、火花の層を重ね、線の模様をシェーダーで足す。
    lines: (関数, 色, 幅, にじみ, 強さ)。関数は (m, u, v) から線までの距離のソケットを返す"""
    m = Mat(name)
    tick = clock(m, clk)
    uv = m.uv()
    u, v, _ = m._split(uv)
    noise = m.n('ShaderNodeTexNoise', noise_dimensions='4D')
    m.put(noise.inputs['Vector'], uv)
    m.put(noise.inputs['W'], m.f('MULTIPLY', tick['t'], 0.12))
    m.put(noise.inputs['Scale'], 2.6)
    wob = m.vec('SCALE', m.vec('SUBTRACT', noise.outputs['Color'], (0.5, 0.5, 0.5)), scale=0.05)
    centered = m.vec('ADD', m.vec('SCALE', m.vec('SUBTRACT', uv, (0.5, 0.5, 0)), scale=zoom), (0.5, 0.5, 0))  # 絵を縮めて、四隅の雲を鏡映しで内側へ寄せる
    tex = m.image(img, m.vec('ADD', centered, wob), extension='MIRROR')
    # 雲の上を走る細い稲妻。画面の高さで色が変わる
    bolt_uv = m.n('ShaderNodeMapping')
    m.put(bolt_uv.inputs[0], uv)
    m.put(bolt_uv.inputs['Scale'], (1.3, 1.3, 1))
    m.put(bolt_uv.inputs['Location'], m.join(m.f('MULTIPLY', tick['t'], -0.012), m.f('MULTIPLY', tick['t'], 0.018)))
    bolts = m.image(bolts_img, bolt_uv)
    stars = m.n('ShaderNodeMapping')
    m.put(stars.inputs[0], uv)
    m.put(stars.inputs['Scale'], (2.2, 2.2, 1))
    m.put(stars.inputs['Location'], m.join(m.f('MULTIPLY', tick['t'], 0.02), m.f('MULTIPLY', tick['t'], 0.05)))
    sp = m.image(sparks, stars)
    gain = m.f('ADD', 0.7, m.f('MULTIPLY', tick['pulse_a'], 0.6))
    pic = m.vec('MULTIPLY', m.vec('POWER', tex.outputs[0], (0.92, 0.92, 0.92)), m.rgb('MIX', (*tint[0], 1), (*tint[1], 1), v))  # 下の色から上の色へ
    col = m.vec('ADD', m.vec('SCALE', pic, scale=m.f('MULTIPLY', gain, strength)), m.vec('SCALE', sp.outputs[0], scale=0.3))
    col = m.vec('ADD', col, m.vec('SCALE', lift, scale=gain))  # LED の面は暗い所でも淡く光る
    col = m.vec('ADD', col, m.vec('SCALE', m.vec('MULTIPLY', bolts.outputs[0], m.rgb('MIX', (0.25, 0.75, 1.0, 1), (0.8, 0.5, 1.0, 1), v)), scale=m.f('MULTIPLY', gain, 0.32)))
    col = m.vec('ADD', col, m.vec('SCALE', bottom, scale=m.f('POWER', m.f('SUBTRACT', 1.0, v, clamp=True), 9.0)))  # 下端は舞台へにじむ
    grid_u = m.f('SINE', m.f('MULTIPLY', u, 760.0))
    grid_v = m.f('SINE', m.f('MULTIPLY', v, 600.0))
    dots = m.f('ADD', 0.88, m.f('MULTIPLY', m.f('MULTIPLY', m.f('ABSOLUTE', grid_u), m.f('ABSOLUTE', grid_v)), 0.24))
    col = m.vec('SCALE', col, scale=dots)
    for fn_, tint, width, glow, power in lines:
        d = fn_(m, u, v)
        col = m.vec('ADD', col, m.vec('SCALE', tint, scale=m.f('MULTIPLY', line_core(m, d, width, glow), m.f('MULTIPLY', power, gain))))
    return m.finish(m.emission(col))


def beam_material(clk, assets):
    m = Mat('beam')
    tick = clock(m, clk)
    info = m.n('ShaderNodeObjectInfo')
    u, v, _ = m._split(m.uv())
    fade = m.f('POWER', m.f('SUBTRACT', 1.0, v, clamp=True), 1.5)
    near = m.f('ADD', 0.2, m.f('POWER', m.f('SUBTRACT', 1.0, v, clamp=True), 6.0))
    facing = m.n('ShaderNodeLayerWeight')
    m.put(facing.inputs[0], 0.5)
    edge = m.f('POWER', m.f('SUBTRACT', 1.0, facing.outputs['Facing']), 3.4)
    # 光の中の煙のむら。先へ行くほど濃淡を強くする
    drift = m.join(m.f('ADD', m.f('MULTIPLY', u, 2.0), info.outputs['Random']), m.f('SUBTRACT', m.f('MULTIPLY', v, 1.4), m.f('MULTIPLY', tick['t'], 0.08)))
    haze = m.image(assets / 'beam_haze.png', drift, data=True)
    dense = m.f('ADD', m.f('SUBTRACT', 1.0, v), m.f('MULTIPLY', m.f('POWER', haze, 2.0), m.f('MULTIPLY', v, 4.5)), clamp=False)
    even = m.f('GREATER_THAN', info.outputs['Random'], 0.5)
    flick = m.n('ShaderNodeMix', data_type='FLOAT')
    m.put(flick.inputs[0], even)
    m.put(flick.inputs[2], tick['pulse_a'])
    m.put(flick.inputs[3], tick['pulse_b'])
    power = m.f('MULTIPLY', m.f('MULTIPLY', m.f('MULTIPLY', fade, near), m.f('MULTIPLY', edge, dense)), m.f('MULTIPLY', info.outputs['Alpha'], m.f('ADD', 1.4, m.f('MULTIPLY', flick.outputs[0], 5.8))))
    add = m.n('ShaderNodeAddShader')
    m.t.links.new(m.n('ShaderNodeBsdfTransparent').outputs[0], add.inputs[0])
    m.t.links.new(m.emission(info.outputs['Color'], power), add.inputs[1])
    return m.finish(add.outputs[0])


def halo_material():
    m = Mat('halo')
    info = m.n('ShaderNodeObjectInfo')
    facing = m.n('ShaderNodeLayerWeight')
    m.put(facing.inputs[0], 0.5)
    edge = m.f('POWER', m.f('SUBTRACT', 1.0, facing.outputs['Facing']), 7.0)
    add = m.n('ShaderNodeAddShader')
    m.t.links.new(m.n('ShaderNodeBsdfTransparent').outputs[0], add.inputs[0])
    m.t.links.new(m.emission(info.outputs['Color'], m.f('MULTIPLY', edge, m.f('MULTIPLY', info.outputs['Alpha'], 7.0))), add.inputs[1])
    return m.finish(add.outputs[0])


def lens_material(tex):
    m = Mat('lens')
    info = m.n('ShaderNodeObjectInfo')
    im = m.image(tex, m.uv(), extension='CLIP')
    col = m.rgb('ADD', m.vec('SCALE', info.outputs['Color'], scale=0.9), m.vec('SCALE', (1, 1, 1), scale=0.2))
    return m.finish(m.emission(m.vec('MULTIPLY', im.outputs[0], col), m.f('MULTIPLY', info.outputs['Alpha'], 26.0)))


def dark_material(name, tex=None, base=(0.01, 0.01, 0.012), rough=0.45, rim=None, rim_power=0.0, metallic=0.6, scale=1.0, uv=False, lit=None, lit_power=0.0):
    """黒い材質。rim は縁に受ける色の光。lit は下と手前を向いた面が受ける色の光で、部材の面を明暗に分ける。
    どちらも実際の光を増やさずに済む"""
    m = Mat(name)
    b = m.n('ShaderNodeBsdfPrincipled')
    m.put(b.inputs['Metallic'], metallic)
    m.put(b.inputs['Roughness'], rough)
    if tex:
        if uv:
            im = m.image(tex, m.uv(), extension='EXTEND')
        else:
            coord = m.vec('SCALE', m.n('ShaderNodeTexCoord').outputs['Object'], scale=scale)
            im = m.image(tex, coord)
        m.put(b.inputs['Base Color'], m.vec('SCALE', im.outputs[0], scale=0.5))
    else:
        m.put(b.inputs['Base Color'], (*base, 1))
    shader = b.outputs[0]
    for col, power in ((rim, rim_power), (lit, lit_power)):
        if not col:
            continue
        if col is rim:
            facing = m.n('ShaderNodeLayerWeight')
            m.put(facing.inputs[0], 0.5)
            k = m.f('POWER', facing.outputs['Facing'], 3.0)
        else:
            dot = m.vec('DOT_PRODUCT', m.n('ShaderNodeNewGeometry').outputs['Normal'], (0, -0.7, 0.7))
            k = m.f('POWER', m.f('MAXIMUM', m.t.nodes[dot.node.name].outputs['Value'], 0.0), 2.0)
        add = m.n('ShaderNodeAddShader')
        m.t.links.new(shader, add.inputs[0])
        m.t.links.new(m.emission((*col, 1), m.f('MULTIPLY', k, power)), add.inputs[1])
        shader = add.outputs[0]
    return m.finish(shader)


def tri_material():
    """三角の枠の暗いガラス。下辺の線の光が内側へにじむ"""
    m = Mat('tri')
    _, v, _ = m._split(m.uv())
    return m.finish(m.emission((0.9, 0.05, 0.55, 1), m.f('ADD', 0.01, m.f('MULTIPLY', m.f('POWER', v, 3.0), 0.35))))


def neon_material(name, color, strength):
    m = Mat(name)
    return m.finish(m.emission((*color, 1), strength))


def floor_material(assets):
    """黒い硬い床。細かい凹凸は視線の向きにだけ法線を傾けるので、反射は左右へ揺れず、画面の縦に伸びて手前で粒に崩れる。
    どの視点でも同じ計算で、異方性の向きも視線から決める。"""
    m = Mat('floor')
    b = m.n('ShaderNodeBsdfPrincipled')
    geo = m.n('ShaderNodeNewGeometry')
    ix, iy, _ = m._split(geo.outputs['Incoming'])
    t = m.vec('NORMALIZE', m.join(ix, iy, 0.0))
    uv = m.uv()
    coord = m.vec('SCALE', uv, scale=0.9)
    rough = m.image(assets / 'floor_rough.png', coord, data=True)
    norm = m.image(assets / 'floor_normal.png', coord, data=True)
    nx, ny, _ = m._split(norm.outputs[0])
    dn = m.join(m.f('SUBTRACT', nx, 0.5), m.f('SUBTRACT', ny, 0.5), 0.0)
    along = m.vec('DOT_PRODUCT', dn, t)
    bent = m.vec('NORMALIZE', m.vec('ADD', (0, 0, 1), m.vec('SCALE', t, scale=m.f('MULTIPLY', m.t.nodes[along.node.name].outputs['Value'], 0.12))))
    ux, uy, _ = m._split(uv)
    seam_uv = m.join(m.f('DIVIDE', m.f('ADD', ux, 15.0), 30.0), m.f('DIVIDE', m.f('ADD', uy, 6.0), 12.5))
    seam = m.image(assets / 'floor_seams.png', seam_uv, data=True, extension='EXTEND')
    bump = m.n('ShaderNodeBump')
    m.put(bump.inputs['Height'], m.f('MULTIPLY', seam, -1.0))
    m.put(bump.inputs['Distance'], 0.004)
    m.put(bump.inputs['Normal'], bent)
    m.put(b.inputs['Normal'], bump.outputs[0])
    m.put(b.inputs['Tangent'], t)
    m.put(b.inputs['Anisotropic'], 0.86)
    # 真横に近い視線では反射を抑え、低いカメラでも黒い地を残す
    grazing = m.n('ShaderNodeMapRange', clamp=True)
    lw = m.n('ShaderNodeLayerWeight')
    m.put(lw.inputs[0], 0.5)
    m.put(grazing.inputs['Value'], lw.outputs['Facing'])
    m.put(grazing.inputs['From Min'], 0.84)
    m.put(grazing.inputs['From Max'], 0.97)
    m.put(grazing.inputs['To Min'], 1.0)
    m.put(grazing.inputs['To Max'], 0.42)
    # 舞台の中ほどより手前は地を黒くして、LED をそのまま映さない。奥の縁だけ鏡に近い
    depth = m.n('ShaderNodeMapRange', clamp=True)
    m.put(depth.inputs['Value'], uy)
    m.put(depth.inputs['From Min'], 1.5)
    m.put(depth.inputs['From Max'], 4.0)
    m.put(depth.inputs['To Min'], 0.5)
    m.put(depth.inputs['To Max'], 1.0)
    tone = m.f('MULTIPLY', m.f('MULTIPLY', grazing.outputs[0], depth.outputs[0]), m.f('SUBTRACT', 1.0, m.f('MULTIPLY', seam, 0.92)))
    m.put(b.inputs['Base Color'], m.vec('SCALE', (0.62, 0.58, 0.74), scale=tone))
    m.put(b.inputs['Metallic'], 1.0)
    # 奥は鏡に近く、手前ほど粗い
    near = m.n('ShaderNodeMapRange', clamp=True)
    m.put(near.inputs['Value'], uy)
    m.put(near.inputs['From Min'], 5.5)
    m.put(near.inputs['From Max'], -3.5)
    m.put(near.inputs['To Min'], 0.05)
    m.put(near.inputs['To Max'], 1.0)
    m.put(b.inputs['Roughness'], m.f('MULTIPLY', near.outputs[0], m.f('ADD', 0.06, m.f('MULTIPLY', rough, 0.2))))
    return m.finish(b.outputs[0])


def band_material(gain=1.0):
    """前縁の LED の帯。U は弧の長さ(m)。シアンの区間の端は 0.15 m かけて色が変わる"""
    m = Mat(f'band{gain}')
    u, v, _ = m._split(m.uv())
    s = m.f('SUBTRACT', m.f('MULTIPLY', m.f('FRACT', m.f('DIVIDE', m.f('ADD', u, 3.5), 7.0)), 7.0), 3.5)

    def window(center, half):
        node = m.n('ShaderNodeMapRange', clamp=True)
        m.put(node.inputs['Value'], m.f('ABSOLUTE', m.f('SUBTRACT', s, center)))
        m.put(node.inputs['From Min'], half)
        m.put(node.inputs['From Max'], half + 0.1)
        m.put(node.inputs['To Min'], 1.0)
        m.put(node.inputs['To Max'], 0.0)
        return node.outputs[0]

    cy = m.f('MAXIMUM', window(-1.4, 0.3), window(1.54, 0.18))
    col = m.rgb('MIX', (1.0, 0.06, 0.48, 1), (0.08, 0.48, 1.0, 1), cy)
    core = m.f('POWER', m.f('SUBTRACT', 1.0, m.f('ABSOLUTE', m.f('MULTIPLY', m.f('SUBTRACT', v, 0.5), 2.0))), 3.0)
    white = m.rgb('MIX', col, (1, 0.8, 0.92, 1), m.f('MULTIPLY', core, 0.72))
    return m.finish(m.emission(white, m.f('MULTIPLY', m.f('ADD', 1.0, m.f('MULTIPLY', core, 0.8)), gain)))


def ghost_material():
    """床にだけ映る色の柱。U と V の端で消える"""
    m = Mat('ghost')
    info = m.n('ShaderNodeObjectInfo')
    u, v, _ = m._split(m.uv())
    fu = m.f('SINE', m.f('MULTIPLY', u, math.pi))
    fv = m.f('SINE', m.f('MULTIPLY', v, math.pi))
    add = m.n('ShaderNodeAddShader')
    m.t.links.new(m.n('ShaderNodeBsdfTransparent').outputs[0], add.inputs[0])
    m.t.links.new(m.emission(info.outputs['Color'], m.f('MULTIPLY', m.f('MULTIPLY', m.f('POWER', fu, 2.2), m.f('POWER', fv, 1.4)), info.outputs['Alpha'])), add.inputs[1])
    return m.finish(add.outputs[0])


def smoke_material(tex, clk):
    m = Mat('smoke_' + tex.stem)
    info = m.n('ShaderNodeObjectInfo')
    tick = clock(m, clk)
    u, v, _ = m._split(m.uv())
    drift = m.join(m.f('ADD', u, m.f('MULTIPLY', m.f('MULTIPLY', tick['t'], 0.006), m.f('ADD', 0.5, info.outputs['Random']))), v)
    im = m.image(tex, drift, extension='EXTEND')
    a = m.f('MULTIPLY', m.f('POWER', im.outputs[0], 1.35), info.outputs['Alpha'], clamp=True)
    # 板が回って段や床に刺さっても切れ目が出ないよう、奥の弧の内側と床際で消す
    px, py, pz = m._split(m.n('ShaderNodeNewGeometry').outputs['Position'])
    dist = m.f('SUBTRACT', m.f('SQRT', m.f('ADD', m.f('POWER', px, 2.0), m.f('POWER', m.f('SUBTRACT', py, REAR_Y - REAR_R), 2.0))), REAR_R)
    behind = m.f('DIVIDE', m.f('ADD', dist, 0.2), 0.2, clamp=True)
    low = m.f('DIVIDE', m.f('SUBTRACT', RISER + 0.25, pz), 0.25, clamp=True)
    a = m.f('MULTIPLY', a, m.f('SUBTRACT', 1.0, m.f('MULTIPLY', behind, low), clamp=True))
    a = m.f('MULTIPLY', a, m.f('DIVIDE', pz, 0.08, clamp=True))
    a = m.f('MULTIPLY', a, m.f('SUBTRACT', 1.0, m.f('MULTIPLY', m.n('ShaderNodeLightPath').outputs['Is Glossy Ray'], 0.62)))  # 床に映る煙は薄い
    mix = m.n('ShaderNodeMixShader')
    m.put(mix.inputs[0], a)
    m.t.links.new(m.n('ShaderNodeBsdfTransparent').outputs[0], mix.inputs[1])
    # 下ほど明るい。壁の光が煙に映った色
    tone = m.rgb('MIX', info.outputs['Color'], (0.95, 0.85, 1.0, 1), m.f('MULTIPLY', a, 0.1))
    m.t.links.new(m.emission(tone, 1.2), mix.inputs[2])
    return m.finish(mix.outputs[0])


def penlight_material(clk):
    """丸い点の光。交差した小さな板の中心だけ光らせる"""
    m = Mat('penlight')
    tick = clock(m, clk)
    col = m.n('ShaderNodeAttribute', attribute_name='col', attribute_type='GEOMETRY')
    rnd = m.n('ShaderNodeAttribute', attribute_name='rnd', attribute_type='GEOMETRY')
    u, v, _ = m._split(m.uv())
    r2 = m.f('ADD', m.f('POWER', m.f('SUBTRACT', u, 0.5), 2.0), m.f('POWER', m.f('SUBTRACT', v, 0.5), 2.0))
    disc = m.f('POWER', m.f('SUBTRACT', 1.0, m.f('MULTIPLY', r2, 4.0), clamp=True), 2.0)
    wave = m.f('SINE', m.f('ADD', m.f('MULTIPLY', tick['t'], 6.0), m.f('MULTIPLY', rnd.outputs['Fac'], 6.283)))
    power = m.f('MULTIPLY', disc, m.f('ADD', 3.0, m.f('MULTIPLY', wave, 1.0)))
    add = m.n('ShaderNodeAddShader')
    m.t.links.new(m.n('ShaderNodeBsdfTransparent').outputs[0], add.inputs[0])
    m.t.links.new(m.emission(col.outputs['Color'], power), add.inputs[1])
    return m.finish(add.outputs[0])


# ---- 部品 ----
def build_floor(mats):
    # 前と奥の弧で囲んだレンズの形。継ぎ目は材質の中の配置図で描く
    tip = 14.5
    for x in np.arange(13, 16, 0.002):
        if front_y(x) >= rear_y(x):
            tip = float(x)
            break
    V, Q, UV = grid(lambda s, t: (lambda x: (x, front_y(x) + (rear_y(x) - front_y(x)) * t, 0))(-tip + 2 * tip * s), 96, 24)
    uv = [(v[0], v[1]) for v in V]
    quads('Floor', V, Q, mats['floor'], uv)


def build_stage_front(mats):
    n = 160
    xs = np.linspace(-14.3, 14.3, n + 1)
    fy = [front_y(float(x)) for x in xs]
    arc = np.concatenate([[0], np.cumsum(np.hypot(np.diff(xs), np.diff(fy)))])
    arc -= arc[-1] / 2

    def strip(name, z0, z1, off0, off1, mat):
        V, UV = [], []
        for i in range(n + 1):
            V += [(xs[i], fy[i] - off0, z0), (xs[i], fy[i] - off1, z1)]
            UV += [(arc[i], 0), (arc[i], 1)]
        Q = [(2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1) for i in range(n)]
        return quads(name, V, Q, mat, UV)

    strip('Band', -0.075, 0.0, 0.015, 0.0, mats['band'])
    strip('Lip', -0.18, -0.075, 0.05, 0.015, mats['gloss'])
    strip('Band2', -0.2, -0.18, 0.05, 0.05, mats['band2'])
    strip('Lip2', -0.30, -0.2, 0.08, 0.05, mats['gloss'])
    strip('Step', -0.34, -0.30, 0.0, 0.08, mats['gloss'])
    strip('FrontWall', -1.3, -0.34, 0.0, 0.0, mats['gloss'])
    frame = Bag()
    for x, lean in ((1.78, 0.0), (2.1, 0.3), (5.4, 0.0), (9.0, 0.0)):
        for sgn in (-1, 1):
            xs_ = sgn * x
            frame.tubes([(xs_ + sgn * lean, front_y(xs_) - 0.01, -1.3)], [(xs_, front_y(xs_) - 0.01, -0.36)], 0.02, 4)
    frame.build('FrontFrames', mats['trim'])
    # 奥の縁の細い線。中央は水色、左右はピンク
    for name, lo, hi, key in (('RearC', -2.0, 2.0, 'rearline'), ('RearL', -13.8, -2.0, 'neon_p'), ('RearR', 2.0, 13.8, 'neon_p')):
        b = Bag()
        b.line([(float(x), rear_y(float(x)) - 0.005, 0.02) for x in np.linspace(lo, hi, 50)], 0.008)
        b.build(name, mats[key]).visible_glossy = False


def build_riser(mats):
    # 奥の段。中央に 5 段の階段。段の端にだけ細い水色の線
    half = 1.92
    deck = Bag()
    xs = np.linspace(half, 13.8, 40)
    for sign in (-1, 1):
        for a, b in zip(xs[:-1], xs[1:]):
            a, b = float(a), float(b)
            pts = [(sign * a, rear_y(a), 0), (sign * b, rear_y(b), 0), (sign * b, rear_y(b), RISER), (sign * a, rear_y(a), RISER)]
            deck.box(pts + [(p[0], 11.0, p[2]) for p in pts])
    deck.box([(-half, 6.75, 0), (half, 6.75, 0), (half, 6.75, RISER), (-half, 6.75, RISER), (-half, 11, 0), (half, 11, 0), (half, 11, RISER), (-half, 11, RISER)])
    steps = 5
    lit = Bag()
    y0 = rear_y(0)
    for i in range(steps):
        z0, z1 = RISER * i / steps, RISER * (i + 1) / steps
        y1 = y0 + i * 0.2
        y2 = 6.8
        deck.box([(-half, y1, z0), (half, y1, z0), (half, y1, z1), (-half, y1, z1), (-half, y2, z0), (half, y2, z0), (half, y2, z1), (-half, y2, z1)])
        lit.tubes([(-half, y1 - 0.005, z1 - 0.006)], [(half, y1 - 0.005, z1 - 0.006)], 0.006, 4)
    deck.build('Riser', mats['riser'])
    lit.build('StepLights', mats['step'])


def wall_lines():
    def xy(m, u, v):
        return m.f('DIVIDE', m.f('ABSOLUTE', m.f('SUBTRACT', u, 0.5)), 0.363), m.f('DIVIDE', m.f('SUBTRACT', v, 0.512), 0.458)

    def chevron(sign):
        def fn(m, u, v):
            x, y = xy(m, u, v)
            d = m.f('MULTIPLY', m.f('ABSOLUTE', m.f('ADD', m.f('SUBTRACT', m.f('MULTIPLY', y, sign), 1.0), x)), 0.34)
            return m.f('ADD', d, m.f('MULTIPLY', m.f('MAXIMUM', m.f('SUBTRACT', x, 1.0), 0.0), 0.5))  # 菱形の外では線から離れていく
        return fn

    def outer(sign):
        def fn(m, u, v):
            x, y = xy(m, u, v)
            d = m.f('MULTIPLY', m.f('ABSOLUTE', m.f('ADD', m.f('SUBTRACT', m.f('MULTIPLY', y, sign), 1.0), x)), 0.34)
            return m.f('ADD', d, m.f('MULTIPLY', m.f('MAXIMUM', m.f('SUBTRACT', 1.0, x), 0.0), 0.5))  # 菱形の外へ伸びる部分
        return fn

    def apex(m, u, v):  # 菱形の頂点が画面で一番明るい
        return m.f('SQRT', m.f('ADD', m.f('POWER', m.f('SUBTRACT', u, 0.5), 2.0), m.f('POWER', m.f('MULTIPLY', m.f('SUBTRACT', v, 0.965), 0.7), 2.0)))

    return [
        (chevron(1), (1.0, 0.32, 0.85), 0.001, 0.01, 2.8),
        (chevron(-1), (0.3, 0.8, 1.0), 0.001, 0.01, 2.8),
        (outer(1), (0.5, 0.8, 1.0), 0.0006, 0.005, 0.9),
        (outer(-1), (0.9, 0.6, 1.0), 0.0006, 0.005, 0.9),
        (apex, (1.0, 0.8, 0.98), 0.012, 0.05, 3.0),
    ]


def seg(a, b):
    """UV の 2 点を通る直線までの距離"""
    (x0, y0), (x1, y1) = a, b
    nx, ny = y0 - y1, x1 - x0
    k = math.hypot(nx, ny)
    nx, ny = nx / k, ny / k

    def fn(m, u, v):
        return m.f('ABSOLUTE', m.f('ADD', m.f('MULTIPLY', m.f('SUBTRACT', u, x0), nx), m.f('MULTIPLY', m.f('SUBTRACT', v, y0), ny)))
    return fn


def side_lines():
    """左右の LED を 1 枚の絵として走る線。座標は左の板の target の画素"""
    def uv(px, py):
        return (px - SIDE_BOX[0]) / (SIDE_BOX[1] - SIDE_BOX[0]), (SIDE_BOX[3] - py) / (SIDE_BOX[3] - SIDE_BOX[2])

    return [
        (seg(uv(126, 719), uv(257, 881)), (0.7, 0.85, 1.0), 0.002, 0.012, 1.5),
        (seg(uv(109, 822), uv(249, 972)), (1.0, 0.55, 0.9), 0.002, 0.012, 1.4),
        (seg(uv(211, 660), uv(270, 744)), (0.8, 0.6, 1.0), 0.0015, 0.01, 0.9),
        (seg(uv(108, 770), uv(190, 660)), (0.6, 0.85, 1.0), 0.0012, 0.008, 0.6),
        (seg(uv(150, 896), uv(272, 720)), (0.9, 0.6, 1.0), 0.0012, 0.008, 0.6),
        (seg(uv(160, 640), uv(250, 960)), (0.6, 0.8, 1.0), 0.001, 0.006, 0.4),
    ]


def build_center_wall(assets, clk, mats):
    mat = led_material('led_center', assets / 'led_center.png', assets / 'led_sparks.png', assets / 'led_bolts.png', clk, wall_lines(), strength=2.0, tint=((0.8, 1.1, 1.1), (1.0, 1.05, 1.15)), lift=(0.1, 0.08, 0.24), bottom=(0.5, 0.2, 0.6), zoom=1.22)

    def surf(s, t):
        x = -3.75 + 7.5 * s
        k = 1 - (2 * s - 1) ** 2
        d0, d1 = 16.0 + 1.2 * k, 17.0 + 1.2 * k
        h = 0.3 + 6.42 * t
        x *= 1 - 0.04 * t
        return (x, CAM.y + d0 + (d1 - d0) * t, h)

    V, Q, UV = grid(surf, 64, 16)
    quads('WallCenter', V, Q, mat, UV)
    # 裏の箱と上の縁
    back = Bag()
    for i in range(64):
        s0, s1 = i / 64, (i + 1) / 64
        f = [Vector(surf(s0, 0)), Vector(surf(s1, 0)), Vector(surf(s1, 1)), Vector(surf(s0, 1))]
        back.box([tuple(p + Vector((0, 0.02, 0))) for p in f] + [tuple(p + Vector((0, 0.4, 0))) for p in f])
    back.build('WallCenterBack', mats['black'])


def build_side(side, assets, clk, mats):
    tag = 'R' if side > 0 else 'L'

    def Pm(u, v, d):
        p = P(u, v, d)
        p.x = side * abs(p.x)
        return p

    # 2 枚の LED は段の上に立つ。四隅は左下、右下、右上、左上(左の板の画素)。UV は画素そのものなので絵と線が 2 枚をまたいでつながる
    pxB = [(155, 917), (249, 972), (273, 706), (188, 660)]
    pxA = [(109, 822), (150, 896), (179, 651), (140, 622)]
    dA, dB = (14.6, 15.0, 15.0, 14.6), (15.2, 16.1, 16.1, 15.2)
    black, lit = Bag(), Bag()
    for name, pix, dep in (('B', pxB, dB), ('A', pxA, dA)):
        q = [Pm(u, v, d) for (u, v), d in zip(pix, dep)]
        uvq = [Vector(((u - SIDE_BOX[0]) / (SIDE_BOX[1] - SIDE_BOX[0]), (SIDE_BOX[3] - v) / (SIDE_BOX[3] - SIDE_BOX[2]), 0)) for u, v in pix]
        V, Q, UV = grid(lambda s, t: tuple(bilinear(q, s, t)), 8, 8)
        UV = [tuple(bilinear(uvq, s, t))[:2] for s, t in UV]
        if side > 0:
            Q = [tuple(reversed(f)) for f in Q]
        quads(f'Wall{name}{tag}', V, Q, SIDE_LED['mat'], UV)
        # 裏の箱と、段まで下りる脚
        back = [p + Vector((0, 0.03, 0)) for p in q]
        black.box([tuple(p) for p in back] + [tuple(p + Vector((0, 0.4, 0))) for p in back])
        for p in (q[0], q[1]):
            lit.tubes([p + Vector((0, 0.25, 0))], [(p.x, p.y + 0.25, RISER)], 0.07, 6)
        if name == 'B':  # 内側の板の下は黒い面で段へ収める
            low = [Vector((p.x, p.y + 0.05, RISER)) for p in (q[0], q[1])]
            black.box([tuple(q[0] + Vector((0, 0.05, 0))), tuple(q[1] + Vector((0, 0.05, 0))), tuple(low[1]), tuple(low[0]),
                       tuple(q[0] + Vector((0, 0.4, 0))), tuple(q[1] + Vector((0, 0.4, 0))), tuple(low[1] + Vector((0, 0.35, 0))), tuple(low[0] + Vector((0, 0.35, 0)))])

    def boxq(u0, v0, u1, v1, u2, v2, u3, v3, d0, d1, depth=1.0):
        f = [Pm(u0, v0, d0), Pm(u1, v1, d1), Pm(u2, v2, d1), Pm(u3, v3, d0)]
        return f + [p + Vector((0, depth, 0)) for p in f]

    # 吊ったスピーカーの塔
    tower = boxq(50, 838, 90, 841, 141, 516, 114, 510, 14.2, 14.8)
    V = [tuple(p) for p in tower]
    Qt = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    uv = [(0, 0), (1, 0), (1, 1), (0, 1), (0, 0), (1, 0), (1, 1), (0, 1)]
    quads(f'Tower{tag}', V, [tuple(reversed(f)) if side > 0 else f for f in Qt], mats['speaker'], uv)
    for k in (2, 3):
        lit.tubes([tower[k]], [(side * 6.5, tower[k].y, 13)], 0.03, 6)
    # 2 枚の間の細い柱。LED の前に斜めに重なる
    black.box(boxq(141, 1006, 151, 1006, 193, 650, 184, 648, 14.5, 14.5, 0.2))
    # LED と中央の壁の間の柱はトラスの枠
    a, b = Pm(280, 1006, 16.4), Pm(292, 716, 16.7)
    n = 13
    Pts = np.array([tuple(a.lerp(b, i / (n - 1))) for i in range(n)], float)
    Up = np.tile([1.0, 0, 0], (n, 1))
    truss(TRUSS['ch_q'], TRUSS['la_q'], Pts, Up, 0.92, 0.45, 0.04, 0.016)
    back = boxq(258, 1006, 306, 1006, 312, 722, 274, 708, 18.3, 18.3, 0.3)  # 中央の壁より奥に置き、斜めの壁と重ならない
    black.box(back)
    black.box(boxq(283, 1006, 304, 1006, 313, 716, 297, 716, 15.85, 15.85, 0.3))  # 傾いた壁の端と柱の隙間を隠す板
    for i in range(9):
        t = i / 8
        c = a.lerp(b, 0.1 + 0.8 * t)
        add_dot(Vector((c.x, c.y - 0.3, c.z)), (1.0, 0.25, 0.75) if i % 2 else (0.75, 0.85, 1.0), 0.016)
    # 上の三角の枠
    tri = [Pm(154, 544, 14.5), Pm(179, 634, 14.9), Pm(143, 605, 14.6)]
    quads(f'Tri{tag}', [tuple(p) for p in tri] + [tuple(tri[2])], [(0, 1, 2, 3) if side < 0 else (3, 2, 1, 0)], mats['tri'], [(0.5, 0), (1, 1), (0, 1), (0, 1)])
    black.box([tuple(p + Vector((0, 0.03, 0))) for p in tri + [tri[2]]] + [tuple(p + Vector((0, 0.25, 0))) for p in tri + [tri[2]]])
    black.build(f'SideBlack{tag}', mats['black'])
    lit.build(f'SideLegs{tag}', mats['fixture'])

    neon_c, neon_p = Bag(), Bag()
    neon_c.line([Pm(140, 622, 14.55), Pm(109, 822, 14.55), Pm(91, 955, 14.6), Pm(84, 1000, 14.6)], 0.008)
    neon_c.line([Pm(188, 650, 14.45), Pm(146, 1000, 14.45)], 0.008)
    neon_c.line([Pm(190, 643, 15.1), Pm(272, 704, 16.05)], 0.008)
    neon_p.line([Pm(154, 544, 14.5), Pm(179, 634, 14.9)], 0.009)
    neon_p.line([Pm(154, 544, 14.5), Pm(143, 605, 14.6)], 0.009)
    neon_p.line([Pm(143, 605, 14.6), Pm(179, 634, 14.9)], 0.009)
    neon_c.line([Pm(109, 822, 14.55), Pm(146, 894, 14.9)], 0.007)
    neon_p.line([Pm(150, 575, 14.55), Pm(170, 625, 14.85)], 0.006)
    neon_c.line([Pm(129, 875, 14.8), Pm(93, 934, 14.6)], 0.006)
    for bag_, name_, key in ((neon_c, 'NeonC', 'neon_c'), (neon_p, 'NeonP', 'neon_p')):
        o = bag_.build(f'{name_}{tag}', mats[key])
        o.visible_glossy = False  # 細い線は床へ映すと棒に見える


def add_dot(p, color, r):
    """小さな光の点"""
    o = link(bpy.data.objects.new('dot', DOT['mesh']))
    o.location = p
    o.scale = (r, r, r)
    o.color = (*color, 1)
    rays(o, False, False)
    return o


DOT = {}


def make_dot_meshes(mats):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
    me = bpy.data.meshes.new('dotcore')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mats['dotcore'])
    DOT['mesh'] = me
    DOT['core'] = mats['dotcore']
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
    me = bpy.data.meshes.new('halo')
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.materials.append(mats['halo'])
    DOT['halo_mesh'] = me


def truss(ch, la, Pts, Up, h=0.8, w=0.5, r_ch=0.045, r_la=0.021, top=None):
    Pts, Up = np.asarray(Pts, float), np.asarray(Up, float)
    T = np.gradient(Pts, axis=0)
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    S = np.cross(T, Up)
    S /= np.linalg.norm(S, axis=1, keepdims=True)
    C = [Pts + Up * a * h / 2 + S * b * w / 2 for a, b in ((1, 1), (1, -1), (-1, -1), (-1, 1))]
    for k, c in enumerate(C):
        if top is not None and k < 2:
            top.tubes(c[:-1], c[1:], r_ch * 0.5, 6)  # 上弦は細い光の線
        ch.tubes(c[:-1] if k >= 2 or top is None else c[:-1] - Up[:-1] * 0.05, c[1:] if k >= 2 or top is None else c[1:] - Up[1:] * 0.05, r_ch, 6)
    for k in range(4):
        a, b = C[k], C[(k + 1) % 4]
        la.tubes(a, b, r_la * 0.8, 4)
        la.tubes(a[::2][:-1], b[1::2][:len(a[::2]) - 1], r_la, 4)
        la.tubes(b[1::2][:len(a[::2]) - 1], a[2::2], r_la, 4)


ARCHES = ((10.2, 75, 145, 151), (13.9, 298, 238, 363), (18.5, 443, 285, 484), (27.5, 588, 357, 613))  # 奥行き、中央の v、端の u, v
TRUSS = {'ch_q': Bag(), 'la_q': Bag()}  # 柱のトラス。build_trusses がまとめて作る


def build_trusses(mats):
    ch, la, lo, up = Bag(), Bag(), Bag(), Bag()
    ends = []
    for d, vtop, uend, vend in ARCHES:
        y = P(470, vtop, d).y
        top = P(470, vtop, d)
        end = P(uend, vend, d)
        w, rise = abs(end.x), top.z - end.z
        R = (w ** 2 + rise ** 2) / (2 * rise)
        lim = math.asin(w / R)
        phis = np.linspace(-lim, lim, 15)
        Pts = np.stack([R * np.sin(phis), np.full(15, y), top.z - R + R * np.cos(phis)], 1)
        Up = np.stack([np.sin(phis), np.zeros(15), np.cos(phis)], 1)
        truss(ch, la, Pts, Up, 0.55, 0.2, 0.045 * (0.75 + d / 40), 0.021 * (0.75 + d / 40), top=up)
        ends.append((y, w, end.z))
        for sx in (-1, 1):
            lo.tubes([(sx * w, y, top.z - rise)], [(sx * w, y, 26)], 0.02, 4)
    W, Z = ends[0][1], ends[0][2]
    ys = np.arange(-14.0, 30.0, 0.8)
    for x, z in ((W, Z), (-W, Z), (6.5, Z), (-6.5, Z)):
        Pts = np.stack([np.full(len(ys), x), ys, np.full(len(ys), z)], 1)
        truss(lo, lo, Pts, np.tile([0, 0, 1.0], (len(ys), 1)), 0.7, 0.9, 0.06, 0.03)
    for y, _, _ in ends:
        for sx in (-1, 1):
            lo.tubes([(sx * W, y, Z)], [(sx * 6.5, y, Z)], 0.05, 6)
            lo.tubes([(sx * 6.5, y, Z)], [(sx * 6.5, y, 26)], 0.012, 4)
    ch.build('TrussChord', mats['chord'])
    up.build('TrussTop', mats['chord_top'])
    la.build('TrussLace', mats['lace'])
    lo.build('TrussLong', mats['long'])
    TRUSS['ch_q'].build('QChord', mats['q'])
    TRUSS['la_q'].build('QLace', mats['q'])


BEAMS = [
    (263, 148, 10.0, 165, -30, 5.0, CYAN, 90.0, 0.3, 0),
    (144, 190, 10.0, -80, 460, 4.5, PINK, 7.5, 0.95, 1),
    (144, 190, 10.0, -30, -40, 5.0, PINK, 0.8, 0.9, 1),
    (409, 99, 10.0, 335, 340, 9.0, CYAN, 3.4, 0.8, 2),
    (328, 165, 10.2, 285, 410, 9.5, CYAN, 1.5, 0.8, 2),
    (235, 168, 10.0, 190, 285, 9.0, CYAN, 2.0, 0.45, 0),
    (168, 290, 11.0, 60, 620, 7.5, BLUE, 0.6, 0.45, 1),
    (205, 380, 12.5, 290, 545, 12.5, PINK, 1.25, 1.2, 3),
    (205, 380, 12.5, 118, 190, 7.5, PINK, 0.6, 0.5, 3),
    (307, 361, 13.9, 298, 495, 13.0, CYAN, 2.2, 0.4, 2),
    (396, 339, 13.9, 386, 440, 13.0, CYAN, 1.0, 0.35, 2),
    (422, 472, 18.5, 300, 660, 17.0, CYAN, 1.0, 0.8, 3),
    (364, 488, 18.5, 470, 660, 17.0, CYAN, 1.0, 0.8, 3),
    (290, 511, 18.5, 170, 660, 16.0, BLUE, 1.1, 0.8, 3),
    (205, 560, 22.0, 197, 650, 22.0, CYAN, 0.7, 0.5, 2),
    (431, 622, 27.5, 485, 745, 27.0, PINK, 2.0, 1.3, 2),
    (351, 631, 27.5, 356, 745, 27.0, PINK, 1.5, 1.2, 2),
    (276, 615, 27.5, 262, 715, 27.0, PINK, 1.5, 1.2, 2),
    (63, 675, 31.0, 47, 770, 31.0, PINK, 0.55, 0.9, 2),
    (17, 654, 31.0, 3, 745, 31.0, PINK, 0.55, 0.9, 2),
    (314, 622, 27.5, 311, 655, 27.0, CYAN, 0.9, 0.3, 2),
    (393, 628, 27.5, 392, 660, 27.0, CYAN, 0.9, 0.3, 2),
]
# 灯体だけの暗い機材(左半分)
FIXTURES = [(191, 171, 10.2), (101, 181, 10.2), (64, 44, 8.5), (30, 12, 8.5), (336, 343, 13.9), (268, 383, 13.9), (327, 494, 18.5), (390, 467, 18.5)]
CENTER_FIXTURES = [(470, 104, 10.2), (470, 315, 13.9), (470, 470, 18.5), (470, 605, 27.5)]
HEAD_SIZE = {328: 1.3, 168: 1.1}
CORE = {205: 4.0, 263: 3.6}  # 芯が大きい灯体  # 大きい頭の灯体。ほかは小さい


def make_head_mesh(mats):
    """灯体の頭。-Z が光の向き。原点がレンズ"""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=0.2, radius2=0.26, depth=0.62, matrix=Matrix.Translation((0, 0, 0.31)))
    uv = bm.loops.layers.uv.new('UVMap')
    ret = bmesh.ops.create_circle(bm, cap_ends=True, segments=20, radius=0.05, matrix=Matrix.Translation((0, 0, -0.005)))
    for v in ret['verts']:
        for lp in v.link_loops:
            lp[uv].uv = (v.co.x / 0.1 + 0.5, v.co.y / 0.1 + 0.5)
        for f in v.link_faces:
            f.material_index = 1
    me = bpy.data.meshes.new('head')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mats['fixture'])
    me.materials.append(mats['lens'])
    return me


def make_cone_mesh(mats):
    """長さ 1、先の半径 1 の円すい。-Z へ伸びる。V が根元 0、先 1"""
    sides, rings = 28, 6
    V, UV = [], []
    for j in range(rings + 1):
        v = j / rings
        r = 0.05 + 0.95 * v
        for i in range(sides + 1):
            a = i / sides * 2 * math.pi
            V.append((r * math.cos(a), r * math.sin(a), -v))
            UV.append((i / sides, v))
    Q = [(j * (sides + 1) + i, j * (sides + 1) + i + 1, (j + 1) * (sides + 1) + i + 1, (j + 1) * (sides + 1) + i) for j in range(rings) for i in range(sides)]
    o = quads('cone_proto', V, Q, mats['beam'], UV, smooth=True)
    me = o.data
    bpy.data.objects.remove(o)
    return me


def place_fixture(p, q, color, alpha, head_me, side_bag, size=0.55):
    """灯体を置く。動かす親は空の pivot"""
    pivot = link(bpy.data.objects.new('pivot', None))
    pivot.location = p
    pivot.rotation_mode = 'XYZ'
    pivot.rotation_euler = q.to_euler()
    head = link(bpy.data.objects.new('head', head_me))
    head.parent = pivot
    head.scale = (size, size, size)
    head.color = (*color, alpha)
    # 動かない腕と台
    back = p + q @ Vector((0, 0, 0.3 * size))
    for s in (-1, 1):
        side_bag.tubes([back + Vector((s * 0.3 * size, 0, 0))], [back + Vector((s * 0.3 * size, 0, 0.5 * size))], 0.04 * size, 4)
    side_bag.tubes([back + Vector((-0.3 * size, 0, 0.5 * size))], [back + Vector((0.3 * size, 0, 0.5 * size))], 0.1 * size, 4)
    return pivot


def build_beams(mats):
    head_me = make_head_mesh(mats)
    cone_me = make_cone_mesh(mats)
    yoke = Bag()
    rigs = []
    down = Vector((0, 0, -1))
    for row in BEAMS:
        u, v, d, tu, tv, td, col, strength, radius, group = row
        if col is not PINK:  # 青の光線は濃く細く
            radius, strength = radius * 0.72, strength * 0.68
        for sgn in (-1, 1):
            a, b = P(u, v, d), P(tu, tv, td)
            if sgn > 0:
                a.x, b.x = -a.x, -b.x
            axis = b - a
            q = down.rotation_difference(axis.normalized())
            piv = place_fixture(a, q, col, 1.0, head_me, yoke, HEAD_SIZE.get(u, 0.55))
            cone = link(bpy.data.objects.new('beam', cone_me))
            cone.parent = piv
            cone.scale = (radius, radius, axis.length * 1.6)  # 色が消える所が先になるよう長めに
            cone.color = (*col, strength)
            rays(cone, False, False)
            air = link(bpy.data.objects.new('beam_air', cone_me))  # 光線の周りに散る光
            air.parent = piv
            air.scale = (radius * 2.4, radius * 2.4, axis.length * 1.9)
            air.color = (col[0] * 0.8, col[1] + 0.14, col[2], min(strength, 6.0) * (0.17 if col is PINK else 0.36) * min(1.0, 0.5 / radius))  # 空気は少し緑を含む
            rays(air, False, False)
            h = link(bpy.data.objects.new('lamp_glow', DOT['halo_mesh']))
            h.location = a
            h.scale = (0.09 * d / 10,) * 3
            h.color = (*col, 0.75)
            rays(h, False, False)
            add_core = link(bpy.data.objects.new('lamp_core', DOT['mesh']))
            add_core.location = a
            add_core.scale = (CORE.get(u, 1.0) * 0.014 * d / 10,) * 3
            add_core.color = (*col, 1)
            rays(add_core, False, False)
            rigs.append((piv, sgn, group))
    q = down.rotation_difference(Vector((0, -0.25, -1)).normalized())
    for u, v, d in FIXTURES:
        for sgn in (-1, 1):
            a = P(u, v, d)
            a.x = abs(a.x) * sgn
            place_fixture(a, q, (1, 0.2, 0.6), 0.2, head_me, yoke, 0.6)
    for u, v, d in CENTER_FIXTURES:
        place_fixture(P(u, v, d), q, (1, 0.2, 0.6), 0.5, head_me, yoke, 0.45)
    yoke.build('Yokes', mats['fixture'])
    return rigs


def build_floor_lights(mats):
    """奥の段の上のムービングライト 8 台と、壁の上の小さな灯り"""
    head_me = bpy.data.meshes['head']
    yoke = Bag()
    aim = Vector((0, 0, -1)).rotation_difference(Vector((0, -0.8, 0.6)).normalized())
    for u in (260, 283, 354, 381):
        for sgn in (-1, 1):
            a = P(u, 990, 15.6)
            a.z = RISER + 0.3
            a.x = abs(a.x) * sgn
            head = link(bpy.data.objects.new('floorhead', head_me))
            head.location = a
            head.scale = (0.75, 0.75, 0.75)
            head.rotation_euler = aim.to_euler()
            head.color = (1, 0.35, 0.8, 0.2) if u in (260, 283) else (1, 0.8, 0.95, 0.12)
            yoke.box([(a.x - 0.2, a.y - 0.2, RISER), (a.x + 0.2, a.y - 0.2, RISER), (a.x + 0.2, a.y - 0.2, RISER + 0.12), (a.x - 0.2, a.y - 0.2, RISER + 0.12),
                      (a.x - 0.2, a.y + 0.2, RISER), (a.x + 0.2, a.y + 0.2, RISER), (a.x + 0.2, a.y + 0.2, RISER + 0.12), (a.x - 0.2, a.y + 0.2, RISER + 0.12)])
    # 階段の両脇の小さな箱
    for x in (2.05, 2.5, 3.1):
        for sgn in (-1, 1):
            c = (sgn * x, 6.1)
            yoke.box([(c[0] - 0.12, c[1] - 0.12, RISER), (c[0] + 0.12, c[1] - 0.12, RISER), (c[0] + 0.12, c[1] - 0.12, RISER + 0.2), (c[0] - 0.12, c[1] - 0.12, RISER + 0.2),
                      (c[0] - 0.12, c[1] + 0.12, RISER), (c[0] + 0.12, c[1] + 0.12, RISER), (c[0] + 0.12, c[1] + 0.12, RISER + 0.2), (c[0] - 0.12, c[1] + 0.12, RISER + 0.2)])
    yoke.build('FloorYokes', mats['fixture'])
    for u in (260, 283):  # 外側の灯体のピンクの光
        for sgn in (-1, 1):
            a = P(u, 986, 15.4)
            a.x = abs(a.x) * sgn
            add_dot(a, (1.0, 0.25, 0.75), 0.05)
    for u, v, d in ((470, 100, 10.0), (470, 312, 13.7), (65, 45, 8.4), (58, 52, 8.4), (72, 52, 8.4)):  # 上の器具の小さなピンクの点
        for sgn in (-1, 1):
            a = P(u, v, d)
            a.x = abs(a.x) * sgn
            add_dot(a, (1.0, 0.15, 0.6), 0.02)
    for u in (349, 380, 424, 513, 553, 587):
        add_dot(P(u, 714, 20), (0.6, 0.8, 1.0), 0.012)


def ring(th, k, a0=16.0, rear=7.1, front=16.0):
    a = a0 + k
    b = (rear if math.cos(th) > 0 else front) + k
    return a * math.sin(th), b * math.cos(th)


def tier_z(k):
    # 1 階席、手すりの帯、2 階席、3 階席
    if k <= 8:
        return -1.3 + k * 0.4
    if k <= 18:
        return 2.2 + (k - 9) * 0.36
    return 6.5 + (k - 18) * 0.62


def in_rear(th):
    a = (th + math.pi) % (2 * math.pi) - math.pi
    return abs(a) < math.radians(24)


def build_arena(mats):
    rows = np.arange(0, 36, 1.0)  # 手すりは段の縁の高さへ
    ths = np.linspace(0, 2 * math.pi, 241)
    V, Q = [], []
    idx = 0
    for k in rows:
        for th0, th1 in zip(ths[:-1], ths[1:]):
            if in_rear(float(th0)):
                continue
            x0, y0 = ring(th0, k)
            x1, y1 = ring(th1, k)
            x2, y2 = ring(th1, k + 1)
            x3, y3 = ring(th0, k + 1)
            z0, z1 = tier_z(k), tier_z(k + 1)
            V += [(x0, y0, z0), (x1, y1, z0), (x2, y2, z0), (x3, y3, z0), (x3, y3, z1), (x2, y2, z1)]
            Q += [(idx, idx + 1, idx + 2, idx + 3), (idx + 3, idx + 2, idx + 5, idx + 4)]
            idx += 6
    quads('Tiers', V, Q, mats['tier'])
    # 下の壁、ピット、奥の壁、天井
    quads('Pit', [(-60, -60, -1.3), (60, -60, -1.3), (60, 60, -1.3), (-60, 60, -1.3)], [(0, 1, 2, 3)], mats['pit'])
    quads('Roof', [(-60, -60, 27), (60, -60, 27), (60, 60, 27), (-60, 60, 27)], [(3, 2, 1, 0)], mats['roof'])
    quads('BackWall', [(-30, 26, -1.3), (30, 26, -1.3), (30, 26, 27), (-30, 26, 27)], [(0, 1, 2, 3)], mats['hall'])
    wall = Bag()
    for th0, th1 in zip(ths[:-1], ths[1:]):
        p0 = (*ring(th0, 36), tier_z(36))
        p1 = (*ring(th1, 36), tier_z(36))
        wall.add(np.array([p0, p1, (p1[0], p1[1], 27), (p0[0], p0[1], 27)], float), np.array([[0, 1, 2, 3]]))
    wall.build('OuterWall', mats['hall'])
    # 客席の縁の光の線。切れ目を入れる
    pinks = Bag()
    # 2 階の前の手すり。切らずに客席を 1 周させる
    pinks.line([(*ring(float(t), 18.4), tier_z(18.4) + 0.9) for t in ths if not in_rear(float(t))], 0.04, 4)
    # 上階の、奥へ走る梁とピンクの線、点の列
    beam, dots = Bag(), []
    for sgn in (-1, 1):
        a, b = P(0, 482, 14 * F / 470), P(100, 575, 14 * F / 370)
        a.x, b.x = sgn * abs(a.x), sgn * abs(b.x)
        pts = np.array([tuple(a.lerp(b, t / 23)) for t in range(24)], float)
        truss(beam, beam, pts, np.tile([0, 0, 1.0], (24, 1)), 0.5, 0.5)
        pinks.line(pts + (0, 0, 0.3), 0.04, 4)
        pinks.line(pts + (sgn * 1.2, 0, -0.9), 0.03, 4)  # 平行な段
        pinks.line(pts + (sgn * 2.2, 0, -1.9), 0.03, 4)
        for t in range(120):
            dots.append(tuple(a.lerp(b, t / 119) + Vector((0, 0, 0.42))))
    beam.build('UpperRail', mats['long'])
    for p_ in dots[::3]:
        add_dot(Vector(p_), (1.0, 0.3, 0.8), 0.03)
    pinks.build('TierRails', mats['rail'])


def build_crowd(mats):
    rng = np.random.default_rng(5)
    pts, cols, sizes, seats = [], [], [], []
    palette = np.array([(1.0, 0.05, 0.55), (0.75, 0.1, 1.0), (0.1, 0.5, 1.0), (1.0, 0.8, 0.95), (0.4, 0.2, 1.0), (1.0, 0.15, 0.8)])
    weights = [0.36, 0.34, 0.12, 0.02, 0.1, 0.06]

    def push(xyz, size):
        xyz = np.asarray(xyz)
        pts.append(xyz)
        cols.append(palette[rng.choice(6, len(xyz), p=weights)])
        sizes.append(np.full(len(xyz), size))
        cols[-1] = cols[-1] * (0.4 if size < 0.023 else 1.0)  # 3 階は暗く

    groups = ((np.arange(0.3, 6.4, 0.6), 34.0, 0.024), (np.arange(10.4, 15.6, 0.6), 14.0, 0.024), (np.arange(21.0, 35, 1.0), 2.5, 0.022))
    for rows, dens, size in groups:
        for k in rows:
            n = int(2 * math.pi * (16 + k) * dens)
            th = rng.uniform(0, 2 * math.pi, n)
            keep = np.array([not in_rear(float(t)) for t in th])
            th = th[keep]
            a, r, f = 16.0 + k, 7.1 + k, 16.0 + k
            cs = np.cos(th)
            x = a * np.sin(th)
            y = np.where(cs > 0, r, f) * cs
            ok = ~((y > 0) & (np.abs(x) < 0.52 * (y + 9.3)))  # 壁の後ろの席は作らない
            x, y = x[ok] + rng.normal(0, 0.12, ok.sum()), y[ok] + rng.normal(0, 0.12, ok.sum())
            z = np.full(len(x), tier_z(float(k)))
            if k < 19:
                seats.append(np.stack([x, y, z], 1)[::3])
            push(np.stack([x, y, z + rng.uniform(1.5, 1.95, len(x))], 1), size)
    # ピットの観客
    n = 26000
    x = rng.uniform(-16, 16, n)
    y = rng.uniform(-16, 3, n)
    fr = np.array([front_y(float(v)) for v in np.clip(x, -13.9, 13.9)])
    ok = (y < fr - 0.9) & ((x / 16) ** 2 + (y / 16) ** 2 < 1) & ~(np.abs(x) < 0.72 * (y + 9.3) + 1.2)
    seats.append(np.stack([x[ok], y[ok], np.full(ok.sum(), -1.3)], 1)[::2])
    push(np.stack([x[ok], y[ok], rng.uniform(0.3, 0.8, ok.sum())], 1), 0.075)
    p = np.concatenate(pts)
    c = np.concatenate(cols)
    w = np.concatenate(sizes)[:, None, None] * rng.uniform(0.8, 1.25, len(p))[:, None, None]
    off = np.array([(-1, 0, -1), (1, 0, -1), (1, 0, 1), (-1, 0, 1), (0, -1, -1), (0, 1, -1), (0, 1, 1), (0, -1, 1)], float)
    corner = np.array([(0, 0), (1, 0), (1, 1), (0, 1)] * 2, float)
    V = (p[:, None] + off[None] * w).reshape(-1, 3)
    Q = (np.array([[0, 1, 2, 3], [4, 5, 6, 7]])[None] + (np.arange(len(p)) * 8)[:, None, None]).reshape(-1, 4)
    UV = np.tile(corner, (len(p), 1))
    o = quads('Crowd', V, Q, mats['penlight'], UV)
    me = o.data
    col = me.attributes.new('col', 'FLOAT_COLOR', 'POINT')
    col.data.foreach_set('color', np.concatenate([np.repeat(c, 8, 0), np.ones((len(p) * 8, 1))], 1).ravel().astype(np.float32))
    rnd = me.attributes.new('rnd', 'FLOAT', 'POINT')
    rnd.data.foreach_set('value', np.repeat(rng.random(len(p)), 8).astype(np.float32))
    rays(o, False, False)
    o.visible_glossy = False
    # 客の体。胴と頭の暗い箱
    b = np.concatenate(seats)
    bag = Bag()
    for z0, z1, hw in ((0.0, 1.25, 0.2), (1.28, 1.52, 0.1)):
        lo = b + (0, 0, z0)
        hi = b + (0, 0, z1)
        corners = np.array([(-1, -1), (1, -1), (1, 1), (-1, 1)], float) * hw
        ring0 = lo[:, None] + np.c_[corners, np.zeros(4)][None]
        ring1 = hi[:, None] + np.c_[corners, np.zeros(4)][None]
        V = np.concatenate([ring0, ring1], 1).reshape(-1, 3)
        one = np.array([[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]])
        bag.add(V, (one[None] + (np.arange(len(b)) * 8)[:, None, None]).reshape(-1, 4))
    rays(bag.build('CrowdBodies', mats['body']), False, False)


def build_smoke(assets, clk, cam):
    """煙の板。Z 軸まわりにカメラを向き続けるので、どの角度から見ても板に見えない。左右の端に量を寄せる"""
    bank = smoke_material(assets / 'smoke_bank.png', clk)
    rng = np.random.default_rng(2)

    def card(name, mat, x, y, w, h, z, col, alpha, flip):
        V = [(-w / 2, 0, z), (w / 2, 0, z), (w / 2, 0, z + h), (-w / 2, 0, z + h)]
        uv = [(1, 0), (0, 0), (0, 1), (1, 1)] if flip else [(0, 0), (1, 0), (1, 1), (0, 1)]
        o = quads(name, V, [(0, 1, 2, 3)], mat, uv)
        o.location = (x, y, 0)
        o.color = (*col, alpha)
        c = o.constraints.new('LOCKED_TRACK')
        c.target = cam
        c.track_axis = 'TRACK_NEGATIVE_Y'
        c.lock_axis = 'LOCK_Z'
        rays(o, False, False)
        return o

    blue = [(0.42, 0.6, 1.0), (0.36, 0.52, 1.0), (0.6, 0.55, 1.0)]
    pink = [(0.85, 0.4, 1.0), (0.7, 0.45, 1.0)]
    rows = []
    for i, (x, w, a) in enumerate(((3.0, 2.4, 0.7), (4.4, 3.2, 0.9), (5.6, 3.6, 1.2), (6.6, 3.6, 1.3), (7.6, 4.2, 1.9), (8.6, 4.4, 2.2), (9.8, 4.6, 1.9), (11.0, 4.6, 1.8), (12.4, 4.6, 1.7))):
        rows.append((x, w, a, pink[i % 2] if x < 6.2 else blue[i % 3]))
    for s in (-1, 1):  # 左右で形を変える
        for i, (x, w, a, tint) in enumerate(rows):
            y = rear_y(x) - 0.25 + rng.uniform(-0.1, 0.1)
            shift = float(rng.uniform(-0.5, 0.5))
            card('smoke', bank, s * (x + shift), y, w * float(rng.uniform(0.85, 1.15)), float(rng.uniform(2.6, 4.6)), -0.5, tint, a * float(rng.uniform(0.8, 1.1)), bool(rng.integers(2)))
        for x, a in ((3.5, 0.55), (4.8, 0.65)):  # LED の下端の光を受けた空気
            card('smoke', bank, s * x, rear_y(x) + 0.5, 3.4, 1.5, 0.45, (1.0, 0.28, 0.7), a, s > 0)


def floor_v(y):
    """床の y の点が写る画素の v"""
    hit = Vector((0, y, 0)) - CAM
    c, s = math.cos(TILT), math.sin(TILT)
    return H / 2 - F * (hit.z * c - hit.y * s) / (hit.y * c + hit.z * s)


def mirror_point(u, v, y):
    """床の画素 (u, v) に映って見える、奥の面 y の上の点"""
    a, b = (u - W / 2) / F, (H / 2 - v) / F
    c, s = math.cos(TILT), math.sin(TILT)
    ray = Vector((a, c - b * s, s + b * c))
    hit = CAM + ray * (CAM.z / -ray.z)
    ray.z = -ray.z
    return hit + ray * ((y - hit.y) / ray.y)


def build_reflections(mats):
    """目標の床は、壁の上や奥の手前まで長い縦の光を映している。カメラには見えず、床の反射にだけ出る色の柱を奥の段の手前に置く。
    置き場所は床の画素で指定する(中心 u, 半幅, v の範囲, 色, 強さ)。面は段の弧の直前に立て、段の中へ入らない"""
    white = (1.0, 0.72, 0.85)
    sky = (0.04, 0.3, 0.8)
    pink = (1.0, 0.05, 0.45)
    table = [
        (280, 42, 1048, 1140, pink, 3.0), (660, 42, 1048, 1140, pink, 3.0), (278, 5, 1048, 1200, white, 4.0), (660, 5, 1048, 1200, white, 4.0),
        (262, 2, 1060, 1420, white, 0.8), (292, 2, 1100, 1400, sky, 1.2), (648, 2, 1100, 1400, sky, 1.2), (680, 2, 1060, 1420, white, 0.8),
        (125, 12, 1048, 1160, sky, 3.0), (815, 12, 1048, 1160, sky, 3.0),
        (30, 4, 1048, 1170, sky, 2.0), (70, 3, 1048, 1160, white, 1.2), (205, 4, 1048, 1170, sky, 1.6), (740, 4, 1048, 1170, sky, 1.6), (870, 3, 1048, 1160, white, 1.2), (915, 4, 1048, 1170, sky, 2.0),
        (470, 85, 1046, 1250, sky, 2.4),
        (165, 30, 1100, 1235, pink, 2.6), (305, 28, 1100, 1240, pink, 2.6), (635, 28, 1100, 1240, pink, 2.6), (775, 30, 1100, 1235, pink, 2.6),
        (85, 34, 1110, 1440, sky, 2.2), (855, 34, 1110, 1440, sky, 1.5), (225, 22, 1100, 1300, sky, 1.2), (715, 22, 1100, 1300, sky, 1.0),
        (470, 60, 1250, 1440, pink, 6.0), (320, 40, 1280, 1420, pink, 3.2), (640, 40, 1280, 1420, pink, 3.2),
        (745, 34, 1250, 1430, sky, 0.9), (195, 34, 1250, 1430, sky, 1.5),
    ]
    for u, hw, v0, v1, col, power in table:
        x0, x1 = abs(u - 470) - hw, abs(u - 470) + hw
        Y = rear_y(min(13.5, max(x1, 0) * 15 / F)) - 0.04  # その幅の中で一番手前の弧の位置
        v0 = max(v0, floor_v(Y) + 2)
        if v1 <= v0:
            continue
        q = [mirror_point(u - hw, v0, Y), mirror_point(u + hw, v0, Y), mirror_point(u + hw, v1, Y), mirror_point(u - hw, v1, Y)]
        o = quads('ghost', [tuple(p) for p in q], [(0, 1, 2, 3)], mats['ghost'], [(0, 0.5 if v0 < 1060 else 0), (1, 0.5 if v0 < 1060 else 0), (1, 1), (0, 1)])  # 奥の縁から始まる柱は下で消さない
        o.color = (*col, power * 0.75)
        o.visible_camera = False
        rays(o, False, False)


def make_materials(ctx, clk):
    a = ctx.assets
    purple = (0.42, 0.12, 0.85)
    return {
        'floor': floor_material(a),
        'gloss': dark_material('gloss', base=(0.006, 0.006, 0.01), rough=0.2),
        'riser': dark_material('riser', base=(0.004, 0.005, 0.012), rough=0.55, metallic=0.0),
        'black': dark_material('black', base=(0.002, 0.002, 0.003), rough=0.5, rim=(0.1, 0.15, 0.7), rim_power=0.01),
        'speaker': dark_material('speaker', tex=a / 'speaker_panel.png', rough=0.5, uv=True, rim=(0.15, 0.25, 0.8), rim_power=0.008),
        'trim': neon_material('trim', (0.12, 0.06, 0.2), 0.05),
        'tri': tri_material(),
        'band': band_material(),
        'band2': band_material(0.16),
        'rearline': neon_material('rearline', (0.3, 0.7, 1.0), 1.3),
        'step': neon_material('step', (0.35, 0.75, 1.0), 1.0),
        'neon_c': neon_material('neon_c', (0.35, 0.8, 1.0), 1.5),
        'neon_p': neon_material('neon_p', (1.0, 0.2, 0.7), 2.2),
        'chord_top': (lambda m: m.finish(m.emission((0.3, 0.025, 0.2, 1), 1.0)))(Mat('chord_top')),
        'chord': dark_material('chord', tex=a / 'truss_metal.png', rough=0.35, rim=(0.8, 0.15, 0.7), rim_power=0.12, scale=0.5, lit=purple, lit_power=0.04),
        'lace': dark_material('lace', tex=a / 'truss_metal.png', rough=0.4, rim=(0.5, 0.25, 1.0), rim_power=0.13, scale=0.5, lit=purple, lit_power=0.12),
        'long': dark_material('long', tex=a / 'truss_metal.png', rough=0.4, rim=(0.5, 0.2, 0.9), rim_power=0.13, scale=0.5, lit=purple, lit_power=0.06),
        'q': dark_material('q', tex=a / 'truss_metal.png', rough=0.4, rim=(0.3, 0.25, 0.9), rim_power=0.2, scale=0.5, lit=(0.2, 0.2, 0.7), lit_power=0.08),
        'fixture': dark_material('fixture', base=(0.003, 0.003, 0.004), rough=0.28, rim=(0.4, 0.35, 0.7), rim_power=0.05),
        'lens': lens_material(a / 'lens_cell.png'),
        'beam': beam_material(clk, a),
        'halo': halo_material(),
        'dotcore': (lambda m: m.finish(m.emission(m.n('ShaderNodeObjectInfo').outputs['Color'], 20.0)))(Mat('dotcore')),
        'penlight': penlight_material(clk),
        'body': dark_material('body', base=(0.006, 0.005, 0.01), rough=0.7, metallic=0, rim=(0.5, 0.15, 0.8), rim_power=0.08),
        'tier': neon_material('tier', (0.006, 0.0045, 0.012), 1.0),
        'pit': dark_material('pit', base=(0.002, 0.002, 0.003), rough=0.6, metallic=0),
        'roof': neon_material('roof', (0.0035, 0.005, 0.012), 1.0),
        'hall': neon_material('hall', (0.0065, 0.0057, 0.014), 1.0),
        'rail': neon_material('rail', (1.0, 0.1, 0.6), 1.0),
        'ghost': ghost_material(),
    }


def add_area(name, loc, target, size, power, color):
    d = bpy.data.lights.new(name, 'AREA')
    d.shape = 'RECTANGLE'
    d.size, d.size_y = size
    d.energy = power
    d.color = color
    o = link(bpy.data.objects.new(name, d))
    o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    o.visible_camera = o.visible_glossy = False
    return o


def animate(ctx, clk, rigs):
    F_ = ctx.frames
    if F_ <= 1:
        return
    t = clk.nodes['t'].outputs[0]
    for f in range(1, F_ + 1):  # 全コマに打つので補間の曲線に左右されず、時間が一定に進む
        t.default_value = (f - 1) / ctx.fps
        t.keyframe_insert('default_value', frame=f)
    frames = [round(b * ctx.fps) + 1 for b in ctx.beats]
    frames = [f for f in frames if 1 <= f <= F_]
    # 拍の頭で 1 に上がり、次の拍へ向けて下がる。a は偶数拍、b は奇数拍で強い
    for name, phase in (('pulse_a', 0), ('pulse_b', 1)):
        s = clk.nodes[name].outputs[0]
        for i, f in enumerate(frames):
            nxt = frames[i + 1] if i + 1 < len(frames) else f + 15
            s.default_value = 1.0 if i % 2 == phase else 0.25
            s.keyframe_insert('default_value', frame=f)
            s.default_value = 0.1 if i % 2 == phase else 0.2
            s.keyframe_insert('default_value', frame=max(f + 1, nxt - 1))
    # 首振り。2 拍ごとに左右対称に振る
    bars = frames[::2] or [1]
    for piv, sgn, group in rigs:
        base = piv.rotation_euler.copy()
        for i, f in enumerate(bars):
            swing = math.radians((9, 6, 12, 10)[group]) * (1 if (i + group) % 2 else -1)
            piv.rotation_euler = (base.x + swing * 0.5, base.y + sgn * swing, base.z)
            piv.keyframe_insert('rotation_euler', frame=f)
        piv.rotation_euler = base


def setup_render(s):
    c = s.cycles
    c.max_bounces = 4
    c.diffuse_bounces = 1
    c.glossy_bounces = 2
    c.transmission_bounces = 0
    c.volume_bounces = 0
    c.transparent_max_bounces = 96
    c.sample_clamp_indirect = 20.0
    c.filter_width = 1.0
    s.view_settings.view_transform = 'Standard'
    s.view_settings.look = 'None'
    s.view_settings.exposure = 0.0
    w = bpy.data.worlds.new('dark')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.0006, 0.0008, 0.002, 1)
    s.world = w
    # 順に、弱いシャープ、光のにじみ、色の調整
    t = bpy.data.node_groups.new('post', 'CompositorNodeTree')
    t.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    N, L = t.nodes, t.links
    rl = N.new('CompositorNodeRLayers')
    sh = N.new('CompositorNodeFilter')
    sh.inputs['Type'].default_value = 'Box Sharpen'
    sh.inputs['Factor'].default_value = 0.06
    L.new(rl.outputs['Image'], sh.inputs['Image'])
    gl = N.new('CompositorNodeGlare')
    gl.inputs['Type'].default_value = 'Bloom'
    gl.inputs['Quality'].default_value = 'Medium'
    gl.inputs['Threshold'].default_value = 0.85
    gl.inputs['Smoothness'].default_value = 0.5
    gl.inputs['Strength'].default_value = 0.5
    gl.inputs['Saturation'].default_value = 1.1
    gl.inputs['Size'].default_value = 0.78
    L.new(sh.outputs[0], gl.inputs['Image'])
    cb = N.new('CompositorNodeColorBalance')
    L.new(gl.outputs['Image'], cb.inputs['Image'])
    next(i for i in cb.inputs if i.name == 'Gain' and i.type == 'RGBA').default_value = (0.97, 0.98, 1.0, 1)
    next(i for i in cb.inputs if i.name == 'Lift' and i.type == 'VALUE').default_value = -0.003  # 暗部の薄い膜を締める
    out = N.new('NodeGroupOutput')
    L.new(cb.outputs['Image'], out.inputs[0])
    s.compositing_node_group = t
    s.render.use_compositing = True
    s.render.compositor_device = 'GPU'


def build(ctx):
    s = bpy.context.scene
    setup_render(s)
    cam = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
    s.collection.objects.link(cam)
    s.camera = cam  # 煙の板が向く相手。render.py はこれをそのまま使う
    clk = clock_group()
    mats = make_materials(ctx, clk)
    make_dot_meshes(mats)
    SIDE_LED['mat'] = led_material('led_side', ctx.assets / 'led_side.png', ctx.assets / 'led_sparks.png', ctx.assets / 'led_bolts.png', clk, side_lines(), strength=1.15, tint=((0.9, 0.95, 1.1), (0.65, 0.95, 1.0)), lift=(0.05, 0.08, 0.22), bottom=(0.5, 0.15, 0.5))
    build_floor(mats)
    build_stage_front(mats)
    build_riser(mats)
    build_center_wall(ctx.assets, clk, mats)
    for side in (-1, 1):
        build_side(side, ctx.assets, clk, mats)
    build_trusses(mats)
    rigs = build_beams(mats)
    build_floor_lights(mats)
    build_arena(mats)
    build_crowd(mats)
    build_smoke(ctx.assets, clk, cam)
    build_reflections(mats)
    # キャラに当てる正面の光と、左右後ろの色の光
    add_area('KeyFront', (0, -7, 5), MARK, (7, 3), 800, (1.0, 0.86, 0.96))
    add_area('Face', (0, -4.5, 1.7), MARK, (2, 1.2), 60, (1.0, 0.8, 0.95))
    add_area('FloorCyan', (0, -1.6, 0.03), (0, -1.6, 2), (5, 5), 130, (0.08, 0.5, 1.0))
    add_area('RimCyan', (-5, 4, 4.5), MARK, (3, 3), 1100, (0.1, 0.5, 1.0))
    add_area('RimPink', (5, 4, 4.5), MARK, (3, 3), 1100, (1.0, 0.1, 0.55))
    animate(ctx, clk, rigs)
    tilt = (CAM + Vector((0, 10, 10 * math.tan(TILT))))
    return {
        'mark': (MARK[0], MARK[1], 0),
        'facing': 0,
        'bounds': ((-5.5, 5.5), (-8, 5.2), (0.1, 6)),
        'char_emission': 0.34,
        'beats_per_shot': 8,
        'views': {
            'target': {'loc': tuple(CAM), 'look': tuple(tilt), 'lens': LENS},
            'hold1': {'loc': (3, -3.8, 1.2), 'look': (0, -0.8, 1), 'lens': 35},
            'hold2': {'loc': (-3, -1.8, 0.5), 'look': (0, 1.2, 1.4), 'lens': 28},
        },
    }
