"""放課後の学校の体育館。床は X -7(窓)..7、Y -9.5(後ろ)..13(舞台の壁)、軒の高さ 9.5 m、棟 11.3 m の切妻。素材は assets/gym の image_gen の画像。

左の壁(西)は下の窓と高い窓が並び、夕日が窓枠の影ごと床へ斜めに入る。右の壁は腰の緑の板、肋木、バスケットのゴール。両側の壁の 4 m の高さにギャラリー。
奥(+Y)は幕の下りた舞台。天井は緑の鉄骨のトラスと吊りの照明。mark は床の中央(センターサークルの中心)で、まわり 3 m 四方は空いている。
日の光は 2 つ: SunMain は窓から床と壁へ。SunChar はステージの物を除いて、キャラだけを低い角度で照らす。
"""
import math
import random

import bpy
from mathutils import Vector
from lib.studio import load_image

HX = 7.0               # 左右の壁の X(内側の面)
Y0, Y1 = -9.5, 13.0    # 後ろの壁と舞台の壁の Y
EAVE, RIDGE = 9.5, 11.3
BAYS = [Y0 + 4.5 * k for k in range(6)]  # 柱とトラスの Y
PANEL_Z = 1.8          # 腰の板の高さ
GAL_Z, GAL_D = 4.0, 0.9  # ギャラリーの床の高さと奥行き
LOW_WIN = (1.2, 3.2)   # 左の壁の下の窓(Z)
HIGH_WIN = (4.8, 9.0)  # 左の壁の高い窓(Z)
STAGE_Z = 1.0          # 舞台の床の高さ
OPEN_X, OPEN_Z = 4.8, 6.0  # 舞台の口の半幅と上端
MARK = (0.0, 0.0, 0.0)
CAM = (0.0, -5.0, 1.0)
LOOK = (0.0, 15.0, -0.25)
SUN_MAIN = dict(az=55, el=35, energy=8.0, color=(1.0, 0.72, 0.45))
SUN_CHAR = dict(az=110, el=20, energy=4.0, color=(1.0, 0.7, 0.45))  # キャラだけに当たる日。左の窓の側から少し前へ回し、顔に当てる
CHAR_TOP = 90.0  # キャラの顔の光(W)
SUN_STAGE = dict(az=112, el=18, energy=6.0, color=(1.0, 0.7, 0.42))  # 舞台の壁と幕だけに当たる日。奥の窓の形を幕に落とす
GAIN = (1.0, 1.0, 1.08, 1)


def sun_vec(az, el):
    """太陽へ向かう単位ベクトル。az は +Y から -X へ回した度数"""
    a, e = math.radians(az), math.radians(el)
    return Vector((-math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))


def link(name, data, loc=(0, 0, 0), rot=0.0):
    o = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (0, 0, rot)
    return o


