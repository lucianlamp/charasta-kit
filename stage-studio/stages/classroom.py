"""夕方の日本の高校の教室。部屋は X -3.55(窓)..3.5、Y -4.5(後ろ)..4.5(黒板)、高さ 3 m。素材は assets/classroom の image_gen の画像。

カメラ target は目標画像に合わせて左へ振った低い視点。目標の画角に入るのは部屋の左半分なので、mark を画角の中の床(X -1.15)に置き、そのまわり 3 m 四方を空ける。
物の位置は目標の画素からこのカメラの光線で逆算した値。
日の光は 3 つ: SunMain は床と机に長い窓枠の影を落とす。SunBoard は前の壁の物だけを照らす(目標は太陽が前にあるのに黒板にも窓の影があるため)。SunChar はステージの物を除いて、キャラだけを低い角度で照らす。
SunBlocker は窓の外の建物の代わりで、後ろの窓からの日を止めて手前の床に大きな斜めの影を作る。
"""
import math
import random

import bpy
from mathutils import Vector
from lib.studio import load_image

ROOM_X, ROOM_Y, ROOM_Z = 3.5, 4.5, 3.0
WIN_X = -3.55
MARK = (-1.15, 0.0, 0.0)
CAM = (-1.05, -3.6, 0.42)
LOOK = (-2.231, 1.249, 0.114)
PILLARS = (-3.6, -1.05, 2.56, 3.75)
STILES = (-3.0, -2.3, -1.68, -0.2, 0.55, 1.28, 1.97, 3.15, 4.02)
SILL, HEAD, TRANSOM, GUARD = 0.74, 2.7, 2.12, 1.0
BOARD = (-2.81, 2.3, 0.9, 1.95)
SUN_MAIN = dict(az=52, el=33, energy=16.0, color=(1.0, 0.76, 0.5))
SUN_BOARD = dict(az=135, el=27, energy=5.4, color=(1.0, 0.78, 0.54))
SUN_CHAR = dict(az=62, el=13, energy=9.0, color=(1.0, 0.68, 0.4))  # キャラだけに当たる低い日。床の光の位置を動かさずに顔まで照らす
SHADE_Y = (-0.04, -0.7)  # 影の板の縁の Y(高さ -1 m と 5 m)。これより後ろの窓の日は止める
FLOOR_SIZE = (7.3, 9.0)
NEAR_SPOT = (-3.2, -1.2, 2.6)
NEAR_BAND = ((-1.62, -2.21), (-1.03, -3.08), (-0.9, -3.03), (-1.3, -2.14))  # 床の上の影の四隅。目標の帯の縁をカメラの光線で床へ戻した位置
FAR_PATCH = 22.0
FLOOR_SPOT = 16
SKY_POWER, FILL_POWER, BOUNCE_POWER, LOW_POWER = 11, 46, 10, 80
BOARD_TINT = (1.08, 0.96, 0.92)
GAIN = (0.95, 1.06, 1.22, 1)
# 窓の桟より太い影。目標の床の暗い帯を太陽の向きで窓の面へ戻した位置(Y の範囲)。SunMain だけが受ける
SHADOW_BARS = ((1.8, 2.4), (0.69, 0.81), (0.07, 0.2))
# (Y の始まり, 終わり, 裾の膨らみ, 乱数, 裾の高さ)
CURTAINS = ((-0.6, 0.33, 0.0, 21, 0.72), (2.22, 2.97, 0.07, 22, 0.86), (3.66, 3.82, 0.015, 23, 0.72), (-2.0, -1.2, 0.08, 24, 0.82), (-3.75, -3.1, 0.08, 26, 0.82))


def sun_vec(az, el):
    """太陽へ向かう単位ベクトル。az は +Y から -X へ回した度数"""
    a, e = math.radians(az), math.radians(el)
    return Vector((-math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))


class Geo:
    """材質の番号つきの面を集めて 1 つのメッシュにする。UV はメートル単位(材質の側で繰り返しの大きさを決める)"""

    def __init__(self):
        self.v, self.f, self.uv, self.mat, self.smooth = [], [], [], [], []

    def poly(self, pts, uvs, mat, smooth=False):
        i = len(self.v)
        self.v.extend(tuple(p) for p in pts)
        self.f.append(tuple(range(i, i + len(pts))))
        self.uv.extend(uvs)
        self.mat.append(mat)
        self.smooth.append(smooth)

    def quad(self, a, b, c, d, mat, uv=((0, 0), (1, 0), (1, 1), (0, 1))):
        self.poly((a, b, c, d), uv, mat)

    def box(self, lo, hi, mat):
        x0, y0, z0 = lo
        x1, y1, z1 = hi
        faces = (
            ((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), 0, 2),
            ((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1), 0, 2),
            ((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1), 1, 2),
            ((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1), 1, 2),
            ((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1), 0, 1),
            ((x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0), 0, 1),
        )
        for a, b, c, d, u, v in faces:
            self.poly((a, b, c, d), [(p[u], p[v]) for p in (a, b, c, d)], mat)

    def tube(self, pts, r, mat, n=8, corner=0.05):
        """折れ線を丸い角の管にする"""
        path = [Vector(p) for p in pts]
        out = [path[0]]
        for a, b, c in zip(path, path[1:], path[2:]):
            ab, cb = (a - b), (c - b)
            k = min(corner, ab.length * 0.45, cb.length * 0.45)
            p0, p1 = b + ab.normalized() * k, b + cb.normalized() * k
            for t in range(5):
                u = t / 4
                out.append(p0.lerp(b, u).lerp(b.lerp(p1, u), u))
        out.append(path[-1])
        up = Vector((0.13, 0.37, 0.92))
        rings = []
        for i, p in enumerate(out):
            d = (out[min(i + 1, len(out) - 1)] - out[max(i - 1, 0)]).normalized()
            s = d.cross(up).normalized()
            up = s.cross(d).normalized()
            rings.append([p + (s * math.cos(a) + up * math.sin(a)) * r for a in (6.2832 * j / n for j in range(n))])
        for a, b in zip(rings, rings[1:]):
            for j in range(n):
                k = (j + 1) % n
                self.poly((a[j], a[k], b[k], b[j]), [(0, 0)] * 4, mat, True)
        for ring in (rings[0], rings[-1]):
            self.poly(ring, [(0, 0)] * n, mat, True)

    def mesh(self, name, mats):
        m = bpy.data.meshes.new(name)
        m.from_pydata(self.v, [], self.f)
        uv = m.uv_layers.new(name='UVMap')
        uv.data.foreach_set('uv', [c for p in self.uv for c in p])
        m.polygons.foreach_set('material_index', self.mat)
        m.polygons.foreach_set('use_smooth', self.smooth)
        for x in mats:
            m.materials.append(x)
        m.update()
        return m

    def obj(self, name, mats, loc=(0, 0, 0)):
        return link(name, self.mesh(name, mats), loc)


def link(name, data, loc=(0, 0, 0), rot=0.0):
    o = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (0, 0, rot)
    return o


