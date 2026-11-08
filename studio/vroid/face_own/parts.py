"""顔の部品の形を作る。座標はモデルの世界座標(メートル)。正面の xy は +X がキャラの左。
下地の面、目と口の輪郭、肌のメッシュ、白目・虹彩・ハイライト、まつ毛と眉の板、口の中。"""
import json
import numpy as np
from PIL import Image
from scipy import ndimage as ni
from scipy.spatial import Delaunay, cKDTree
import base as B
MM = 1e-3
FEAT = None; S = None


def configure(P):
    """register.py が作った feat.json を読む。"""
    global FEAT, S
    B.configure(P)
    FEAT = json.load(open(P['work'] + '/feat.json'))
    S = FEAT['src']


def inside(poly, pts):
    """点が多角形の内側か。半直線の交差の偶奇。"""
    poly = np.asarray(poly); pts = np.asarray(pts)
    x, y = pts[:, 0], pts[:, 1]
    a, b = poly, np.roll(poly, -1, 0)
    o = np.zeros(len(pts), bool)
    for (x0, y0), (x1, y1) in zip(a, b):
        c = (y0 > y) != (y1 > y)
        if c.any():
            o ^= c & (x < (x1 - x0) * (y - y0) / (y1 - y0 + 1e-30) + x0)
    return o


def px2m(c, r):
    """元の絵 neutral_v2.png の画素 → 正面の xy。"""
    return S['x0'] + np.asarray(c, float) * S['dxdpx'], S['y0'] - np.asarray(r, float) * S['dxdpx']


def m2px(x, y):
    return (np.asarray(x, float) - S['x0']) / S['dxdpx'], (S['y0'] - np.asarray(y, float)) / S['dxdpx']