class Geo:
    """材質の名前つきの面を集めて 1 つのメッシュにする。UV はメートル単位(材質の側で繰り返しの大きさを決める)"""

    def __init__(self):
        self.v, self.f, self.uv, self.mat, self.smooth = [], [], [], [], []

    def poly(self, pts, uvs, mat, smooth=False):
        i = len(self.v)
        self.v.extend(tuple(p) for p in pts)
        self.f.append(tuple(range(i, i + len(pts))))
        self.uv.extend(uvs)
        self.mat.append(mat)
        self.smooth.append(smooth)

    def quad(self, a, b, c, d, mat, uv=None):
        if uv is None:  # 面の大きさのまま(メートル)
            w, h = (Vector(b) - Vector(a)).length, (Vector(d) - Vector(a)).length
            uv = ((0, 0), (w, 0), (w, h), (0, h))
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

    def beam(self, p0, p1, w, h, mat):
        """p0 から p1 への角材(幅 w、高さ h)"""
        p0, p1 = Vector(p0), Vector(p1)
        d = (p1 - p0).normalized()
        ref = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        s = d.cross(ref).normalized() * (w / 2)
        u = s.cross(d).normalized() * (h / 2)
        c = [p0 - s - u, p0 + s - u, p0 + s + u, p0 - s + u]
        e = [q + (p1 - p0) for q in c]
        L = (p1 - p0).length
        for i in range(4):
            j = (i + 1) % 4
            self.poly((c[i], c[j], e[j], e[i]), ((0, 0), (w, 0), (w, L), (0, L)), mat)
        self.poly(tuple(reversed(c)), ((0, 0), (w, 0), (w, h), (0, h)), mat)
        self.poly(tuple(e), ((0, 0), (w, 0), (w, h), (0, h)), mat)

    def tube(self, pts, r, mat, n=8):
        path = [Vector(p) for p in pts]
        up = Vector((0.13, 0.37, 0.92))
        rings = []
        for i, p in enumerate(path):
            d = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
            s = d.cross(up).normalized()
            up = s.cross(d).normalized()
            rings.append([p + (s * math.cos(a) + up * math.sin(a)) * r for a in (6.2832 * j / n for j in range(n))])
        for a, b in zip(rings, rings[1:]):
            for j in range(n):
                k = (j + 1) % n
                self.poly((a[j], a[k], b[k], b[j]), [(0, 0)] * 4, mat, True)

    def wall(self, axis, coord, us, vs, holes, inward, mat_of, reveal=0.0, reveal_mat=None):
        """平らな壁を穴(窓、舞台の口)を残して格子に切って張る。axis='x' は X=coord の壁(面の座標は Y, Z)、'y' は Y=coord の壁(X, Z)。
        holes は (u0, u1, v0, v1)。mat_of(u, v) は格子の 1 つの中心の材質。inward は内側の法線の向き(+1/-1)。reveal は穴の厚み(外へ)"""
        cu = sorted({*us, *(h[0] for h in holes), *(h[1] for h in holes)})
        cv = sorted({*vs, *(h[2] for h in holes), *(h[3] for h in holes), PANEL_Z})
        cu = [u for u in cu if us[0] <= u <= us[-1]]
        cv = [v for v in cv if vs[0] <= v <= vs[-1]]

        def P(u, v, off=0.0):
            return (coord - inward * off, u, v) if axis == 'x' else (u, coord - inward * off, v)
        # X=coord の壁で (u: +Y, v: +Z) の順は +X を向く。Y=coord の壁で (u: +X, v: +Z) の順は -Y を向く
        keep = inward > 0 if axis == 'x' else inward < 0
        for u0, u1 in zip(cu, cu[1:]):
            for v0, v1 in zip(cv, cv[1:]):
                mu, mv = (u0 + u1) / 2, (v0 + v1) / 2
                if any(h[0] <= mu <= h[1] and h[2] <= mv <= h[3] for h in holes):
                    continue
                pts = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)]
                uv = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
                if not keep:
                    pts, uv = pts[::-1], uv[::-1]
                self.poly(pts, uv, mat_of(mu, mv))
        if reveal:
            for u0, u1, v0, v1 in holes:
                for a, b in (((u0, v0), (u1, v0)), ((u1, v0), (u1, v1)), ((u1, v1), (u0, v1)), ((u0, v1), (u0, v0))):
                    pts = [P(*a), P(*b), P(*b, reveal), P(*a, reveal)]
                    if not keep:
                        pts = pts[::-1]
                    L = math.dist(a, b)
                    self.poly(pts, ((0, 0), (L, 0), (L, reveal), (0, reveal)), reveal_mat)

    def mesh(self, name, names, mats):
        m = bpy.data.meshes.new(name)
        m.from_pydata(self.v, [], self.f)
        uv = m.uv_layers.new(name='UVMap')
        uv.data.foreach_set('uv', [c for p in self.uv for c in p])
        m.polygons.foreach_set('material_index', [names.index(x) for x in self.mat])
        m.polygons.foreach_set('use_smooth', self.smooth)
        for x in mats:
            m.materials.append(x)
        m.update()
        return m


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

    def tex(self, nt, img, size=1.0, ext='REPEAT', rot=0.0):
        """UV(メートル)を size で割って画像を読む節"""
        uv = nt.nodes.new('ShaderNodeTexCoord')
        mp = nt.nodes.new('ShaderNodeMapping')
        sx, sy = size if isinstance(size, tuple) else (size, size)
        mp.inputs['Scale'].default_value = (1 / sx, 1 / sy, 1)
        mp.inputs['Rotation'].default_value = (0, 0, rot)
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = img
        t.extension = ext
        nt.links.new(uv.outputs['UV'], mp.inputs['Vector'])
        nt.links.new(mp.outputs['Vector'], t.inputs['Vector'])
        return t

    def textured(self, name, img, size=1.0, rough=0.6, spec=0.5, tint=(1, 1, 1), ext='REPEAT', bump=0.0, rot=0.0, sheen=0.0):
        m, nt, b = self.base(name)
        t = self.tex(nt, self.image(img), size, ext, rot)
        mix = nt.nodes.new('ShaderNodeVectorMath')
        mix.operation = 'MULTIPLY'
        mix.inputs[1].default_value = tint
        nt.links.new(t.outputs['Color'], mix.inputs[0])
        nt.links.new(mix.outputs['Vector'], b.inputs['Base Color'])
        b.inputs['Roughness'].default_value = rough
        b.inputs['Specular IOR Level'].default_value = spec
        if sheen:
            b.inputs['Sheen Weight'].default_value = sheen
            b.inputs['Sheen Tint'].default_value = (1.0, 0.5, 0.45, 1)
        if bump:
            bp = nt.nodes.new('ShaderNodeBump')
            bp.inputs['Distance'].default_value = bump
            nt.links.new(t.outputs['Color'], bp.inputs['Height'])
            nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
        return m

    def plain(self, name, color, rough=0.5, metal=0.0, spec=0.5, coat=0.0):
        m, nt, b = self.base(name)
        b.inputs['Base Color'].default_value = (*color, 1)
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        b.inputs['Specular IOR Level'].default_value = spec
        if coat:
            b.inputs['Coat Weight'].default_value = coat
            b.inputs['Coat Roughness'].default_value = 0.03
        return m

    def floor(self):
        """ニスを塗った体育館の床。板は奥(+Y)へ向かって走る。艶はコートの層で、板の明暗から粗さを少しだけ変える"""
        m, nt, b = self.base('Floor')
        t = self.tex(nt, self.image('floor'), 2.4, rot=math.radians(90))
        tint = nt.nodes.new('ShaderNodeVectorMath')
        tint.operation = 'MULTIPLY'
        tint.inputs[1].default_value = (0.95, 0.66, 0.38)
        nt.links.new(t.outputs['Color'], tint.inputs[0])
        nt.links.new(tint.outputs['Vector'], b.inputs['Base Color'])
        r = nt.nodes.new('ShaderNodeMapRange')
        r.inputs['From Min'].default_value = 0.4
        r.inputs['From Max'].default_value = 0.9
        r.inputs['To Min'].default_value = 0.32
        r.inputs['To Max'].default_value = 0.18
        nt.links.new(t.outputs['Color'], r.inputs['Value'])
        nt.links.new(r.outputs['Result'], b.inputs['Roughness'])
        cr = nt.nodes.new('ShaderNodeMapRange')
        cr.inputs['From Min'].default_value = 0.4
        cr.inputs['From Max'].default_value = 0.9
        cr.inputs['To Min'].default_value = 0.035
        cr.inputs['To Max'].default_value = 0.012
        nt.links.new(t.outputs['Color'], cr.inputs['Value'])
        nt.links.new(cr.outputs['Result'], b.inputs['Coat Roughness'])
        b.inputs['Specular IOR Level'].default_value = 0.5
        b.inputs['Coat Weight'].default_value = 1.0
        b.inputs['Coat IOR'].default_value = 1.5
        bp = nt.nodes.new('ShaderNodeBump')  # 板の継ぎ目だけのごく弱い凹凸
        bp.inputs['Distance'].default_value = 0.0004
        bp.inputs['Strength'].default_value = 0.15
        nt.links.new(t.outputs['Color'], bp.inputs['Height'])
        nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
        return m

    def shadeless(self, name, img, strength, ext='EXTEND', reflect=1.0):
        """窓の外の板。光としては数えない。reflect は床などの映り込みでの明るさの倍率"""
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        t = self.tex(nt, self.image(img), 1.0, ext)
        em = nt.nodes.new('ShaderNodeEmission')
        lp = nt.nodes.new('ShaderNodeLightPath')
        mr = nt.nodes.new('ShaderNodeMapRange')
        mr.inputs['To Min'].default_value = strength
        mr.inputs['To Max'].default_value = strength * reflect
        nt.links.new(lp.outputs['Is Glossy Ray'], mr.inputs['Value'])
        nt.links.new(mr.outputs['Result'], em.inputs['Strength'])
        nt.links.new(t.outputs['Color'], em.inputs['Color'])
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