class Mats:
    def __init__(self, assets):
        self.assets = assets

    def image(self, name, data=False):
        return load_image(self.assets / f'{name}.png', data)

    def base(self, name):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        return m, nt, next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')

    def tex(self, nt, img, size=1.0, ext='REPEAT'):
        """UV(メートル)を size で割って画像を読む節"""
        uv = nt.nodes.new('ShaderNodeTexCoord')
        mp = nt.nodes.new('ShaderNodeMapping')
        sx, sy = size if isinstance(size, tuple) else (size, size)
        mp.inputs['Scale'].default_value = (1 / sx, 1 / sy, 1)
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = img
        t.extension = ext
        nt.links.new(uv.outputs['UV'], mp.inputs['Vector'])
        nt.links.new(mp.outputs['Vector'], t.inputs['Vector'])
        return t

    def textured(self, name, img, size=1.0, rough=0.6, spec=0.5, tint=(1, 1, 1), ext='REPEAT', bump=0.0):
        m, nt, b = self.base(name)
        t = self.tex(nt, self.image(img), size, ext)
        mix = nt.nodes.new('ShaderNodeVectorMath')
        mix.operation = 'MULTIPLY'
        mix.inputs[1].default_value = tint
        nt.links.new(t.outputs['Color'], mix.inputs[0])
        nt.links.new(mix.outputs['Vector'], b.inputs['Base Color'])
        b.inputs['Roughness'].default_value = rough
        b.inputs['Specular IOR Level'].default_value = spec
        if bump:
            bp = nt.nodes.new('ShaderNodeBump')
            bp.inputs['Distance'].default_value = bump
            nt.links.new(t.outputs['Color'], bp.inputs['Height'])
            nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
        return m

    def soft(self, name, img, size, rough, tint, amount):
        """画像の模様を tint の色へ amount だけ薄める"""
        m, nt, b = self.base(name)
        t = self.tex(nt, self.image(img), size)
        mix = nt.nodes.new('ShaderNodeMixRGB')
        mix.inputs[0].default_value = amount
        mix.inputs[2].default_value = (*tint, 1)
        nt.links.new(t.outputs['Color'], mix.inputs[1])
        nt.links.new(mix.outputs[0], b.inputs['Base Color'])
        b.inputs['Roughness'].default_value = rough
        b.inputs['Specular IOR Level'].default_value = 0.25
        return m

    def plain(self, name, color, rough=0.5, metal=0.0, spec=0.5):
        m, nt, b = self.base(name)
        b.inputs['Base Color'].default_value = (*color, 1)
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        b.inputs['Specular IOR Level'].default_value = spec
        return m

    def floor(self):
        """磨いたニスの床。傷と艶は粗さの画像で入れ、法線はごく弱くする。摩耗の画像は部屋全体の UV で読む"""
        m, nt, b = self.base('Floor')
        size = 0.5
        alb = self.tex(nt, self.image('floor_albedo_s'), size)
        rgh = self.tex(nt, self.image('floor_rough', True), size)
        nor = self.tex(nt, self.image('floor_normal', True), size)
        wear = self.tex(nt, self.image('floor_wear_s', True), 2.6)
        uv = nt.nodes.new('ShaderNodeUVMap')
        uv.uv_map = 'World'
        nt.links.new(uv.outputs['UV'], wear.inputs['Vector'].links[0].from_node.inputs['Vector'])
        tint = nt.nodes.new('ShaderNodeVertexColor')
        tint.layer_name = 'tint'
        mul = nt.nodes.new('ShaderNodeVectorMath')
        mul.operation = 'MULTIPLY'
        nt.links.new(alb.outputs['Color'], mul.inputs[0])
        nt.links.new(tint.outputs['Color'], mul.inputs[1])
        scuff = nt.nodes.new('ShaderNodeMixRGB')
        scuff.inputs[2].default_value = (0.62, 0.5, 0.38, 1)
        fac = nt.nodes.new('ShaderNodeMath')
        fac.operation = 'MULTIPLY'
        fac.inputs[1].default_value = 0.7
        nt.links.new(wear.outputs['Color'], fac.inputs[0])
        nt.links.new(fac.outputs[0], scuff.inputs[0])
        # 床の明るさの地図(部屋の座標で読む)。手前の影の帯と日の当たり方を決める。値は 0..3
        lm = self.image('floor_light', True)
        lmap = nt.nodes.new('ShaderNodeTexImage')
        lmap.image = lm
        lmap.extension = 'EXTEND'
        lmp = nt.nodes.new('ShaderNodeMapping')
        lmp.inputs['Scale'].default_value = (1 / FLOOR_SIZE[0], 1 / FLOOR_SIZE[1], 1)
        lmp.inputs['Location'].default_value = (3.8 / FLOOR_SIZE[0], 4.5 / FLOOR_SIZE[1], 0)
        nt.links.new(uv.outputs['UV'], lmp.inputs['Vector'])
        nt.links.new(lmp.outputs['Vector'], lmap.inputs['Vector'])
        twice = nt.nodes.new('ShaderNodeVectorMath')
        twice.operation = 'SCALE'
        twice.inputs['Scale'].default_value = 3.0
        nt.links.new(lmap.outputs['Color'], twice.inputs[0])
        lit = nt.nodes.new('ShaderNodeVectorMath')
        lit.operation = 'MULTIPLY'
        nt.links.new(mul.outputs['Vector'], lit.inputs[0])
        nt.links.new(twice.outputs['Vector'], lit.inputs[1])
        nt.links.new(lit.outputs['Vector'], scuff.inputs[1])
        nt.links.new(scuff.outputs[0], b.inputs['Base Color'])
        r = nt.nodes.new('ShaderNodeMapRange')
        r.inputs['To Min'].default_value = 0.05
        r.inputs['To Max'].default_value = 0.2
        nt.links.new(rgh.outputs['Color'], r.inputs['Value'])
        add = nt.nodes.new('ShaderNodeMath')
        add.operation = 'ADD'
        nt.links.new(r.outputs['Result'], add.inputs[0])
        nt.links.new(fac.outputs[0], add.inputs[1])
        nt.links.new(add.outputs[0], b.inputs['Roughness'])
        b.inputs['Specular IOR Level'].default_value = 0.6
        b.inputs['Coat Weight'].default_value = 1.0
        b.inputs['Coat IOR'].default_value = 1.6
        cr = nt.nodes.new('ShaderNodeMapRange')
        cr.inputs['To Min'].default_value = 0.012
        cr.inputs['To Max'].default_value = 0.5
        nt.links.new(fac.outputs[0], cr.inputs['Value'])
        nt.links.new(cr.outputs['Result'], b.inputs['Coat Roughness'])
        fine = nt.nodes.new('ShaderNodeNormalMap')
        fine.inputs['Strength'].default_value = 0.035
        nt.links.new(nor.outputs['Color'], fine.inputs['Color'])
        nt.links.new(fine.outputs['Normal'], b.inputs['Normal'])
        nt.links.new(fine.outputs['Normal'], b.inputs['Coat Normal'])
        return m

    def glass(self):
        m = bpy.data.materials.new('Glass')
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        mix = nt.nodes.new('ShaderNodeMixShader')
        fr = nt.nodes.new('ShaderNodeFresnel')
        fr.inputs['IOR'].default_value = 1.5
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        tr.inputs['Color'].default_value = (0.96, 0.97, 0.95, 1)
        gl = nt.nodes.new('ShaderNodeBsdfAnisotropic')
        gl.inputs['Roughness'].default_value = 0.02
        weak = nt.nodes.new('ShaderNodeMath')
        weak.operation = 'MULTIPLY'
        weak.inputs[1].default_value = 0.12
        nt.links.new(fr.outputs[0], weak.inputs[0])
        nt.links.new(weak.outputs[0], mix.inputs[0])
        nt.links.new(tr.outputs[0], mix.inputs[1])
        nt.links.new(gl.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs['Surface'])
        return m

    def curtain(self):
        """薄い透ける布。背後の日で光る分は発光で入れ、ひだは面の向きで濃淡を付ける。織り目の画像は使わない。裾は頂点色 shade で暗くする"""
        m = bpy.data.materials.new('Curtain')
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        col = (0.9, 0.7, 0.4, 1)
        dif, tl = nt.nodes.new('ShaderNodeBsdfDiffuse'), nt.nodes.new('ShaderNodeBsdfTranslucent')
        dif.inputs['Color'].default_value = col
        tl.inputs['Color'].default_value = col
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        a, c = nt.nodes.new('ShaderNodeMixShader'), nt.nodes.new('ShaderNodeMixShader')
        a.inputs[0].default_value = 0.6
        c.inputs[0].default_value = 0.2
        nt.links.new(dif.outputs[0], a.inputs[1])
        nt.links.new(tl.outputs[0], a.inputs[2])
        nt.links.new(a.outputs[0], c.inputs[1])
        nt.links.new(tr.outputs[0], c.inputs[2])
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = col
        lw = nt.nodes.new('ShaderNodeLayerWeight')
        fold = nt.nodes.new('ShaderNodeMapRange')  # ひだの陰影: 視線に対して寝た面ほど暗い
        fold.inputs['From Max'].default_value = 0.7
        fold.inputs['To Min'].default_value = 0.6
        fold.inputs['To Max'].default_value = 0.0
        nt.links.new(lw.outputs['Facing'], fold.inputs['Value'])
        lp = nt.nodes.new('ShaderNodeLightPath')  # 床に写るカーテンを明るくして、目標の縦の光の筋を作る
        boost = nt.nodes.new('ShaderNodeMapRange')
        boost.inputs['To Min'].default_value = 1.0
        boost.inputs['To Max'].default_value = 4.0
        nt.links.new(lp.outputs['Is Glossy Ray'], boost.inputs['Value'])
        shade = nt.nodes.new('ShaderNodeVertexColor')
        shade.layer_name = 'shade'
        t1, t2 = nt.nodes.new('ShaderNodeMath'), nt.nodes.new('ShaderNodeMath')
        t1.operation = t2.operation = 'MULTIPLY'
        nt.links.new(fold.outputs['Result'], t1.inputs[0])
        nt.links.new(boost.outputs['Result'], t1.inputs[1])
        nt.links.new(t1.outputs[0], t2.inputs[0])
        nt.links.new(shade.outputs['Color'], t2.inputs[1])
        nt.links.new(t2.outputs[0], em.inputs['Strength'])
        white = nt.nodes.new('ShaderNodeMixRGB')  # 床に写るカーテンは白に寄せる
        white.inputs[1].default_value = col
        white.inputs[2].default_value = (1.0, 0.9, 0.8, 1)
        nt.links.new(lp.outputs['Is Glossy Ray'], white.inputs[0])
        nt.links.new(white.outputs[0], em.inputs['Color'])
        add = nt.nodes.new('ShaderNodeAddShader')
        nt.links.new(c.outputs[0], add.inputs[0])
        nt.links.new(em.outputs[0], add.inputs[1])
        nt.links.new(add.outputs[0], out.inputs['Surface'])
        m.cycles.emission_sampling = 'NONE'
        return m

    def shadeless(self, name, img, strength, size=(1, 1), ext='MIRROR', cutout=False, reflect=1.0):
        """窓の外の板。光としては数えない(ノイズを増やさないため)。reflect は床などの映り込みでの明るさの倍率"""
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        t = self.tex(nt, self.image(img), size, ext)
        em = nt.nodes.new('ShaderNodeEmission')
        lp = nt.nodes.new('ShaderNodeLightPath')
        mr = nt.nodes.new('ShaderNodeMapRange')
        mr.inputs['To Min'].default_value = strength
        mr.inputs['To Max'].default_value = strength * reflect
        nt.links.new(lp.outputs['Is Glossy Ray'], mr.inputs['Value'])
        nt.links.new(mr.outputs['Result'], em.inputs['Strength'])
        nt.links.new(t.outputs['Color'], em.inputs['Color'])
        if cutout:
            mix = nt.nodes.new('ShaderNodeMixShader')
            tr = nt.nodes.new('ShaderNodeBsdfTransparent')
            nt.links.new(t.outputs['Alpha'], mix.inputs[0])
            nt.links.new(tr.outputs[0], mix.inputs[1])
            nt.links.new(em.outputs[0], mix.inputs[2])
            nt.links.new(mix.outputs[0], out.inputs['Surface'])
        else:
            nt.links.new(em.outputs[0], out.inputs['Surface'])
        m.cycles.emission_sampling = 'NONE'
        return m

    def glow(self, name, color, strength):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (*color, 1)
        em.inputs['Strength'].default_value = strength
        nt.links.new(em.outputs[0], out.inputs['Surface'])
        m.cycles.emission_sampling = 'NONE'
        return m

    def sun_glow(self):
        """太陽 1 つ分の光。中心は飽和し、まわりへ滑らかに消える。輪郭の線が出ない"""
        m = bpy.data.materials.new('SunGlow')
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        uv = nt.nodes.new('ShaderNodeTexCoord')
        mp = nt.nodes.new('ShaderNodeMapping')
        mp.inputs['Location'].default_value = (-1, -1, 0)
        mp.inputs['Scale'].default_value = (2, 2, 1)
        g = nt.nodes.new('ShaderNodeTexGradient')
        g.gradient_type = 'SPHERICAL'
        nt.links.new(uv.outputs['UV'], mp.inputs['Vector'])
        nt.links.new(mp.outputs['Vector'], g.inputs['Vector'])
        def term(power, gain):
            pw = nt.nodes.new('ShaderNodeMath')
            pw.operation = 'POWER'
            pw.inputs[1].default_value = power
            nt.links.new(g.outputs['Fac'], pw.inputs[0])
            k = nt.nodes.new('ShaderNodeMath')
            k.operation = 'MULTIPLY'
            k.inputs[1].default_value = gain
            nt.links.new(pw.outputs[0], k.inputs[0])
            return k
        k = nt.nodes.new('ShaderNodeMath')  # 小さな芯と広い滲み
        k.operation = 'ADD'
        nt.links.new(term(46.0, 18.0).outputs[0], k.inputs[0])
        nt.links.new(term(7.0, 0.22).outputs[0], k.inputs[1])
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (1.0, 0.8, 0.5, 1)
        nt.links.new(k.outputs[0], em.inputs['Strength'])
        add = nt.nodes.new('ShaderNodeAddShader')
        nt.links.new(nt.nodes.new('ShaderNodeBsdfTransparent').outputs[0], add.inputs[0])
        nt.links.new(em.outputs[0], add.inputs[1])
        nt.links.new(add.outputs[0], out.inputs['Surface'])
        m.cycles.emission_sampling = 'NONE'
        return m


