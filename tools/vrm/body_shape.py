"""VRM の体型を変える(glTF を直接書き換える。Blender の読み込みと書き出しを通さないので、揺れ骨とコライダーの設定が崩れない)。

  python tools/vrm/body_shape.py in.vrm out.vrm [--head 0.94] [--neck 0.0075] [--shoulder -0.012] [--arm 0.85] [--waist 0.95] [--leg 0.9]
  python tools/vrm/body_shape.py in.vrm --probe        # 骨の高さと、それから決めた区間を JSON で出すだけ

値(どれも省くと変えない):
  --head      頭の大きさの倍率。頭の骨とその子(顔、髪、目、髪の揺れ骨)に全部の重みがある頂点を、首の区間の中ほどの点を中心に一様に拡縮する。
              首の区間の中の首の筒は、倍率を 1 から滑らかにつなぐ。頭の骨の子の節点、コライダー、揺れ骨の当たりの半径も同じ倍率にする。
  --neck      首の長さの変化(m)。頭の骨とその子を上へ平行に動かし、首の筒の頂点は首の区間の中で滑らかに伸ばす(縮めるときは負)。
  --shoulder  肩幅の変化(m、片側)。正は広く、負は狭く。腕の骨とその子を横へ動かし、肩の頂点は胸の上の帯だけ滑らかにつなぐ。
  --arm       腕の太さの倍率。upperArm と lowerArm の重みの分だけ、頂点を骨の軸へ寄せる(長さは変えない)。
  --waist     腰回りの倍率。spine の重みの分だけ、頂点を体の中心の縦の線へ水平に寄せる(前後は変化を半分にする)。
  --leg       脚の太さの倍率。upperLeg と lowerLeg の重みの分だけ骨の軸へ寄せる。足首から脛の 4 割までは 1 へ戻す(靴を変えない)。

区間と高さは骨から決める(キャラごとの数を書かない):
  首の区間 z0..z1   neck の高さ + (head - neck) の 0.15 と 0.6
  首の筒の半径      首の区間の高さで neck に重みのある頂点の、首の中心からの水平の距離の中央値の 1.4 倍。(head - neck) の 0.6 を超えない(襟の重みを拾わない)
  肩の帯 X0..X1     upperArm の |x| の 0.45 から |x| まで。胸の上の帯 Y0..Y1 は upperArm の高さの 0.909 から 0.959

逆バインド行列は、動かした量(と頭の倍率)だけ直す。元の逆バインド行列が節点の静止の姿勢と一致しないモデル(手の向きを直したものなど)でも、
静止の形は計算どおりに変わる。モーフの差分も同じ写像で直す。法線は細くした分だけ直す。順は 細く → 肩 → 首 → 頭。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glb  # noqa: E402
from neck_len import descendants, world_mats  # noqa: E402

# 値の範囲(画面の public/adjust-plan.mjs と同じ。外れた値は止める)
RANGES = {"head": (0.8, 1.2), "neck": (-0.03, 0.03), "shoulder": (-0.04, 0.04), "arm": (0.6, 1.3), "waist": (0.7, 1.3), "leg": (0.6, 1.3)}
NEUTRAL = {"head": 1.0, "neck": 0.0, "shoulder": 0.0, "arm": 1.0, "waist": 1.0, "leg": 1.0}
NEEDED = ["hips", "spine", "neck", "head", "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm", "rightLowerArm", "rightHand",
          "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot"]


def ss(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


class Model:
    """glTF と BIN を持ち、骨、重み、頂点の読み書きをまとめる。"""

    def __init__(self, js, binc):
        self.js, self.binc = js, binc
        ext = js.get("extensions", {})
        if "VRMC_vrm" not in ext:
            raise ValueError("VRM 1.0 ではない(VRMC_vrm が無い)。VRM 0.x は先に 1.0 へ変換する")
        hb = ext["VRMC_vrm"]["humanoid"]["humanBones"]
        self.hb = {k: v["node"] for k, v in hb.items()}
        missing = [b for b in NEEDED if b not in self.hb]
        if missing:
            raise ValueError("humanoid の骨が足りない: " + ", ".join(missing))
        if not js.get("skins"):
            raise ValueError("skin が無い")
        self.N = js["nodes"]

    # ---- 骨 ----
    def refresh(self):
        self.G, self.par = world_mats(self.N)
        self.bind = {}   # 節点 -> バインドの世界の行列(逆バインド行列の逆)
        for sk in self.js["skins"]:
            if "inverseBindMatrices" not in sk:
                continue
            IB = glb.acc(self.js, self.binc, sk["inverseBindMatrices"]).reshape(-1, 4, 4).astype(float)
            for k, j in enumerate(sk["joints"]):
                self.bind.setdefault(j, np.linalg.inv(IB[k].T))

    def bpos(self, bone):
        """バインドの姿勢の骨の位置(頂点と同じ座標)。"""
        n = self.hb[bone]
        return (self.bind[n] if n in self.bind else self.G[n])[:3, 3].copy()

    def subtree(self, bone):
        return set(descendants(self.N, self.hb[bone]))

    def move_nodes(self, new_world):
        """節点 -> 新しい世界の位置(3)。回転は変えず、translation を親から求め直す。"""
        Gn = dict(self.G)
        for i, p in new_world.items():
            M = self.G[i].copy()
            M[:3, 3] = p
            Gn[i] = M
        for i in new_world:
            parent = np.linalg.inv(Gn[self.par[i]]) if i in self.par else np.eye(4)
            self.N[i]["translation"] = (parent @ Gn[i])[:3, 3].tolist()

    def fix_ibm(self, change):
        """change: 節点 -> 4x4 の行列 A(バインドの座標の写像)。新しい逆バインド行列 = 骨の中での写像 x 元 x A の逆。
        平行移動 T(d) なら 元 x T(-d)、頭の倍率なら S(s) x 元 x U(s)^-1。"""
        n = 0
        for sk in self.js["skins"]:
            if "inverseBindMatrices" not in sk:
                continue
            IB = glb.acc(self.js, self.binc, sk["inverseBindMatrices"]).reshape(-1, 4, 4).astype(float)
            for k, j in enumerate(sk["joints"]):
                if j in change:
                    pre, A = change[j]
                    IB[k] = (pre @ IB[k].T @ np.linalg.inv(A)).T
                    n += 1
            glb.put(self.js, self.binc, sk["inverseBindMatrices"], IB.reshape(-1, 16))
        return n

    # ---- 頂点 ----
    def primitives(self):
        """skin のある mesh の primitive を 1 度ずつ。(名前, primitive, 節点の番号の配列)"""
        done = set()
        for n in self.N:
            if "mesh" not in n or "skin" not in n:
                continue
            joints = np.array(self.js["skins"][n["skin"]]["joints"])
            mesh = self.js["meshes"][n["mesh"]]
            for p in mesh["primitives"]:
                a = p["attributes"]
                if a["POSITION"] in done or "JOINTS_0" not in a or "WEIGHTS_0" not in a:
                    continue
                done.add(a["POSITION"])
                yield n.get("name") or mesh.get("name", ""), p, joints

    def weights(self, p, joints):
        a = p["attributes"]
        Jn = joints[glb.acc(self.js, self.binc, a["JOINTS_0"]).astype(int)]
        W = glb.acc(self.js, self.binc, a["WEIGHTS_0"]).astype(float)
        ct = self.js["accessors"][a["WEIGHTS_0"]]["componentType"]
        if ct == 5121:
            W /= 255
        elif ct == 5123:
            W /= 65535
        return Jn, W

    def get(self, i):
        return glb.acc(self.js, self.binc, i).astype(float)

    def put(self, i, arr):
        glb.put(self.js, self.binc, i, arr)

    def springs(self):
        return self.js.get("extensions", {}).get("VRMC_springBone", {})


def weight_in(Jn, W, nodes):
    return (W * np.isin(Jn, list(nodes))).sum(1)


# ---- 腕、腰、脚を細くする ----
def slim(m, arm=1.0, waist=1.0, leg=1.0):
    if arm == 1 and waist == 1 and leg == 1:
        return None
    waist_d = 1 - (1 - waist) / 2
    AX = {}   # 節点 -> (起点, 単位方向, 倍率, 種類)
    for s in ("left", "right"):
        for b, c, k, kind in ((f"{s}UpperArm", f"{s}LowerArm", arm, "arm"), (f"{s}LowerArm", f"{s}Hand", arm, "arm"),
                              (f"{s}UpperLeg", f"{s}LowerLeg", leg, "leg"), (f"{s}LowerLeg", f"{s}Foot", leg, "leg")):
            if k == 1:
                continue
            p0, p1 = m.bpos(b), m.bpos(c)
            AX[m.hb[b]] = (p0, (p1 - p0) / np.linalg.norm(p1 - p0), k, kind)
    if waist != 1:
        AX[m.hb["spine"]] = (m.bpos("spine"), np.array([0, 1.0, 0]), waist, "waist")
    foot_y = (m.bpos("leftFoot")[1] + m.bpos("rightFoot")[1]) / 2
    knee_y = (m.bpos("leftLowerLeg")[1] + m.bpos("rightLowerLeg")[1]) / 2
    ramp_h = max(0.4 * (knee_y - foot_y), 1e-3)
    fw = np.array([1 - waist, 0, 1 - waist_d])

    def displacement(P, Jn, W):
        D = np.zeros_like(P)
        terms = []
        for nd, (p0, u, k, kind) in AX.items():
            w = (W * (Jn == nd)).sum(1)
            sel = w > 0
            if not sel.any():
                continue
            r = P[sel] - p0
            perp = r - (r @ u)[:, None] * u
            if kind == "waist":
                d = perp * fw
            else:
                f = np.full(sel.sum(), 1 - k)
                if kind == "leg":
                    f = f * ss((P[sel, 1] - foot_y) / ramp_h)
                d = perp * f[:, None]
            D[sel] += w[sel, None] * d
            terms.append((sel, w[sel], u, kind, k))
        return D, terms

    def fix_normals(Nrm, terms):
        out = Nrm.copy()
        for sel, w, u, kind, k in terms:
            n = Nrm[sel]
            perp = n - (n @ u)[:, None] * u
            g = np.array([1 / waist - 1, 0, 1 / waist_d - 1]) if kind == "waist" else (1 / k - 1)
            out[sel] += w[:, None] * perp * g
        return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-9)

    moved, most = 0, 0.0
    for _, p, joints in m.primitives():
        a = p["attributes"]
        P = m.get(a["POSITION"])
        Jn, W = m.weights(p, joints)
        D, terms = displacement(P, Jn, W)
        if not terms:
            continue
        for t in p.get("targets", []):
            if "POSITION" not in t:
                continue
            dP = m.get(t["POSITION"])
            if not np.abs(dP).any():
                continue
            D2, _ = displacement(P + dP, Jn, W)
            m.put(t["POSITION"], dP - D2 + D)
        m.put(a["POSITION"], P - D)
        if "NORMAL" in a:
            m.put(a["NORMAL"], fix_normals(m.get(a["NORMAL"]), terms))
        size = np.linalg.norm(D, axis=1)
        moved += int((size > 1e-6).sum())
        most = max(most, float(size.max()))

    colliders = 0
    for c in m.springs().get("colliders", []):
        nd = c["node"]
        if nd not in AX:
            continue
        p0, u, k, kind = AX[nd]
        for name, sh in c["shape"].items():
            if kind == "waist":
                sh["radius"] *= waist
            else:
                sh["radius"] *= k
                R = m.G[nd][:3, :3]
                ul = R.T @ u / np.linalg.norm(R.T @ u)   # 骨の向きを節点の中の座標で
                for key in ("offset", "tail"):
                    if key in sh:
                        o = np.array(sh[key], float)
                        par = (o @ ul) * ul
                        sh[key] = (par + k * (o - par)).tolist()
            colliders += 1
    return {"vertices": moved, "maxMm": round(most * 1000, 1), "colliders": colliders}


# ---- 肩幅 ----
def shoulder(m, width):
    """width: 片側の肩幅の変化(m)。正は広く。"""
    if width == 0:
        return None
    inward = -width
    ua = abs(m.bpos("leftUpperArm")[0] - m.bpos("hips")[0])
    cx = m.bpos("hips")[0]
    X0, X1 = 0.45 * ua, ua
    Ya = (m.bpos("leftUpperArm")[1] + m.bpos("rightUpperArm")[1]) / 2
    Y0, Y1 = 0.909 * Ya, 0.959 * Ya

    def sx(x):
        d = x - cx
        return inward * ss((np.abs(d) - X0) / (X1 - X0)) * np.sign(d)

    arms = set()
    for s in ("left", "right"):
        arms |= m.subtree(f"{s}Shoulder" if f"{s}Shoulder" in m.hb else f"{s}UpperArm")
    head = m.subtree("head")
    new, change = {}, {}
    for i in arms:   # 節点と逆バインド行列は同じ量だけ動かす(静止の形が頂点の写像のとおりになる)
        p = m.G[i][:3, 3].copy()
        d = np.array([-sx(p[0]), 0, 0])
        new[i] = p + d
        T = np.eye(4)
        T[:3, 3] = d
        change[i] = (np.eye(4), T)
    m.move_nodes(new)
    ibm = m.fix_ibm(change)
    moved = 0
    for _, p, joints in m.primitives():
        a = p["attributes"]
        P = m.get(a["POSITION"])
        Jn, W = m.weights(p, joints)
        mask = np.maximum(weight_in(Jn, W, arms), ss((P[:, 1] - Y0) / (Y1 - Y0))) * (1 - weight_in(Jn, W, head))
        dx = sx(P[:, 0]) * mask
        if not np.abs(dx).any():
            continue
        P[:, 0] -= dx
        m.put(a["POSITION"], P)
        moved += int((np.abs(dx) > 1e-6).sum())
    return {"upperArmX": [round(float(ua), 4), round(float(ua + width), 4)], "vertices": moved, "inverseBind": ibm}


# ---- 首の区間と筒 ----
def neck_band(m):
    ny, hy = m.bpos("neck")[1], m.bpos("head")[1]
    return ny + 0.15 * (hy - ny), ny + 0.6 * (hy - ny)


def neck_axis(m, y):
    """高さ y の首の中心(x, z)。neck と head の骨の位置を高さで補う。"""
    a, b = m.bpos("neck"), m.bpos("head")
    t = np.clip((np.asarray(y, float) - a[1]) / max(b[1] - a[1], 1e-6), 0, 1)
    return a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t


def neck_radius(m):
    z0, z1 = neck_band(m)
    nd = m.hb["neck"]
    rs = []
    for _, p, joints in m.primitives():
        P = m.get(p["attributes"]["POSITION"])
        Jn, W = m.weights(p, joints)
        sel = ((W * (Jn == nd)).sum(1) > 0.5) & (P[:, 1] > z0) & (P[:, 1] < z1)
        if sel.any():
            cx, cz = neck_axis(m, P[sel, 1])
            rs.append(np.hypot(P[sel, 0] - cx, P[sel, 2] - cz))
    cap = 0.6 * float(m.bpos("head")[1] - m.bpos("neck")[1])
    return min(float(np.median(np.concatenate(rs))) * 1.4, cap) if rs else cap


# ---- 首の長さ ----
def neck(m, D):
    if D == 0:
        return None
    z0, z1 = neck_band(m)
    R = neck_radius(m)
    head = m.subtree("head")
    new, change = {}, {}
    T = np.eye(4)
    T[:3, 3] = [0, D, 0]
    for i in head:
        new[i] = m.G[i][:3, 3] + [0, D, 0]
        change[i] = (np.eye(4), T)
    m.move_nodes(new)
    ibm = m.fix_ibm(change)
    moved = 0
    for _, p, joints in m.primitives():
        a = p["attributes"]
        P = m.get(a["POSITION"])
        Jn, W = m.weights(p, joints)
        wh = weight_in(Jn, W, head)
        cx, cz = neck_axis(m, P[:, 1])
        tube = np.hypot(P[:, 0] - cx, P[:, 2] - cz) < R
        f = np.clip(wh + (1 - wh) * ss((P[:, 1] - z0) / (z1 - z0)) * tube, 0, 1)
        if not f.any():
            continue
        P[:, 1] += D * f
        m.put(a["POSITION"], P)
        moved += int((f > 1e-6).sum())
    return {"band": [round(float(z0), 4), round(float(z1), 4)], "radius": round(R, 4), "vertices": moved, "inverseBind": ibm}


# ---- 頭の大きさ ----
def head(m, s):
    if s == 1:
        return None
    y0, y1 = neck_band(m)
    h = y1 - y0
    Cy = y0 + h / 2
    cx, cz = (float(v) for v in neck_axis(m, Cy))
    C = np.array([cx, Cy, cz])
    R = neck_radius(m)

    def band(P):
        t = np.clip((P[:, 1] - y0) / h, 0, 1)
        k = 1 + (s - 1) * ss(t)
        Q = P.copy()
        Q[:, 0] = cx + k * (P[:, 0] - cx)
        Q[:, 2] = cz + k * (P[:, 2] - cz)
        S = t ** 3 - t ** 4 / 2   # 倍率を高さで積んだもの。帯の上端で一様の写像と位置も傾きもつながる
        Q[:, 1] = np.where(P[:, 1] <= y0, P[:, 1], np.where(P[:, 1] >= y1, Cy + s * (P[:, 1] - Cy), P[:, 1] + (s - 1) * h * S))
        return Q, k

    sub = m.subtree("head")
    U = np.eye(4)
    U[:3, :3] *= s
    U[:3, 3] = C - s * C
    Sb = np.diag([s, s, s, 1.0])
    m.move_nodes({i: C + s * (m.G[i][:3, 3] - C) for i in sub})
    ibm = m.fix_ibm({i: (Sb, U) for i in sub})
    uni_n = band_n = 0
    for _, p, joints in m.primitives():
        a = p["attributes"]
        P = m.get(a["POSITION"])
        Jn, W = m.weights(p, joints)
        full = weight_in(Jn, W, sub) >= 0.99
        r = np.hypot(P[:, 0] - cx, P[:, 2] - cz)
        inner = r < R
        use_u = full & ((P[:, 1] >= y1) | ~inner)
        use_b = ~use_u & inner & (P[:, 1] > y0)
        if not (use_u.any() or use_b.any()):
            continue
        Qb, kb = band(P)
        Q = P.copy()
        Q[use_b] = Qb[use_b]
        Q[use_u] = C + s * (P[use_u] - C)
        k = np.ones(len(P))
        k[use_b] = kb[use_b]
        k[use_u] = s
        m.put(a["POSITION"], Q)
        for t in p.get("targets", []):
            if "POSITION" in t:
                dP = m.get(t["POSITION"])
                if np.abs(dP).any():
                    m.put(t["POSITION"], dP * k[:, None])
        uni_n += int(use_u.sum())
        band_n += int((use_b & (np.abs(kb - 1) > 1e-6)).sum())
    sp = m.springs()
    colliders = 0
    for c in sp.get("colliders", []):
        if c["node"] in sub:
            for sh in c["shape"].values():
                for key in ("offset", "tail"):
                    if key in sh:
                        sh[key] = [v * s for v in sh[key]]
                sh["radius"] *= s
            colliders += 1
    joints = 0
    for spg in sp.get("springs", []):
        for jn in spg["joints"]:
            if jn["node"] in sub and "hitRadius" in jn:
                jn["hitRadius"] *= s
                joints += 1
    return {"center": np.round(C, 4).tolist(), "uniform": uni_n, "band": band_n, "inverseBind": ibm, "colliders": colliders, "springJoints": joints}


def check(values):
    out = dict(NEUTRAL)
    for k, v in values.items():
        if v is None:
            continue
        lo, hi = RANGES[k]
        if not (lo <= v <= hi):
            raise ValueError(f"{k} は {lo} から {hi}: {v}")
        out[k] = float(v)
    return out


def body_shape(js, binc, values):
    """js と binc をその場で書き換え、報告を返す。values は RANGES の鍵の値(無い鍵は変えない)。"""
    v = check(values)
    m = Model(js, binc)
    rep = {"values": v}
    m.refresh()
    rep["slim"] = slim(m, v["arm"], v["waist"], v["leg"])
    m.refresh()
    rep["shoulder"] = shoulder(m, v["shoulder"])
    m.refresh()
    rep["neck"] = neck(m, v["neck"])
    m.refresh()
    rep["head"] = head(m, v["head"])
    return rep


def probe(js, binc):
    m = Model(js, binc)
    m.refresh()
    z0, z1 = neck_band(m)
    return {"bones": {b: np.round(m.bpos(b), 4).tolist() for b in ("hips", "spine", "neck", "head", "leftUpperArm", "leftLowerLeg", "leftFoot")},
            "neckBand": [round(float(z0), 4), round(float(z1), 4)], "neckRadius": round(neck_radius(m), 4)}


def main():
    ap = argparse.ArgumentParser(description="VRM の体型を変える(docs/vrm-edits.md)")
    ap.add_argument("inp")
    ap.add_argument("out", nargs="?")
    for k in RANGES:
        ap.add_argument("--" + k, type=float)
    ap.add_argument("--probe", action="store_true", help="骨の高さと区間を出して終わる")
    a = ap.parse_args()
    js, binc = glb.load(a.inp)
    try:
        if a.probe:
            print(json.dumps(probe(js, binc), ensure_ascii=False))
            return
        if a.out is None:
            ap.error("out が要る(--probe のときは要らない)")
        rep = body_shape(js, binc, {k: getattr(a, k) for k in RANGES})
    except ValueError as e:
        print(f"止めた: {e}", file=sys.stderr)
        sys.exit(2)
    glb.save(a.out, js, binc)
    print(json.dumps(rep, ensure_ascii=False))


if __name__ == "__main__":
    main()