def side_wall(g, x, inward, windows):
    """左右の壁。柱の間の区画ごとに窓の穴を開ける。腰は緑の板"""
    holes = []
    if windows:
        for y0, y1 in zip(BAYS, BAYS[1:]):
            for z0, z1 in (LOW_WIN, HIGH_WIN):
                holes.append((y0 + 0.45, y1 - 0.45, z0, z1))
    g.wall('x', x, [Y0, Y1], [0.0, EAVE], holes, inward, lambda u, v: 'Panel' if v < PANEL_Z else 'Wall', 0.3, 'Reveal')
    for y in BAYS:  # 柱(H 形鋼の代わりの角材)
        yy = min(max(y, Y0 + 0.2), Y1 - 0.2)
        g.box((x + inward * 0.0 - (0.3 if inward < 0 else 0), yy - 0.2, 0.0), (x + (0.3 if inward > 0 else 0), yy + 0.2, EAVE), 'Steel')
    if windows:
        for u0, u1, v0, v1 in holes:
            window_frame(g, x - inward * 0.12, u0, u1, v0, v1)
    # 巾木
    g.box((x - 0.02 if inward > 0 else x - 0.06, Y0, 0), (x + 0.06 if inward > 0 else x + 0.02, Y1, 0.12), 'Baseboard')


def window_frame(g, x, y0, y1, z0, z1):
    """緑の鉄の窓枠: 外枠、縦の桟、横の桟"""
    t, d = 0.07, 0.08
    for (a, b) in (((y0, z0), (y1, z0)), ((y0, z1), (y1, z1)), ((y0, z0), (y0, z1)), ((y1, z0), (y1, z1))):
        g.beam((x, a[0], a[1]), (x, b[0], b[1]), d, t, 'Frame')
    n = max(2, round((y1 - y0) / 0.78))
    for i in range(1, n):
        y = y0 + (y1 - y0) * i / n
        g.beam((x, y, z0), (x, y, z1), d, 0.04, 'Frame')
    m = max(2, round((z1 - z0) / 0.7))
    for j in range(1, m):
        z = z0 + (z1 - z0) * j / m
        g.beam((x, y0, z), (x, y1, z), 0.04, d, 'Frame')


def gallery(g, side):
    """壁沿いのギャラリー: 床の板、手すり、縦の格子"""
    x_wall = side * HX
    x_edge = side * (HX - GAL_D)
    lo, hi = min(x_wall, x_edge), max(x_wall, x_edge)
    g.box((lo, Y0, GAL_Z), (hi, Y1, GAL_Z + 0.22), 'GalleryUnder')
    g.box((x_edge - 0.03, Y0, GAL_Z - 0.06), (x_edge + 0.03, Y1, GAL_Z + 0.22), 'Steel')
    xr = x_edge - side * 0.04
    for z in (GAL_Z + 1.05, GAL_Z + 0.55):
        g.beam((xr, Y0, z), (xr, Y1, z), 0.05, 0.05, 'Steel')
    y = Y0 + 0.15
    while y < Y1 - 0.1:
        g.beam((xr, y, GAL_Z + 0.22), (xr, y, GAL_Z + 1.05), 0.022, 0.022, 'Steel')
        y += 0.16
    for yb in BAYS[1:-1]:  # 手すりの柱
        g.beam((xr, yb, GAL_Z + 0.22), (xr, yb, GAL_Z + 1.12), 0.06, 0.06, 'Steel')
    # ギャラリーを支える腕
    for yb in BAYS:
        yy = min(max(yb, Y0 + 0.3), Y1 - 0.3)
        g.beam((x_wall, yy, GAL_Z - 0.7), (x_edge + side * 0.05, yy, GAL_Z - 0.03), 0.12, 0.12, 'Steel')