def block_floor(mat, r):
    """継ぎ目が揃う格子の寄木。1 枚ごとに画像の別の場所を読み、色と傾きを少し変える。目地は下の灰色の面"""
    w, h = 0.1, 0.19  # 継ぎ目が揃う格子
    v, f, uv, world, tint = [], [], [], [], []
    rows = int(2 * ROOM_Y / h) + 1
    for j in range(rows):
        y0 = -ROOM_Y + j * h
        x = -3.8
        while x < ROOM_X:
            gap = r.choice((0.0, 0.0, 0.0002, 0.0004, 0.0007, 0.0012))  # 継ぎ目の太さは場所ごとに違う
            a, b = (x + gap, y0 + gap), (x + w - gap, y0 + h - gap)
            i = len(v)
            tx, ty, tz = r.uniform(-1, 1) * 0.0005, r.uniform(-1, 1) * 0.0011, r.uniform(0, 0.0002)
            corners = ((a[0], a[1]), (b[0], a[1]), (b[0], b[1]), (a[0], b[1]))
            for px, py in corners:
                v.append((px, py, tz + tx * (px - a[0]) + ty * (py - a[1])))
                world.append((px, py))
            f.append((i, i + 1, i + 2, i + 3))
            ou, ov = r.uniform(0, 1), r.uniform(0, 1)
            flip = r.choice((1, -1))
            for px, py in corners:
                uv.append((ou + flip * (px - a[0]), ov + flip * (py - a[1])))
            s = r.uniform(0.62, 1.0) * (0.55 if r.random() < 0.03 else 1.0)  # 少しだけ濃い板が混じる
            c = (s * 0.74, s * r.uniform(0.95, 1.0), s * r.uniform(1.0, 1.12), 1)
            tint.extend(c for _ in range(4))
            x += w
    m = bpy.data.meshes.new('Floor')
    m.from_pydata(v, [], f)
    m.uv_layers.new(name='UVMap').data.foreach_set('uv', [c for p in uv for c in p])
    m.uv_layers.new(name='World').data.foreach_set('uv', [c for p in world for c in p])
    col = m.color_attributes.new('tint', 'FLOAT_COLOR', 'CORNER')
    col.data.foreach_set('color', [c for p in tint for c in p])
    m.materials.append(mat)
    m.update()
    return link('Floor', m)


def ceiling_tiles(g, mat, r):
    """天井の板。継ぎ目は細い隙間で作り、板ごとに画像の別の場所を読む"""
    s, gap = 0.91, 0.001
    x = -ROOM_X
    while x < ROOM_X:
        y = -ROOM_Y
        while y < ROOM_Y:
            ou, ov = r.uniform(0, 3), r.uniform(0, 3)
            a, b, c, d = (x + gap, y + gap, ROOM_Z), (x + gap, y + s - gap, ROOM_Z), (x + s - gap, y + s - gap, ROOM_Z), (x + s - gap, y + gap, ROOM_Z)
            g.quad(a, b, c, d, 'Ceiling', tuple((p[0] + ou, p[1] + ov) for p in (a, b, c, d)))
            y += s
        x += s


def window_wall(g):
    """左の壁: 腰の細い板張り、柱、細いアルミサッシ、ガラス、落下防止の桟、カーテンレール"""
    O, W = -3.75, WIN_X
    g.box((O, -ROOM_Y, 0.1), (W, ROOM_Y, SILL), 'WoodPanelSide')
    g.box((O, -ROOM_Y, 0), (W + 0.015, ROOM_Y, 0.1), 'Baseboard')
    g.box((O, -ROOM_Y, SILL - 0.02), (W + 0.1, ROOM_Y, SILL), 'Trim')
    g.box((O, -ROOM_Y, HEAD), (-3.58, ROOM_Y, ROOM_Z), 'Wall')
    g.box((O, -4.5, SILL), (W, -3.9, HEAD), 'Wall')
    g.box((O, 4.28, 0), (-3.33, ROOM_Y, ROOM_Z), 'Wall')
    F0, F1 = -3.6, -3.56
    for y in (*STILES, *PILLARS):
        g.box((F0, y - 0.022, SILL), (F1, y + 0.022, HEAD), 'Alu')
        g.box((F1, y - 0.0025, SILL), (F1 + 0.001, y + 0.0025, HEAD), 'AluGlint')
    for z, h in ((SILL + 0.012, 0.012), (TRANSOM, 0.032), (HEAD - 0.012, 0.012)):
        g.box((F0, -ROOM_Y, z - h), (F1, ROOM_Y, z + h), 'AluWarm')
    g.box((-3.56, -ROOM_Y, GUARD - 0.007), (-3.53, 2.54, GUARD + 0.007), 'Rail')
    g.quad((-3.58, -ROOM_Y, SILL), (-3.58, ROOM_Y, SILL), (-3.58, ROOM_Y, HEAD), (-3.58, -ROOM_Y, HEAD), 'Glass')
    g.box((-3.5, -ROOM_Y, 2.538), (-3.485, ROOM_Y, 2.552), 'Rail')
    g.box((-3.46, -ROOM_Y, 2.538), (-3.445, ROOM_Y, 2.552), 'Rail')


def poster(g, name, x0, x1, z0, z1, y, tilt=0.0, sign=1):
    """壁の紙。y は壁の手前の面、sign は見る向き(前の壁は 1、後ろの壁は -1)"""
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    c, s = math.cos(tilt), math.sin(tilt)
    pts = []
    for px, pz in ((x0, z0), (x1, z0), (x1, z1), (x0, z1)):
        dx, dz = px - cx, pz - cz
        pts.append((cx + dx * c - dz * s, y, cz + dx * s + dz * c))
    if sign < 0:
        g.quad(pts[1], pts[0], pts[3], pts[2], name)
    else:
        g.quad(*pts, name)


def side_poster(g, name, y0, y1, z0, z1, x):
    """右の壁の紙。部屋の内側から読める向き"""
    g.quad((x, y1, z0), (x, y0, z0), (x, y0, z1), (x, y1, z1), name)


def frame_box(g, ax, bx, z0, z1, Y, d, mat='AluBright', t=0.02):
    for lo, hi in (((ax - t, Y - d, z0 - t), (ax, Y, z1 + t)), ((bx, Y - d, z0 - t), (bx + t, Y, z1 + t)), ((ax - t, Y - d, z1), (bx + t, Y, z1 + t)), ((ax - t, Y - d, z0 - t), (bx + t, Y, z0))):
        g.box(lo, hi, mat)