def smooth(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ---- 下地の面 -------------------------------------------------------------
class Surface:
    def __init__(s, A):
        P = A['surface']
        raw = np.load(A['work'] + '/raw.npz')['r']
        U, V = np.meshgrid(B.US, B.VS)
        hit = np.isfinite(raw)
        r = np.where(hit, raw, 0)
        # 耳の 3 か所のかけらと穴: 周りの中央値から外れた所を捨てる
        med = ni.median_filter(r, size=15)
        D = P['drop']
        bad = (~hit) | ((np.abs(r - med) > D['tol']) & (np.abs(U) > D['u']) & (V < D['v'][1]) & (V > D['v'][0]))
        ear = (np.abs(U) > P['ear_u']) & (V > P['ear_v'][0]) & (V < P['ear_v'][1])
        s.mask = ni.binary_fill_holes(hit & ~ear) & ~ear
        good = hit & ~bad & ~ear
        w = ni.gaussian_filter(good.astype(float), P['sigma'])
        rs = ni.gaussian_filter(np.where(good, r, 0), P['sigma']) / np.maximum(w, 1e-4)
        far = ni.gaussian_filter(good.astype(float), 6)
        rw = ni.gaussian_filter(np.where(good, r, 0), 6) / np.maximum(far, 1e-4)
        s.r = np.where(w > .05, rs, rw)
        s.r[~(far > .001)] = np.nanmedian(s.r)
        # 頬から下は Kimi の三角形の折れが輪郭と陰に出るので、強くならす(jaw_sigma。v が jaw_band の間で切り替える)
        ws = ni.gaussian_filter(good.astype(float), P['jaw_sigma'])
        rj = ni.gaussian_filter(np.where(good, r, 0), P['jaw_sigma']) / np.maximum(ws, 1e-4)
        t = smooth(P['jaw_band'][0], P['jaw_band'][1], V) * (ws > .05)
        s.r = s.r * (1 - t) + np.where(ws > .05, rj, s.r) * t
        s.rn = ni.gaussian_filter(s.r, P['normal_sigma'])   # 法線はさらにならした面から出す
        s.jaw = P.get('jaw')
        # 正面の高さの表 Zf(x,y)
        pts = s.surf(U[s.mask], V[s.mask])
        n = s.normals_grid()
        keep = n[s.mask][:, 2] > .05
        from scipy.interpolate import griddata
        g = P['grid']
        s.gx = np.arange(g[0], g[1], .0005); s.gy = np.arange(g[2], g[3], .0005)
        X, Y = np.meshgrid(s.gx, s.gy)
        Z = griddata(pts[keep, :2], pts[keep, 2], (X, Y), method='linear')
        ok = np.isfinite(Z)
        ind = ni.distance_transform_edt(~ok, return_distances=False, return_indices=True)
        s.Z = Z[tuple(ind)]
        s.Zok = ok

    def add_lid_bump(s, balls, R, clear, radius):
        """閉じたまぶたが眼球の前を通るように、目の上の面を持ち上げる。"""
        X, Y = np.meshgrid(s.gx, s.gy)
        b = np.zeros_like(s.Z)
        for c in balls:
            d2 = (X - c[0]) ** 2 + (Y - c[1]) ** 2
            zs = np.where(d2 < (R * .98) ** 2, c[2] + np.sqrt(np.maximum(R * R - d2, 0)), -9)
            b = np.maximum(b, zs + clear - s.Z)
        cx, cy = np.mean([c[0] for c in balls]), np.mean([c[1] for c in balls])
        b = np.where(np.hypot(X - cx, Y - cy) < radius, b, 0)
        b = ni.maximum_filter(b, size=9)
        s.B = ni.gaussian_filter(b, 6)
        s.Z = s.Z + s.B
        print('lid bump max mm', round(float(s.B.max() * 1000), 2))

    def bump_at(s, x, y):
        i = (np.asarray(y) - s.gy[0]) / .0005; j = (np.asarray(x) - s.gx[0]) / .0005
        return ni.map_coordinates(s.B, [i, j], order=1, mode='nearest')

    def warp_jaw(s, Q):
        """顎の線を元絵に合わせる。y の関数で x を縮め、先を下へ伸ばす。"""
        J = s.jaw
        if not J: return Q
        Q = Q.copy()
        y = Q[..., 1]
        t = smooth(J['y1'], J['y0'], y)
        k = 1 + (J['xk'] - 1) * t
        Q[..., 0] = J['cx'] + (Q[..., 0] - J['cx']) * k
        # 先を下へ伸ばす。中心の線のあたりだけ
        Q[..., 1] = y - J['drop'] * MM * smooth(J['y1'], J['y0'] + J['tip'], y) * (1 - smooth(.0, J['xr'], np.abs(Q[..., 0] - J['cx']))) * smooth(J['z'][0], J['z'][1], Q[..., 2])
        return Q

    def surf(s, u, v, table=None):
        i = (np.asarray(v) - B.VS[0]) / B.STEP; j = (np.asarray(u) - B.US[0]) / B.STEP
        r = ni.map_coordinates(s.r if table is None else table, [i, j], order=3, mode='nearest')
        return s.warp_jaw(B.CEN + r[..., None] * B.dirs(np.asarray(u), np.asarray(v)))

    def normal_at(s, u, v, d=.5):
        """(u,v) の面の法線。三角形の割り方によらない。外向き。閉じたまぶたの持ち上げの傾きも足す。"""
        a = s.surf(u + d, v, s.rn) - s.surf(u - d, v, s.rn); b = s.surf(u, v + d, s.rn) - s.surf(u, v - d, s.rn)
        n = np.cross(a, b)
        p = s.surf(u, v, s.rn)
        n = n * np.sign((n * (p - B.CEN)).sum(-1, keepdims=True) + 1e-20)
        n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-12)
        gy, gx = np.gradient(ni.gaussian_filter(s.B, 4), .0005)
        i = (p[..., 1] - s.gy[0]) / .0005; j = (p[..., 0] - s.gx[0]) / .0005
        bx = ni.map_coordinates(gx, [i, j], order=1, mode='nearest'); by = ni.map_coordinates(gy, [i, j], order=1, mode='nearest')
        n = n + np.stack([-bx, -by, np.zeros_like(bx)], -1) * np.maximum(n[..., 2:], 0)
        return n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-12)

    def normals_grid(s):
        U, V = np.meshgrid(B.US, B.VS)
        d = .4
        a = s.surf(U + d, V) - s.surf(U - d, V); b = s.surf(U, V + d) - s.surf(U, V - d)
        n = np.cross(a, b)
        return n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-12)

    def zf(s, x, y):
        i = (np.atleast_1d(y) - s.gy[0]) / .0005; j = (np.atleast_1d(x) - s.gx[0]) / .0005
        o = ni.map_coordinates(s.Z, [i, j], order=1, mode='nearest')
        return o if np.ndim(x) else float(o[0])

    def xyz(s, xy):
        xy = np.asarray(xy)
        return np.c_[xy, s.zf(xy[:, 0], xy[:, 1])]