def roof(g):
    """切妻の屋根の裏と、緑の鉄骨のトラス、母屋"""
    for s in (-1, 1):
        a, b = (s * HX, Y0, EAVE), (0, Y0, RIDGE)
        c, d = (0, Y1, RIDGE), (s * HX, Y1, EAVE)
        L = math.hypot(HX, RIDGE - EAVE)
        pts = [a, b, c, d] if s > 0 else [d, c, b, a]
        uvs = [(Y0, L), (Y0, 0), (Y1, 0), (Y1, L)] if s > 0 else [(Y1, L), (Y1, 0), (Y0, 0), (Y0, L)]
        g.poly(pts, uvs, 'Ceiling')
        for k in range(1, 6):  # 母屋
            t = k / 6
            x = s * HX * (1 - t)
            z = EAVE + (RIDGE - EAVE) * t - 0.12
            g.beam((x, Y0, z), (x, Y1, z), 0.1, 0.16, 'Truss')
    for y in BAYS:
        yy = min(max(y, Y0 + 0.15), Y1 - 0.15)
        bot = lambda x: EAVE - 0.9 + (RIDGE - EAVE - 0.5) * (1 - abs(x) / HX)
        top = lambda x: EAVE + (RIDGE - EAVE) * (1 - abs(x) / HX) - 0.25
        for s in (-1, 1):
            g.beam((s * HX, yy, top(HX)), (0, yy, top(0)), 0.16, 0.24, 'Truss')
            g.beam((s * HX, yy, bot(HX)), (0, yy, bot(0)), 0.14, 0.2, 'Truss')
            g.beam((s * HX, yy, bot(HX)), (s * HX, yy, top(HX)), 0.14, 0.14, 'Truss')
            n = 6
            for i in range(n):  # 斜めの材と縦の材
                x0, x1 = s * HX * (1 - i / n), s * HX * (1 - (i + 1) / n)
                g.beam((x0, yy, bot(x0)), (x1, yy, top(x1)), 0.07, 0.07, 'Truss')
                g.beam((x1, yy, bot(x1)), (x1, yy, top(x1)), 0.07, 0.07, 'Truss')
    for y0, y1 in zip(BAYS, BAYS[1:]):  # 屋根の面の筋交い
        for s in (-1, 1):
            p = lambda t, y: (s * HX * (1 - t), y, EAVE + (RIDGE - EAVE) * t - 0.3)
            g.beam(p(0.05, y0), p(0.95, y1), 0.04, 0.04, 'Truss')
            g.beam(p(0.95, y0), p(0.05, y1), 0.04, 0.04, 'Truss')
    g.beam((0, Y0, RIDGE - 0.3), (0, Y1, RIDGE - 0.3), 0.14, 0.2, 'Truss')


def end_wall(g, y, inward, holes, mat_of):
    """後ろと舞台の壁。軒より上は三角の妻壁"""
    g.wall('y', y, [-HX, HX], [0.0, EAVE], holes, inward, mat_of, 0.4, 'Wall')
    a, b, c = (-HX, y, EAVE), (HX, y, EAVE), (0, y, RIDGE)
    pts = [a, b, c] if inward < 0 else [b, a, c]
    g.poly(pts, [(p[0], p[2]) for p in pts], 'Wall')


def stage(g, cur):
    """舞台: 前の板張り、床、口の額縁、幕、上の短い幕、真ん中の階段。幕の後ろは閉じた箱"""
    def mat_of(u, v):
        return 'Panel' if v < PANEL_Z and abs(u) > OPEN_X + 0.3 else 'Wall'
    end_wall(g, Y1, -1, [(-OPEN_X, OPEN_X, STAGE_Z, OPEN_Z), (-OPEN_X, OPEN_X, 0.0, STAGE_Z)], mat_of)
    # 前の板張り(腰板の箱を並べる)
    n = 9
    for i in range(n):
        x0 = -OPEN_X + 2 * OPEN_X * i / n + 0.01
        x1 = -OPEN_X + 2 * OPEN_X * (i + 1) / n - 0.01
        g.box((x0, Y1 - 0.06, 0.0), (x1, Y1 + 0.02, STAGE_Z - 0.02), 'StageWood')
    g.box((-OPEN_X, Y1 - 0.08, STAGE_Z - 0.06), (OPEN_X, Y1 + 0.9, STAGE_Z), 'StageWood')  # 縁
    g.box((-OPEN_X, Y1, STAGE_Z - 0.06), (OPEN_X, Y1 + 4.5, STAGE_Z), 'StageFloor')
    g.box((-OPEN_X, Y1 - 0.03, 0.0), (OPEN_X, Y1 - 0.02, 0.08), 'Baseboard')
    # 額縁
    for lo, hi in (((-OPEN_X - 0.3, Y1 - 0.1, STAGE_Z), (-OPEN_X, Y1 + 0.3, OPEN_Z + 0.3)),
                   ((OPEN_X, Y1 - 0.1, STAGE_Z), (OPEN_X + 0.3, Y1 + 0.3, OPEN_Z + 0.3)),
                   ((-OPEN_X - 0.3, Y1 - 0.1, OPEN_Z), (OPEN_X + 0.3, Y1 + 0.3, OPEN_Z + 0.3))):
        g.box(lo, hi, 'StageWood')
    # 幕の後ろの箱
    g.box((-OPEN_X, Y1 + 4.5, STAGE_Z), (OPEN_X, Y1 + 4.6, OPEN_Z + 0.5), 'Dark')
    for s in (-1, 1):
        g.box((s * OPEN_X - 0.05, Y1 + 0.32, STAGE_Z), (s * OPEN_X + 0.05, Y1 + 4.6, OPEN_Z + 0.5), 'Dark')
    g.box((-OPEN_X, Y1 + 0.32, OPEN_Z), (OPEN_X, Y1 + 4.6, OPEN_Z + 0.5), 'Dark')
    # 階段
    for k in range(3):
        h = STAGE_Z * (k + 1) / 4
        g.box((-0.7, Y1 - 0.3 * (3 - k), 0.0), (0.7, Y1 - 0.3 * (2 - k), h), 'StageWood')
    for s in (-1, 1):  # 階段の手すりの代わりの側板
        g.box((s * 0.7 - 0.03, Y1 - 0.9, 0.0), (s * 0.7 + 0.03, Y1, STAGE_Z * 0.25 + 0.05), 'StageWood')
    # 幕は波打つ面
    fold = Geo()
    yc = Y1 + 0.9
    nx = 240
    for z0, z1, y_off, name in ((STAGE_Z + 0.02, OPEN_Z - 0.05, 0.0, 'Curtain'), (OPEN_Z - 0.75, OPEN_Z - 0.02, -0.25, 'Valance')):
        rows = [z0, z1]
        for i in range(nx):
            xa, xb = -OPEN_X + 2 * OPEN_X * i / nx, -OPEN_X + 2 * OPEN_X * (i + 1) / nx
            wa = 0.06 * math.sin(xa / 0.235 * math.pi * 2) if name == 'Curtain' else 0.03 * math.sin(xa / 0.12 * math.pi * 2)
            wb = 0.06 * math.sin(xb / 0.235 * math.pi * 2) if name == 'Curtain' else 0.03 * math.sin(xb / 0.12 * math.pi * 2)
            ya, yb = yc + y_off + wa, yc + y_off + wb
            fold.poly(((xa, ya, rows[0]), (xb, yb, rows[0]), (xb, yb, rows[1]), (xa, ya, rows[1])),
                      ((xa, rows[0]), (xb, rows[0]), (xb, rows[1]), (xa, rows[1])), name, True)
    fold.box((-OPEN_X, yc - 0.3, OPEN_Z - 0.8), (OPEN_X, yc - 0.27, OPEN_Z - 0.76), 'Gold')
    return fold