def front_wall(g, room):
    """前の壁。黒板の光を受ける物は g、光を受けない上の壁と掲示板は room に入れる"""
    Y = ROOM_Y
    x0, x1, z0, z1 = BOARD
    g.quad((-3.75, Y, 0.6), (ROOM_X, Y, 0.6), (ROOM_X, Y, 0.97), (-3.75, Y, 0.97), 'Wall', ((-ROOM_X, 0.6), (ROOM_X, 0.6), (ROOM_X, 0.97), (-ROOM_X, 0.97)))
    room.quad((-3.75, Y, 0.97), (ROOM_X, Y, 0.97), (ROOM_X, Y, 2.95), (-3.75, Y, 2.95), 'Wall', ((-ROOM_X, 0.97), (ROOM_X, 0.97), (ROOM_X, 2.95), (-ROOM_X, 2.95)))
    g.box((-3.75, Y - 0.025, 0.1), (ROOM_X, Y, 0.68), 'WoodPanel')
    g.box((-3.75, Y - 0.04, 0.67), (ROOM_X, Y, 0.7), 'Trim')
    g.box((-3.75, Y - 0.03, 0), (ROOM_X, Y, 0.1), 'Baseboard')
    bw = 2.6
    u = lambda x: (x - x0) / bw
    v = lambda z: (z - z0) / (bw / 1.5)
    g.quad((x0, Y - 0.03, z0), (x1, Y - 0.03, z0), (x1, Y - 0.03, z1), (x0, Y - 0.03, z1), 'Board', ((u(x0), v(z0)), (u(x1), v(z0)), (u(x1), v(z1)), (u(x0), v(z1))))
    frame_box(g, x0, x1, z0, z1, Y, 0.05, 'FrameDark', 0.012)
    g.box((x0 - 0.03, Y - 0.12, z0 - 0.04), (x1 + 0.03, Y, z0 - 0.015), 'AluBright')
    g.box((x0 - 0.03, Y - 0.125, z0 - 0.04), (x1 + 0.03, Y - 0.115, z0 + 0.012), 'AluBright')
    for ax, bx in ((-3.33, -2.84), (2.38, 3.3)):
        room.quad((ax, Y - 0.02, z0), (bx, Y - 0.02, z0), (bx, Y - 0.02, z1), (ax, Y - 0.02, z1), 'Cork', ((ax, z0), (bx, z0), (bx, z1), (ax, z1)))
        frame_box(room, ax, bx, z0, z1, Y, 0.04, 'FrameDark', 0.01)
    py = Y - 0.024
    poster(room, 'NoticeA', -3.28, -3.04, 1.58, 1.83, py)
    poster(room, 'NoticeC', -3.17, -3.04, 1.43, 1.56, py)
    poster(room, 'NoticeB', -3.26, -2.95, 1.12, 1.43, py)
    poster(room, 'PosterA', 2.48, 2.95, 1.15, 1.85, py, 0.02)
    poster(room, 'NoticeA', 3.0, 3.22, 1.5, 1.82, py, -0.02)
    poster(room, 'PosterB', 3.0, 3.24, 1.08, 1.42, py, 0.015)
    for x in (-2.6, -2.5, -0.82, -0.7, -0.6, 0.3, 1.2):
        g.box((x, Y - 0.105, z0 - 0.015), (x + 0.1, Y - 0.05, z0 + 0.04), 'EraserB')
        g.box((x, Y - 0.105, z0 + 0.04), (x + 0.1, Y - 0.05, z0 + 0.075), 'EraserY')
    for x, length in ((-2.7, 0.07), (-2.25, 0.09), (-0.2, 0.08), (0.7, 0.06)):
        g.tube(((x, Y - 0.08, z0 - 0.008), (x + length, Y - 0.08, z0 - 0.008)), 0.005, 'Chalk', 6)
    # スピーカー
    g.box((-1.68, Y - 0.1, 2.07), (-1.29, Y, 2.37), 'SpeakerBox')
    g.quad((-1.675, Y - 0.102, 2.075), (-1.295, Y - 0.102, 2.075), (-1.295, Y - 0.102, 2.365), (-1.675, Y - 0.102, 2.365), 'SpeakerFace')
    # 時計
    cx, cz, cr = -0.69, 2.285, 0.165
    cy = Y - 0.05
    n = 48
    ring = [(cx + math.cos(a) * cr, cy, cz + math.sin(a) * cr) for a in (6.2832 * i / n for i in range(n))]
    g.poly(ring, [(0.5 + math.cos(6.2832 * i / n) / 2, 0.5 + math.sin(6.2832 * i / n) / 2) for i in range(n)], 'ClockFace')
    g.tube([(cx + math.cos(a) * (cr + 0.008), cy, cz + math.sin(a) * (cr + 0.008)) for a in (6.2832 * i / n for i in range(n + 1))], 0.012, 'ClockRim', 8, 0.001)
    for a_deg, length, wid in ((90, 0.09, 0.008), (138, 0.14, 0.005), (290, 0.145, 0.002)):
        a = math.radians(a_deg)
        d, s = Vector((math.sin(a), 0, math.cos(a))), Vector((math.cos(a), 0, -math.sin(a)))
        c = Vector((cx, cy - 0.006, cz))
        g.quad(c - s * wid - d * 0.02, c + s * wid - d * 0.02, c + s * wid * 0.6 + d * length, c - s * wid * 0.6 + d * length, 'ClockHand', ((0, 0),) * 4)
    # 教卓: 4 本の脚と枠、段差のある鏡板。下は隙間
    wl, wr, wf, wb, h = -1.87, -1.25, 3.86, 4.25, 0.87
    L = 0.042
    g.box((wl - 0.018, wf - 0.03, h - 0.028), (wr + 0.018, wb + 0.025, h), 'PodiumTop')
    for x in (wl, wr - L):
        for y in (wf, wb - L):
            g.box((x, y, 0), (x + L, y + L, h - 0.028), 'PodiumFrame')
    g.box((wl, wf + 0.002, h - 0.09), (wr, wf + 0.03, h - 0.028), 'PodiumFrame')
    g.box((wl, wf + 0.002, 0.13), (wr, wf + 0.03, 0.18), 'PodiumFrame')
    g.quad((wl + L, wf + 0.016, 0.18), (wr - L, wf + 0.016, 0.18), (wr - L, wf + 0.016, h - 0.09), (wl + L, wf + 0.016, h - 0.09), 'Podium', ((0.18, 0), (0.18, wr - wl - 2 * L), (h - 0.09, wr - wl - 2 * L), (h - 0.09, 0)))
    for x in (wl + 0.012, wr - 0.018):
        g.box((x, wf + L, 0.13), (x + 0.008, wb - L, h - 0.03), 'Podium')
    # 左隅の棚と本
    g.box((-3.33, 4.1, 0.09), (-2.9, 4.46, 0.8), 'Cabinet')
    g.box((-3.33, 4.08, 0.8), (-2.88, 4.47, 0.82), 'Cabinet')
    g.box((-3.33, 4.11, 0.0), (-2.9, 4.46, 0.09), 'CabBase')
    g.box((-3.075, 4.092, 0.12), (-3.071, 4.1, 0.78), 'Baseboard')
    for x in (-3.1, -3.045):
        g.box((x, 4.09, 0.42), (x + 0.012, 4.1, 0.5), 'Steel')
    g.box((-3.3, 4.2, 0.82), (-3.08, 4.42, 1.0), 'Books')
    g.quad((-3.3, 4.198, 0.82), (-3.08, 4.198, 0.82), (-3.08, 4.198, 1.01), (-3.3, 4.198, 1.01), 'BookSpines')
    z = 0.82
    for i, (t, m) in enumerate(((0.024, 'BookBlue'), (0.018, 'PaperStack'), (0.03, 'BookGreen'), (0.02, 'PaperStack'))):
        g.box((-3.05 + i * 0.006, 4.19, z), (-2.86 - i * 0.008, 4.42, z + t), m)
        z += t
    g.tube(((-2.84, 4.4, 0), (-2.83, 4.43, 0.32)), 0.016, 'Steel', 8)
    g.quad((-3.29, 4.095, 0.64), (-3.16, 4.095, 0.64), (-3.16, 4.095, 0.78), (-3.29, 4.095, 0.78), 'NoticeA')


def back_wall(g, r):
    """後ろの壁: ロッカー、上に置いた物、掲示板、大きさと向きの違う掲示物"""
    Y = -ROOM_Y
    g.quad((ROOM_X, Y, 0), (-3.75, Y, 0), (-3.75, Y, ROOM_Z), (ROOM_X, Y, ROOM_Z), 'Wall', ((ROOM_X, 0), (-3.75, 0), (-3.75, ROOM_Z), (ROOM_X, ROOM_Z)))
    g.box((-3.3, Y, 0), (3.3, Y + 0.42, 0.08), 'Baseboard')
    g.box((-3.32, Y, 1.22), (3.32, Y + 0.44, 1.25), 'Trim')
    w, h, z0 = 1.65, 1.14, 0.08
    x = -3.3
    while x < 3.25:
        flip = r.random() < 0.5
        uv = ((1, 0), (0, 0), (0, 1), (1, 1)) if flip else ((0, 0), (1, 0), (1, 1), (0, 1))
        g.quad((x + w, Y + 0.42, z0), (x, Y + 0.42, z0), (x, Y + 0.42, z0 + h), (x + w, Y + 0.42, z0 + h), 'Locker', uv)
        x += w
    g.box((-3.3, Y, z0), (-3.28, Y + 0.42, z0 + h), 'Cabinet')
    g.box((3.28, Y, z0), (3.3, Y + 0.42, z0 + h), 'Cabinet')
    # ロッカーの上: 箱とかばん
    for x0, x1, h2, d, m in ((-3.0, -2.6, 0.26, 0.3, 'Box'), (-2.55, -2.3, 0.18, 0.28, 'BookBlue'), (-0.9, -0.5, 0.3, 0.32, 'Box'), (0.6, 0.86, 0.34, 0.2, 'Bag'), (1.0, 1.2, 0.27, 0.2, 'BookGreen'), (2.3, 2.75, 0.22, 0.3, 'Box')):
        g.box((x0, Y + 0.06, 1.25), (x1, Y + 0.06 + d, 1.25 + h2), m)
        if m == 'Box':  # 箱の表に貼った紙
            g.quad((x1 - 0.05, Y + 0.058 + d + 0.003, 1.28), (x0 + 0.05, Y + 0.058 + d + 0.003, 1.28), (x0 + 0.05, Y + 0.058 + d + 0.003, 1.25 + h2 - 0.03), (x1 - 0.05, Y + 0.058 + d + 0.003, 1.25 + h2 - 0.03), 'NoticeC')
    g.tube(((-1.7, Y + 0.2, 1.25), (-1.7, Y + 0.2, 1.42)), 0.012, 'Steel', 8)
    ax, bx, z0, z1 = -2.6, 2.6, 1.55, 2.48
    g.quad((bx, Y + 0.02, z0), (ax, Y + 0.02, z0), (ax, Y + 0.02, z1), (bx, Y + 0.02, z1), 'Cork', ((bx, z0), (ax, z0), (ax, z1), (bx, z1)))
    for lo, hi in (((ax - 0.025, Y, z0 - 0.025), (ax, Y + 0.04, z1 + 0.025)), ((bx, Y, z0 - 0.025), (bx + 0.025, Y + 0.04, z1 + 0.025)), ((ax, Y, z1), (bx, Y + 0.04, z1 + 0.025)), ((ax, Y, z0 - 0.025), (bx, Y + 0.04, z0))):
        g.box(lo, hi, 'AluBright')
    x = -2.5
    names = ('PosterA', 'NoticeB', 'NoticeA', 'PosterB', 'NoticeC', 'NoticeA', 'PosterA', 'NoticeB', 'PosterB', 'NoticeC')
    for i, name in enumerate(names):
        wide = r.uniform(0.3, 0.56) if name.startswith('Poster') else r.uniform(0.2, 0.34)
        tall = wide * (1.42 if name != 'NoticeC' else 1.0)
        z = r.uniform(z0 + 0.04, z1 - tall - 0.02)
        poster(g, name, x, x + wide, z, z + tall, Y + 0.024, r.uniform(-0.04, 0.04), -1)
        x += wide + r.uniform(0.06, 0.2)
        if x > 2.2:
            break


