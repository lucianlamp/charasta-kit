"""Kimi の頭に、VRoid と同じ構成の顔(Fcl_ の 57 キー)を新しく作って VRM を書き出す。Blender は使わず GLB を直接組む。
own.py から呼ぶ。Body と Hair のアクセサと画像は元のバイトのまま残る。"""
import sys, json, copy, io, os
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from glbw import *
import parts as pt
from parts import MM, smooth, px2m, m2px, Surface, Eye, Mouth
from PIL import Image
from scipy import ndimage as ni
from scipy.spatial import cKDTree
import build_liner
NAMES = json.load(open(os.path.join(HERE, 'fcl_names.json'), encoding='utf8'))


def srgb2lin(c):
    c = np.asarray(c, float) / 255
    return np.where(c <= .04045, c / 12.92, ((c + .055) / 1.055) ** 2.4)


# ---- 変形の定義 -----------------------------------------------------------
def eye_targets(e, key, P):
    """キーごとの上まぶたと下まぶたの目標の曲線(201 点)。t は目頭 0、目尻 1。"""
    t = e.t; bump = np.sin(np.pi * t)
    A = e.U[0] + np.outer(t, e.U[-1] - e.U[0])
    ey = np.array([0, 1.0]); ex = np.array([e.sign, 0.0])
    U, L = e.U.copy(), e.L.copy()
    k = P['eye'].get(key, {})
    mm = lambda a: a[:, None] * MM
    if key == 'Close':
        Cc = A + mm(k['down'] * -bump) * ey; return Cc, Cc.copy()
    if key == 'Joy':
        Cc = A + mm(k['arc'] * bump) * ey; return Cc, Cc.copy()
    if key == 'Fun':
        return U + mm(-k['up'] * bump ** .7) * ey, L + mm(k['lo'] * bump) * ey
    if key == 'Angry':
        return U + mm(-k['in'] * (1 - t) ** 1.2 * np.minimum(1, bump * 3) - k['mid'] * bump) * ey, L + mm(k['lo'] * bump) * ey
    if key == 'Sorrow':
        return U + mm(-k['out'] * t ** 1.3 * np.minimum(1, bump * 3) - k['mid'] * bump) * ey, L
    if key == 'Surprised':
        return U + mm(k['up'] * bump) * ey, L + mm(-k['lo'] * bump) * ey
    if key == 'Spread':
        cor = (2 * t - 1) * k['side']
        return U + mm(k['up'] * bump) * ey + mm(cor) * ex, L + mm(-k['lo'] * bump) * ey + mm(cor) * ex
    raise KeyError(key)


def eye_field(e, xy, Up, Lo, P):
    du, iu, dl, il = e.near(xy)
    dU, dL = Up - e.U, Lo - e.L
    mU, mL = np.linalg.norm(dU, axis=1).max(), np.linalg.norm(dL, axis=1).max()
    Ru = max(P['Rmin'] * MM, P['Rk'] * mU); Rl = max(P['Rmin'] * MM, P['Rk'] * mL)
    upper = du <= dl
    d = np.where(upper, du, dl); R = np.where(upper, Ru, Rl)
    w = np.clip(1 - d / R, 0, 1) ** P['Rp']
    D = np.where(upper[:, None], dU[iu], dL[il])
    return D * w[:, None]


def rigid_field(e, xy, Up, Lo, lower=False):
    """まつ毛の板は曲線の動きをそのまま受ける。太さが変わらない。"""
    du, iu, dl, il = e.near(xy)
    return (Lo - e.L)[il] if lower else (Up - e.U)[iu]


def mouth_pos(M, s, upper, a):
    bulge = np.maximum(1 - np.abs(s) ** a.get('pw', 2.0), 0) ** a.get('qw', 1.0)
    x = M.xm + a.get('dx', 0) * MM + a['w'] * MM * s
    y = M.ym + (a.get('cy', 0) + a.get('cor', 0) * s * s + np.where(upper, a.get('hu', 0), -a.get('hl', 0)) * bulge) * MM
    return np.c_[x, y]


def mouth_field(M, xy, a, P):
    """顔の面の点を、口の形 a に動かす量と、前へ出す量の重み。"""
    s = np.clip((xy[:, 0] - M.xm) / M.W0, -1, 1); upper = xy[:, 1] >= M.ym
    dx = np.maximum(np.abs(xy[:, 0] - M.xm) - M.W0, 0); dy = np.abs(xy[:, 1] - M.ym)
    Rv = np.where(upper, a.get('Ru', P['Ru']), a.get('Rl', P['Rl'])) * MM
    rho = np.sqrt((dx / (a.get('Rs', P['Rs']) * MM)) ** 2 + (dy / Rv) ** 2)
    w = np.clip(1 - rho, 0, 1) ** 1.3
    dom = np.c_[M.xm + M.W0 * s, M.ym + np.where(upper, 1, -1) * M.h0 * (1 - s ** 4)]
    return (mouth_pos(M, s, upper, a) - dom) * w[:, None], w


def lift(sf, xy0, xy1, front):
    return (sf.zf(xy1[:, 0], xy1[:, 1]) - sf.zf(xy0[:, 0], xy0[:, 1])) * front


def jaw_term(V, a, M, P):
    j = a.get('jaw')
    if not j: return np.zeros_like(V)
    Q = P['jaw_fade']
    g = (1 - smooth(Q['x'][0], Q['x'][1], np.abs(V[:, 0] - M.xm))) * smooth(M.ym - Q['y'][0], M.ym - Q['y'][1], V[:, 1]) * smooth(Q['z'][0], Q['z'][1], V[:, 2])
    return np.outer(g, np.array([0, j[0], j[1]]) * MM)


class Face:
    """1 つの Face メッシュの部品(primitive)の集まり。キーごとの差分を部品ごとに持つ。"""
    def __init__(s, names):
        s.names = names; s.parts = {}

    def add(s, name, **kw):
        kw['targets'] = {}
        s.parts[name] = kw

    def key(s, part, name, d):
        if not np.any(np.abs(d) > 1e-7): return
        t = s.parts[part]['targets']
        t[name] = t.get(name, 0) + d


