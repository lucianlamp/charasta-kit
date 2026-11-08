"""VRMA の足を、対象の VRM の体の上で地面に付ける（焼き込み。体ごとに結果が違う）。

  python plant_feet.py in.vrma model.vrm out.vrma [--contacts corrected_initial_contacts.npz] [--contacts-json out.json] [--report r.json]

素の再生（vrma_playback）で VRM の正規化した骨に FK し、足ごとに vrma-pipeline の footlock を使う。
  - アンカーは爪先。接地の区間ごとに中央値の位置へ止め、いちばん低い足裏を床に合わせ、区間の外は余弦で戻す。
  - 脚は 2 ボーン IK（足首の世界回転を保つ）。届かないところは腰を滑らかに下げる。
接地の区間は RGB MoCap の接地補正（corrected_*_contacts.npz の segments。足 0 = 左、1 = 右、[開始, 終了)）。無ければ footlock.detect で対象の体から検出する。
床は接地中の足裏の高さの中央値。書き換えるのは upperLeg / lowerLeg / foot の回転と hips の位置だけ。
"""
import argparse
import json
from pathlib import Path

import numpy as np

import vrma_env


def smooth(x, k):
    if k <= 1:
        return x
    w = np.hanning(k + 2)[1:-1]
    w /= w.sum()
    pad = k // 2
    return np.convolve(np.pad(x, (pad, pad), mode="edge"), w, mode="valid")[: len(x)]


def contact_masks(segments, T):
    """RGB MoCap の segments 行（足, 開始, 終了, ...）から、足ごとの接地コマの真偽（長さ T）。足 0 = 左、1 = 右。終了は含まない。長さ 0 の区間は 1 コマ。"""
    masks = {}
    for k, s in enumerate(("left", "right")):
        m = np.zeros(T, bool)
        for row in segments:
            if int(row[0]) == k:
                st, en = int(round(row[1])), int(round(row[2]))
                m[st:min(max(en, st + 1), T)] = True
        masks[s] = m
    return masks


def contacts_json(masks, T, fps=30):
    """compose の contacts.json と同じ形（leftHeel, leftToe, rightHeel, rightToe）。"""
    frames = []
    for f in range(T):
        row = []
        for s in ("left", "right"):
            c = float(masks[s][f])
            row += [c, c]
        frames.append(row)
    return {"fps": fps, "order": ["leftHeel", "leftToe", "rightHeel", "rightToe"], "frames": frames}