def right_wall(g):
    """廊下側の壁: 腰板、引き戸 2 枚、明かり窓、掲示板"""
    X = ROOM_X
    g.quad((X, ROOM_Y, 0.72), (X, -ROOM_Y, 0.72), (X, -ROOM_Y, ROOM_Z), (X, ROOM_Y, ROOM_Z), 'Wall', ((ROOM_Y, 0.72), (-ROOM_Y, 0.72), (-ROOM_Y, ROOM_Z), (ROOM_Y, ROOM_Z)))
    g.box((X - 0.025, -ROOM_Y, 0.1), (X, ROOM_Y, 0.7), 'WoodPanelSide')
    g.box((X - 0.045, -ROOM_Y, 0.69), (X, ROOM_Y, 0.72), 'Trim')
    g.box((X - 0.03, -ROOM_Y, 0), (X, ROOM_Y, 0.1), 'Baseboard')
    for y0, y1 in ((2.2, 4.0), (-3.9, -2.1)):
        g.box((X - 0.06, y0 - 0.05, 0), (X, y1 + 0.05, 2.16), 'DoorFrame')
        mid = (y0 + y1) / 2
        for a, b, off in ((y0, mid + 0.02, 0.1), (mid - 0.02, y1, 0.075)):
            g.box((X - off, a, 0.01), (X - off + 0.03, b, 2.1), 'Door')
            g.box((X - off - 0.002, a + 0.14, 1.05), (X - off + 0.002, b - 0.14, 1.95), 'DoorGlass')
            side_poster(g, 'NoticeC', a + 0.25, a + 0.5, 1.5, 1.75, X - off - 0.004)
    # 戸の間の掲示板
    y0, y1, z0, z1 = -1.7, 1.7, 1.05, 1.95
    g.quad((X - 0.02, y1, z0), (X - 0.02, y0, z0), (X - 0.02, y0, z1), (X - 0.02, y1, z1), 'Cork', ((y1, z0), (y0, z0), (y0, z1), (y1, z1)))
    g.box((X - 0.04, y0 - 0.02, z1), (X, y1 + 0.02, z1 + 0.02), 'AluBright')
    g.box((X - 0.04, y0 - 0.02, z0 - 0.02), (X, y1 + 0.02, z0), 'AluBright')
    y = -1.6
    for name, wide in (('PosterB', 0.5), ('NoticeA', 0.3), ('PosterA', 0.56), ('NoticeB', 0.46), ('NoticeC', 0.26), ('PosterB', 0.5), ('NoticeA', 0.28)):
        tall = min(wide * 1.4, 0.8)
        side_poster(g, name, y, y + wide, 1.12, 1.12 + tall, X - 0.024)
        y += wide + 0.06
    for y0, y1 in ((-1.7, -0.3), (0.2, 1.6)):
        g.box((X - 0.05, y0, 2.16), (X, y1, 2.72), 'DoorFrame')
        g.quad((X - 0.055, y1 - 0.04, 2.2), (X - 0.055, y0 + 0.04, 2.2), (X - 0.055, y0 + 0.04, 2.68), (X - 0.055, y1 - 0.04, 2.68), 'Hallway')


def fixture(g, x, y):
    """吊り下げの蛍光灯。Y 方向に長い。消灯"""
    L, W, zb, zt = 0.62, 0.1, 2.5, 2.57
    g.box((x - W, y - L, zt - 0.015), (x + W, y + L, zt), 'FixtureBody')
    for s in (-1, 1):
        g.box((x + s * W - 0.006, y - L, zb), (x + s * W + 0.006, y + L, zt), 'FixtureBody')
    g.box((x - 0.03, y - L, zt - 0.05), (x + 0.03, y + L, zt - 0.015), 'FixtureBody')
    for s in (-1, 1):
        g.tube(((x + s * 0.06, y - L + 0.02, zb + 0.022), (x + s * 0.06, y + L - 0.02, zb + 0.022)), 0.013, 'Tube', 10)
        for yy in (y - L, y + L - 0.02):
            g.box((x + s * 0.085 - 0.04, yy, zb + 0.005), (x + s * 0.085 + 0.002, yy + 0.02, zb + 0.04), 'FixtureBody')
    for yy in (y - L * 0.95, y + L * 0.95):
        g.tube(((x, yy, zt), (x, yy, ROOM_Z)), 0.006, 'RodDark', 6)


def desk_geo(books):
    """机。天板は X 0.42、Y 0.62、高さ 0.66。銀の細い脚。開いた収納は +X 側(部屋の中)。books で中に本を入れる"""
    g = Geo()
    t = 0.665
    hx, hy = 0.21, 0.3
    g.box((-hx, -hy, t), (hx, hy, t + 0.012), 'DeskTop')
    g.box((-hx - 0.002, -hy - 0.002, t - 0.006), (hx + 0.002, hy + 0.002, t), 'DeskEdge')
    trayz = t - 0.12
    g.box((-0.17, -0.235, trayz), (0.17, 0.235, trayz + 0.008), 'TrayMetal')
    g.box((-0.178, -0.235, trayz), (-0.17, 0.235, t - 0.016), 'TrayMetal')
    for s in (-1, 1):
        g.box((-0.178, s * 0.235 - 0.004, trayz), (0.17, s * 0.235 + 0.004, t - 0.016), 'TrayMetal')
    if books:
        g.box((-0.15, -0.21, trayz + 0.008), (0.14, -0.03, trayz + 0.055), 'BookBlue')
        g.box((-0.14, 0.0, trayz + 0.008), (0.15, 0.2, trayz + 0.03), 'PaperStack')
        g.box((-0.13, 0.03, trayz + 0.03), (0.13, 0.19, trayz + 0.07), 'BookGreen')
    R = 0.0125
    for sy in (-1, 1):
        y = sy * 0.26
        g.tube(((-0.18, y, 0.01), (-0.18, y, t - 0.016), (0.18, y, t - 0.016), (0.18, y, 0.01)), R, 'Steel', 8, 0.04)
        g.tube(((-0.18, y, 0.17), (0.18, y, 0.17)), 0.009, 'Steel')
        for x in (-0.18, 0.18):
            g.tube(((x, y, 0), (x, y, 0.03)), 0.016, 'Rubber', 8)
    g.tube(((-0.18, -0.26, 0.17), (-0.18, 0.26, 0.17)), 0.009, 'Steel')
    g.tube(((0.18, -0.26, 0.17), (0.18, 0.26, 0.17)), 0.009, 'Steel')
    return g


def chair_geo():
    """椅子。背もたれは -Y 側。座面は木、背は反らせた木の板"""
    g = Geo()
    z = 0.375
    g.box((-0.17, -0.17, z), (0.17, 0.16, z + 0.032), 'ChairWood')
    g.box((-0.14, -0.214, 0.52), (0.14, -0.2, 0.66), 'ChairWood')
    R = 0.0115
    for s in (-1, 1):
        x = s * 0.15
        g.tube(((x, 0.14, 0.01), (x, 0.14, z - 0.006), (x, -0.185, z - 0.006), (x, -0.218, 0.68)), R, 'Steel', 8, 0.04)
        g.tube(((x, -0.16, 0.01), (x, -0.18, z - 0.02)), R, 'Steel')
        g.tube(((x, -0.16, 0.15), (x, 0.14, 0.15)), 0.008, 'Steel')
        for y in (-0.16, 0.14):
            g.tube(((x, y, 0), (x, y, 0.028)), 0.015, 'Rubber', 8)
    g.tube(((-0.15, 0.14, 0.15), (0.15, 0.14, 0.15)), 0.008, 'Steel')
    return g


def curtain(name, y0, y1, mat, seed, top=2.5, bottom=0.82, flare=0.0, x=-3.42, bright=1.0):
    """薄いカーテン。上は細かく、下へ行くほど風で膨らむ大きなひだになる。シェイプキー 2 つで揺らす"""
    r = random.Random(seed)
    nu, nv = 120, 36
    folds = max(2.2, (y1 - y0) / 0.28)
    ph = [r.uniform(0, 6.28) for _ in range(4)]

    def point(u, v, sway):
        n = 6.2832 * folds
        drift = 1.6 * v * math.sin(2.7 * u + ph[0] + sway[0]) + 0.9 * v * math.sin(6.1 * u + ph[1] - 1.4 * v + sway[1])
        a = 0.014 + 0.12 * v ** 1.1
        px = x + a * (math.sin(n * u + ph[2] + drift) + 0.4 * math.sin(2.3 * n * u + ph[3] - 1.2 * v + drift))
        px += flare * v ** 2.4 * (0.55 + 0.45 * math.sin(3.4 * u + ph[1] + sway[2])) + 0.05 * v * v * sway[2]
        spread = 1 + 0.03 * v * v
        py = (y0 + y1) / 2 + (y1 - y0) * (u - 0.5) * spread + 0.09 * v * v * math.sin(ph[3] + 1.6 * u + sway[0])
        return px, py, top + (bottom - top) * v - 0.03 * v ** 3 * math.sin(3 * u + ph[0])

    v_, f_, uv_, sh = [], [], [], []
    for j in range(nv + 1):
        for i in range(nu + 1):
            v_.append(point(i / nu, j / nv, (0, 0, 0)))
            uv_.append((i / nu, j / nv))
            sh.append(bright * (0.34 if j >= nv - 2 else 1.0))  # 裾の折り返し
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            f_.append((a, a + 1, a + nu + 2, a + nu + 1))
    m = bpy.data.meshes.new(name)
    m.from_pydata(v_, [], f_)
    m.uv_layers.new(name='UVMap').data.foreach_set('uv', [c for fc in f_ for k in fc for c in uv_[k]])
    col = m.color_attributes.new('shade', 'FLOAT_COLOR', 'POINT')
    col.data.foreach_set('color', [c for s in sh for c in (s, s, s, 1)])
    m.polygons.foreach_set('use_smooth', [True] * len(f_))
    m.materials.append(mat)
    m.update()
    o = link(name, m)
    o.shape_key_add(name='Basis')
    for k, sway in enumerate(((0.55, -0.4, 1.0), (-0.5, 0.6, -0.8))):
        key = o.shape_key_add(name=f'Sway{k}')
        idx = 0
        for j in range(nv + 1):
            for i in range(nu + 1):
                key.data[idx].co = point(i / nu, j / nv, sway)
                idx += 1
    return o


def key_sway(o, keys, total, period, phase):
    """シェイプキーの強さを周期 period(コマ)で往復させる"""
    sk = o.data.shape_keys.key_blocks
    step = max(4, round(period / 8))
    for name, ph in zip(keys, (phase, phase + 2.1)):
        b = sk[name]
        f = 1
        while f <= total + step:
            b.value = 0.5 + 0.5 * math.sin(6.2832 * f / period + ph)
            b.keyframe_insert('value', frame=f)
            f += step