def build(P):
    jc, bc = read_glb(P['source_vrm'])
    wc, _ = node_world(jc)
    hc = jc['extensions']['VRMC_vrm']['humanoid']['humanBones']['head']['node']
    names = NAMES
    assert len(names) == 57
    GEN = P['images'].rstrip('/') + '/'
    SW, SH = pt.S['w'], pt.S['h']
    sf = Surface(P)
    eyes = [Eye('L', P['eye_xf']), Eye('R', P['eye_xf'])]
    M = Mouth(P['mouth'])
    Fc = Face(names)

    # 眼球の球を先に決め、閉じたまぶたの面を持ち上げる
    Rb = P['ball']['R'] * MM
    balls = {e.side: pt.fit_ball(sf, e, Rb, P['ball']['gap'] * MM) for e in eyes}
    sf.add_lid_bump(list(balls.values()), Rb, P['ball']['lid_clear'] * MM, P['ball']['bump_radius'])
    # ---- 肌 -----------------------------------------------------------------
    V, F, loops, uv_dom = pt.skin_mesh(sf, eyes, M, P['mesh'])
    fr0 = smooth(.1, .4, pt.normals(V, F)[:, 2])
    fr0 = np.where((pt.normals(V, F) * (V - pt.B.CEN)).sum(1) < 0, smooth(.1, .4, -pt.normals(V, F)[:, 2]), fr0)
    V[:, 2] += sf.bump_at(V[:, 0], V[:, 1]) * fr0
    print('skin', len(V), 'verts', len(F), 'tris')
    # 目の縁の折り返しと唇の裏
    extras = {}
    for k, depth in (('L', P['lid_depth']), ('R', P['lid_depth']), ('M', P['lip_depth'])):
        n0 = len(V)
        V, F, new = pt.extrude_loop(V, F, loops[k], np.array([0, 0, -1.0]), depth * MM)
        extras[k] = (loops[k], new)
    N = pt.normals(V, F)
    # 外側の面の向きを揃える: 法線が頭の中心から外を向くように反転
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]); cf = V[F].mean(1)
    n_out = len(F) - sum(2 * len(v[0]) for v in extras.values())
    flip = (fn[:n_out] * (cf[:n_out] - pt.B.CEN)).sum(1) < 0
    print('flipped outer tris', int(flip.sum()))
    F[:n_out][flip] = F[:n_out][flip][:, [0, 2, 1]]
    # 折り返しの面は穴の中心を向く
    ofs = n_out
    for k, (lp, new) in extras.items():
        m = 2 * len(lp); sub = F[ofs:ofs + m]
        nf = np.cross(V[sub[:, 1]] - V[sub[:, 0]], V[sub[:, 2]] - V[sub[:, 0]])
        cen = np.r_[V[lp, :2].mean(0), V[lp, 2].mean()]
        if (nf * (cen - V[sub].mean(1))).sum() < 0: F[ofs:ofs + m] = sub[:, [0, 2, 1]]
        ofs += m
    N = pt.normals(V, F)
    front = smooth(.15, .45, N[:, 2])
    xy0 = V[:, :2].copy()

    rest_mouth = P['mouth_rest']
    D0, w0 = mouth_field(M, xy0, rest_mouth, P['mouth_field'])
    # 休みの位置
    Vr = V.copy(); Vr[:, :2] += D0; Vr[:, 2] += lift(sf, xy0, xy0 + D0, front)
    Nr = pt.normals(Vr, F)
    # 法線は頭の面の表 r(u,v) から出す。三角形の割り方で影の境が割れず、正面の高さの表のように輪郭の近くで崩れない。
    # 目と口の縁の折り返しの点だけ、三角形から出した法線のまま
    Nr[:len(uv_dom)] = sf.normal_at(uv_dom[:, 0], uv_dom[:, 1])
    # UV は休みの位置の正面投影
    TEXR = dict(zip(('x0', 'x1', 'y0', 'y1'), P['tex_box']))
    uv = np.c_[(Vr[:, 0] - TEXR['x0']) / (TEXR['x1'] - TEXR['x0']), (TEXR['y1'] - Vr[:, 1]) / (TEXR['y1'] - TEXR['y0'])]
    Fc.add('Face_00_SKIN', V=Vr, F=F, N=Nr, uv=uv, joint='head')

    side_k = 1 - smooth(P['side_fade'][0], P['side_fade'][1], np.abs(Vr[:, 0] - M.xm))

    def skin_key(name, Dxy=None, Dz=None):
        d = np.zeros_like(Vr)
        if Dxy is not None:
            Dxy = Dxy * side_k[:, None]
            d[:, :2] = Dxy; d[:, 2] = lift(sf, Vr[:, :2], Vr[:, :2] + Dxy, front)
        if Dz is not None: d[:, 2] += Dz
        Fc.key('Face_00_SKIN', name, d)

    # ---- 虹彩、ハイライト、白目 ---------------------------------------------
    R = Rb; WB = P['white_box']
    Ei = np.asarray(Image.open(GEN + 'iris.png').convert('RGBA'))
    Ai = Ei[..., 3]
    lab, nl = ni.label(Ai > 40); obj = ni.find_objects(lab)
    cells = sorted([o for o in obj if (o[0].stop - o[0].start) > 200], key=lambda o: o[1].start)
    assert len(cells) == 2
    high = np.asarray(Image.open(GEN + 'high.png').convert('RGBA'))
    kx, ky = SW / high.shape[1], SH / high.shape[0]
    ir = P['iris']
    for e in eyes:
        c = balls[e.side]
        # 白目
        rings = e.rings(np.array([P['ball']['white_margin']]) * MM)[0]
        lo, hi = rings.min(0), rings.max(0)
        g = np.linspace(0, 1, 34); X, Y = np.meshgrid(lo[0] + (hi[0] - lo[0]) * g, lo[1] + (hi[1] - lo[1]) * g)
        ins = pt.inside(rings, np.c_[X.ravel(), Y.ravel()]).reshape(X.shape)
        cell = ins[:-1, :-1] | ins[1:, 1:] | ins[:-1, 1:] | ins[1:, :-1]
        p2, f2 = pt.region_grid(cell, X, Y)
        Pw = pt.cap(c, R, p2)
        Fc.add('EyeWhite_' + e.side, V=Pw, F=f2, N=(Pw - c) / R, uv=np.c_[(e.xf_inv(p2)[:, 0] - WB[0]) / (WB[1] - WB[0]), (WB[3] - e.xf_inv(p2)[:, 1]) / (WB[3] - WB[2])], joint='head')
        # 虹彩: 絵の 1 マスを ir の大きさで置く
        cx = e.cen[0] + e.sign * ir['dx'] * MM if 'cx' not in ir else ir['cx'][e.side]
        cy = ir['cy']
        p2, f2, q = pt.disc_grid(cx, cy, ir['rx'] * MM, ir['ry'] * MM)
        o = cells[0] if e.side == 'R' else cells[1]   # 絵の左が画面の左 = キャラの右
        u = (o[1].start + (q[:, 0] * -1 * -1 + 1) / 2 * (o[1].stop - o[1].start)) / Ai.shape[1]
        v = (o[0].start + (1 - q[:, 1]) / 2 * (o[0].stop - o[0].start)) / Ai.shape[0]
        Pi = pt.cap(c, R + .3 * MM, p2)
        Fc.add('EyeIris_' + e.side, V=Pi, F=f2, N=(Pi - c) / R, uv=np.c_[u, v], joint='eye' + e.side)
        k = 'Fcl_EYE_Iris_Hide'
        Fc.key('EyeIris_' + e.side, k, np.tile([0, 0, -P['hide']['iris']], (len(Pi), 1)))
        ds = np.zeros_like(Pi); ds[:, :2] = (np.array([cx, cy]) - Pi[:, :2]) * P['surprised_iris']; ds[:, 0] += e.sign * P['surprised_shift'] * MM
        Fc.key('EyeIris_' + e.side, 'Fcl_EYE_Surprised', ds)
        # ハイライト: 絵の位置のまま
        mid = high.shape[1] // 2
        al = high[..., 3].copy()
        if e.side == 'L':
            # 元の絵の +X は画面の右
            al[:, :mid] = 0
        else:
            al[:, mid:] = 0
        pp, ff = pt.sheet_from_alpha(al, 9, 1)
        hx, hy = px2m(pp[:, 0] * kx, pp[:, 1] * ky)
        Ph = pt.cap(c, R + .55 * MM, e.xf(np.c_[hx, hy]))
        Fc.add('EyeHighlight_' + e.side, V=Ph, F=ff, N=(Ph - c) / R, uv=np.c_[pp[:, 0] / high.shape[1], pp[:, 1] / high.shape[0]], joint='eye' + e.side)
        Fc.key('EyeHighlight_' + e.side, 'Fcl_EYE_Iris_Hide', np.tile([0, 0, -P['hide']['iris']], (len(Ph), 1)))
        Fc.key('EyeHighlight_' + e.side, 'Fcl_EYE_Highlight_Hide', np.tile([0, 0, -P['hide']['high']], (len(Ph), 1)))
        ds = np.zeros_like(Ph); ds[:, :2] = (np.array([cx, cy]) - Ph[:, :2]) * P['surprised_iris']; ds[:, 0] += e.sign * P['surprised_shift'] * MM
        Fc.key('EyeHighlight_' + e.side, 'Fcl_EYE_Surprised', ds)

    # ---- まつ毛 ---------------------------------------------------------------
    lash = np.asarray(Image.open(GEN + 'lash.png').convert('RGBA'))
    brow = np.asarray(Image.open(GEN + 'brow.png').convert('RGBA'))
    Al = lash[..., 3]
    kx, ky = SW / Al.shape[1], SH / Al.shape[0]

    def plate(alpha, cell, group_of, off):
        """絵の板。頂点は絵の画素、group_of(lab, 点) で部品の組を決め、組をまたぐ四角は捨てる。"""
        pp, ff = pt.sheet_from_alpha(alpha, cell, 2)
        x, y = px2m(pp[:, 0] * kx, pp[:, 1] * ky)
        xy = np.c_[x, y]
        lab, nl = ni.label(ni.binary_dilation(alpha > 12, iterations=2))
        ind = ni.distance_transform_edt(lab == 0, return_distances=False, return_indices=True)
        lb = lab[ind[0], ind[1]]
        gid = group_of(lb, pp, lab, nl)
        return xy, ff, gid

    lash_parts = {}
    for e in eyes:
        mid = Al.shape[1] // 2
        al = Al.copy()
        if e.side == 'L': al[:, :mid] = 0
        else: al[:, mid:] = 0

        def group(lb, pp, lab, nl):
            sz = ni.sum(lab > 0, lab, range(1, nl + 1)); big = 1 + int(np.argmax(sz))
            i = np.clip(pp[:, 1].astype(int), 0, lb.shape[0] - 1); j = np.clip(pp[:, 0].astype(int), 0, lb.shape[1] - 1)
            return (lb[i, j] != big).astype(int)    # 0 上、1 下
        xy, ff, gid = plate(al, P['lash_cell'], group, 0)
        keep = gid[ff].max(1) == gid[ff].min(1)
        ff = ff[keep]
        uvl = np.c_[m2px(xy[:, 0], xy[:, 1])[0] / SW, m2px(xy[:, 0], xy[:, 1])[1] / SH]
        xy = e.xf(xy)
        Pl = sf.xyz(xy); Pl[:, 2] += P['lash_lift'] * MM
        Fc.add('FaceEyelash_' + e.side, V=Pl, F=ff, N=np.tile([0, 0, 1.0], (len(Pl), 1)), uv=uvl, joint='head', group=gid, xy=xy)
        lash_parts[e.side] = (xy, gid)

    # ---- 眉と二重の線 ---------------------------------------------------------
    Ab = brow[..., 3]
    kx, ky = SW / Ab.shape[1], SH / Ab.shape[0]
    brow_parts = {}
    for e in eyes:
        mid = Ab.shape[1] // 2
        al = Ab.copy()
        if e.side == 'L': al[:, :mid] = 0
        else: al[:, mid:] = 0

        def group(lb, pp, lab, nl):
            # 上の線が眉(0)、下が二重の線(1)
            ys = ni.mean(np.mgrid[0:lab.shape[0], 0:lab.shape[1]][0], lab, range(1, nl + 1))
            sz = ni.sum(lab > 0, lab, range(1, nl + 1))
            top = 1 + int(np.argmin(np.where(sz > 200, ys, 1e9)))
            i = np.clip(pp[:, 1].astype(int), 0, lb.shape[0] - 1); j = np.clip(pp[:, 0].astype(int), 0, lb.shape[1] - 1)
            return (lb[i, j] != top).astype(int)
        xy, ff, gid = plate(al, P['brow_cell'], group, 0)
        keep = gid[ff].max(1) == gid[ff].min(1)
        ff = ff[keep]
        uvb = np.c_[m2px(xy[:, 0], xy[:, 1])[0] / SW, m2px(xy[:, 0], xy[:, 1])[1] / SH]
        xy = np.where(gid[:, None] == 1, e.xf(xy), xy)
        Pb = sf.xyz(xy); Pb[:, 2] += P['brow_lift'] * MM
        Fc.add('FaceBrow_' + e.side, V=Pb, F=ff, N=np.tile([0, 0, 1.0], (len(Pb), 1)), uv=uvb, joint='head', group=gid, xy=xy)
        brow_parts[e.side] = (xy, gid)

    # ---- 目のキー ---------------------------------------------------------------
    EF = P['eye_field']

    def apply_eye(name, ek, sides=('L', 'R')):
        d = np.zeros((len(Vr), 2))
        for e in eyes:
            if e.side not in sides: continue
            Up, Lo = eye_targets(e, ek, P)
            d += eye_field(e, xy0, Up, Lo, EF)
            # まつ毛
            xy, gid = lash_parts[e.side]
            D = np.where(gid[:, None] == 0, rigid_field(e, xy, Up, Lo), rigid_field(e, xy, Up, Lo, True))
            D3 = np.c_[D, sf.zf(xy[:, 0] + D[:, 0], xy[:, 1] + D[:, 1]) - sf.zf(xy[:, 0], xy[:, 1])]
            Fc.key('FaceEyelash_' + e.side, name, D3)
            # 二重の線は肌と一緒に動く
            xy, gid = brow_parts[e.side]
            D = eye_field(e, xy, Up, Lo, EF) * (gid[:, None] == 1)
            D3 = np.c_[D, (sf.zf(xy[:, 0] + D[:, 0], xy[:, 1] + D[:, 1]) - sf.zf(xy[:, 0], xy[:, 1]))]
            Fc.key('FaceBrow_' + e.side, name, D3)
        skin_key(name, d)

    for key, ek in (('Fcl_EYE_Close', 'Close'), ('Fcl_EYE_Joy', 'Joy'), ('Fcl_EYE_Fun', 'Fun'), ('Fcl_EYE_Angry', 'Angry'), ('Fcl_EYE_Sorrow', 'Sorrow'), ('Fcl_EYE_Surprised', 'Surprised'), ('Fcl_EYE_Spread', 'Spread')):
        apply_eye(key, ek)
    apply_eye('Fcl_EYE_Close_R', 'Close', ('R',)); apply_eye('Fcl_EYE_Close_L', 'Close', ('L',))
    apply_eye('Fcl_EYE_Joy_R', 'Joy', ('R',)); apply_eye('Fcl_EYE_Joy_L', 'Joy', ('L',))

    # ---- 眉のキー ---------------------------------------------------------------
    def brow_key(name, f):
        for e in eyes:
            xy, gid = brow_parts[e.side]
            m = gid == 0
            ax = np.abs(xy[:, 0] - M.xm); t = np.clip((ax - ax[m].min()) / (ax[m].max() - ax[m].min()), 0, 1)
            dx, dy = f(t)
            D = np.c_[e.sign * dx, dy] * MM * m[:, None]
            D3 = np.c_[D, (sf.zf(xy[:, 0] + D[:, 0], xy[:, 1] + D[:, 1]) - sf.zf(xy[:, 0], xy[:, 1]))]
            Fc.key('FaceBrow_' + e.side, name, D3)
    BK = P['brow']
    brow_key('Fcl_BRW_Angry', lambda t: (BK['Angry']['dx'] * (1 - t), -BK['Angry']['in'] * (1 - t) ** 1.2 + BK['Angry']['out'] * t))
    brow_key('Fcl_BRW_Sorrow', lambda t: (BK['Sorrow']['dx'] * (1 - t), BK['Sorrow']['in'] * (1 - t) ** 1.1 - BK['Sorrow']['out'] * t))
    brow_key('Fcl_BRW_Joy', lambda t: (0 * t, BK['Joy']['up'] * np.sin(np.pi * t) - BK['Joy']['out'] * t + BK['Joy'].get('in', 0) * (1 - t)))
    brow_key('Fcl_BRW_Fun', lambda t: (0 * t, BK['Fun']['up'] * np.sin(np.pi * t) - BK['Fun']['out'] * t))
    brow_key('Fcl_BRW_Surprised', lambda t: (0 * t, BK['Surprised']['up'] + BK['Surprised']['arc'] * np.sin(np.pi * t)))

    # ---- 口の中 ---------------------------------------------------------------
    mzs = P['mouth_in']
    # 外の面の少し奥に、椀を置く
    a, b_t, b_b = mzs['a'] * MM, mzs['bt'] * MM, mzs['bb'] * MM
    th = np.linspace(0, 2 * np.pi, 41)[:-1]; rho = np.linspace(0, 1, 9)
    pts = [(M.xm, M.ym, 0.0)]
    for r_ in rho[1:]:
        for t_ in th:
            bb = b_t if np.sin(t_) > 0 else b_b
            pts.append((M.xm + a * r_ * np.cos(t_), M.ym + bb * r_ * np.sin(t_), r_))
    pts = np.array(pts); xyc = pts[:, :2]
    zs = sf.zf(xyc[:, 0], xyc[:, 1])
    rim = mzs['rim'] + mzs['rim_lo'] * np.clip((M.ym - xyc[:, 1]) / b_b, 0, 1)
    Pc = np.c_[xyc, zs - rim * MM - mzs['depth'] * MM * (1 - pts[:, 2] ** 2)]
    fc = []
    nth = len(th)
    for j in range(nth):
        fc.append((0, 1 + j, 1 + (j + 1) % nth))
    for i in range(len(rho) - 2):
        for j in range(nth):
            a0 = 1 + i * nth + j; a1 = 1 + i * nth + (j + 1) % nth; b0 = a0 + nth; b1 = a1 + nth
            fc += [(a0, b0, b1), (a0, b1, a1)]
    fc = np.array(fc)
    # 歯: 上下の帯
    def teeth(y1, y0, zo):
        xs = np.linspace(-mzs['tw'], mzs['tw'], 49) * MM; ys = np.linspace(y0, y1, 5) * MM
        X, Y = np.meshgrid(xs, ys); X = X + M.xm; Y = Y + M.ym
        Zt = sf.zf(X.ravel(), Y.ravel()).reshape(X.shape).min(0, keepdims=True) - zo * MM
        Zt = np.tile(Zt, (X.shape[0], 1))
        vv = np.stack([X.ravel(), Y.ravel(), Zt.ravel()], 1)
        ff = []
        for i in range(4):
            for j in range(48):
                a0 = i * 49 + j; a1 = a0 + 1; b0 = a0 + 49; b1 = b0 + 1
                ff += [(a0, a1, b1), (a0, b1, b0)]
        return vv, np.array(ff), X.ravel() - M.xm, np.tile(np.linspace(0, 1, 5), (49, 1)).T.ravel()
    Tu, Fu, xu, ru = teeth(mzs['tu'][1], mzs['tu'][0], mzs['tz'])          # ru: 0 が歯茎の側ではない。下の端が 0
    Tl, Fl, xl, rl = teeth(mzs['tl'][1], mzs['tl'][0], mzs['tz'] + .7)
    # 舌
    pn = 15
    g = np.linspace(-1, 1, pn); X, Y = np.meshgrid(g, g)
    tx = M.xm + X.ravel() * mzs['tgw'] * MM
    tq = Y.ravel()
    tzc = sf.zf(M.xm, M.ym - mzs['tgzy'] * MM) - (mzs['tgz'] + (tq + 1) * mzs['tgl'] / 2) * MM
    bow = np.clip(1 - X.ravel() ** 2 - .4 * tq ** 2, 0, 1)
    ty = M.ym + (mzs['tgy'] + mzs['tgh'] * bow) * MM
    Tg = np.c_[tx, ty, tzc * np.ones(len(tx))]
    Fg = []
    for i in range(pn - 1):
        for j in range(pn - 1):
            a0 = i * pn + j; a1 = a0 + 1; b0 = a0 + pn; b1 = b0 + 1
            Fg += [(a0, a1, b1), (a0, b1, b0)]
    Fg = np.array(Fg)
    # 1 枚にまとめる。色は小さい色見本の UV
    sets = [(Pc, fc, (.125, .125)), (Tu, Fu, (.375, .125)), (Tl, Fl, (.375, .125)), (Tg, Fg, (.625, .125))]
    Vm = np.vstack([s_[0] for s_ in sets]); ofs = np.cumsum([0] + [len(s_[0]) for s_ in sets])
    Fm = np.vstack([s_[1] + o for s_, o in zip(sets, ofs)])
    uvm = np.vstack([np.tile(s_[2], (len(s_[0]), 1)) for s_ in sets])
    Fc.add('FaceMouth', V=Vm, F=Fm, N=pt.normals(Vm, Fm), uv=uvm, joint='head')
    # 歯の色の面の向き: 前を向く
    ic, iu, il, ig = [np.arange(ofs[i], ofs[i + 1]) for i in range(4)]
    print('mouth interior verts', len(Vm))

    TF = P['teeth_follow']

    def follow(dd):
        """口の中の点は、動いた先の面より奥に留める。"""
        q = Vm + dd
        dd[:, 2] += np.minimum(sf.zf(q[:, 0], q[:, 1]) - sf.zf(Vm[:, 0], Vm[:, 1]), 0) * 1.25

    def apply_mouth(name, a, inner=True):
        d, w = mouth_field(M, xy0, a, P['mouth_field'])
        dxy = d - D0
        extra = (a.get('pz', 0) * MM) * w * front
        J = jaw_term(Vr, a, M, P)
        skin_key(name, dxy + J[:, :2] * 0, extra)
        if a.get('jaw'):
            Fc.key('Face_00_SKIN', name, J)
        if not inner: return
        tk = a.get('tk', 1.0)
        hu = a.get('hu', 0) * tk; hl = a.get('hl', 0) * tk; cy = a.get('cy', 0); dx = a.get('dx', 0)
        dd = np.zeros_like(Vm)
        dd[:, 0] = dx * MM; dd[:, 1] = cy * MM
        dd[iu, 1] += hu * TF['u'] * MM
        dd[il, 1] += -hl * TF['l'] * MM
        dd[ig, 1] += -hl * TF['tongue'] * MM
        # 歯の幅は口の幅に少し合わせる
        kw = np.clip(a['w'] * MM / M.W0, TF['kw'][0], TF['kw'][1]) - 1
        dd[iu, 0] += (Vm[iu, 0] - M.xm) * kw; dd[il, 0] += (Vm[il, 0] - M.xm) * kw
        follow(dd)
        Fc.key('FaceMouth', name, dd)

    MS = P['mouth_shapes']
    for key, a in MS.items():
        apply_mouth(key, {**rest_mouth, **a})

    # SkinFung: 上唇の縁を小さく下げて八重歯の形にする
    def skin_fung(name, sides):
        d = np.zeros_like(Vr)
        s_ = (xy0[:, 0] - M.xm) / M.W0
        for sgn in sides:
            c = sgn * P['fung']['s']
            d[:, 1] += -P['fung']['h'] * MM * np.exp(-((s_ - c) / P['fung']['ws']) ** 2) * smooth(P['fung']['band'] * MM, 0, np.abs(xy0[:, 1] - M.ym - P['fung']['off'] * MM)) * (xy0[:, 1] >= M.ym)
        d[:, 2] = np.abs(d[:, 1]) * .25
        Fc.key('Face_00_SKIN', name, d)
    skin_fung('Fcl_MTH_SkinFung', (-1, 1)); skin_fung('Fcl_MTH_SkinFung_R', (-1,)); skin_fung('Fcl_MTH_SkinFung_L', (1,))

    # 歯のキー
    def tooth_cols(which):
        """中心からの mm で、尖らせる歯の位置。"""
        return which

    def fang(name, up, low, centers, width, h):
        dd = np.zeros_like(Vm)
        for idx, x_, r_, sgn, on in ((iu, xu, ru, -1, up), (il, xl, rl, 1, low)):
            if not on: continue
            prof = sum(np.exp(-((np.abs(x_) * 1000 - c) / width) ** 2) for c in centers)
            # 帯の唇の側の端だけ動かす
            edge = (1 - r_) if sgn == -1 else r_
            dd[idx, 1] += sgn * h * MM * np.clip(prof, 0, 1) * edge
        follow(dd)
        Fc.key('FaceMouth', name, dd)
    FG = P['fangs']
    for suf, up, low in (('', 1, 1), ('_Low', 0, 1), ('_Up', 1, 0)):
        fang('Fcl_HA_Fung1' + suf, up, low, FG['f1']['c'], FG['f1']['w'], FG['f1']['h'])
        fang('Fcl_HA_Fung2' + suf, up, low, FG['f2']['c'], FG['f2']['w'], FG['f2']['h'])
        fang('Fcl_HA_Fung3' + suf, up, low, FG['f3']['c'], FG['f3']['w'], FG['f3']['h'])
    for suf, up, low in (('', 1, 1), ('_Up', 1, 0), ('_Low', 0, 1)):
        dd = np.zeros_like(Vm)
        if up: dd[iu, 1] = FG['short'] * MM * (1 - ru)
        if low: dd[il, 1] = -FG['short'] * MM * rl
        Fc.key('FaceMouth', 'Fcl_HA_Short' + suf, dd)
    dd = np.zeros_like(Vm); dd[np.r_[iu, il], 2] = -P['hide']['teeth']
    Fc.key('FaceMouth', 'Fcl_HA_Hide', dd)

    # ALL は 眉 + 目 + 口 の足し合わせ
    for k in ('Angry', 'Fun', 'Joy', 'Sorrow', 'Surprised'):
        for part in Fc.parts.values():
            s_ = 0
            t = part['targets']
            for pre in ('Fcl_BRW_', 'Fcl_EYE_', 'Fcl_MTH_'):
                if pre + k in t: s_ = s_ + t[pre + k]
            if not np.isscalar(s_): t['Fcl_ALL_' + k] = s_

    return dict(Fc=Fc, sf=sf, eyes=eyes, M=M, balls=balls, jc=jc, bc=bc, wc=wc, hc=hc, names=names, TEXR=TEXR)