def plant_feet(vrma, vrm, out, contacts=None, contacts_out=None, ramp=4, max_drop=0.08, min_len=4, smooth_k=7):
    from scipy.spatial.transform import Rotation as R
    VP, FL = vrma_env.load()
    js, binc0 = VP.read_glb(vrma)
    binc = bytearray(binc0)
    clip = VP.load_clip(vrma)
    heads = VP.load_model(vrm)
    P = VP.play(clip, heads)
    T = len(clip["times"])
    fps = (T - 1) / (clip["times"][-1] - clip["times"][0])
    scale = heads["hips"][1] / clip["rest_hips_y"]
    have = set(heads)

    G = {}   # 正規化した骨の世界回転
    for b in VP.ORDER:
        if b not in have:
            continue
        q = R.from_quat(clip["rot"][b]) if b in clip["rot"] else R.identity(T)
        p = VP._humanoid_parent(b, have)
        G[b] = q if p is None else G[p] * q

    sole, masks = {}, {}
    for s in ("left", "right"):
        sole[s] = np.minimum(P[f"{s}Toes"][:, 1] - heads[f"{s}Toes"][1], P[f"{s}Foot"][:, 1] - heads[f"{s}Foot"][1])
    if contacts:
        masks = contact_masks(np.load(contacts)["segments"], T)
        src = "exmr"
    else:
        fl0 = min(np.percentile(sole[s], 2) for s in sole)
        for s in sole:
            masks[s], _ = FL.detect(sole[s] - fl0, P[f"{s}Toes"], fps, 1, {**FL.DEFAULTS, "height": 0.04, "speed": 0.35})
        src = "detect"
    for s in masks:
        masks[s] = FL.clean_mask(masks[s], min_len, 2)
    allc = np.concatenate([sole[s][masks[s]] for s in sole])
    floor = float(np.median(allc)) if len(allc) else float(min(np.percentile(sole[s], 2) for s in sole))
    for s in sole:
        sole[s] = sole[s] - floor
    deltas = {}
    for s in sole:
        d = FL.lock_deltas(P[f"{s}Toes"], sole[s], masks[s], 1, ramp, True)
        d = np.stack([smooth(d[:, k], smooth_k) for k in range(3)], 1)
        d[:, 1] = np.maximum(d[:, 1], -sole[s])   # 平滑のあとも床より下に行かない
        deltas[s] = d
    # ロックした足首が届かないところで腰を下げる（retarget_to_vrma と同じ）
    drop = np.zeros(T)
    for s in sole:
        hip, ank = P[f"{s}UpperLeg"], P[f"{s}Foot"]
        tgt = ank + deltas[s]
        Rr = 0.995 * 0.999 * (np.linalg.norm(heads[f"{s}LowerLeg"] - heads[f"{s}UpperLeg"]) + np.linalg.norm(heads[f"{s}Foot"] - heads[f"{s}LowerLeg"]))
        dh = np.linalg.norm((tgt - hip)[:, [0, 2]], axis=1)
        need = (hip[:, 1] - tgt[:, 1]) - np.sqrt(np.maximum(Rr ** 2 - dh ** 2, 0.0))
        drop = np.maximum(drop, np.where(np.linalg.norm(deltas[s], axis=1) > 1e-9, need, 0.0))
    drop = np.clip(drop, 0.0, max_drop)
    if drop.max() > 0:
        ds = drop.copy()
        for _ in range(3):
            ds = np.maximum(smooth(ds, 9), drop)
        drop = smooth(ds, 5)
    shift = -floor - drop   # hips の世界 Y に足す量。定数分が床合わせ、残りが IK と腰の下げ
    for b in P:
        P[b] = P[b] + np.c_[np.zeros(T), shift, np.zeros(T)]
    stats = {}
    newG = dict(G)
    for s in sole:
        s2 = sole[s] - drop
        # 膝の向き: 元の膝の向きを、脚が伸びるにつれて解剖学的な前向きへ混ぜる（切り替えない）
        hip, knee, ank = P[f"{s}UpperLeg"], P[f"{s}LowerLeg"], P[f"{s}Foot"]
        dirv = (ank - hip) / np.linalg.norm(ank - hip, axis=1)[:, None]
        pk = (knee - hip) - np.sum((knee - hip) * dirv, 1)[:, None] * dirv
        l1 = np.linalg.norm(knee - hip, axis=1)
        hint = G[f"{s}UpperLeg"].apply([0.0, 0.0, 1.0])
        hint = hint - np.sum(hint * dirv, 1)[:, None] * dirv
        hint /= np.maximum(np.linalg.norm(hint, axis=1), 1e-9)[:, None]
        pkn = pk / np.maximum(np.linalg.norm(pk, axis=1), 1e-9)[:, None]
        wgt = np.clip((np.linalg.norm(pk, axis=1) / l1 - 0.03) / 0.12, 0, 1)[:, None]
        pole = wgt * pkn + (1 - wgt) * hint
        pole = l1[:, None] * pole / np.maximum(np.linalg.norm(pole, axis=1), 1e-9)[:, None]
        d = deltas[s].copy()
        d[:, 1] = np.maximum(d[:, 1], -s2)   # 腰を下げたあとも足裏は床の上
        act = np.linalg.norm(d, axis=1) > 1e-9
        dR1 = np.repeat(np.eye(3)[None], T, 0)
        dR2 = dR1.copy()
        resid = np.zeros(T)
        if act.any():
            r1, r2, _k, _r, res = FL.two_bone_ik(P[f"{s}UpperLeg"][act], P[f"{s}LowerLeg"][act], P[f"{s}Foot"][act],
                                                P[f"{s}Foot"][act] + d[act], 0.995, pole[act])
            dR1[act], dR2[act], resid[act] = r1, r2, res
        newG[f"{s}UpperLeg"] = R.from_matrix(dR1) * G[f"{s}UpperLeg"]
        newG[f"{s}LowerLeg"] = R.from_matrix(dR2) * G[f"{s}LowerLeg"]
        stats[s] = {"contact_runs": len(FL.segments(masks[s])), "frames_adjusted": int(act.sum()),
                    "delta_max_m": round(float(np.linalg.norm(d, axis=1).max()), 4), "ik_residual_max_m": round(float(resid.max()), 4)}

    # 骨ごとのローカル回転へ戻す
    ext = js["extensions"]["VRMC_vrm_animation"]
    hb = {b: v["node"] for b, v in ext["humanoid"]["humanBones"].items() if b in VP.PARENT}
    w, parent = VP.world_mats(js)
    anim = js["animations"][0]
    chan = {}
    for ch in anim["channels"]:
        n = ch["target"].get("node")
        chan[(n, ch["target"]["path"])] = anim["samplers"][ch["sampler"]]["output"]
    hvrma = set(hb)

    def rotm(M):
        return R.from_matrix(M[:3, :3] / np.linalg.norm(M[:3, :3], axis=0))

    for s in ("left", "right"):
        for b in (f"{s}UpperLeg", f"{s}LowerLeg", f"{s}Foot"):
            pb = VP._humanoid_parent(b, have)
            qn = newG[pb].inv() * newG[b]
            pv = VP._humanoid_parent(b, hvrma)
            Wp = w(hb[pv]) if pv else np.eye(4)
            ql = (rotm(Wp).inv() * qn * rotm(w(hb[b]))).as_quat()
            i = chan[(hb[b], "rotation")]
            old = VP.accessor(js, binc0, i)
            assert len(old) == T, (b, len(old), T)
            ql[np.sum(ql * old, 1) < 0] *= -1
            vrma_env.put_accessor(js, binc, i, ql)
    i = chan[(hb["hips"], "translation")]
    ht = VP.accessor(js, binc0, i)
    hp = w(parent[hb["hips"]]) if hb["hips"] in parent else np.eye(4)
    dworld = np.c_[np.zeros(T), shift / scale, np.zeros(T)]
    ht = ht + (np.linalg.inv(hp[:3, :3]) @ dworld.T).T
    vrma_env.put_accessor(js, binc, i, ht)
    vrma_env.write_glb(out, js, binc)
    if contacts_out:
        Path(contacts_out).write_text(json.dumps(contacts_json(masks, T)))
    return {"contacts": src, "floor_m": round(floor, 4), "drop_max_m": round(float(drop.max()), 4), "legs": stats,
            "contact_frames": {s: int(masks[s].sum()) for s in masks}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("vrma")
    ap.add_argument("vrm")
    ap.add_argument("out")
    ap.add_argument("--contacts")
    ap.add_argument("--contacts-json")
    ap.add_argument("--report")
    a = ap.parse_args()
    rep = plant_feet(a.vrma, a.vrm, a.out, a.contacts, a.contacts_json)
    print(json.dumps(rep))
    if a.report:
        Path(a.report).write_text(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
