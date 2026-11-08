"""Kimi の頭の面を、頭の中心から見た半径の表 r(u,v) にする。u は +Z から +X への方位角、v は仰角(どちらも度)。
configure(P) で中心と表の範囲を決める。raycast(P) の出力は work/raw.npz。"""
import numpy as np
from glbw import read_glb, accessor

CEN = None; STEP = None; US = None; VS = None


def configure(P):
    global CEN, STEP, US, VS
    s = P['surface']
    CEN = np.array(s['center'], float); STEP = s['step']
    US = np.arange(s['u'][0], s['u'][1] + 1e-6, STEP)
    VS = np.arange(s['v'][0], s['v'][1] + 1e-6, STEP)


def dirs(u, v):
    u, v = np.radians(u), np.radians(v)
    return np.stack([np.cos(v) * np.sin(u), np.sin(v), np.cos(v) * np.cos(u)], -1)


def uv_of(P):
    d = np.asarray(P, float) - CEN
    r = np.linalg.norm(d, axis=-1)
    return np.degrees(np.arctan2(d[..., 0], d[..., 2])), np.degrees(np.arcsin(d[..., 1] / r))


def far_hits(o, D, T, chunk=3000):
    v0 = T[:, 0]; e1 = T[:, 1] - v0; e2 = T[:, 2] - v0
    s = o - v0; q = np.cross(s, e1)
    best = np.full(len(D), -np.inf)
    for k in range(0, len(T), chunk):
        E1, E2, S, Q = e1[k:k + chunk], e2[k:k + chunk], s[k:k + chunk], q[k:k + chunk]
        for j in range(0, len(D), 4000):
            d = D[j:j + 4000]
            h = np.cross(d[:, None], E2[None]); a = (E1[None] * h).sum(2)
            ok = np.abs(a) > 1e-12; f = np.where(ok, 1 / np.where(ok, a, 1), 0)
            u = f * (S[None] * h).sum(2); v = f * (d[:, None] * Q[None]).sum(2); t = f * (E2[None] * Q[None]).sum(2)
            t = np.where(ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-5), t, -np.inf)
            best[j:j + 4000] = np.maximum(best[j:j + 4000], t.max(1))
    return best


def raycast(P):
    js, b = read_glb(P['source_vrm'])
    n = next(n for n in js['nodes'] if n.get('name') == P['head_mesh'])
    T = []
    for p in js['meshes'][n['mesh']]['primitives']:
        Q = accessor(js, b, p['attributes']['POSITION']).astype(float); I = accessor(js, b, p['indices']).astype(int).reshape(-1, 3)
        T.append(Q[I])
    T = np.vstack(T)
    U, V = np.meshgrid(US, VS)
    r = far_hits(CEN, dirs(U, V).reshape(-1, 3), T).reshape(U.shape)
    print('rays', r.size, 'hit', np.isfinite(r).sum(), 'r', r[np.isfinite(r)].min(), r[np.isfinite(r)].max())
    np.savez(P['work'] + '/raw.npz', r=r)