def dust(mat, r, sun, frames, fps, beat):
    """窓から入る光の筋の中だけに置くほこり。シェイプキー 2 つで漂わせる"""
    N = 420
    base, a, b, f = [], [], [], []
    shape = ((1, 0, -0.7), (-1, 0, -0.7), (0, 1, 0.7), (0, -1, 0.7))
    for n in range(N):
        y = r.uniform(-0.8, 4.0)
        z = r.uniform(SILL + 0.1, HEAD - 0.1)
        p = Vector((-3.3, y, z)) - sun * r.uniform(0.3, 5.5)
        if p.z < 0.08 or p.z > 2.2 or p.x > 3.2 or abs(p.y) > 4.2 or (p - Vector(CAM)).length < 1.6:
            continue
        s = r.uniform(0.0007, 0.0016)
        i = len(base)
        da = Vector((r.uniform(-0.2, 0.2), r.uniform(-0.2, 0.2), r.uniform(-0.1, 0.16)))
        db = Vector((r.uniform(-0.2, 0.2), r.uniform(-0.2, 0.2), r.uniform(-0.16, 0.1)))
        for q in shape:
            c = p + Vector(q) * s
            base.append(c)
            a.append(c + da)
            b.append(c + db)
        f.extend(((i, i + 1, i + 2), (i, i + 3, i + 1), (i, i + 2, i + 3), (i + 1, i + 3, i + 2)))
    m = bpy.data.meshes.new('Dust')
    m.from_pydata([tuple(c) for c in base], [], f)
    m.materials.append(mat)
    m.update()
    o = link('Dust', m)
    o.visible_shadow = False
    o.shape_key_add(name='Basis')
    for name, co in (('DriftA', a), ('DriftB', b)):
        key = o.shape_key_add(name=name)
        key.data.foreach_set('co', [c for p in co for c in p])
    key_sway(o, ('DriftA', 'DriftB'), frames, 16 * beat * fps, 0.7)
    return o


def cylinder(name, mat, radius, z0, z1, a0, a1, u0, u1, v0, v1, center=(0, 0), n=72):
    """内側を向いた円筒の帯。a は +Y から -X へ回した度数。u は角度に比例する"""
    v, f, uv = [], [], []
    for i in range(n + 1):
        t = i / n
        a = math.radians(a0 + (a1 - a0) * t)
        x, y = center[0] - math.sin(a) * radius, center[1] + math.cos(a) * radius
        v.extend(((x, y, z0), (x, y, z1)))
        uv.append(((u0 + (u1 - u0) * t, v0), (u0 + (u1 - u0) * t, v1)))
    for i in range(n):
        j = i * 2
        f.append((j, j + 2, j + 3, j + 1))
    m = bpy.data.meshes.new(name)
    m.from_pydata(v, [], f)
    m.uv_layers.new(name='UVMap').data.foreach_set('uv', [c for i in range(n) for p in (uv[i][0], uv[i + 1][0], uv[i + 1][1], uv[i][1]) for c in p])
    m.materials.append(mat)
    m.update()
    o = link(name, m)
    o.visible_shadow = False
    return o


def card(name, mat, az, dist, width, ztop, flip):
    """窓の外の桜の 1 枚。カメラのある方へ向く。視差が出るよう距離を変えて何枚も置く"""
    a = math.radians(az)
    d = Vector((-math.sin(a), math.cos(a), 0))
    side = Vector((d.y, -d.x, 0)) * (width / 2)
    c = Vector((CAM[0], CAM[1], 0)) + d * dist
    h = width / 1.5
    z0 = ztop - 0.86 * h
    pts = [c - side + Vector((0, 0, z0)), c + side + Vector((0, 0, z0)), c + side + Vector((0, 0, z0 + h)), c - side + Vector((0, 0, z0 + h))]
    m = bpy.data.meshes.new(name)
    m.from_pydata([tuple(p) for p in pts], [], [(0, 1, 2, 3)])
    uv = ((1, 0), (0, 0), (0, 1), (1, 1)) if flip else ((0, 0), (1, 0), (1, 1), (0, 1))
    m.uv_layers.new(name='UVMap').data.foreach_set('uv', [c2 for p in uv for c2 in p])
    m.materials.append(mat)
    m.update()
    o = link(name, m)
    o.visible_shadow = False
    return o


def outside(mt, r):
    """窓の外。遠景は 2 枚: 全周の空と街、目標の窓に見える方角の空と丘。桜は距離の違う板。太陽は 1 つの発光の板"""
    R = 90.0
    H = R * math.radians(90) / 1.5
    wide = mt.shadeless('OutsideWide', 'outside_wide_a', 1.0, 1.0, reflect=1.4)
    cylinder('OutsideWide', wide, R, -0.25 * H - 2 * H, 2.75 * H, -40, 215, -0.5, 2.3, -2, 3, CAM[:2])
    main = mt.shadeless('OutsideMain', 'outside_main_a', 1.1, 1.0, 'CLIP', True, reflect=1.2)
    Rm = 84.0
    cylinder('OutsideMain', main, Rm, Rm * math.tan(math.radians(3.2)), Rm * math.tan(math.radians(30.2)), 36, 18, 0, 1, 0, 1, CAM[:2], 16)
    near = mt.shadeless('SakuraNear', 'sakura_cut', 0.96, 1.0, 'CLIP', True, reflect=1.6)
    far = mt.shadeless('SakuraFar', 'sakura_b_cut', 0.88, 1.0, 'CLIP', True, reflect=1.4)
    for i, (m, az, dist, width, ztop, flip) in enumerate((
            (far, 21.0, 30.0, 18.0, 6.3, False), (far, 34.0, 30.0, 15.0, 3.7, True),
            (near, 26.5, 15.0, 10.5, 2.75, False), (near, 21.0, 12.0, 7.0, 2.6, True))):
        card(f'SakuraT{i}', m, az, dist, width, ztop, flip)
    az = 56.0
    i = 0
    while az < 178:
        m = r.choice((near, far))
        card(f'Sakura{i}', m, az + r.uniform(-4, 4), r.uniform(16, 34), r.uniform(10, 14), r.uniform(3.2, 5.6), r.random() < 0.5)
        az += r.uniform(9, 16)
        i += 1
    # 丘の上の鉄塔と建物
    land = Geo()
    far_d = lambda az_: Vector((-math.sin(math.radians(az_)), math.cos(math.radians(az_)), 0))
    tp = Vector(CAM) + far_d(23.55) * 74
    h0, h1 = 74 * math.tan(math.radians(9.5)), 74 * math.tan(math.radians(11.6))
    land.tube((tp + Vector((0, 0, h0)), tp + Vector((0, 0, h1))), 0.05, 0, 5)
    land.obj('Tower', [mt.glow('TowerDark', (0.16, 0.14, 0.15), 1.0)])
    bd = Geo()
    bp = Vector(CAM) + far_d(26.3) * 70
    b0, b1 = 70 * math.tan(math.radians(8.9)), 70 * math.tan(math.radians(9.6))
    sb = Vector((far_d(26.3).y, -far_d(26.3).x, 0)) * 0.6
    bd.quad(bp - sb + Vector((0, 0, b0)), bp + sb + Vector((0, 0, b0)), bp + sb + Vector((0, 0, b1)), bp - sb + Vector((0, 0, b1)), 0)
    bd.obj('SchoolFar', [mt.glow('SchoolFar', (0.72, 0.66, 0.6), 1.0)])
    a, e = math.radians(29.8), math.radians(11.1)
    d = Vector((-math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))
    s = d.cross(Vector((0, 0, 1))).normalized() * 9.0
    u = s.cross(d).normalized() * 9.0
    c = Vector(CAM) + d * 80
    mesh = bpy.data.meshes.new('SunGlow')
    mesh.from_pydata([tuple(c - s - u), tuple(c + s - u), tuple(c + s + u), tuple(c - s + u)], [], [(0, 1, 2, 3)])
    mesh.uv_layers.new(name='UVMap').data.foreach_set('uv', [0, 0, 1, 0, 1, 1, 0, 1])
    mesh.materials.append(mt.sun_glow())
    mesh.update()
    link('SunGlow', mesh).visible_shadow = False


def compositor():
    """太陽と窓のにじみ、弱いシャープ、色の調整。シャープはにじみのあとに置き、明るい物の縁に黒い線を出さない"""
    s = bpy.context.scene
    nt = bpy.data.node_groups.new('Glow', 'CompositorNodeTree')
    s.compositing_node_group = nt
    N, L = nt.nodes, nt.links
    rl = N.new('CompositorNodeRLayers')
    g = N.new('CompositorNodeGlare')
    g.inputs['Type'].default_value = 'Bloom'
    g.inputs['Quality'].default_value = 'Medium'
    g.inputs['Threshold'].default_value = 0.95
    g.inputs['Smoothness'].default_value = 0.6
    g.inputs['Strength'].default_value = 0.24
    g.inputs['Saturation'].default_value = 1.0
    g.inputs['Size'].default_value = 0.86
    L.new(rl.outputs['Image'], g.inputs['Image'])
    st = N.new('CompositorNodeGlare')  # 太陽だけの光条
    st.inputs['Type'].default_value = 'Streaks'
    st.inputs['Quality'].default_value = 'Medium'
    st.inputs['Threshold'].default_value = 3.0
    st.inputs['Strength'].default_value = 0.2
    st.inputs['Size'].default_value = 0.55
    st.inputs['Streaks'].default_value = 8
    st.inputs['Streaks Angle'].default_value = 0.2
    st.inputs['Fade'].default_value = 0.88
    L.new(g.outputs['Image'], st.inputs['Image'])
    sh = N.new('CompositorNodeFilter')
    sh.inputs['Type'].default_value = 'Box Sharpen'
    sh.inputs['Factor'].default_value = 0.05
    L.new(st.outputs['Image'], sh.inputs['Image'])
    cb = N.new('CompositorNodeColorBalance')
    L.new(sh.outputs[0], cb.inputs['Image'])
    [i for i in cb.inputs if i.name == 'Gain' and i.type == 'RGBA'][0].default_value = GAIN
    [i for i in cb.inputs if i.name == 'Lift' and i.type == 'VALUE'][0].default_value = 0.0  # 暗部を締める
    nt.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    L.new(cb.outputs['Image'], N.new('NodeGroupOutput').inputs[0])
    s.render.use_compositing = True


