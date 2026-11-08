"""武器の物理の確かめ: 刃先と重心の速さ、角速度、地面と体の衝突、握りの滑り、手首の可動域。

武器は持つ手に固定の剛体として測るので、持つ手の回転と位置だけで姿勢が決まる。grip の動きも武器を主にした動きも同じ関数で測れる。
世界の高さは three-vrm の再生と同じにする: hips は REST の体の値にキャラの hips の高さの比をかけ、ほかの骨は hips からの差をキャラの体の長さで足す。
体はカプセル（骨の線分と半径）。半径は VRM の T ポーズのメッシュの、その骨が支配的な重みの頂点までの距離の 90 パーセンタイル。揺れものの骨の頂点は入れない。腕は入れない。
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

import clip as C
import grip as Grip
from soma_vrma import qinv, qmul, qrot

CAPSULES = {"torsoLow": ("hips", "spine"), "torsoMid": ("spine", "chest"), "torsoHigh": ("chest", "neck"), "head": ("neck", "head"),
            "leftThigh": ("leftUpperLeg", "leftLowerLeg"), "leftShin": ("leftLowerLeg", "leftFoot"), "leftFoot": ("leftFoot", "leftToes"),
            "rightThigh": ("rightUpperLeg", "rightLowerLeg"), "rightShin": ("rightLowerLeg", "rightFoot"), "rightFoot": ("rightFoot", "rightToes")}
GROUP = {"torsoLow": "body", "torsoMid": "body", "torsoHigh": "body", "head": "head", "leftThigh": "legs", "leftShin": "legs", "leftFoot": "legs", "rightThigh": "legs", "rightShin": "legs", "rightFoot": "legs"}
MESH_BONES = {"torsoLow": ["hips"], "torsoMid": ["spine"], "torsoHigh": ["chest", "upperChest"], "head": ["head", "neck"], "leftThigh": ["leftUpperLeg"], "leftShin": ["leftLowerLeg"], "leftFoot": ["leftFoot", "leftToes"],
              "rightThigh": ["rightUpperLeg"], "rightShin": ["rightLowerLeg"], "rightFoot": ["rightFoot", "rightToes"]}
DEFAULT_RADIUS = 0.08       # メッシュの無い VRM の半径
DEFAULT_HEAD_TOP = 0.15     # 同じく、頭の骨から頭の上までの長さ
SWEEP = (0.25, 0.5, 0.75)   # コマの間を見る位置


def vrm_vertices(path):
    """VRM の T ポーズのメッシュの頂点を、支配的な重みの人型の骨ごとに返す。座標は vrm_rest と同じ（Y が上、前が +Z）。"""
    buf = Path(path).read_bytes()
    length = struct.unpack_from("<I", buf, 12)[0]
    js = json.loads(buf[20:20 + length])
    ext = js.get("extensions", {})
    if "VRMC_vrm" in ext:
        bones = {k: v["node"] for k, v in ext["VRMC_vrm"]["humanoid"]["humanBones"].items()}
        turn = np.array([1.0, 1.0, 1.0])
    else:
        bones = {b["bone"]: b["node"] for b in ext["VRM"]["humanoid"]["humanBones"]}
        turn = np.array([-1.0, 1.0, -1.0])
    start = 20 + length + 8

    def accessor(i):
        a = js["accessors"][i]
        view = js["bufferViews"][a["bufferView"]]
        kind = {5126: "<f4", 5123: "<u2", 5121: "u1", 5125: "<u4"}[a["componentType"]]
        count = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
        at = start + view.get("byteOffset", 0) + a.get("byteOffset", 0)
        size = np.dtype(kind).itemsize * count
        stride = view.get("byteStride") or size
        if stride == size:
            return np.frombuffer(buf, kind, a["count"] * count, at).reshape(-1, count).astype(np.float64)
        return np.stack([np.frombuffer(buf, kind, count, at + k * stride) for k in range(a["count"])]).astype(np.float64)

    names = {v: k for k, v in bones.items()}
    verts = {}
    for node in js["nodes"]:
        if "mesh" not in node or "skin" not in node:
            continue
        joints = js["skins"][node["skin"]]["joints"]
        for part in js["meshes"][node["mesh"]]["primitives"]:
            pos, index, weight = (accessor(part["attributes"][k]) for k in ("POSITION", "JOINTS_0", "WEIGHTS_0"))
            main = index[np.arange(len(index)), weight.argmax(1)].astype(int)
            for j in np.unique(main):
                if joints[j] in names:
                    verts.setdefault(names[joints[j]], []).append(pos[main == j] * turn)
    return {k: np.concatenate(v) for k, v in verts.items()}


def segment_distance(p, a, b):
    d = b - a
    u = np.clip(np.sum((p - a) * d, -1) / np.maximum(np.sum(d * d, -1), 1e-9), 0, 1)
    return np.linalg.norm(a + d * u[..., None] - p, axis=-1), a + d * u[..., None]


def body_radii(path, rest):
    """カプセルの半径 {カプセル: m} と、頭の骨から頭の上までの長さ headTop。"""
    verts = vrm_vertices(path)
    top = float(np.percentile(verts["head"][:, 1], 98) - rest["head"][1]) if "head" in verts else DEFAULT_HEAD_TOP
    out = {"headTop": top}
    for k, (a, b) in CAPSULES.items():
        have = [verts[n] for n in MESH_BONES[k] if n in verts]
        end = rest[b] + ([0, top, 0] if k == "head" else 0)
        out[k] = float(np.percentile(segment_distance(np.concatenate(have), rest[a], end)[0], 90)) if have else DEFAULT_RADIUS
    return out


def world_joints(m, rest):
    """three-vrm の再生と同じ世界の骨の位置。"""
    pos = C.joints(m, rest)
    move = m["hips"] * (rest["hips"][1] / C.HIPS_HEIGHT - 1)
    return {k: v + move for k, v in pos.items()}


def capsules(j, radii):
    """[(グループ, 端 a [F, 3], 端 b [F, 3], 半径)]。頭は head の骨からその向きと関わりなく真上へ延ばす。"""
    out = []
    for k, (a, b) in CAPSULES.items():
        out.append((GROUP[k], j[a], j[b] + ([0, radii["headTop"], 0] if k == "head" else 0), radii[k]))
    return out


def weapon_rotation(m, weapon):
    """武器の座標から世界への回転 W [F, 4]。持つ手の回転 D = W * 握り。"""
    return qmul(C.world_deltas(m)[weapon["hold"] + "Hand"], np.broadcast_to(qinv(weapon["hand"][weapon["hold"]]), (C.frames(m), 4)))


def weapon_points(W, wrist, points, weapon, scale):
    """武器の座標の点 [P, 3] の世界の位置 [F, P, 3]。wrist は持つ手の手首 [F, 3]。"""
    offset = (points - weapon["wrist"][weapon["hold"]]) * scale
    return np.stack([wrist + qrot(W, np.broadcast_to(o, (len(W), 3))) for o in offset], 1)


def angle_steps(W):
    """コマの間の回転の角度（度）[F-1]。"""
    return np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(W[1:] * W[:-1], -1)), 0, 1)))


def collisions(pts, parts):
    """コマごとの一番深い入り方（m、0 は当たらない）{グループ: [F]}。"""
    deep = {g: np.zeros(len(pts)) for g in ("body", "legs", "head")}
    for group, a, b, r in parts:
        deep[group] = np.maximum(deep[group], r - segment_distance(pts, a[:, None], b[:, None])[0].min(1))
    return deep


def report(m, weapon, rest, radii, limit=Grip.BEND_LIMIT):
    """m（中間形式、REST の hips）を rest の体に当てて測る。limit は手首の折れの可動域（度）。"""
    n = C.frames(m)
    scale = body_scale(weapon, rest)
    hold, free = weapon["hold"], Grip.OTHER[weapon["hold"]]
    W = weapon_rotation(m, weapon)
    j = world_joints(m, rest)
    wrist = j[hold + "Hand"]
    tip, com = weapon_points(W, wrist, np.array([[weapon["lengthM"], 0, 0], weapon["centerOfMassM"]]), weapon, scale).transpose(1, 0, 2)
    pts = weapon_points(W, wrist, weapon["points"], weapon, scale)
    parts = capsules(j, radii)
    deep = collisions(pts, parts)
    low = pts[:, :, 1].min(1)
    steps = angle_steps(W)
    v_tip = np.diff(tip, axis=0) * C.FPS
    acc = np.linalg.norm(np.diff(v_tip, axis=0), axis=1) * C.FPS
    jerk = np.linalg.norm(np.diff(tip, 3, axis=0), axis=1) * C.FPS ** 3
    # コマの間: 武器は回転の球面補間、体は線形
    swept = {"body": np.zeros(n - 1, bool), "legs": np.zeros(n - 1, bool), "head": np.zeros(n - 1, bool), "ground": np.zeros(n - 1, bool)}
    for u in SWEEP:
        mid = weapon_points(C.slerp(W[:-1], W[1:], np.full((n - 1, 1), u)), wrist[:-1] * (1 - u) + wrist[1:] * u, weapon["points"], weapon, scale)
        swept["ground"] |= mid[:, :, 1].min(1) < 0
        between = [(g, a[:-1] * (1 - u) + a[1:] * u, b[:-1] * (1 - u) + b[1:] * u, r) for g, a, b, r in parts]
        for g, d in collisions(mid, between).items():
            swept[g] |= d > 0
    want = wrist + qrot(W, np.broadcast_to((weapon["wrist"][free] - weapon["wrist"][hold]) * scale, (n, 3)))
    slip = np.linalg.norm(j[free + "Hand"] - want, axis=1) * 100
    d = C.world_deltas(m)
    rom = {}
    for s in Grip.OTHER:
        axis = np.broadcast_to(Grip.arm_axes(s, rest)[1], (n, 3))
        bend = np.degrees(Grip.swing_twist(qmul(qinv(d[s + "LowerArm"]), d[s + "Hand"]), axis)[1])
        rom[s] = {"wristBendDegMax": round(float(bend.max()), 1), "framesOver": int((bend > limit).sum())}
    hit = {g: {"frames": int((x > 0).sum()), "depthCm": round(float(x.max() * 100), 1)} for g, x in deep.items()}
    return {"frames": n, "rotationStepDegMax": round(float(steps.max()), 1), "angularSpeedDegPerSecMax": round(float(steps.max() * C.FPS)),
            "tipSpeedMpsMax": round(float(np.linalg.norm(v_tip, axis=1).max()), 1), "centerOfMassSpeedMpsMax": round(float(np.linalg.norm(np.diff(com, axis=0), axis=1).max() * C.FPS), 1),
            "tipAccelMps2Max": round(float(acc.max())), "tipJerkMps3Rms": round(float(np.sqrt((jerk ** 2).mean()))),
            "ground": {"frames": int((low < 0).sum()), "depthCm": round(float(max(0, -low.min()) * 100), 1)}, **hit,
            "sweptSteps": {k: int(v.sum()) for k, v in swept.items()}, "gripSlipCm": {"max": round(float(slip.max()), 2), "median": round(float(np.median(slip)), 2)}, "wrist": rom}


def body_scale(weapon, rest):
    """武器の単位からこの体の m への比。武器の長さは定義の lengthPerBodyHeight（hips から爪先までの高さの倍数）に保たれる。"""
    return float((rest["hips"][1] - rest["leftToes"][1]) / weapon["bodyHeightM"])