# ---- 輪郭 ------------------------------------------------------------------
def resample(C, n):
    d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(C, axis=0), axis=1))]
    t = np.linspace(0, d[-1], n)
    return np.c_[np.interp(t, d, C[:, 0]), np.interp(t, d, C[:, 1])]


class Eye:
    def __init__(s, side, xf):
        s.side = side; s.sign = 1 if side == 'L' else -1
        P = np.array(FEAT[side])
        s.c0 = P.mean(0); s.k = xf['k']; s.dx = np.array([s.sign * xf['dx'] * MM, xf.get('dy', 0) * MM])
        P = s.xf(P)
        a, b = P[:, 0].argmin(), P[:, 0].argmax()     # 左端と右端
        inner, outer = (a, b) if side == 'L' else (b, a)
        n = len(P)
        def chain(i, j, step):
            o = [i]
            while o[-1] != j: o.append((o[-1] + step) % n)
            return P[o]
        c1, c2 = chain(inner, outer, 1), chain(inner, outer, -1)
        U, L = (c1, c2) if c1[:, 1].mean() > c2[:, 1].mean() else (c2, c1)
        s.U = resample(U, 201); s.L = resample(L, 201)
        s.t = np.linspace(0, 1, 201)
        s.poly = np.vstack([s.U, s.L[::-1][1:-1]])
        s.poly_dense = resample(np.vstack([s.U, s.L[::-1]]), 141)[:-1]
        s.cen = s.poly.mean(0)

    def xf(s, xy):
        """元の絵の目の位置 → 元絵に合わせて広げた位置。"""
        return s.c0 + (np.asarray(xy) - s.c0) * s.k + s.dx

    def xf_inv(s, xy):
        return s.c0 + (np.asarray(xy) - s.c0 - s.dx) / s.k

    def rings(s, off):
        Q = s.poly_dense
        d = np.roll(Q, -1, 0) - np.roll(Q, 1, 0)
        n = np.c_[d[:, 1], -d[:, 0]]; n /= np.linalg.norm(n, axis=1, keepdims=True)
        if ((Q + n * 1e-3 - s.cen) ** 2).sum() < ((Q - s.cen) ** 2).sum(): n = -n
        for _ in range(3): n = (np.roll(n, 1, 0) + 2 * n + np.roll(n, -1, 0)); n /= np.linalg.norm(n, axis=1, keepdims=True)
        return [Q + o * n for o in off]

    def near(s, xy):
        """点ごとに上の縁と下の縁の最近点の番号と距離。"""
        du, iu = cKDTree(s.U).query(xy); dl, il = cKDTree(s.L).query(xy)
        return du, iu, dl, il


class Mouth:
    def __init__(s, P):
        s.xm = P['xm']; s.ym = P['ym']; s.W0 = P['W0']; s.h0 = P['h0']
        t = np.linspace(-1, 1, 41)
        s.t = t
        s.Ud = np.c_[s.xm + s.W0 * t, s.ym + s.h0 * (1 - t ** 4)]
        s.Ld = np.c_[s.xm + s.W0 * t, s.ym - s.h0 * (1 - t ** 4)]
        s.poly = np.vstack([s.Ud, s.Ld[::-1][1:-1]])
        s.cen = np.array([s.xm, s.ym])

    def rings(s, off):
        Q = s.poly
        d = np.roll(Q, -1, 0) - np.roll(Q, 1, 0)
        n = np.c_[d[:, 1], -d[:, 0]]; n /= np.linalg.norm(n, axis=1, keepdims=True)
        if ((Q + n * 1e-3 - s.cen) ** 2).sum() < ((Q - s.cen) ** 2).sum(): n = -n
        for _ in range(4): n = (np.roll(n, 1, 0) + 2 * n + np.roll(n, -1, 0)); n /= np.linalg.norm(n, axis=1, keepdims=True)
        return [Q + o * n for o in off]


