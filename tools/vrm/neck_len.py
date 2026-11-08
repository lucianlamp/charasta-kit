"""VRM の首の長さを変える(glTF を直接書き換える。Blender の読み込みと書き出しを通さないので、揺れ骨とコライダーの設定が崩れない)。

  python tools/vrm/neck_len.py in.vrm out.vrm --delta 0.0075 --band 1.262 1.272 [--tube-meshes Body] [--radius 0.035]
  python tools/vrm/neck_len.py in.vrm --probe        # 首と頭の骨の高さを出すだけ

高さ z0..z1(--band、m、VRM の座標)の区間を縦に伸ばし(delta > 0)/縮め(delta < 0)、z1 より上を delta だけ上げる。
区間の中は smoothstep でつなぐので、段は付かない。区間は首の見えている所(あごの下から襟の上)にとる。頭の骨の付け根は区間の中か上に置く。

動かすもの:
  - 頭の骨とその子の節点(髪の揺れ骨、目など)。移動に合わせて逆バインド行列も平行移動する(静止の形はそのまま)。
  - メッシュの頂点。--tube-meshes に挙げたメッシュ(既定 Body。首と胴が 1 枚になっているもの)は、z1 より上だけの部品(帽子など)は全部、
    ほかは首の筒(頭の骨から水平に --radius 以内)の頂点だけ動かす。ほかのメッシュ(顔、髪)は全部の頂点を高さで動かす(区間の下は動かない)。
  - モーフの差分、揺れ骨の当たり判定(コライダーは骨の子なので骨と一緒に動く)は変えない。

ナース(2026-11-07)では v9-skirtfix のあごの下の色を直した版に --delta 0.0075 --band 1.262 1.272 をかけて v11-neck075 にした。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glb  # noqa: E402


def smooth_shift(y, D, z0, z1):
    t = np.clip((np.asarray(y, float) - z0) / (z1 - z0), 0, 1)
    return D * t * t * (3 - 2 * t)


def q2m(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def local(n):
    M = np.eye(4)
    M[:3, :3] = q2m(n.get("rotation", [0, 0, 0, 1])) @ np.diag(n.get("scale", [1, 1, 1]))
    M[:3, 3] = n.get("translation", [0, 0, 0])
    return M


def world_mats(nodes):
    par = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    G = {}

    def glob(i):
        if i not in G:
            G[i] = (glob(par[i]) if i in par else np.eye(4)) @ local(nodes[i])
        return G[i]

    for i in range(len(nodes)):
        glob(i)
    return G, par


def humanoid_node(js, bone):
    ext = js.get("extensions", {})
    if "VRMC_vrm" in ext:
        return ext["VRMC_vrm"]["humanoid"]["humanBones"][bone]["node"]
    for b in ext["VRM"]["humanoid"]["humanBones"]:   # VRM 0.x
        if b["bone"] == bone:
            return b["node"]
    raise KeyError(bone)


def descendants(nodes, i):
    out = [i]
    for c in nodes[i].get("children", []):
        out += descendants(nodes, c)
    return out


def neck_len(js, binc, D, z0, z1, tube_meshes=("Body",), radius=0.035):
    """js と binc をその場で書き換え、報告を返す。"""
    if not z1 > z0:
        raise ValueError("区間は z0 < z1")
    N = js["nodes"]
    G, par = world_mats(N)
    hd = humanoid_node(js, "head")
    sub = descendants(N, hd)
    Gn = dict(G)
    for i in sub:
        M = G[i].copy()
        M[1, 3] += smooth_shift(M[1, 3], D, z0, z1)
        Gn[i] = M
    for i in sub:
        N[i]["translation"] = (np.linalg.inv(Gn[par[i]]) @ Gn[i])[:3, 3].tolist()
    ibm_moved = 0
    for sk in js.get("skins", []):
        if "inverseBindMatrices" not in sk:
            continue
        IB = glb.acc(js, binc, sk["inverseBindMatrices"]).reshape(-1, 4, 4).astype(float)
        for k, j in enumerate(sk["joints"]):   # VRM の静止の姿勢と節点の姿勢は一致しないことがあるので、動いた量だけ平行移動する
            if j in sub:
                Tm = np.eye(4)
                Tm[:3, 3] = Gn[j][:3, 3] - G[j][:3, 3]
                IB[k] = np.linalg.inv(Tm @ np.linalg.inv(IB[k].T)).T
                ibm_moved += 1
        glb.put(js, binc, sk["inverseBindMatrices"], IB.reshape(-1, 16))
    cx, cz = G[hd][0, 3], G[hd][2, 3]
    done, meshes = set(), {}
    for n in N:
        if "mesh" not in n:
            continue
        name = n.get("name") or js["meshes"][n["mesh"]].get("name", "")
        for p in js["meshes"][n["mesh"]]["primitives"]:
            a = p["attributes"]["POSITION"]
            if a in done:
                continue
            done.add(a)
            P = glb.acc(js, binc, a).astype(float)
            if name in tube_meshes and P[:, 1].min() <= z1:
                m = (P[:, 1] > z0 - 0.002) & (np.hypot(P[:, 0] - cx, P[:, 2] - cz) < radius)
            else:
                m = np.ones(len(P), bool)
            d = smooth_shift(P[:, 1], D, z0, z1) * m
            P[:, 1] += d
            glb.put(js, binc, a, P)
            meshes[name] = meshes.get(name, 0) + int((np.abs(d) > 1e-6).sum())
    return {"headY": [round(float(G[hd][1, 3]), 4), round(float(Gn[hd][1, 3]), 4)], "nodesMoved": len(sub),
            "inverseBindMoved": ibm_moved, "verticesMoved": meshes}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inp")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--delta", type=float, help="伸ばす量(m)。縮めるときは負")
    ap.add_argument("--band", type=float, nargs=2, metavar=("Z0", "Z1"), help="伸び縮みさせる高さの区間(m)")
    ap.add_argument("--tube-meshes", default="Body", help="首の筒だけ動かすメッシュの名前(コンマ区切り)")
    ap.add_argument("--radius", type=float, default=0.035, help="首の筒の半径(m)")
    ap.add_argument("--probe", action="store_true", help="首と頭の骨の高さを出して終わる")
    a = ap.parse_args()
    js, binc = glb.load(a.inp)
    if a.probe:
        G, _ = world_mats(js["nodes"])
        for b in ("upperChest", "neck", "head"):
            try:
                print(b, round(float(G[humanoid_node(js, b)][1, 3]), 4))
            except KeyError:
                pass
        return
    if a.out is None or a.delta is None or a.band is None:
        ap.error("out、--delta、--band が要る(--probe のときは要らない)")
    rep = neck_len(js, binc, a.delta, a.band[0], a.band[1], tuple(s for s in a.tube_meshes.split(",") if s), a.radius)
    glb.save(a.out, js, binc)
    print(rep)


if __name__ == "__main__":
    main()
