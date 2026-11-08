"""VRMA（glb）を読んで中間形式にする。節点に静止姿勢の回転があってもよい（Blender の VRM アドオンが書く VRMA）。

three-vrm-animation の createVRMAnimationClip と同じ考え方で、骨ごとに静止姿勢からのワールドの回転の差を求める。
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

import clip as C
from soma_vrma import continuous, qinv, qmul, qnormalize, qrot

WIDTH = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}


def parse(path):
    buf = Path(path).read_bytes()
    if buf[:4] != b"glTF":
        raise ValueError("VRMA（glb）ではない: " + str(path))
    length = struct.unpack_from("<I", buf, 12)[0]
    js = json.loads(buf[20:20 + length])
    blob = buf[20 + length + 8:]

    def read(i):
        a = js["accessors"][i]
        v = js["bufferViews"][a["bufferView"]]
        if a["componentType"] != 5126:
            raise ValueError("float でないトラックは読めない")
        w = WIDTH[a["type"]]
        start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        return np.frombuffer(blob, np.float32, a["count"] * w, start).astype(np.float64).reshape(a["count"], w)
    return js, read


def on_times(t, values, times):
    """トラック (t, values) を時刻 times の値にする（線形）。"""
    if len(t) == len(times) and np.allclose(t, times):
        return values
    if len(t) == 1:
        return np.repeat(values, len(times), 0)
    i = np.clip(np.searchsorted(t, times, side="right") - 1, 0, len(t) - 2)
    u = np.clip((times - t[i]) / np.maximum(t[i + 1] - t[i], 1e-9), 0, 1)[:, None]
    return values[i] * (1 - u) + values[i + 1] * u


def read_vrma(path):
    js, read = parse(path)
    nodes = js["nodes"]
    bones = {b: v["node"] for b, v in js["extensions"]["VRMC_vrm_animation"]["humanoid"]["humanBones"].items()}
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    anim = js["animations"][0]
    hips_node = bones["hips"]
    tracks, hips_track, times = {}, None, None
    for ch in anim["channels"]:
        s = anim["samplers"][ch["sampler"]]
        node, kind = ch["target"]["node"], ch["target"]["path"]
        if s.get("interpolation", "LINEAR") != "LINEAR":
            raise ValueError("線形でないトラックは読めない: " + s["interpolation"])
        t = read(s["input"])[:, 0]
        if times is None or len(t) > len(times):
            times = t
        if kind == "rotation":
            tracks[node] = (t, read(s["output"]))
        elif kind == "translation" and node == hips_node:
            hips_track = (t, read(s["output"]))
    if hips_track is None:
        raise ValueError("hips の位置のトラックが無い: " + str(path))
    n = len(times)

    # 静止姿勢と毎コマのワールドの回転・位置を、親から順に求める
    rest_rot, rest_pos, world_rot, world_pos = {}, {}, {}, {}

    def build(i):
        if i in rest_rot:
            return
        nd = nodes[i]
        t = np.array(nd.get("translation", (0, 0, 0)), dtype=np.float64)
        q = np.array(nd.get("rotation", (0, 0, 0, 1)), dtype=np.float64)
        local = qnormalize(on_times(tracks[i][0], continuous(tracks[i][1]), times)) if i in tracks else np.tile(q, (n, 1))
        p = parent.get(i)
        if p is None:
            rest_rot[i], rest_pos[i], world_rot[i], world_pos[i] = q, t, local, np.tile(t, (n, 1))
            return
        build(p)
        rest_rot[i], rest_pos[i] = qmul(rest_rot[p], q), rest_pos[p] + qrot(rest_rot[p], t)
        world_rot[i] = qmul(world_rot[p], local)
        world_pos[i] = world_pos[p] + qrot(world_rot[p], np.tile(t, (n, 1)))

    for i in range(len(nodes)):
        build(i)

    deltas = {b: qnormalize(qmul(world_rot[i], qinv(rest_rot[i])[None])) for b, i in bones.items() if b in C.PARENT or b == "upperChest"}
    p = parent.get(hips_node)
    t = on_times(*hips_track, times)
    hips = t if p is None else world_pos[p] + qrot(world_rot[p], t)
    hips = hips * (C.HIPS_HEIGHT / rest_pos[hips_node][1])
    rot, h = C.resample(times, deltas, hips)
    return C.from_world_deltas(rot, h)
