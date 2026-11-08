"""頭の中心から全方向へ光線を飛ばし、何に当たるかを数える。
python measure.py <model.vrm> [--center x,y,z] [--png out.png]
分類(光線の上で最初に当たる殻ではなく、その方向に何があるか):
  shell  Head/Face/Liner の面がある
  body   Head/Face は無いが Body(首・襟)がある
  hair   Head/Face/Body が無く Hair だけある
    hair_fixed  その方向の Hair に、頭の骨にほぼ固定された面がある(揺れても残る)
    hair_swing  その方向の Hair は揺れる髪だけ(揺れると開く)
  none   何も無い
"""
import sys, argparse
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb import *

SPRING_T = 0.9   # 頭の骨のウェイトがこれ以上なら「固定」


def fib_sphere(n):
    i = np.arange(n) + .5
    y = 1 - 2 * i / n
    r = np.sqrt(1 - y * y)
    th = np.pi * (3 - 5 ** .5) * i
    return np.stack([r * np.cos(th), y, r * np.sin(th)], 1)


def mesh_groups(js, b):
    """{group: (tris Nx3x3, per-tri head weight)}"""
    head = js['extensions']['VRMC_vrm']['humanoid']['humanBones']['head']['node']
    skin = js['skins'][0]; joints = skin['joints']
    head_j = joints.index(head)
    out = {}
    for n in js['nodes']:
        if 'mesh' not in n:
            continue
        name = n.get('name', '')
        m = js['meshes'][n['mesh']]
        for p in m['primitives']:
            mname = js['materials'][p['material']].get('name', '')
            if name.startswith('Head'):
                g = 'shell'
            elif name in ('Hair',) or name.startswith('Hair') or 'hair' in mname.lower():
                g = 'hair'
            elif name == 'Body':
                g = 'body'
            else:
                continue
            P = accessor(js, b, p['attributes']['POSITION']).astype(np.float64)
            I = accessor(js, b, p['indices']).astype(np.int64).reshape(-1, 3)
            J = accessor(js, b, p['attributes']['JOINTS_0']); W = accessor(js, b, p['attributes']['WEIGHTS_0'])
            if W.dtype != np.float32:
                W = W / 255.0 if W.dtype == np.uint8 else W / 65535.0
            hw = ((J == head_j) * W).sum(1) / np.maximum(W.sum(1), 1e-6)
            t, w = P[I], hw[I].min(1)
            out.setdefault(g, []).append((t, w))
    return {k: (np.concatenate([a for a, _ in v]), np.concatenate([c for _, c in v])) for k, v in out.items()}


def ray_hit(o, dirs, tris, chunk=3000):
    """o から dirs 各方向へ。各光線の最初の当たりまでの距離と三角形の番号(無ければ inf,-1)。"""
    v0 = tris[:, 0]; e1 = tris[:, 1] - v0; e2 = tris[:, 2] - v0
    s = o - v0
    best = np.full(len(dirs), np.inf); idx = np.full(len(dirs), -1)
    q = np.cross(s, e1)
    for k in range(0, len(tris), chunk):
        E1, E2, S, Q = e1[k:k + chunk], e2[k:k + chunk], s[k:k + chunk], q[k:k + chunk]
        h = np.cross(dirs[:, None, :], E2[None])          # R,T,3
        a = (E1[None] * h).sum(2)
        ok = np.abs(a) > 1e-12
        f = np.where(ok, 1 / np.where(ok, a, 1), 0)
        u = f * (S[None] * h).sum(2)
        v = f * (dirs[:, None, :] * Q[None]).sum(2)
        t = f * (E2[None] * Q[None]).sum(2)
        hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-5)
        t = np.where(hit, t, np.inf)
        m = t.argmin(1); tv = t[np.arange(len(dirs)), m]
        up = tv < best
        best[up] = tv[up]; idx[up] = m[up] + k
    return best, idx


def head_center(js, b, g):
    """頭の中心: x=0、頭の外形(Hair と Head の頭蓋の高さ)の中心。頭の骨より上の Head の面の範囲で取る。"""
    hb = js['extensions']['VRMC_vrm']['humanoid']['humanBones']
    W, _ = node_world(js)
    hy = W[hb['head']['node']][1, 3]
    t = g['shell'][0].reshape(-1, 3)
    t = t[t[:, 1] > hy]
    c = (t.min(0) + t.max(0)) / 2
    return np.array([0, c[1], c[2]]), hy


def classify(js, b, center=None, n=6000):
    g = mesh_groups(js, b)
    c, hy = head_center(js, b, g)
    if center is not None:
        c = np.array(center, float)
    d = fib_sphere(n)
    rs, _ = ray_hit(c, d, g['shell'][0])
    rb, _ = ray_hit(c, d, g['body'][0])
    rh, _ = ray_hit(c, d, g['hair'][0])
    fx = g['hair'][1] >= SPRING_T
    rf, _ = ray_hit(c, d, g['hair'][0][fx]) if fx.any() else (np.full(n, np.inf), None)
    cat = np.select([np.isfinite(rs), np.isfinite(rb), np.isfinite(rf), np.isfinite(rh)], [0, 1, 2, 3], 4)
    return dict(center=c, head_y=hy, dirs=d, cat=cat, rs=rs, rb=rb, rh=rh, rf=rf, g=g)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('vrm'); ap.add_argument('--center'); ap.add_argument('--png')
    a = ap.parse_args()
    js, b = read_glb(a.vrm)
    r = classify(js, b, [float(x) for x in a.center.split(',')] if a.center else None)
    cat = r['cat']; n = len(cat)
    names = ['shell', 'body', 'hair_fixed', 'hair_swing', 'none']
    pc = {k: 100 * (cat == i).mean() for i, k in enumerate(names)}
    d = r['dirs']
    back = d[:, 2] < 0   # VRM 1.0 は +Z が正面
    bk = {k: 100 * (cat[back] == i).mean() for i, k in enumerate(names)}
    print('center', r['center'].round(4), 'head bone y', round(float(r['head_y']), 4))
    print('all ', {k: round(v, 1) for k, v in pc.items()})
    print('back', {k: round(v, 1) for k, v in bk.items()})
    print('hair tris fixed', int((r['g']['hair'][1] >= SPRING_T).sum()), '/', len(r['g']['hair'][1]))
    if a.png:
        from PIL import Image
        W, H = 720, 360
        col = np.array([[90, 170, 90], [90, 120, 200], [230, 200, 80], [240, 130, 40], [220, 40, 40]], np.uint8)
        yy, xx = np.mgrid[0:H, 0:W]
        lon = (xx + .5) / W * 2 * np.pi - np.pi; lat = np.pi / 2 - (yy + .5) / H * np.pi
        v = np.stack([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)], 2).reshape(-1, 3)
        idx = np.concatenate([(v[i:i + 20000] @ d.T).argmax(1) for i in range(0, len(v), 20000)])
        Image.fromarray(col[cat[idx]].reshape(H, W, 3)).save(a.png)
