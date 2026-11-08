"""VRMA の指の形を MediaPipe Hand Landmarker(hands.npz)と比べる指標。exmr.json に手の補正の前後を残すのに使う。

手ごと、4 本の指ごとに、手のひらの座標(hand_shape_fix と同じ。n は PIP が曲がる側を正にそろえる)で
  mcp = 近位指節の手のひらの面からの仰角(手のひら側が正)、spr = 中指に対する外転(人差し指、薬指、小指)、thumb = 親指の近位指節と人差し指の近位指節の角。
score 0.8 以上のコマで、アバターと MediaPipe の差の絶対値の平均(度)を返す。mcp は 4 本、spr は 3 本の平均。
"""
import numpy as np

import vrma_env
from hand_shape_fix import FING, MIN_SCORE, MPI4, load_rig, unit


def _ang(a, b):
    return np.degrees(np.arccos(np.clip(np.sum(unit(a) * unit(b), -1), -1, 1)))


def avatar_joints(rig, side):
    """アバターの 21 点(MediaPipe の並び)。手首、親指 1 から 4、指ごとの付け根、PIP、DIP、先。"""
    G, P, heads = rig["G"], rig["P"], rig["heads"]
    J = np.zeros((rig["T"], 21, 3))
    J[:, 0] = P[f"{side}Hand"]
    tb = [f"{side}Thumb{j}" for j in FING["Thumb"]]
    J[:, 1], J[:, 2], J[:, 3] = P[tb[0]], P[tb[1]], P[tb[2]]
    J[:, 4] = P[tb[2]] + G[tb[2]].apply(heads[tb[2]] - heads[tb[1]])
    for fn, (a, b, c, d) in MPI4.items():
        bs = [f"{side}{fn}{j}" for j in FING[fn]]
        J[:, a], J[:, b], J[:, c] = P[bs[0]], P[bs[1]], P[bs[2]]
        J[:, d] = P[bs[2]] + G[bs[2]].apply(heads[bs[2]] - heads[bs[1]])
    return J


def shape(J, palm_sign=None):
    """(指標の辞書, 手のひら側の符号)。"""
    f = unit(J[:, 9] - J[:, 0])
    a = J[:, 5] - J[:, 17]
    a = unit(a - np.sum(a * f, -1, keepdims=True) * f)
    n = unit(np.cross(f, a))
    if palm_sign is None:
        s = np.median(np.stack([np.sum((unit(J[:, i2] - J[:, i1]) - unit(J[:, i1] - J[:, i0])) * n, -1) for (i0, i1, i2, _) in MPI4.values()]), 0)
        palm_sign = 1.0 if np.median(s[np.abs(s) > 0.1]) > 0 else -1.0
    n = n * palm_sign
    dmid = unit(J[:, 10] - J[:, 9])
    out = {}
    for fn, (i0, i1, _, _) in MPI4.items():
        d0 = unit(J[:, i1] - J[:, i0])
        out[fn + "_mcp"] = np.degrees(np.arcsin(np.clip(np.sum(d0 * n, -1), -1, 1)))
        if fn != "Middle":
            out[fn + "_spr"] = np.degrees(np.arcsin(np.clip(np.sum(d0 * a, -1), -1, 1))) - np.degrees(np.arcsin(np.clip(np.sum(dmid * a, -1), -1, 1)))
    out["thumb"] = _ang(J[:, 3] - J[:, 2], J[:, 6] - J[:, 5])
    return out, palm_sign


def hand_metrics(vrma, vrm, hands_npz, mp_side=(0, 1)):
    """{left|right: {confidentFrames, mcpErrDeg, spreadErrDeg, thumbErrDeg}}。"""
    rig = load_rig(vrma, vrm)
    H = np.load(hands_npz)
    T = rig["T"]
    res = {}
    for si, side in enumerate(("left", "right")):
        s = mp_side[si]
        ok = H["detected"][:T, s] & (H["score"][:T, s] >= MIN_SCORE)
        mp, _ = shape(np.nan_to_num(H["world"][:T, s].astype(float)))
        av, _ = shape(avatar_joints(rig, side))
        err = lambda keys: float(np.mean([np.abs(av[k][ok] - mp[k][ok]).mean() for k in keys])) if ok.any() else 0.0   # noqa: E731
        res[side] = {"confidentFrames": int(ok.sum()),
                     "mcpErrDeg": round(err([f + "_mcp" for f in MPI4]), 1),
                     "spreadErrDeg": round(err([f + "_spr" for f in ("Index", "Ring", "Little")]), 1),
                     "thumbErrDeg": round(err(["thumb"]), 1)}
    return res
