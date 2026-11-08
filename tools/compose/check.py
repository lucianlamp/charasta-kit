"""つないだ動きを数値で確かめる。REST の体で組み立てて測る（キャラに当てた値は tools/motion_shots.mjs で別に測る）。numpy だけを使う。

- 継ぎ目の跳び: 継ぎ目の前後 2 コマの関節の速さの最大と、1 コマの速さの変化の最大。比べる値として、継ぎ目から離れたコマの 99 パーセンタイルを出す。
- 足の滑り: 接地のコマの、足首と爪先の遅い方の水平の速さ。
- hips の高さ: 区間ごとの最小と最大。
- 手が体に入るコマ: 手首か肘が、hips から首の軸の水平の距離 9 cm 以内に入ったコマの数。距離の測り方は motion_shots.mjs の handInBody と同じだが、
  あちらは手首と肘を別々に数えるので、値は同じにならない。
"""

from __future__ import annotations

import numpy as np

import clip as C

WATCH = ["leftHand", "rightHand", "leftLowerArm", "rightLowerArm", "leftFoot", "rightFoot", "leftToes", "rightToes", "head", "hips"]


def speeds(pos):
    """関節ごとの 1 コマの速さ [F-1, 関節]（m/s）。"""
    return np.stack([np.linalg.norm(np.diff(pos[b], axis=0), axis=1) for b in WATCH], 1) * C.FPS


def seam_report(pos, seams):
    v = speeds(pos)
    far = np.ones(len(v), bool)
    for s in seams:
        far[max(0, s - 6):s + 6] = False
    base = v[far] if far.any() else v
    dv = np.abs(np.diff(v, axis=0))
    base_dv = dv[far[1:]] if far[1:].any() else dv
    out = {"elsewhereP99": {"speedMps": round(float(np.percentile(base.max(1), 99)), 2), "speedChangeMps": round(float(np.percentile(base_dv.max(1), 99)), 2)}, "seams": []}
    for s in seams:
        lo, hi = max(0, s - 3), min(len(v), s + 2)
        w = v[lo:hi]
        j = np.unravel_index(int(np.argmax(w)), w.shape)
        out["seams"].append({"frame": int(s), "speedMaxMps": round(float(w.max()), 2), "joint": WATCH[j[1]],
                             "speedChangeMaxMps": round(float(dv[max(0, lo - 1):hi].max()), 2)})
    return out


def foot_slide(m, pos, spans):
    """接地のコマの足の水平の速さ（cm/s）。全体と区間ごと。"""
    speed = {}
    for k, (a, b) in enumerate(C.FEET):
        va = np.linalg.norm(np.diff(pos[a][:, [0, 2]], axis=0), axis=1)
        vb = np.linalg.norm(np.diff(pos[b][:, [0, 2]], axis=0), axis=1)
        speed[k] = np.minimum(va, vb) * C.FPS * 100
    cont = m["contacts"] > 0.5
    on = {k: (cont[:, k * 2] | cont[:, k * 2 + 1]) for k in (0, 1)}

    def stats(lo, hi):
        vals = np.concatenate([speed[k][lo:hi - 1][on[k][lo:hi - 1] & on[k][lo + 1:hi]] for k in (0, 1)])
        if not len(vals):
            return {"contactFrames": 0, "meanCmPerSec": 0.0, "p95CmPerSec": 0.0}
        return {"contactFrames": len(vals), "meanCmPerSec": round(float(vals.mean()), 2), "p95CmPerSec": round(float(np.percentile(vals, 95)), 2)}

    return {"all": stats(0, C.frames(m)), "spans": [{"label": s["label"], **stats(s["start"], s["end"])} for s in spans]}


def hand_in_body(pos):
    a, b = pos["hips"], pos["neck"]
    d = b - a
    count = np.zeros(len(a), bool)
    for bone in ("leftHand", "rightHand", "leftLowerArm", "rightLowerArm"):
        p = pos[bone]
        u = np.clip(np.sum((p - a) * d, 1) / np.sum(d * d, 1), 0, 1)[:, None]
        near = a + d * u - p
        hit = (p[:, 1] > a[:, 1] - 0.05) & (p[:, 1] < b[:, 1]) & (np.hypot(near[:, 0], near[:, 2]) < 0.09)
        count |= hit
    return count


def report(m, seams, spans):
    """spans: [{"label", "start", "end"}]（end は含まない）。"""
    pos = C.joints(m)
    hit = hand_in_body(pos)
    return {
        "frames": C.frames(m), "seconds": round(C.frames(m) / C.FPS, 2), **seam_report(pos, seams), "footSlide": foot_slide(m, pos, spans),
        "hipsHeight": [{"label": s["label"], "minM": round(float(m["hips"][s["start"]:s["end"], 1].min()), 3), "maxM": round(float(m["hips"][s["start"]:s["end"], 1].max()), 3)} for s in spans],
        "handInBody": {"frames": int(hit.sum()), "spans": [{"label": s["label"], "frames": int(hit[s["start"]:s["end"]].sum())} for s in spans]},
    }