def back_wall(g):
    def mat_of(u, v):
        return 'Panel' if v < PANEL_Z else 'Wall'
    door = (-1.3, 1.3, 0.0, 2.5)
    end_wall(g, Y0, 1, [door], mat_of)
    g.box((-1.3, Y0 - 0.4, 0.0), (1.3, Y0 - 0.36, 2.5), 'Door')
    g.box((-0.02, Y0 - 0.37, 0.0), (0.02, Y0 - 0.3, 2.5), 'Steel')
    for x in (-0.25, 0.25):
        g.box((x - 0.015, Y0 - 0.36, 0.95), (x + 0.015, Y0 - 0.3, 1.15), 'Steel')
    for (lo, hi) in (((-1.42, Y0, 0), (-1.3, Y0 + 0.06, 2.62)), ((1.3, Y0, 0), (1.42, Y0 + 0.06, 2.62)), ((-1.42, Y0, 2.5), (1.42, Y0 + 0.06, 2.62))):
        g.box(lo, hi, 'Steel')
    g.box((-HX, Y0, 0), (HX, Y0 + 0.06, 0.12), 'Baseboard')


def wall_bars(g, y0, y1):
    """肋木: 0.9 m ごとの柱と丸い横木"""
    x = HX - 0.02
    n = round((y1 - y0) / 0.9)
    for i in range(n + 1):
        y = y0 + i * 0.9
        g.box((x - 0.16, y - 0.04, 0.0), (x, y + 0.04, 2.55), 'BarWood')
    for i in range(n):
        ya, yb = y0 + i * 0.9 + 0.04, y0 + (i + 1) * 0.9 - 0.04
        for k in range(16):
            z = 0.18 + k * 0.15
            g.tube(((x - 0.09, ya, z), (x - 0.09, yb, z)), 0.018, 'BarWood', 8)


def hoop(g, y):
    """右の壁のバスケットのゴール。壁から腕で出した板、橙の輪、白い網"""
    bx = HX - 1.25
    g.box((bx - 0.03, y - 0.9, 2.78), (bx, y + 0.9, 3.83), 'Backboard')
    for lo, hi in (((bx - 0.035, y - 0.9, 2.78), (bx - 0.03, y + 0.9, 2.83)), ((bx - 0.035, y - 0.9, 3.78), (bx - 0.03, y + 0.9, 3.83)),
                   ((bx - 0.035, y - 0.9, 2.78), (bx - 0.03, y - 0.85, 3.83)), ((bx - 0.035, y + 0.85, 2.78), (bx - 0.03, y + 0.9, 3.83)),
                   ((bx - 0.035, y - 0.3, 3.0), (bx - 0.03, y + 0.3, 3.04)), ((bx - 0.035, y - 0.3, 3.41), (bx - 0.03, y + 0.3, 3.45)),
                   ((bx - 0.035, y - 0.3, 3.0), (bx - 0.03, y - 0.26, 3.45)), ((bx - 0.035, y + 0.26, 3.0), (bx - 0.03, y + 0.3, 3.45))):
        g.box(lo, hi, 'Paint')
    for dy in (-0.6, 0.6):  # 腕
        for z in (2.9, 3.7):
            g.beam((HX, y + dy, z), (bx, y + dy * 0.7, z), 0.06, 0.06, 'Truss')
        g.beam((HX, y + dy, 2.2), (bx, y + dy * 0.7, 2.9), 0.05, 0.05, 'Truss')
    cx, r = bx - 0.15 - 0.23, 0.23
    ring = [(cx + r * math.cos(a), y + r * math.sin(a), 3.05) for a in (6.2832 * i / 32 for i in range(33))]
    g.tube(ring, 0.01, 'Rim', 6)
    g.beam((bx, y, 3.05), (cx + r, y, 3.05), 0.05, 0.03, 'Rim')
    for i in range(12):  # 網
        a = 6.2832 * i / 12
        g.tube(((cx + r * math.cos(a), y + r * math.sin(a), 3.05), (cx + 0.15 * math.cos(a + 0.4), y + 0.15 * math.sin(a + 0.4), 2.62)), 0.005, 'Net', 4)
    for z, rr in ((2.92, 0.2), (2.76, 0.17), (2.62, 0.15)):
        g.tube([(cx + rr * math.cos(a), y + rr * math.sin(a), z) for a in (6.2832 * i / 20 for i in range(21))], 0.004, 'Net', 4)