def lights():
    for name, p in (('SunMain', SUN_MAIN), ('SunBoard', SUN_BOARD), ('SunChar', SUN_CHAR)):
        data = bpy.data.lights.new(name, 'SUN')
        data.energy = p['energy']
        data.color = p['color']
        data.angle = math.radians(0.8)
        o = link(name, data)
        o.rotation_euler = sun_vec(p['az'], p['el']).to_track_quat('Z', 'Y').to_euler()
        o.visible_glossy = False  # 床の白飛びを防ぐ。太陽の反射は SunGlow が受け持つ
    # 窓からの空の光。カメラと反射には写らない
    for y, w in ((2.2, 4.0), (-0.9, 3.4), (-3.2, 1.4)):
        data = bpy.data.lights.new(f'Sky{y}', 'AREA')
        data.shape = 'RECTANGLE'
        data.size, data.size_y = 1.5, w
        data.energy = SKY_POWER * w
        data.color = (1.0, 0.84, 0.7)
        o = link(f'Sky{y}', data, (-3.0, y, 1.7))
        o.rotation_euler = (0, math.radians(90), 0)
        o.visible_camera = False
        o.visible_glossy = False
    # 床だけの光: 机の前まで届く金色の光と、窓の上端の影で暗くなる右側を埋める光
    for name, loc, size, energy in (('FloorSpot', (-2.3, -1.1, 1.1), (1.5, 3.4), FLOOR_SPOT), ('FloorSpotR', (-0.1, -0.2, 1.1), (1.3, 5.5), 6), ('FloorSpotF', (-1.7, 3.5, 1.1), (3.0, 1.2), 22)):
        data = bpy.data.lights.new(name, 'AREA')
        data.shape = 'RECTANGLE'
        data.size, data.size_y = size
        data.energy = energy
        data.spread = math.radians(48)
        data.color = (1.0, 0.76, 0.46)
        data.use_shadow = False
        o = link(name, data, loc)
        o.visible_camera = False
        o.visible_glossy = False
    data = bpy.data.lights.new('NearSpot', 'SPOT')  # 手前の床の明るさ。NearStrip の影が帯になる
    data.energy = 620
    data.spot_size = math.radians(60)
    data.spot_blend = 0.5
    data.shadow_soft_size = 0.05
    data.color = (1.0, 0.72, 0.46)
    o = link('NearSpot', data, NEAR_SPOT)
    o.rotation_euler = (Vector((-1.0, -2.7, 0)) - Vector(NEAR_SPOT)).to_track_quat('-Z', 'Y').to_euler()
    o.visible_glossy = False
    data = bpy.data.lights.new('FarPatch', 'AREA')  # 奥の金色の日なた
    data.shape = 'RECTANGLE'
    data.size, data.size_y = 1.7, 0.3
    data.energy = FAR_PATCH
    data.color = (1.0, 0.72, 0.42)
    data.use_shadow = False
    o = link('FarPatch', data, (-2.72, 1.34, 0.16))
    o.rotation_euler = (0, 0, math.radians(-43))
    o.visible_camera = False
    o.visible_glossy = False
    # 床と壁からの照り返しの代わり。右から、床から天井へ、低い所から左の腰板へ弱く当てる
    for name, size, energy, loc, rot in (
            ('Fill', (2.4, 8.0), FILL_POWER, (2.6, 0, 1.4), (0, math.radians(-90), 0)),
            ('Bounce', (6.0, 8.0), BOUNCE_POWER, (0, 0, 0.06), (math.radians(180), 0, 0)),
            ('Low', (0.8, 8.5), LOW_POWER, (-1.7, 0, 0.42), (0, math.radians(-90), 0)),
            ('FrontFill', (6.0, 2.4), 80, (0, -3.6, 1.5), (math.radians(90), 0, 0)),
            ('FloorFill', (8.0, 9.0), 3, (0, 0, 2.9), (0, 0, 0))):
        data = bpy.data.lights.new(name, 'AREA')
        data.shape = 'RECTANGLE'
        data.size, data.size_y = size
        data.energy = energy
        data.color = (1.0, 0.8, 0.62)
        o = link(name, data, loc)
        o.rotation_euler = rot
        o.visible_camera = False
        o.visible_glossy = False


def sun_blocker():
    """窓の外の建物の代わり。後ろの窓からの日を止めて、手前の床に大きな斜めの影を作る。影にしか現れない"""
    mesh = bpy.data.meshes.new('SunBlocker')
    v, f = [], []
    shift = 0.148  # 帯の位置は窓の面 X -3.55 の値。この板は X -3.74 にある
    v.extend(((-3.74, -4.7, -1), (-3.74, SHADE_Y[0], -1), (-3.74, SHADE_Y[1], 5), (-3.74, -4.7, 5)))
    f.append((0, 1, 2, 3))
    for y0, y1 in SHADOW_BARS:
        i = len(v)
        y0, y1 = y0 + shift, y1 + shift
        v.extend(((-3.74, y0, -1), (-3.74, y1, -1), (-3.74, y1, 5), (-3.74, y0, 5)))
        f.append((i, i + 1, i + 2, i + 3))
    mesh.from_pydata(v, [], f)
    mesh.update()
    o = link('SunBlocker', mesh)
    o.visible_camera = o.visible_diffuse = o.visible_glossy = o.visible_transmission = False
    return o


def near_strip():
    """手前の床の斜めの影を作る板。NearSpot の光の途中に置く。影にしか現れない"""
    t = 0.6
    P = Vector(NEAR_SPOT)
    pts = [P + (Vector((x, y, 0)) - P) * t for x, y in NEAR_BAND]
    mesh = bpy.data.meshes.new('NearStrip')
    mesh.from_pydata([tuple(q) for q in pts], [], [(0, 1, 2, 3)])
    mesh.update()
    o = link('NearStrip', mesh)
    o.visible_camera = o.visible_diffuse = o.visible_glossy = o.visible_transmission = False
    return o


def board_bars():
    """SunBoard だけの横の影。教卓と黒板に斜めの窓枠の影を足す"""
    mesh = bpy.data.meshes.new('BoardBars')
    v, f = [], []
    for z0, z1 in ((1.92, 2.04),):
        i = len(v)
        v.extend(((-3.74, -1, z0), (-3.74, 2.6, z0), (-3.74, 2.6, z1), (-3.74, -1, z1)))
        f.append((i, i + 1, i + 2, i + 3))
    mesh.from_pydata(v, [], f)
    mesh.update()
    o = link('BoardBars', mesh)
    o.visible_camera = o.visible_diffuse = o.visible_glossy = o.visible_transmission = False
    return o


def exclude(name, objects, light, attr='receiver_collection'):
    """objects を除いた集まりを light に結ぶ。ライトリンクは「除くだけの集まり」で残りすべてを対象にする"""
    c = bpy.data.collections.new(name)
    for o in objects:
        c.objects.link(o)
    for co in c.collection_objects:
        co.light_linking.link_state = 'EXCLUDE'
    setattr(bpy.data.objects[light].light_linking, attr, c)


