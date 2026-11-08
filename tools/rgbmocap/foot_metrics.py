"""VRMA を VRM の上で素の再生（vrma_playback）したときの足の指標。exmr.json に補正の前後を残すのに使う（audit の足の部分だけ）。

  浮き: 低いほうの足裏の高さ。floatFrames は両足が 3cm 以上浮いたコマ。
  滑り: 接地中の爪先の水平の速さ。接地は contacts（RGB MoCap の contacts.npz の segments。開始の次のコマから）があればそれ、無ければ床から 3cm 未満が連続する爪先と足首。
"""
import numpy as np

import vrma_env


def foot_metrics(vrma, vrm, float_height=0.03, contact_height=0.03, frames=None, contacts=None):
    VP, _ = vrma_env.load()
    clip = VP.load_clip(vrma)
    heads = VP.load_model(vrm)
    P = VP.play(clip, heads)
    if frames:   # (開始, 終了) のコマだけを測る
        P = {b: v[frames[0]:frames[1]] for b, v in P.items()}
        clip = {**clip, "times": clip["times"][frames[0]:frames[1]]}
    T = len(clip["times"])
    fps = (T - 1) / (clip["times"][-1] - clip["times"][0])
    low, slide = {}, []
    for s in ("left", "right"):
        low[s] = np.min([P[f"{s}{b}"][:, 1] - heads[f"{s}{b}"][1] for b in ("Toes", "Foot")], 0)
    lmin = np.minimum(low["left"], low["right"])
    floor = float(np.percentile(lmin, 2))
    seg = np.load(contacts)["segments"] if contacts else None
    for k, s in enumerate(("left", "right")):
        for b in ("Toes",) if seg is not None else ("Toes", "Foot"):
            v = np.r_[0, np.linalg.norm(np.diff(P[f"{s}{b}"][:, [0, 2]], axis=0), axis=1) * fps]
            if seg is not None:
                c = np.zeros(T, bool)
                for row in seg:
                    if int(row[0]) == k:
                        c[int(row[1]) + 1:min(int(row[2]), T)] = True
            else:
                c = P[f"{s}{b}"][:, 1] - heads[f"{s}{b}"][1] - floor < contact_height
                c[1:] &= c[:-1].copy()
            slide.append(v[c] * 100)
    slide = np.concatenate(slide)
    return {"frames": T, "floatMedianCm": round(float(np.median(lmin)) * 100, 2),
            "floatFrames": int((lmin > float_height).sum()),
            "slideMeanCmPerSec": round(float(slide.mean()), 2) if len(slide) else 0.0,
            "slideBasis": "contacts" if seg is not None else "height"}