# ---- 肌のメッシュ ----------------------------------------------------------
def skin_mesh(sf, eyes, mouth, P):
    """(u,v) の平面で Delaunay。目と口のまわりは輪、その外は格子。"""
    EO = np.array(P['eye_rings']) * MM; MO = np.array(P['mouth_rings']) * MM
    groups = []
    for e in eyes:
        groups += e.rings(EO)
    groups += mouth.rings(MO)
    ring = np.vstack(groups)
    ring_uv = np.c_[B.uv_of(sf.xyz(ring))]
    # 格子
    du = P['grid_deg']
    U, V = np.meshgrid(np.arange(-139, 139, du), np.arange(-84, 74, du))
    U[1::2] += du / 2
    u, v = U.ravel(), V.ravel()
    i = np.round((v - B.VS[0]) / B.STEP).astype(int); j = np.round((u - B.US[0]) / B.STEP).astype(int)
    ins = sf.mask[np.clip(i, 0, sf.mask.shape[0] - 1), np.clip(j, 0, sf.mask.shape[1] - 1)]
    u, v = u[ins], v[ins]
    # 顔の前以外は間引く
    Z_ = P['face_zone']
    facezone = (np.abs(u) < Z_['u']) & (v > Z_['v'][0]) & (v < Z_['v'][1])
    k = (np.arange(len(u)) % 3 == 0) | facezone
    bg = np.c_[u, v][k]
    d, _ = cKDTree(ring_uv).query(bg)
    bg = bg[d > du * .75]
    # 境界の近くの点(面の端を揃える)
    uv = np.vstack([ring_uv, bg])
    tri = Delaunay(uv).simplices
    c = uv[tri].mean(1)
    edge = np.linalg.norm(uv[tri] - uv[np.roll(tri, 1, 1)], axis=2).max(1)
    i = np.round((c[:, 1] - B.VS[0]) / B.STEP).astype(int); j = np.round((c[:, 0] - B.US[0]) / B.STEP).astype(int)
    keep = sf.mask[np.clip(i, 0, sf.mask.shape[0] - 1), np.clip(j, 0, sf.mask.shape[1] - 1)] & (edge < 14)
    # 穴: 目と口
    n_eye = len(eyes[0].poly_dense); n_m = len(mouth.poly); nr = len(EO); ofs = 0; loops = {}
    for e in eyes:
        idx = np.arange(ofs, ofs + n_eye); loops[e.side] = idx
        poly = ring_uv[idx]
        keep &= ~inside(poly, c)
        ofs += n_eye * nr
    idx = np.arange(ofs, ofs + n_m); loops['M'] = idx
    keep &= ~inside(ring_uv[idx], c)
    tri = tri[keep]
    Vt = sf.surf(uv[:, 0], uv[:, 1])
    # 使っていない点を捨てる
    used = np.unique(tri); rm = -np.ones(len(uv), int); rm[used] = np.arange(len(used))
    loops = {k: rm[v] for k, v in loops.items()}
    assert all((v >= 0).all() for v in loops.values()), '輪の点が三角形に入っていない'
    Vt, tri, uv = Vt[used], rm[tri], uv[used]
    # 輪の辺が残っているかを確かめる
    E = {tuple(sorted(e)) for f in tri for e in ((f[0], f[1]), (f[1], f[2]), (f[2], f[0]))}
    for k, lp in loops.items():
        miss = sum(tuple(sorted((a, b))) not in E for a, b in zip(lp, np.roll(lp, -1)))
        print('loop', k, len(lp), 'missing edges', miss)
    return Vt, tri, loops, uv