# ---- テクスチャ ------------------------------------------------------------
def skin_texture(R, P):
    """元の絵から目と眉を除いた skin.png を、正面投影の 2048 画素へ。顔の輪郭より外は平らな肌の色。"""
    GEN = P['images'].rstrip('/') + '/'
    SW, SH = pt.S['w'], pt.S['h']
    src = np.asarray(Image.open(GEN + 'skin.png').convert('RGB'), float)
    H, W = 2048, 2048; T = R['TEXR']
    xs = T['x0'] + (np.arange(W) + .5) / W * (T['x1'] - T['x0']); ys = T['y1'] - (np.arange(H) + .5) / H * (T['y1'] - T['y0'])
    X, Y = np.meshgrid(xs, ys)
    c, r = m2px(X, Y)
    c = c * src.shape[1] / SW; r = r * src.shape[0] / SH
    ins = (c >= 0) & (c < src.shape[1] - 1) & (r >= 0) & (r < src.shape[0] - 1)
    I = np.stack([ni.map_coordinates(src[..., k], [r, c], order=1, mode='nearest') for k in range(3)], -1)
    fh = P['forehead']
    forehead = (np.abs(X - fh[0]) < fh[1]) & (Y > fh[2]) & (Y < fh[3])
    flat = np.median(I[forehead], 0)
    # 頬と鼻と口のまわりだけ絵を使う。外の肌は平らな色。輪郭の線、耳、白い背景を入れない
    a = np.zeros_like(X)
    for cx, cy, rx, ry in P['paint']:
        a = np.maximum(a, 1 - ((X - cx) / rx) ** 2 - ((Y - cy) / ry) ** 2)
    a = ni.gaussian_filter(np.clip(a * 1.6, 0, 1), .003 * W / (T['x1'] - T['x0']))[..., None]
    edge = (a[..., 0] > .03) & (a[..., 0] < .35)
    offset = np.median(I[edge], 0) - flat
    print('flat skin', flat, 'paint offset', offset)
    I = I - offset
    out = flat * (1 - a) + I * a
    gain = np.array(P.get('skin_gain', [1, 1, 1]))
    return Image.fromarray(np.clip(out * gain, 0, 255).astype(np.uint8)), flat * gain