def court_lines(g):
    """床の線。白はバスケット、赤と黄はほかの競技の線。床から少しだけ浮かせた面"""
    z = 0.0015

    def line(a, b, w, mat):
        a, b = Vector((*a, z)), Vector((*b, z))
        d = (b - a).normalized()
        s = Vector((-d.y, d.x, 0)) * (w / 2)
        g.quad(a - s, b - s, b + s, a + s, mat)

    def arc(c, r, a0, a1, w, mat, n=96):
        pts = [Vector((c[0] + math.cos(a0 + (a1 - a0) * i / n) * r, c[1] + math.sin(a0 + (a1 - a0) * i / n) * r, z)) for i in range(n + 1)]
        for p, q in zip(pts, pts[1:]):
            n0, n1 = (p - Vector((c[0], c[1], z))).normalized(), (q - Vector((c[0], c[1], z))).normalized()
            g.quad(p - n0 * w / 2, q - n1 * w / 2, q + n1 * w / 2, p + n0 * w / 2, mat)

    W = 0.05
    line((0, Y0 + 0.6), (0, Y1 - 1.1), W, 'LineWhite')            # 中央の線(舞台へ向かう)
    arc((0, 0), 1.8, 0, 6.2832, W, 'LineWhite')                    # センターサークル
    arc((0, 0), 3.6, 0, 6.2832, W * 1.1, 'LineRed', 160)          # 赤の大きな円
    for y in (Y1 - 1.1, Y0 + 0.6):
        line((-6.3, y), (6.3, y), W, 'LineWhite')                 # 端の線
    for x in (-6.3, 6.3):
        line((x, Y0 + 0.6), (x, Y1 - 1.1), W, 'LineWhite')        # 横の線
    # 舞台の側の制限区域とフリースローの半円
    k0 = Y1 - 1.1 - 5.0
    for x in (-2.45, 2.45):
        line((x, k0), (x, Y1 - 1.1), W, 'LineWhite')
    line((-2.45, k0), (2.45, k0), W, 'LineWhite')
    arc((0, k0), 1.8, math.pi, 2 * math.pi, W, 'LineWhite', 48)
    for s in (-1, 1):
        line((s * 3.3, Y1 - 1.1), (s * 2.0, k0 - 0.6), W * 1.1, 'LineRed')
    # 黄の線(バレーの線の代わり)
    for y in (4.2, 6.6, -4.2, -6.6):
        line((-5.7, y), (5.7, y), W, 'LineYellow')
    for x in (-4.6, 4.6):
        line((x, -6.6), (x, 10.8), W, 'LineYellow')
    line((-5.7, 10.8), (5.7, 10.8), W, 'LineYellow')
    line((-5.7, -6.6), (-5.7, 10.8), W, 'LineYellow')
    line((5.7, -6.6), (5.7, 10.8), W, 'LineYellow')


def lamp_mesh(mats_named):
    """吊りの照明 1 つ: 笠、点いていない球、吊りの棒"""
    g = Geo()
    n = 20
    top, rim, h = 0.12, 0.32, 0.32
    for i in range(n):
        a0, a1 = 6.2832 * i / n, 6.2832 * (i + 1) / n
        p = lambda a, r, z: (math.cos(a) * r, math.sin(a) * r, z)
        g.poly((p(a0, top, 0), p(a1, top, 0), p(a1, rim, -h), p(a0, rim, -h)), [(0, 0)] * 4, 'Shade', True)
    g.poly([(math.cos(6.2832 * i / n) * rim * 0.45, math.sin(6.2832 * i / n) * rim * 0.45, -h + 0.08) for i in range(n)], [(0, 0)] * n, 'Bulb')
    g.beam((0, 0, 0), (0, 0, 1.2), 0.02, 0.02, 'Truss')
    names = ['Shade', 'Bulb', 'Truss']
    return g.mesh('Lamp', names, [mats_named[k] for k in names])


def outside(mt):
    """窓の外。夕方の空と木の写真の板を西の遠くへ立てる。斜めに見ても切れないよう、左右へ鏡に返して 3 枚分の幅にする"""
    m = mt.shadeless('Outside', 'outside', 1.6, 'MIRROR', 1.3)
    me = bpy.data.meshes.new('Outside')
    X, W, Z0, Z1 = -45.0, 130.0, -14.0, 59.0
    me.from_pydata([(X, 1.5 * W, Z0), (X, -1.5 * W, Z0), (X, -1.5 * W, Z1), (X, 1.5 * W, Z1)], [], [(0, 1, 2, 3)])
    me.uv_layers.new(name='UVMap').data.foreach_set('uv', [-1, 0, 2, 0, 2, 1, -1, 1])
    me.materials.append(m)
    me.update()
    o = link('Outside', me)
    o.visible_shadow = False
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
    """窓から入る日の中だけに置くほこり。シェイプキー 2 つで漂わせる。カメラが動く範囲(mark から 5.7 m、高さ 4.7 m まで)には置かない。レンズの前で大きくぼけるため"""
    base, a, b, f = [], [], [], []
    shape = ((1, 0, -0.7), (-1, 0, -0.7), (0, 1, 0.7), (0, -1, 0.7))
    for _ in range(1400):
        y = r.uniform(Y0 + 1, Y1 - 1)
        z0, z1 = HIGH_WIN if r.random() < 0.7 else LOW_WIN
        p = Vector((-HX, y, r.uniform(z0, z1))) - sun * r.uniform(0.5, 14)
        if p.z < 0.1 or p.z > 7.5 or abs(p.x) > HX - 0.3 or not (Y0 + 0.5 < p.y < Y1 - 0.5) or (Vector((p.x - MARK[0], p.y - MARK[1])).length < 5.7 and p.z < 4.7):
            continue
        s = r.uniform(0.0012, 0.0026)
        i = len(base)
        da = Vector((r.uniform(-0.25, 0.25), r.uniform(-0.25, 0.25), r.uniform(-0.12, 0.18)))
        db = Vector((r.uniform(-0.25, 0.25), r.uniform(-0.25, 0.25), r.uniform(-0.18, 0.12)))
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


