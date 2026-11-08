"""VRMA の指の形を、MediaPipe Hand Landmarker の手(vrma-pipeline の Stage A の hands.npz)に寄せる(手の補正 v3)。

  python hand_shape_fix.py in.vrma model.vrm hands.npz out.vrma [--report r.json]

理由: ExMR(SMPL-X の関節)は、指を 30 度近く開き、親指を人差し指から 60 度ほど離し、指の付け根(MCP)の曲げも
MediaPipe と違う。retarget は BVH の指を忠実に写すので、ずれは ExMR から来る。

やること(対象の VRM の正規化した骨で、手ごと、コマごと):
  - 手のひらの座標: fwd = 手首から中指の付け根、across = 小指の付け根から人差し指の付け根(直交化)、n = fwd x across。
  - 開き: 人差し指、薬指、小指の近位指節を、中指に対する外転(fwd と n の面からの角)が MediaPipe に合うように回す。閉じる方向だけで、ExMR の値を越えない。
  - MCP の曲げ: 4 本とも、近位指節の手のひらの面からの仰角(across まわり)を MediaPipe に合わせる。1 コマの変化は 30 度まで。
  - 指全体の曲がりの上限(v3): MediaPipe と ExMR は指を違う関節で折る。MCP だけを合わせると、折れている指を伸ばしてしまう。
    MCP の補正は、指全体の曲がり(手のひら側の MCP + PIP + DIP)を MediaPipe の全体の曲がりへ向かって動かす範囲に限り、越えない。
  - 親指: 補正後の人差し指との角が MediaPipe に合うように、親指の中手骨を回す(10 度より閉じず、ExMR の値を越えない)。
目標は、score 0.8 以上で、手のひらが潰れていない(三角形の比 0.18 から 0.36)MediaPipe のコマ。穴は 15 コマまで補間し、
それより外は ExMR の値 x 0.5(MCP は ExMR の値のまま)。補正量は sigma 1 のガウスで滑らかにする。PIP と DIP は直さない。
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d, median_filter
from scipy.spatial.transform import Rotation as R

import vrma_env

FING = {"Thumb": ["Metacarpal", "Proximal", "Distal"], "Index": ["Proximal", "Intermediate", "Distal"],
        "Middle": ["Proximal", "Intermediate", "Distal"], "Ring": ["Proximal", "Intermediate", "Distal"],
        "Little": ["Proximal", "Intermediate", "Distal"]}
F4 = ("Index", "Middle", "Ring", "Little")
MPI4 = {"Index": (5, 6, 7, 8), "Middle": (9, 10, 11, 12), "Ring": (13, 14, 15, 16), "Little": (17, 18, 19, 20)}
# 既定(ILLIT で確かめた v3 の設定)
MIN_SCORE, FALLBACK, SIGMA, SIGMA_ELEV, ELEV_CAP = 0.8, 0.5, 3.0, 4.0, 30.0
PALM_GATE, TARGET_MEDIAN, CORR_SIGMA = (0.18, 0.36), 5, 1.0


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def palm(W, Ib, Mb, Lb):
    f = unit(Mb - W)
    a = Ib - Lb
    a = unit(a - np.sum(a * f, -1, keepdims=True) * f)
    return f, a, unit(np.cross(f, a))


def abd(d, a):
    """外転: fwd と n の面からの符号つきの角(人差し指の側が正)。曲げた指でも小さいままで、手のひらの面内の方位角のように暴れない。"""
    return np.degrees(np.arcsin(np.clip(np.sum(d * a, -1), -1, 1)))


def inplane(d, f, a):
    return np.degrees(np.arctan2(np.sum(d * a, -1), np.sum(d * f, -1)))


def elev(d, n):
    return np.degrees(np.arcsin(np.clip(np.sum(d * n, -1), -1, 1)))


def angle(a, b):
    return np.degrees(np.arccos(np.clip(np.sum(unit(a) * unit(b), -1), -1, 1)))


def limit_curl(dE, dTot, psign):
    """MCP の補正 dE(度、n 方向の符号つき)を、指全体の曲がりの目標までの差 dTot(手のひら側が正)を越えない範囲に切る。
    曲がりが増える方向なら 0 から dTot まで、減る方向なら dTot から 0 まで。"""
    dP = np.clip(psign * np.asarray(dE, float), np.minimum(0, dTot), np.maximum(0, dTot))
    return psign * dP


def palm_ratio(W):
    """手首、人差し指の付け根、小指の付け根の三角形の面積を (手首から中指の付け根)^2 で割った値。MediaPipe の world が手のひらを潰すと 0.1 を切る。"""
    return 0.5 * np.linalg.norm(np.cross(W[:, 5] - W[:, 0], W[:, 17] - W[:, 0]), axis=-1) / np.maximum(
        np.sum((W[:, 9] - W[:, 0]) ** 2, -1), 1e-12)


def mp_targets(W, ok):
    """MediaPipe の手(world のランドマーク (T,21,3))のコマごとの目標と、使えるコマの真偽。"""
    f, a, n = palm(W[:, 0], W[:, 5], W[:, 9], W[:, 17])
    d = {k: unit(W[:, v[1]] - W[:, v[0]]) for k, v in MPI4.items()}
    d["Thumb"] = unit(W[:, 3] - W[:, 2])
    t = {}
    for k in ("Index", "Ring", "Little"):
        t[k + "_abd"] = abd(d[k], a) - abd(d["Middle"], a)
    t["Thumb"] = angle(d["Thumb"], d["Index"])
    for k in F4:
        t[k + "_abs"] = elev(d[k], n)
    for k, (i0, i1, i2, i3) in MPI4.items():
        e0, e1, e2 = unit(W[:, i1] - W[:, i0]), unit(W[:, i2] - W[:, i1]), unit(W[:, i3] - W[:, i2])
        t[k + "_pipdip"] = angle(e0, e1) + angle(e1, e2)
    mid = inplane(d["Middle"], f, a)
    ratio = palm_ratio(W)
    plaus = (ok & np.isfinite(t["Thumb"]) & (np.abs(inplane(d["Index"], f, a) - mid) < 45) & (np.abs(inplane(d["Little"], f, a) - mid) < 60)
             & (ratio >= PALM_GATE[0]) & (ratio <= PALM_GATE[1]))
    idx = np.where(plaus)[0]
    if TARGET_MEDIAN > 1 and len(idx):
        for k in list(t):
            v = t[k].copy()
            v[idx] = median_filter(v[idx], size=TARGET_MEDIAN, mode="nearest")
            t[k] = v
    return t, plaus


def fill(target, valid, fallback_vals, maxgap=15):
    """使えるコマの値で、15 コマまでの穴は補間し、それより外は fallback_vals で埋める。(値, fallback になったコマの真偽)。"""
    T = len(target)
    out = np.where(valid, target, np.nan)
    idx = np.where(valid)[0]
    if len(idx):
        interp = np.interp(np.arange(T), idx, target[idx])
        dist = np.min(np.abs(np.arange(T)[:, None] - idx[None, :]), 1)
        use = ~valid & (dist <= maxgap)
        out[use] = interp[use]
    miss = np.isnan(out)
    out[miss] = fallback_vals[miss]
    return out, miss


def load_rig(vrma, vrm):
    """VRMA の骨ごとの正規化した回転を VRM の骨の位置で FK し、書き戻しに使う道具と一緒に返す(hand_metrics も使う)。"""
    VP, _ = vrma_env.load()
    js, binc = VP.read_glb(vrma)
    ext = js["extensions"]["VRMC_vrm_animation"]
    hba = {b: v["node"] for b, v in ext["humanoid"]["humanBones"].items()}
    nb = {v: k for k, v in hba.items()}
    wa, parent = VP.world_mats(js)
    anim = js["animations"][0]

    def rm(M):
        return R.from_matrix(M[:3, :3] / np.linalg.norm(M[:3, :3], axis=0))
    rot, acc = {}, {}
    for ch in anim["channels"]:
        n = ch["target"].get("node")
        if n in nb and ch["target"]["path"] == "rotation":
            s = anim["samplers"][ch["sampler"]]
            q = VP.accessor(js, binc, s["output"])
            Wp = wa(parent[n]) if n in parent else np.eye(4)
            rot[nb[n]] = rm(Wp) * R.from_quat(q) * rm(wa(n)).inv()
            acc[nb[n]] = s["output"]
    T = len(next(iter(rot.values())))
    mj, _ = VP.read_glb(vrm)
    mhb = mj["extensions"]["VRMC_vrm"]["humanoid"]["humanBones"]
    mw, _ = VP.world_mats(mj)
    heads = {b: mw(v["node"])[:3, 3].copy() for b, v in mhb.items()}
    PAR = dict(VP.PARENT)
    for side in ("left", "right"):
        for fn, js_ in FING.items():
            prev = f"{side}Hand"
            for j in js_:
                PAR[f"{side}{fn}{j}"] = prev
                prev = f"{side}{fn}{j}"

    def par(b):
        p = PAR.get(b)
        while p is not None and p not in heads:
            p = PAR.get(p)
        return p
    G, P = {}, {}
    for b in [b for b in PAR if b in heads]:
        q = rot.get(b, R.identity(T))
        p = par(b)
        if p is None:
            G[b], P[b] = q, np.zeros((T, 3))
        else:
            G[b] = G[p] * q
            P[b] = P[p] + G[p].apply(heads[b] - heads[p])
    return dict(VP=VP, js=js, binc=binc, hba=hba, wa=wa, parent=parent, rm=rm, acc=acc, T=T, heads=heads, par=par, G=G, P=P)


def fix_hands(vrma, vrm, hands_npz, out, mp_side=(0, 1)):
    """手の補正 v3 を VRMA にかけて out に書く。手ごとの中央値などの報告を返す。"""
    r = load_rig(vrma, vrm)
    VP, js, binc, hba, wa, parent, rm, acc, T, heads, par, G, P = (r[k] for k in (
        "VP", "js", "binc", "hba", "wa", "parent", "rm", "acc", "T", "heads", "par", "G", "P"))
    H = np.load(hands_npz)
    report, newG = {}, dict(G)
    for si, side in enumerate(("left", "right")):
        s = mp_side[si]
        ok = H["detected"][:T, s] & (H["score"][:T, s] >= MIN_SCORE)
        tmp, plaus = mp_targets(np.nan_to_num(H["world"][:T, s].astype(float)), ok)
        base = {fn: P[f"{side}{fn}{FING[fn][0]}"] for fn in FING}
        f, ac, n = palm(P[f"{side}Hand"], base["Index"], base["Middle"], base["Little"])
        d = {fn: unit(P[f"{side}{fn}{FING[fn][1]}"] - base[fn]) for fn in FING}
        d["Thumb"] = unit(P[f"{side}ThumbDistal"] - P[f"{side}ThumbProximal"])
        # アバターの PIP + DIP と、n のどちら側が手のひら側か
        pipdip, bends = {}, []
        for fn in F4:
            bp, bi, bd = (f"{side}{fn}{j}" for j in FING[fn])
            e0, e1 = unit(P[bi] - P[bp]), unit(P[bd] - P[bi])
            e2 = unit(G[bd].apply(heads[bd] - heads[bi]))
            pipdip[fn] = angle(e0, e1) + angle(e1, e2)
            bends.append(np.sum((e1 - e0) * n, -1))
        bends = np.median(np.stack(bends), 0)
        psign = 1.0 if np.median(bends[np.abs(bends) > 0.05]) > 0 else -1.0
        rep = {"mp_frames": int(plaus.sum()), "palm_sign": psign}
        for fn in F4:
            b = f"{side}{fn}Proximal"
            rotn = R.identity(T)
            if fn != "Middle":
                cur = abd(d[fn], ac) - abd(d["Middle"], ac)
                tgt, miss = fill(tmp[fn + "_abd"], plaus, cur * FALLBACK)
                tgt = gaussian_filter1d(tgt, SIGMA)
                tgt = np.sign(cur) * np.clip(np.abs(tgt) * (np.sign(tgt) == np.sign(cur)), 0, np.abs(cur))   # 閉じる方向だけ
                rotn = R.from_rotvec(unit(np.cross(d[fn], ac)) * np.radians(tgt - cur)[:, None])
                rep[fn] = {"cur_med": round(float(np.median(cur)), 1), "target_med": round(float(np.median(tgt)), 1), "fallback_frames": int(miss.sum())}
            curE = elev(rotn.apply(d[fn]), n)
            tgtE, _ = fill(tmp[fn + "_abs"], plaus, curE)
            dE = np.clip(gaussian_filter1d(tgtE, SIGMA_ELEV) - curE, -ELEV_CAP, ELEV_CAP)
            curTot = psign * curE + pipdip[fn]
            tgtTot, _ = fill(psign * tmp[fn + "_abs"] + tmp[fn + "_pipdip"], plaus, curTot)
            dE2 = limit_curl(dE, gaussian_filter1d(tgtTot, SIGMA_ELEV) - curTot, psign)
            rep[fn + "_curl_limited_frames"] = int(np.sum(np.abs(dE2 - dE) > 2))
            newG[b] = R.from_rotvec(-ac * np.radians(dE2)[:, None]) * rotn * G[b]
            rep[fn + "_abs"] = {"cur_med": round(float(np.median(curE)), 1), "target_med": round(float(np.median(curE + dE2)), 1)}
        # 親指: 補正後の人差し指に対して
        b, bi = f"{side}ThumbMetacarpal", f"{side}IndexProximal"
        dI = (newG[bi] * G[bi].inv()).apply(d["Index"])
        curT = angle(d["Thumb"], dI)
        tgtT, missT = fill(tmp["Thumb"], plaus, 10 + (curT - 10) * FALLBACK)
        tgtT = np.clip(gaussian_filter1d(tgtT, SIGMA), 10, curT)
        newG[b] = R.from_rotvec(unit(np.cross(d["Thumb"], dI)) * np.radians(curT - tgtT)[:, None]) * G[b]
        rep["Thumb"] = {"cur_med": round(float(np.median(curT)), 1), "target_med": round(float(np.median(tgtT)), 1), "fallback_frames": int(missT.sum())}
        report[side] = rep
    # 変えた骨だけ、補正を手の座標で時間方向に滑らかにしてローカル回転へ戻す(子はローカル回転のまま付いてくる)
    changed = [f"{s}{fn}Proximal" for s in ("left", "right") for fn in F4] + [f"{s}ThumbMetacarpal" for s in ("left", "right")]
    blob = bytearray(binc)
    for b in changed:
        Gh = G[par(b)]
        corr = gaussian_filter1d((Gh.inv() * newG[b] * G[b].inv() * Gh).as_rotvec(), CORR_SIGMA, axis=0)
        local_norm = R.from_rotvec(corr) * (Gh.inv() * G[b])
        n_ = hba[b]
        Wp = wa(parent[n_]) if n_ in parent else np.eye(4)
        ql = (rm(Wp).inv() * local_norm * rm(wa(n_))).as_quat()
        old = VP.accessor(js, binc, acc[b])
        ql[np.sum(ql * old, 1) < 0] *= -1
        vrma_env.put_accessor(js, blob, acc[b], ql)
    vrma_env.write_glb(out, js, blob)
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("vrma")
    ap.add_argument("vrm")
    ap.add_argument("hands")
    ap.add_argument("out")
    ap.add_argument("--report")
    a = ap.parse_args()
    rep = fix_hands(a.vrma, a.vrm, a.hands, a.out)
    print(json.dumps(rep))
    if a.report:
        Path(a.report).write_text(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