def build(ctx):
    r = random.Random(ctx.seed + 11)
    s = bpy.context.scene
    c = s.cycles
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces, c.transparent_max_bounces = 5, 3, 2, 2, 10
    c.light_sampling_threshold = 0.02
    c.adaptive_threshold = 0.04
    s.view_settings.view_transform = 'Standard'
    s.view_settings.look = 'None'
    c.filter_width = 1.0
    w = bpy.data.worlds.new('Sky')
    w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Strength'].default_value = 0.0
    s.world = w

    mt = Mats(ctx.assets)
    defs = {
        'Wall': mt.textured('Wall', 'wall', 2.2, 0.72, 0.3, (0.9, 0.82, 0.68)),
        'WoodPanel': mt.textured('WoodPanel', 'wood_panel', (0.62, 0.62), 0.34, 0.5, (0.37, 0.52, 1.1)),
        'WoodPanelSide': mt.textured('WoodPanelSide', 'wood_panel', (0.55, 0.55), 0.38, 0.5, (0.34, 0.46, 1.0)),
        'Trim': mt.textured('Trim', 'desk_wood', (1.0, 0.3), 0.5, 0.2, (0.36, 0.3, 0.24)),
        'Baseboard': mt.plain('Baseboard', (0.07, 0.055, 0.045), 0.4),
        'AluGlint': mt.glow('AluGlint', (1.0, 0.86, 0.66), 0.8),
        'Alu': mt.plain('Alu', (0.2, 0.13, 0.07), 0.35, 0.3),
        'AluWarm': mt.plain('AluWarm', (0.17, 0.12, 0.08), 0.4, 0.2),
        'AluBright': mt.plain('AluBright', (0.8, 0.77, 0.7), 0.3, 1.0),
        'FrameDark': mt.plain('FrameDark', (0.14, 0.12, 0.1), 0.35, 0.5),
        'Rail': mt.plain('Rail', (0.3, 0.27, 0.24), 0.35, 1.0),
        'Glass': mt.glass(),
        'Ceiling': mt.soft('Ceiling', 'ceiling', 0.7, 0.8, (0.4, 0.46, 0.4), 0.4),
        'CeilGap': mt.plain('CeilGap', (0.26, 0.2, 0.14), 0.8),
        'Beam': mt.textured('Beam', 'wall', 2.2, 0.7, 0.3, (0.82, 0.76, 0.62)),
        'Board': mt.textured('Board', 'blackboard_c', 1.0, 0.6, 0.3, BOARD_TINT, 'MIRROR'),
        'Cork': mt.textured('Cork', 'cork', 0.9, 0.85, 0.2, (0.95, 0.66, 0.46)),
        'NoticeA': mt.textured('NoticeA', 'notice_a', 1.0, 0.7, 0.3, (0.74, 0.7, 0.62), 'EXTEND'),
        'NoticeB': mt.textured('NoticeB', 'notice_b_c', 1.0, 0.7, 0.3, (0.8, 0.76, 0.68), 'EXTEND'),
        'NoticeC': mt.textured('NoticeC', 'notice_c', 1.0, 0.7, 0.3, (0.66, 0.63, 0.8), 'EXTEND'),
        'PosterA': mt.textured('PosterA', 'poster_a', 1.0, 0.65, 0.3, (0.8, 0.76, 0.7), 'EXTEND'),
        'PosterB': mt.textured('PosterB', 'poster_b', 1.0, 0.65, 0.3, (0.8, 0.76, 0.7), 'EXTEND'),
        'ClockFace': mt.textured('ClockFace', 'clock', 1.0, 0.25, 0.5, (0.9, 0.88, 0.82), 'EXTEND'),
        'ClockRim': mt.plain('ClockRim', (0.1, 0.09, 0.08), 0.35),
        'ClockHand': mt.plain('ClockHand', (0.02, 0.02, 0.02), 0.5),
        'SpeakerBox': mt.plain('SpeakerBox', (0.09, 0.07, 0.055), 0.5),
        'SpeakerFace': mt.textured('SpeakerFace', 'speaker', 1.0, 0.55, 0.3, (3.4, 3.8, 4.2), 'EXTEND'),
        'EraserY': mt.plain('EraserY', (0.72, 0.44, 0.06), 0.8),
        'EraserB': mt.plain('EraserB', (0.06, 0.12, 0.34), 0.7),
        'Chalk': mt.plain('Chalk', (0.9, 0.88, 0.84), 0.8),
        'Podium': mt.textured('Podium', 'desk_wood', (0.8, 0.8), 0.3, 0.5, (0.28, 0.21, 0.155)),
        'PodiumTop': mt.textured('PodiumTop', 'desk_wood', 1.0, 0.26, 0.5, (0.6, 0.4, 0.25)),
        'PodiumFrame': mt.textured('PodiumFrame', 'desk_wood', 1.0, 0.3, 0.5, (0.4, 0.28, 0.18)),
        'Cabinet': mt.plain('Cabinet', (0.5, 0.42, 0.3), 0.42, 0.2),
        'CabBase': mt.plain('CabBase', (0.2, 0.19, 0.18), 0.5),
        'Books': mt.plain('Books', (0.3, 0.3, 0.3), 0.7),
        'BookSpines': mt.textured('BookSpines', 'books', 1.0, 0.45, 0.4, (0.2, 0.2, 0.27), 'EXTEND'),
        'BookBlue': mt.plain('BookBlue', (0.06, 0.13, 0.3), 0.5),
        'BookGreen': mt.plain('BookGreen', (0.2, 0.3, 0.16), 0.5),
        'PaperStack': mt.plain('PaperStack', (0.5, 0.46, 0.4), 0.8),
        'Box': mt.textured('Box', 'desk_wood', 0.8, 0.8, 0.2, (0.6, 0.5, 0.38)),
        'Bag': mt.plain('Bag', (0.1, 0.11, 0.2), 0.55),
        'Steel': mt.plain('Steel', (0.66, 0.66, 0.68), 0.25, 0.75),
        'Rubber': mt.plain('Rubber', (0.012, 0.012, 0.012), 0.5),
        'FloorGap': mt.soft('FloorGap', 'floor_wear', 0.7, 0.6, (0.2, 0.14, 0.1), 0.5),
        'DeskTop': mt.textured('DeskTop', 'desk_wood', 1.0, 0.3, 0.5, (0.76, 0.6, 0.42)),
        'DeskEdge': mt.textured('DeskEdge', 'desk_wood', 0.5, 0.35, 0.5, (0.9, 0.62, 0.38)),
        'TrayMetal': mt.plain('TrayMetal', (0.13, 0.12, 0.11), 0.45, 0.3),
        'ChairWood': mt.textured('ChairWood', 'desk_wood', 1.0, 0.32, 0.5, (0.52, 0.38, 0.26)),
        'FixtureBody': mt.plain('FixtureBody', (0.72, 0.68, 0.6), 0.4),
        'Tube': mt.plain('Tube', (0.86, 0.84, 0.78), 0.25),
        'RodDark': mt.plain('RodDark', (0.12, 0.11, 0.1), 0.45),
        'Locker': mt.textured('Locker', 'locker', 1.0, 0.45, 0.4, (0.72, 0.68, 0.6), 'EXTEND'),
        'DoorFrame': mt.textured('DoorFrame', 'wood_panel', (0.5, 3.0), 0.4, 0.5, (0.7, 0.58, 0.45)),
        'Door': mt.textured('Door', 'wood_panel', (1.2, 2.4), 0.36, 0.5, (0.9, 0.75, 0.6)),
        'DoorGlass': mt.plain('DoorGlass', (0.05, 0.05, 0.05), 0.08),
        'Hallway': mt.glow('Hallway', (0.75, 0.62, 0.48), 0.3),
    }
    names = list(defs)
    mats = [defs[n] for n in names]

    class Slots(Geo):
        """材質を名前で書けるようにする"""

        def poly(self, pts, uvs, mat, smooth=False):
            super().poly(pts, uvs, names.index(mat) if isinstance(mat, str) else mat, smooth)

    floor = block_floor(mt.floor(), r)
    room = Slots()
    front = Slots()
    room.box((-3.9, -ROOM_Y - 0.3, -0.2), (ROOM_X + 0.3, ROOM_Y + 0.3, -0.0006), 'FloorGap')
    room.box((-3.9, -ROOM_Y - 0.3, ROOM_Z + 0.002), (ROOM_X + 0.3, ROOM_Y + 0.3, ROOM_Z + 0.2), 'CeilGap')
    ceiling_tiles(room, 'Ceiling', r)
    window_wall(room)
    front_wall(front, room)
    back_wall(room, r)
    right_wall(room)
    # 梁: 窓の壁に沿う梁は window_wall にある
    # 大梁は目標の見えに合わせて X へ進むほど少し奥へ振る
    for y0 in (2.55, -0.6, -3.6):
        d = 0.45
        a0, a1 = y0 + 0.1 * (-3.7 + 0.6), y0 + 0.1 * (ROOM_X + 0.6)
        A = lambda x, y, z: (x, y, z)
        for pts in (((-3.7, a0, 2.8), (ROOM_X, a1, 2.8), (ROOM_X, a1, ROOM_Z), (-3.7, a0, ROOM_Z)),
                    ((-3.7, a0, 2.8), (-3.7, a0 + d, 2.8), (ROOM_X, a1 + d, 2.8), (ROOM_X, a1, 2.8)),
                    ((ROOM_X, a1 + d, 2.8), (-3.7, a0 + d, 2.8), (-3.7, a0 + d, ROOM_Z), (ROOM_X, a1 + d, ROOM_Z))):
            room.quad(*pts, 'Beam', tuple((p[0], p[1] + p[2]) for p in pts))
    room.box((-3.7, 4.12, 2.86), (ROOM_X, ROOM_Y, ROOM_Z), 'Beam')
    for x, y in ((-2.1, 3.55), (-0.38, 3.15), (1.2, 3.55), (2.8, 3.55), (-2.27, -0.05), (0.0, -0.05), (1.4, -0.05), (2.8, -0.05), (-2.1, -3.4), (-0.38, -3.4), (1.2, -3.4), (2.8, -3.4)):
        fixture(room, x, y)
    room.obj('Room', mats)
    fr_obj = front.obj('Front', mats)
    chair = chair_geo()
    chair.mat = [names.index(m) for m in chair.mat]
    cm = chair.mesh('Chair', mats)
    dms = []
    for b in (True, False):
        g = desk_geo(b)
        g.mat = [names.index(m) for m in g.mat]
        dms.append(g.mesh('Desk', mats))

    def place(x, y, tucked=0.44, with_chair=True, aisle=0.0):
        dm = dms[r.random() < 0.3]
        link('Desk', dm, (x + r.uniform(-0.012, 0.012), y + r.uniform(-0.01, 0.01), 0), math.radians(r.uniform(-1.2, 1.2)))
        if with_chair:
            link('Chair', cm, (x + aisle + r.uniform(-0.015, 0.015), y - tucked + r.uniform(-0.015, 0.015), 0), math.radians(r.uniform(-3, 3)))

    for i in range(10):  # 窓際の列。奥から手前の後ろの壁の近くまで
        place(-3.24, 3.8 - i * 0.9, aisle=0.13)  # 椅子は通路側へ引き出す
    for x in (-0.56, 0.42, 1.5, 2.6):
        for y in (2.0, 2.85, 3.7):
            place(x, y)
    for x in (1.95, 2.95):
        for i in range(4):  # 後ろは空けて、カメラの通り道にする
            place(x, 0.9 - i * 0.9)

    cur = mt.curtain()
    period = 12 * (ctx.beats[1] - ctx.beats[0] if len(ctx.beats) > 1 else 0.5) * ctx.fps
    total = max(ctx.frames, 600)
    curtains = []
    for i, (y0, y1, fl, seed, bot) in enumerate(CURTAINS):
        o = curtain(f'Curtain{i}', y0, y1, cur, seed, bottom=bot, flare=fl, bright=0.8 if i == 0 else 1.0)
        o.visible_shadow = False  # 窓の影の形を保つ
        key_sway(o, ('Sway0', 'Sway1'), total, period * (1 + 0.13 * i), i * 1.4)
        curtains.append(o)

    outside(mt, r)
    lights()
    sun = sun_vec(SUN_MAIN['az'], SUN_MAIN['el'])
    dust(mt.glow('DustGlow', (1.0, 0.82, 0.55), 0.5), r, sun, total, ctx.fps, (ctx.beats[1] - ctx.beats[0]) if len(ctx.beats) > 1 else 0.5)
    blocker = sun_blocker()
    bars = board_bars()
    strip = near_strip()

    recv = bpy.data.collections.new('FrontWallOnly')
    recv.objects.link(fr_obj)
    bpy.data.objects['SunBoard'].light_linking.receiver_collection = recv
    # SunChar: 今ある物(ステージ)をすべて除く。あとから読むキャラだけに当たる
    exclude('NotStage', [o for o in s.collection.objects if o.type == 'MESH'], 'SunChar')
    exclude('NoBlocker', [blocker, bars, strip], 'SunChar', 'blocker_collection')
    exclude('NoBlockerBoard', [blocker, strip], 'SunBoard', 'blocker_collection')
    exclude('NoBarsMain', [bars, strip], 'SunMain', 'blocker_collection')
    exclude('NoCurtain', curtains, 'SunMain')
    # 補助の光は床に当てない。床の明暗を日の光の形のままにする
    for i, name in enumerate(('Fill', 'Low', 'FrontFill', 'Sky2.2', 'Sky-0.9', 'Sky-3.2')):
        exclude(f'NoFloor{i}', [floor, *curtains], name)
    only = bpy.data.collections.new('FloorOnly')
    only.objects.link(floor)
    bpy.data.objects['FloorFill'].light_linking.receiver_collection = only
    bpy.data.objects['FloorSpot'].light_linking.receiver_collection = only
    bpy.data.objects['FloorSpotR'].light_linking.receiver_collection = only
    for name in ('FloorSpotF', 'NearSpot', 'FarPatch'):
        bpy.data.objects[name].light_linking.receiver_collection = only
    compositor()
    return {
        'mark': MARK,
        'facing': 0,
        'bounds': ((-2.95, 3.2), (-4.0, 4.2), (0.12, 2.2)),  # 窓際の机とロッカーの中へ入らない
        'char_emission': 0.42,
        'beats_per_shot': 8,
        'views': {
            'target': {'loc': CAM, 'look': LOOK, 'lens': 30},
            'hold1': {'loc': (1.3, -2.6, 1.2), 'look': (-1.6, 0.6, 1.1), 'lens': 28},
            'hold2': {'loc': (-1.55, 3.0, 0.7), 'look': (-1.2, -3.0, 1.15), 'lens': 20},
        },
    }