def compositor():
    """窓のにじみ、弱いシャープ、色の調整"""
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
    g.inputs['Strength'].default_value = 0.22
    g.inputs['Saturation'].default_value = 1.0
    g.inputs['Size'].default_value = 0.86
    L.new(rl.outputs['Image'], g.inputs['Image'])
    sh = N.new('CompositorNodeFilter')
    sh.inputs['Type'].default_value = 'Box Sharpen'
    sh.inputs['Factor'].default_value = 0.05
    L.new(g.outputs['Image'], sh.inputs['Image'])
    cb = N.new('CompositorNodeColorBalance')
    L.new(sh.outputs[0], cb.inputs['Image'])
    [i for i in cb.inputs if i.name == 'Gain' and i.type == 'RGBA'][0].default_value = GAIN
    nt.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    L.new(cb.outputs['Image'], N.new('NodeGroupOutput').inputs[0])
    s.render.use_compositing = True


def area(name, size, energy, loc, rot, color=(1.0, 0.82, 0.64), shadow=True):
    data = bpy.data.lights.new(name, 'AREA')
    data.shape = 'RECTANGLE'
    data.size, data.size_y = size
    data.energy = energy
    data.color = color
    data.use_shadow = shadow
    o = link(name, data, loc)
    o.rotation_euler = rot
    o.visible_camera = False
    o.visible_glossy = False
    return o


def lights():
    for name, p in (('SunMain', SUN_MAIN), ('SunChar', SUN_CHAR), ('SunStage', SUN_STAGE)):
        data = bpy.data.lights.new(name, 'SUN')
        data.energy = p['energy']
        data.color = p['color']
        data.angle = math.radians(0.8)
        o = link(name, data)
        o.rotation_euler = sun_vec(p['az'], p['el']).to_track_quat('Z', 'Y').to_euler()
        o.visible_glossy = False
    L = Y1 - Y0 - 1.0
    # 窓からの空の光(左の壁の内側、右を向く)
    for z0, z1 in (LOW_WIN, HIGH_WIN):
        area(f'Sky{z0}', (z1 - z0, L), 60 * (z1 - z0), (-HX + 0.35, (Y0 + Y1) / 2, (z0 + z1) / 2), (0, math.radians(-90), 0), (1.0, 0.8, 0.62))
    # 日なたの床からの照り返しの代わり: 床から上へ、右の壁から左へ、天井から下へ弱く
    area('Bounce', (12.0, 22.0), 220, (0.5, 2.5, 0.05), (math.radians(180), 0, 0), (1.0, 0.7, 0.42), False)
    area('FillR', (6.0, 22.0), 160, (HX - 0.4, 2.5, 3.0), (0, math.radians(90), 0), (1.0, 0.86, 0.72))
    area('Top', (12.0, 22.0), 120, (0, 2.5, 7.4), (0, 0, 0), (1.0, 0.88, 0.76), False)
    # キャラの顔の光: mark の上の柔らかい点光源。キャラだけに当て、近い顔ほど明るく、遠い脚は弱い
    data = bpy.data.lights.new('CharTop', 'POINT')
    data.energy = CHAR_TOP
    data.shadow_soft_size = 0.6
    data.color = (1.0, 0.86, 0.72)
    o = link('CharTop', data, (MARK[0], MARK[1] - 0.5, 2.8))
    o.visible_camera = False
    o.visible_glossy = False


def exclude(name, objects, light, attr='receiver_collection'):
    """objects を除いた集まりを light に結ぶ"""
    c = bpy.data.collections.new(name)
    for o in objects:
        c.objects.link(o)
    for co in c.collection_objects:
        co.light_linking.link_state = 'EXCLUDE'
    setattr(bpy.data.objects[light].light_linking, attr, c)