def white_texture(rgb, P):
    """白目。上まぶたの影の透過の絵(white_shade)があれば重ねる。affine は正面の (x,y) から画像の UV への [ax, cx, ay, cy]。"""
    Image.MAX_IMAGE_PIXELS = None
    Sh = P.get('white_shade')
    if not Sh: return Image.new('RGB', (64, 64), tuple(rgb))
    b = P['white_box']
    xs = b[0] + (np.arange(1024) + .5) / 1024 * (b[1] - b[0]); ys = b[3] - (np.arange(512) + .5) / 512 * (b[3] - b[2])
    X, Y = np.meshgrid(xs, ys)
    A = np.asarray(Image.open(Sh['image']).convert('RGBA'), float)
    Hh, Ww = A.shape[:2]
    ax, cx, ay, cy = Sh['affine']
    col = (ax * X + cx) * Ww; row = (ay * Y + cy) * Hh
    I = np.stack([ni.map_coordinates(A[..., k], [row, col], order=1, mode='nearest') for k in range(4)], -1)
    a = I[..., 3:] / 255
    out = np.array(rgb, float) * (1 - a) + I[..., :3] * a
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def png(im):
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()


def assemble(R, P, out):
    jc, bc, Fc, names, hc, wc = R['jc'], R['bc'], R['Fc'], R['names'], R['hc'], R['wc']
    GEN = P['images'].rstrip('/') + '/'
    js = copy.deepcopy(jc); G = W(js, bc)
    gone = [i for i, n in enumerate(js['nodes']) if n.get('name') in P['remove_nodes']]
    for i in gone: del js['nodes'][i]['mesh']; js['nodes'][i].pop('skin', None)
    sc = js['scenes'][0]; sc['nodes'] = [i for i in sc['nodes'] if i not in gone]

    # 材質
    base = next(m for m in jc['materials'] if m['name'] == P['skin_material'])

    def tex(data, name):
        bv = G.view(data)
        js['images'].append({'name': name, 'mimeType': 'image/png', 'bufferView': bv})
        js['textures'].append({'source': len(js['images']) - 1})
        return len(js['textures']) - 1

    def material(name, t, alpha='OPAQUE', flat=False, q=0, factor=None, double=True):
        o = copy.deepcopy(base); o['name'] = name; o['alphaMode'] = alpha; o['doubleSided'] = double
        o['pbrMetallicRoughness']['baseColorTexture'] = {'index': t}
        o['pbrMetallicRoughness']['baseColorFactor'] = (factor or [.8, .8, .8]) + [1.0] if not flat else [1.0, 1.0, 1.0, 1.0]
        e = o['extensions']['VRMC_materials_mtoon']; e['shadeMultiplyTexture'] = {'index': t}
        e['renderQueueOffsetNumber'] = q
        if flat: e['shadeColorFactor'] = [1.0, 1.0, 1.0]
        js['materials'].append(o); return len(js['materials']) - 1

    sk, flat_c = skin_texture(R, P)
    sk.save(P['work'] + '/skin_tex.png')
    mats = {'Face_00_SKIN': material('Face_00_SKIN', tex(png(sk), 'Face_00_SKIN'), factor=P.get('skin_factor'))}
    js['materials'][mats['Face_00_SKIN']]['extensions']['VRMC_materials_mtoon']['shadeColorFactor'] = P['skin_shade']
    js['materials'][mats['Face_00_SKIN']]['extensions']['VRMC_materials_mtoon']['giEqualizationFactor'] = 1.0
    wc_ = P['white_rgb']
    white = white_texture(wc_, P)
    mats['EyeWhite'] = material('EyeWhite', tex(png(white), 'EyeWhite'), flat=True)
    ir = Image.open(GEN + 'iris.png').convert('RGBA')
    mats['EyeIris'] = material('EyeIris', tex(png(ir), 'EyeIris'), 'BLEND', flat=True, q=-3)
    mats['EyeHighlight'] = material('EyeHighlight', tex(png(Image.open(GEN + 'high.png').convert('RGBA')), 'EyeHighlight'), 'BLEND', flat=True, q=-2)
    mats['FaceEyelash'] = material('FaceEyelash', tex(png(Image.open(GEN + 'lash.png').convert('RGBA')), 'FaceEyelash'), 'BLEND', flat=True, q=-1)
    mats['FaceBrow'] = material('FaceBrow', tex(png(Image.open(GEN + 'brow.png').convert('RGBA')), 'FaceBrow'), 'BLEND', flat=True, q=-1)
    pal = np.zeros((64, 64, 3), np.uint8)
    pal[:, :] = P['mouth_rgb']['cup']; pal[:, 16:32] = P['mouth_rgb']['cup']
    pal[32:, :] = P['mouth_rgb']['cup']
    im = np.zeros((16, 16, 3), np.uint8)
    im[:8, :8] = P['mouth_rgb']['cup']; im[:8, 8:] = 0
    # 4 マス: 椀、歯、舌
    im = np.zeros((16, 16, 3), np.uint8)
    im[:, :4] = P['mouth_rgb']['cup']; im[:, 4:8] = P['mouth_rgb']['teeth']; im[:, 8:12] = P['mouth_rgb']['tongue']
    mats['FaceMouth'] = material('FaceMouth', tex(png(Image.fromarray(im).resize((64, 64), Image.NEAREST)), 'FaceMouth'), flat=True)

    # 骨: 目の骨 2 本を頭の子に足す
    skin = js['skins'][0]
    newb = {}
    for side, nm in (('L', 'J_Adj_L_FaceEye'), ('R', 'J_Adj_R_FaceEye')):
        Mw = np.eye(4); Mw[:3, 3] = R['balls'][side]
        Lm = np.linalg.inv(wc[hc]) @ Mw
        rot = Lm[:3, :3]; rot = rot / np.linalg.norm(rot, axis=0)
        js['nodes'].append({'name': nm, 'translation': [float(x) for x in Lm[:3, 3]], 'rotation': quat(rot)})
        k = len(js['nodes']) - 1; js['nodes'][hc]['children'].append(k); newb[side] = (k, Mw)
    ibm = accessor(jc, bc, skin['inverseBindMatrices']).reshape(-1, 16).copy()
    add = []
    jid = {'head': skin['joints'].index(hc)}
    for side in 'LR':
        k, Mw = newb[side]; jid['eye' + side] = len(skin['joints']); skin['joints'].append(k); add.append(np.linalg.inv(Mw).T.reshape(1, 16))
    skin['inverseBindMatrices'] = G.acc(np.vstack([ibm] + add), 'MAT4', 5126)

    # 部品を材質ごとに束ねる。L/R の部品は 1 つの primitive へ
    order = ['FaceMouth', 'EyeWhite', 'EyeIris', 'EyeHighlight', 'Face_00_SKIN', 'FaceEyelash', 'FaceBrow']
    prims = []
    report = {}
    for mname in order:
        ps = [(k, v) for k, v in Fc.parts.items() if k == mname or k.startswith(mname + '_') and k != 'Face_00_SKIN_']
        if mname == 'Face_00_SKIN': ps = [('Face_00_SKIN', Fc.parts['Face_00_SKIN'])]
        Vs = np.vstack([v['V'] for _, v in ps]); Ns = np.vstack([v['N'] for _, v in ps]); Ns = Ns / np.linalg.norm(Ns, axis=1, keepdims=True); UVs = np.vstack([v['uv'] for _, v in ps])
        o = 0; Fs = []; Js = []
        Tg = {nm: np.zeros_like(Vs) for nm in names}
        for _, v in ps:
            Fs.append(v['F'] + o); Js.append(np.full(len(v['V']), jid[v['joint']]))
            for nm, d in v['targets'].items(): Tg[nm][o:o + len(v['V'])] = d
            o += len(v['V'])
        Fs = np.vstack(Fs); Js = np.concatenate(Js)
        zero = G.acc(np.zeros_like(Vs), 'VEC3', 5126, 34962, True)
        tg = []
        for nm in names:
            d = Tg[nm]; mx = np.linalg.norm(d, axis=1).max()
            report.setdefault(nm, {})[mname] = round(float(mx * 1000), 2)
            tg.append({'POSITION': zero if mx < 1e-7 else G.acc(d, 'VEC3', 5126, 34962, True)})
        Jv = np.zeros((len(Vs), 4), np.uint16); Jv[:, 0] = Js
        Wv = np.zeros((len(Vs), 4)); Wv[:, 0] = 1
        attr = {'POSITION': G.acc(Vs, 'VEC3', 5126, 34962, True), 'NORMAL': G.acc(Ns, 'VEC3', 5126, 34962), 'TEXCOORD_0': G.acc(UVs, 'VEC2', 5126, 34962), 'JOINTS_0': G.acc(Jv, 'VEC4', 5123, 34962), 'WEIGHTS_0': G.acc(Wv, 'VEC4', 5126, 34962)}
        prims.append({'attributes': attr, 'indices': G.acc(Fs.astype(np.uint32).ravel(), 'SCALAR', 5125, 34963), 'material': mats[mname], 'mode': 4, 'targets': tg})
        print(mname, len(Vs), 'verts', len(Fs), 'tris')
    js['meshes'].append({'name': 'Face', 'primitives': prims, 'extras': {'targetNames': names}, 'weights': [0.0] * len(names)})
    js['nodes'].append({'name': 'Face', 'mesh': len(js['meshes']) - 1, 'skin': 0})
    fn = len(js['nodes']) - 1; sc['nodes'].append(fn)

    # VRM の情報
    v = js['extensions']['VRMC_vrm']
    v['humanoid']['humanBones']['leftEye'] = {'node': newb['L'][0]}
    v['humanoid']['humanBones']['rightEye'] = {'node': newb['R'][0]}
    mid = (R['balls']['L'] + R['balls']['R']) / 2
    g = P['gaze']
    la = {'type': 'bone', 'offsetFromHeadBone': [float(x) for x in (mid - wc[hc][:3, 3])]}
    for k in ('rangeMapHorizontalInner', 'rangeMapHorizontalOuter'): la[k] = {'inputMaxValue': float(g['inH']), 'outputScale': float(g['h'])}
    for k in ('rangeMapVerticalUp', 'rangeMapVerticalDown'): la[k] = {'inputMaxValue': float(g['inV']), 'outputScale': float(g['v'])}
    v['lookAt'] = la
    B_ = {'neutral': 'Fcl_ALL_Neutral', 'angry': 'Fcl_ALL_Angry', 'relaxed': 'Fcl_ALL_Fun', 'happy': 'Fcl_ALL_Joy', 'sad': 'Fcl_ALL_Sorrow', 'surprised': 'Fcl_ALL_Surprised', 'blink': 'Fcl_EYE_Close', 'blinkRight': 'Fcl_EYE_Close_R', 'blinkLeft': 'Fcl_EYE_Close_L', 'aa': 'Fcl_MTH_A', 'ih': 'Fcl_MTH_I', 'ou': 'Fcl_MTH_U', 'ee': 'Fcl_MTH_E', 'oh': 'Fcl_MTH_O'}
    ex = copy.deepcopy(v['expressions'])
    for k, e in ex['preset'].items():
        e.pop('textureTransformBinds', None); e.pop('morphTargetBinds', None)
        if k in B_: e['morphTargetBinds'] = [{'node': fn, 'index': names.index(B_[k]), 'weight': 1.0}]
    v['expressions'] = ex

    # 内張りの作り直し
    ln = next((i for i, n in enumerate(js['nodes']) if n.get('name') == 'Head_liner'), None)
    t = copy.deepcopy(js); t['nodes'][fn]['name'] = 'Head_face'
    if ln is not None: del t['nodes'][ln]['mesh']
    fm = t['meshes'][t['nodes'][fn]['mesh']]
    fm['primitives'] = [p for p in fm['primitives'] if any(k in t['materials'][p['material']]['name'] for k in ('Face_00_SKIN', 'EyeWhite', 'FaceMouth'))]
    s = build_liner.build(t, bytes(G.bin), 1.0, P.get('liner_inset', .006), 1.0)
    if ln is None:   # 内張りの無い材料は、ここで足す
        G.bin = bytearray(build_liner.append_liner(js, bytes(G.bin), s, build_liner.hair_color(js, bytes(G.bin))[1]))
    else:
        Vl, Fl, Nl = s['V'], s['F'], s['N']
        j = skin['joints'].index(s['head_node'])
        prim = js['meshes'][js['nodes'][ln]['mesh']]['primitives'][0]
        prim['attributes']['POSITION'] = G.acc(Vl, 'VEC3', 5126, 34962, True)
        prim['attributes']['NORMAL'] = G.acc(Nl, 'VEC3', 5126, 34962)
        prim['attributes']['JOINTS_0'] = G.acc(np.tile(np.array([j, 0, 0, 0]), (len(Vl), 1)), 'VEC4', 5123, 34962)
        prim['attributes']['WEIGHTS_0'] = G.acc(np.tile(np.array([1., 0, 0, 0]), (len(Vl), 1)), 'VEC4', 5126, 34962)
        prim['indices'] = G.acc(Fl.reshape(-1), 'SCALAR', 5125, 34963)
    print('liner', len(s['V']), 'verts', len(s['F']), 'tris')

    binary = compact(js, G.bin)
    js['buffers'][0]['byteLength'] = len(binary) + (-len(binary) % 4)
    write_glb(out, js, binary)
    print('wrote', out, os.path.getsize(out) // 1024 // 1024, 'MB')
    json.dump(report, open(out + '.keys.json', 'w'), indent=0)
    return report