def normals(V, F, merge=None):
    n = np.zeros_like(V)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    for i in range(3): np.add.at(n, F[:, i], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def extrude_loop(V, F, loop, depth_dir, depth):
    """穴の縁を奥へ折り返す。縁の面の厚み。戻り値は新しい点の番号。"""
    new = np.arange(len(V), len(V) + len(loop))
    V = np.vstack([V, V[loop] + depth_dir * depth])
    a, b = loop, np.roll(loop, -1); c, d = new, np.roll(new, -1)
    # 輪の向きは後で法線の向きで決める
    f = np.vstack([np.c_[a, b, d], np.c_[a, d, c]])
    return V, np.vstack([F, f]), new


# ---- 目玉 ------------------------------------------------------------------
def fit_ball(sf, e, R, gap):
    """開口の縁の面から gap だけ奥で接する半径 R の球の中心を求める。"""
    from scipy.optimize import least_squares
    b = sf.xyz(e.poly_dense[::4]); inner = sf.xyz(e.poly_dense[::4] * .6 + e.cen * .4)
    c0 = np.r_[e.cen, sf.zf(*e.cen) - R]
    pts = np.vstack([b, inner])
    f = lambda c: np.linalg.norm(pts - c, axis=1) - (R + gap)
    c = least_squares(f, c0).x
    err = np.linalg.norm(pts - c, axis=1) - R
    print(e.side, 'ball', c.round(4), 'clearance mm min/max', (err * 1000).min().round(2), (err * 1000).max().round(2))
    return c


def cap(c, R, xy):
    """正面の xy の点を、球の手前側へ上げる。"""
    d2 = ((xy - c[:2]) ** 2).sum(1)
    return np.c_[xy, c[2] + np.sqrt(np.maximum(R * R - d2, 1e-9))]


def disc_grid(cx, cy, rx, ry, n=24):
    """楕円の円板の格子。"""
    a = np.linspace(-1, 1, n)
    X, Y = np.meshgrid(a, a)
    id_ = -np.ones(X.shape, int); pts = []
    for i in range(n):
        for j in range(n):
            if X[i, j] ** 2 + Y[i, j] ** 2 <= 1.25:
                id_[i, j] = len(pts); pts.append((X[i, j], Y[i, j]))
    F = []
    for i in range(n - 1):
        for j in range(n - 1):
            a_, b_, c_, d_ = id_[i, j], id_[i, j + 1], id_[i + 1, j + 1], id_[i + 1, j]
            if min(a_, b_, c_, d_) >= 0:
                F += [(a_, b_, c_), (a_, c_, d_)]
    p = np.array(pts)
    return np.c_[cx + p[:, 0] * rx, cy + p[:, 1] * ry], np.array(F), p


def region_grid(mask, X, Y):
    """True のセルを四角形にしたメッシュ。X,Y は格子の交点の座標(行 y、列 x)。"""
    h, w = mask.shape
    ids = -np.ones((h + 1, w + 1), int); pts = []; F = []
    for i, j in zip(*np.where(mask)):
        q = []
        for a, b in ((i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j)):
            if ids[a, b] < 0:
                ids[a, b] = len(pts); pts.append((X[a, b], Y[a, b]))
            q.append(ids[a, b])
        F += [(q[0], q[1], q[2]), (q[0], q[2], q[3])]
    return np.array(pts), np.array(F)


def sheet_from_alpha(alpha, cell=9, dil=2):
    """alpha(元の絵の画素)の絵がある所だけを覆う板。頂点は元の絵の画素座標で返す。"""
    H, W = alpha.shape
    h, w = H // cell, W // cell
    a = alpha[:h * cell, :w * cell].reshape(h, cell, w, cell).max((1, 3)) > 6
    a = ni.binary_dilation(a, iterations=dil)
    C, R = np.meshgrid(np.arange(w + 1) * cell, np.arange(h + 1) * cell)
    return region_grid(a, C.astype(float), R.astype(float))