def build(ctx):
    r = random.Random(ctx.seed + 7)
    s = bpy.context.scene
    c = s.cycles
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces, c.transparent_max_bounces = 5, 3, 2, 2, 8
    c.light_sampling_threshold = 0.02
    c.adaptive_threshold = 0.04
    c.filter_width = 1.0
    s.view_settings.view_transform = 'Standard'
    s.view_settings.look = 'None'
    w = bpy.data.worlds.new('Sky')
    w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Strength'].default_value = 0.0
    s.world = w

    mt = Mats(ctx.assets)
    defs = {
        'Wall': mt.textured('Wall', 'wall', 2.5, 0.75, 0.3, (0.95, 0.88, 0.74)),
        'Panel': mt.textured('Panel', 'panel', 2.7, 0.5, 0.4, (0.8, 0.95, 0.82)),
        'Reveal': mt.textured('Reveal', 'wall', 2.5, 0.75, 0.3, (0.9, 0.84, 0.72)),
        'Baseboard': mt.plain('Baseboard', (0.08, 0.1, 0.08), 0.4),
        'Steel': mt.plain('Steel', (0.13, 0.22, 0.13), 0.4, 0.4),
        'Truss': mt.plain('Truss', (0.15, 0.24, 0.14), 0.45, 0.4),
        'Frame': mt.plain('Frame', (0.16, 0.26, 0.16), 0.4, 0.4),
        'GalleryUnder': mt.textured('GalleryUnder', 'wall', 2.5, 0.75, 0.3, (0.88, 0.82, 0.7)),
        'Ceiling': mt.textured('Ceiling', 'ceiling', 2.4, 0.7, 0.3, (0.92, 0.88, 0.82)),
        'StageWood': mt.textured('StageWood', 'wood', 1.6, 0.35, 0.5, (0.72, 0.48, 0.28)),
        'StageFloor': mt.textured('StageFloor', 'floor', 2.4, 0.3, 0.5, (0.7, 0.5, 0.3), rot=math.radians(90)),
        'BarWood': mt.textured('BarWood', 'wood', (0.5, 0.5), 0.35, 0.5, (0.95, 0.66, 0.4)),
        'Dark': mt.plain('Dark', (0.03, 0.02, 0.02), 0.8),
        'Door': mt.textured('Door', 'panel', 2.7, 0.4, 0.4, (0.55, 0.62, 0.55)),
        'Backboard': mt.plain('Backboard', (0.85, 0.85, 0.83), 0.25, 0.0, 0.5),
        'Paint': mt.plain('Paint', (0.05, 0.05, 0.05), 0.4),
        'Rim': mt.plain('Rim', (0.75, 0.2, 0.03), 0.35, 0.6),
        'Net': mt.plain('Net', (0.85, 0.85, 0.82), 0.7),
        'Curtain': mt.textured('Curtain', 'curtain', (2.6, 6.0), 0.75, 0.3, (1.0, 0.78, 0.76), sheen=0.6),
        'Valance': mt.textured('Valance', 'curtain', (1.3, 6.0), 0.75, 0.3, (0.7, 0.55, 0.55), sheen=0.6),
        'Gold': mt.plain('Gold', (0.75, 0.52, 0.2), 0.35, 1.0),
        'LineWhite': mt.plain('LineWhite', (0.78, 0.76, 0.72), 0.3, 0.0, 0.5, 1.0),
        'LineRed': mt.plain('LineRed', (0.42, 0.03, 0.03), 0.3, 0.0, 0.5, 1.0),
        'LineYellow': mt.plain('LineYellow', (0.75, 0.52, 0.04), 0.3, 0.0, 0.5, 1.0),
        'Shade': mt.plain('Shade', (0.2, 0.22, 0.2), 0.3, 0.8),
        'Bulb': mt.glow('Bulb', (1.0, 0.82, 0.62), 1.2),
    }
    names = list(defs)
    mats = [defs[n] for n in names]

    floor = Geo()
    floor.quad((-HX, Y0, 0), (HX, Y0, 0), (HX, Y1, 0), (-HX, Y1, 0), 'Floor', ((-HX, Y0), (HX, Y0), (HX, Y1), (-HX, Y1)))
    floor_obj = link('Floor', floor.mesh('Floor', ['Floor'], [mt.floor()]))
    lines = Geo()
    court_lines(lines)
    link('Lines', lines.mesh('Lines', names, mats))

    room = Geo()
    side_wall(room, -HX, 1, True)
    side_wall(room, HX, -1, False)
    for side in (-1, 1):
        gallery(room, side)
    roof(room)
    back_wall(room)
    wall_bars(room, -7.6, -1.3)
    wall_bars(room, 1.4, 11.3)
    hoop(room, 7.4)
    link('Room', room.mesh('Room', names, mats))
    st = Geo()
    fold = stage(st, defs['Curtain'])
    stage_objs = [link('Stage', st.mesh('Stage', names, mats)), link('Curtain', fold.mesh('Curtain', names, mats))]

    lm = lamp_mesh(defs)
    for y in (BAYS[k] + 2.25 for k in range(5)):
        for x in (-3.0, 3.0):
            link('Lamp', lm, (x, y, EAVE - 0.95 + (RIDGE - EAVE - 0.5) * (1 - abs(x) / HX) - 1.2))

    outside(mt)
    lights()
    beat = (ctx.beats[1] - ctx.beats[0]) if len(ctx.beats) > 1 else 0.5
    dust(mt.glow('DustGlow', (1.0, 0.82, 0.55), 0.6), r, sun_vec(SUN_MAIN['az'], SUN_MAIN['el']), max(ctx.frames, 600), ctx.fps, beat)
    # SunChar: 今ある物(ステージ)をすべて除く。あとから読むキャラだけに当たる
    exclude('NotStage', [o for o in s.collection.objects if o.type == 'MESH'], 'SunChar')
    exclude('NoStageShadow', [o for o in s.collection.objects if o.type == 'MESH'], 'SunChar', 'blocker_collection')  # 壁と屋根の影を落とさない
    exclude('NotStageTop', [o for o in s.collection.objects if o.type == 'MESH'], 'CharTop')
    exclude('NoStageShadowTop', [o for o in s.collection.objects if o.type == 'MESH'], 'CharTop', 'blocker_collection')
    # Bounce は床を除くステージの物だけに当てる。キャラの脚を下から照らして顔より明るくしない
    walls = bpy.data.collections.new('BounceOnly')
    for o in s.collection.objects:
        if o.type == 'MESH' and o is not floor_obj:
            walls.objects.link(o)
    bpy.data.objects['Bounce'].light_linking.receiver_collection = walls
    only = bpy.data.collections.new('StageOnly')
    for o in stage_objs:
        only.objects.link(o)
    bpy.data.objects['SunStage'].light_linking.receiver_collection = only
    compositor()
    return {
        'mark': MARK,
        'facing': 0,
        'bounds': ((-5.7, 5.7), (-8.9, 11.8), (0.12, 4.3)),  # ギャラリー(X ±6.1 より外、高さ 4 m)と肋木、舞台に入らない
        'char_emission': 0.5,
        'beats_per_shot': 8,
        'views': {
            'target': {'loc': CAM, 'look': LOOK, 'lens': 20},
            'hold1': {'loc': (4.6, -3.6, 1.3), 'look': (-3.0, 2.5, 2.2), 'lens': 22},
            'hold2': {'loc': (-1.0, 4.8, 0.7), 'look': (0.8, -9.0, 2.0), 'lens': 20},
        },
    }
