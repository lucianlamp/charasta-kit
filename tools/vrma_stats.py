"""VRMA（glTF バイナリ）の動きを数で出す。歩く動きが実際に進んでいるかを、hips の移動と足の回転で確かめるのに使う（numpy だけ）。

    python tools/vrma_stats.py motion.vrma     # JSON を標準出力へ

出力: frames、fps、durationSec、hipsPathM（hips の水平の道のり）、hipsStraightM（最初から最後までの水平の直線距離）、hipsY（高さの最小と最大）、
maxAngleDeg（骨ごとの、単位の回転からの最大の角度。VRMA の静止姿勢は回転なしの T ポーズなので、上腕や太ももの動いた大きさになる）、
legSwingDeg（左右の太ももの回転軸ごとの振れ幅の大きい方。歩くと前後に振れる）。
"""
from __future__ import annotations

import json
import struct
import sys

import numpy as np


def read_glb(path):
    buf = open(path, "rb").read()
    magic, _, _ = struct.unpack_from("<4sII", buf, 0)
    if magic != b"glTF":
        raise ValueError("glb ではない")
    off, js, blob = 12, None, b""
    while off < len(buf):
        n, kind = struct.unpack_from("<II", buf, off)
        data = buf[off + 8:off + 8 + n]
        if kind == 0x4E4F534A:
            js = json.loads(data)
        elif kind == 0x004E4942:
            blob = data
        off += 8 + n + (-n) % 4
    return js, blob


def accessor(js, blob, i):
    a = js["accessors"][i]
    v = js["bufferViews"][a["bufferView"]]
    width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[a["type"]]
    start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
    return np.frombuffer(blob, dtype="<f4", count=a["count"] * width, offset=start).reshape(a["count"], width).astype(np.float64)


def angle_deg(q):
    """単位の回転 [..., xyzw] からの角度（度）。"""
    w = np.clip(np.abs(q[..., 3]), 0.0, 1.0)
    return np.degrees(2 * np.arccos(w))


def stats(path):
    js, blob = read_glb(path)
    anim = js["animations"][0]
    nodes = js["nodes"]
    bones = {b["node"]: name for name, b in js["extensions"]["VRMC_vrm_animation"]["humanoid"]["humanBones"].items()}
    rot, trans, times = {}, None, None
    for ch in anim["channels"]:
        s = anim["samplers"][ch["sampler"]]
        times = accessor(js, blob, s["input"])[:, 0]
        out = accessor(js, blob, s["output"])
        bone = bones.get(ch["target"]["node"], nodes[ch["target"]["node"]].get("name"))
        if ch["target"]["path"] == "rotation":
            rot[bone] = out
        elif ch["target"]["path"] == "translation" and bone == "hips":
            trans = out
    n = len(times)
    fps = (n - 1) / float(times[-1] - times[0]) if n > 1 else 0.0
    xz = trans[:, [0, 2]]
    result = {
        "frames": int(n), "fps": round(fps, 2), "durationSec": round(float(times[-1]), 3),
        "hipsPathM": round(float(np.linalg.norm(np.diff(xz, axis=0), axis=1).sum()), 3),
        "hipsStraightM": round(float(np.linalg.norm(xz[-1] - xz[0])), 3),
        "hipsY": [round(float(trans[:, 1].min()), 3), round(float(trans[:, 1].max()), 3)],
        "maxAngleDeg": {b: round(float(angle_deg(q).max()), 1) for b, q in sorted(rot.items())},
    }
    swing = []
    for b in ("leftUpperLeg", "rightUpperLeg"):
        if b in rot:
            q = rot[b]
            swing.append(float(np.max(np.ptp(q[:, :3] / np.maximum(q[:, 3:4], 1e-6) * 2.0, axis=0)) * 180 / np.pi / 1.0))
    result["legSwingDeg"] = round(max(swing), 1) if swing else 0.0
    return result


if __name__ == "__main__":
    print(json.dumps(stats(sys.argv[1]), ensure_ascii=False))
