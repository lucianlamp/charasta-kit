"""SOMA の動きを VRM 1.0 の humanoid の骨に移し替えて、VRMA（glTF バイナリ + VRMC_vrm_animation）を書く。

numpy だけを使う（MotionBricks の環境でも、ふだんの Python でも動く）。移し替えの方式は docs/adr/0003-motionbricks-retarget.md。

- SOMA の静止姿勢（soma_base_skel_minimal_no_root.usd）は T ポーズで、Y が上、前が +Z、左が +X、単位はメートル。
  VRM 1.0 の T ポーズと同じ向きなので、座標の入れ替えは要らない。
- 各骨について、静止姿勢からのワールドの回転の差 D = W(t) * W_rest^-1 を求める。VRM の正規化した骨は T ポーズで
  ワールドの回転が単位なので、VRM の骨のワールドの回転は D そのもの。ローカルの回転は D_親^-1 * D_子。
- VRMA の骨の節点は回転なしの T ポーズ（位置は SOMA の静止姿勢）。three-vrm-animation は hips の高さの比で移動を縮める。
"""

from __future__ import annotations

import json
import struct

import numpy as np

# VRM の骨 -> (SOMA の関節, VRM の親の骨)。きゃらくるの VRM に無い upperChest は使わない（無い骨に回転を書くと、
# その回転が抜けて上半身の向きがずれる）。chest に Chest のワールドの向きを入れ、Spine2 の曲がりは chest に含める。
# Neck2 の曲がりは head に含める。指は MotionBricks が動かさないので書かない。
BONES = [
    ("hips", "Hips", None),
    ("spine", "Spine1", "hips"),
    ("chest", "Chest", "spine"),
    ("neck", "Neck1", "chest"),
    ("head", "Head", "neck"),
    ("leftShoulder", "LeftShoulder", "chest"),
    ("leftUpperArm", "LeftArm", "leftShoulder"),
    ("leftLowerArm", "LeftForeArm", "leftUpperArm"),
    ("leftHand", "LeftHand", "leftLowerArm"),
    ("rightShoulder", "RightShoulder", "chest"),
    ("rightUpperArm", "RightArm", "rightShoulder"),
    ("rightLowerArm", "RightForeArm", "rightUpperArm"),
    ("rightHand", "RightHand", "rightLowerArm"),
    ("leftUpperLeg", "LeftLeg", "hips"),
    ("leftLowerLeg", "LeftShin", "leftUpperLeg"),
    ("leftFoot", "LeftFoot", "leftLowerLeg"),
    ("leftToes", "LeftToeBase", "leftFoot"),
    ("rightUpperLeg", "RightLeg", "hips"),
    ("rightLowerLeg", "RightShin", "rightUpperLeg"),
    ("rightFoot", "RightFoot", "rightLowerLeg"),
    ("rightToes", "RightToeBase", "rightFoot"),
]


# ---- 四元数（x, y, z, w）。配列の最後の軸が 4 ----
def qmul(a, b):
    ax, ay, az, aw = np.moveaxis(a, -1, 0)
    bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ], axis=-1)


def qinv(q):
    return q * np.array([-1.0, -1.0, -1.0, 1.0])


def qrot(q, v):
    """四元数 q でベクトル v を回す。"""
    u = np.zeros(v.shape[:-1] + (4,))
    u[..., :3] = v
    return qmul(qmul(q, u), qinv(q))[..., :3]


def qyaw(angle):
    """Y 軸まわりの回転。"""
    return np.array([0.0, np.sin(angle / 2), 0.0, np.cos(angle / 2)])


def qnormalize(q):
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def forward_kinematics(parents, local):
    """local: [..., J, 7]（位置 xyz と回転 xyzw、親から見た値）。返すのはワールドの位置 [..., J, 3] と回転 [..., J, 4]。"""
    pos = np.zeros(local.shape[:-1] + (3,))
    rot = np.zeros(local.shape[:-1] + (4,))
    for j, p in enumerate(parents):
        lp, lq = local[..., j, :3], qnormalize(local[..., j, 3:])
        if p < 0:
            pos[..., j, :], rot[..., j, :] = lp, lq
        else:
            pos[..., j, :] = pos[..., p, :] + qrot(rot[..., p, :], lp)
            rot[..., j, :] = qmul(rot[..., p, :], lq)
    return pos, rot


def continuous(q):
    """隣のコマと同じ半球にそろえる（線形の補間で遠回りしないように）。q: [F, 4]"""
    q = q.copy()
    for i in range(1, len(q)):
        if np.dot(q[i], q[i - 1]) < 0:
            q[i] = -q[i]
    return q


def smooth_track(x, window):
    """コマの軸 0 に沿った移動平均。端は端の点で点対称に折り返して延ばす（一定の速さの移動は端まで残らず引ける）。"""
    window = min(window | 1, 2 * (len(x) - 1) + 1)   # 奇数にして、真ん中のコマにそろえる
    if window <= 1:
        return x.copy()
    pad, post = window // 2, window - 1 - window // 2
    head = 2 * x[0] - x[pad:0:-1]
    tail = 2 * x[-1] - x[-2:-2 - post:-1]
    padded = np.concatenate([head, x, tail], 0)
    kernel = np.ones(window) / window
    return np.stack([np.convolve(padded[:, k], kernel, mode="valid") for k in range(x.shape[1])], 1)


def retarget(joint_names, parents, rest_local, frames_local, fps, root_motion="keep", align=True):
    """SOMA の動き（Y が上の SOMA の空間）を VRM の骨の動きにする。

    rest_local: [J, 7] 静止姿勢（T ポーズ）。frames_local: [F, J, 7]。
    root_motion: keep は進んだ分をそのまま残す。inplace は 1 秒の移動平均の道筋を引いて、その場で動く形にする。
    返すのは {rest: {骨: 位置}, rotations: {骨: [F, 4]}, hips: [F, 3], fps}。
    align が真なら、最初のコマで体が +Z を向き、hips の真下が原点に来るように、全体を Y 軸まわりに回して動かす。
    偽なら入力の位置と向きのまま返す（tools/compose がつなぎの区間に使う）。
    """
    index = {n: i for i, n in enumerate(joint_names)}
    missing = [s for _, s, _ in BONES if s not in index]
    if missing:
        raise ValueError("SOMA の関節が足りない: " + ", ".join(missing))
    rest_pos, rest_rot = forward_kinematics(parents, rest_local)
    pos, rot = forward_kinematics(parents, frames_local)
    ids = [index[s] for _, s, _ in BONES]
    # 静止姿勢からのワールドの回転の差 D = W(t) * W_rest^-1
    delta = qmul(rot[:, ids, :], qinv(rest_rot[ids, :])[None])
    hips = pos[:, index["Hips"], :].copy()

    if align:
        # 最初のコマの体の前（hips の差 D で +Z を回した向きの水平成分）を +Z にそろえる
        fwd = qrot(delta[0, 0], np.array([0.0, 0.0, 1.0]))
        turn = qyaw(-np.arctan2(fwd[0], fwd[2]))
        delta = qmul(np.broadcast_to(turn, delta.shape), delta)
        hips = qrot(np.broadcast_to(turn, hips.shape[:-1] + (4,)), hips)
        hips[:, [0, 2]] -= hips[0, [0, 2]]
    if root_motion == "inplace":
        hips[:, [0, 2]] -= smooth_track(hips[:, [0, 2]], max(1, int(round(fps))))
    elif root_motion != "keep":
        raise ValueError("root_motion は keep か inplace: " + str(root_motion))

    names = [b for b, _, _ in BONES]
    rotations = {}
    for k, (bone, _, parent) in enumerate(BONES):
        q = delta[:, k] if parent is None else qmul(qinv(delta[:, names.index(parent)]), delta[:, k])
        rotations[bone] = continuous(qnormalize(q))
    rest = {bone: rest_pos[index[s]] for bone, s, _ in BONES}
    return {"rest": rest, "rotations": rotations, "hips": hips, "fps": fps}


def write_vrma(path, motion, generator="charasta motionbricks_gen"):
    """retarget() の結果を VRMA（glb）に書く。motion["bones"] があれば、BONES の代わりにその骨の表を使う（指も書くとき）。"""
    table = motion.get("bones", BONES)
    names = [b for b, _, _ in table]
    parent_of = {b: p for b, _, p in table}
    rest = motion["rest"]
    frames = len(motion["hips"])
    times = np.arange(frames, dtype=np.float32) / np.float32(motion["fps"])

    nodes = []
    for b in names:
        p = parent_of[b]
        t = rest[b] if p is None else rest[b] - rest[p]
        nodes.append({"name": b, "translation": [float(v) for v in t]})
    for i, b in enumerate(names):
        kids = [j for j, c in enumerate(names) if parent_of[c] == b]
        if kids:
            nodes[i]["children"] = kids

    blob = bytearray()
    views, accessors = [], []

    def add(array, kind, minmax=False):
        data = np.ascontiguousarray(array, dtype=np.float32)
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": data.nbytes})
        blob.extend(data.tobytes())
        acc = {"bufferView": len(views) - 1, "componentType": 5126, "count": int(data.shape[0]), "type": kind}
        if minmax:
            acc["min"] = [float(v) for v in np.atleast_1d(data.min(0))]
            acc["max"] = [float(v) for v in np.atleast_1d(data.max(0))]
        accessors.append(acc)
        return len(accessors) - 1

    time_acc = add(times, "SCALAR", minmax=True)
    samplers, channels = [], []
    for i, b in enumerate(names):
        samplers.append({"input": time_acc, "output": add(motion["rotations"][b], "VEC4"), "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": i, "path": "rotation"}})
    samplers.append({"input": time_acc, "output": add(motion["hips"], "VEC3"), "interpolation": "LINEAR"})
    channels.append({"sampler": len(samplers) - 1, "target": {"node": 0, "path": "translation"}})
    while len(blob) % 4:
        blob.append(0)

    gltf = {
        "asset": {"version": "2.0", "generator": generator},
        "extensionsUsed": ["VRMC_vrm_animation"],
        "extensions": {"VRMC_vrm_animation": {"specVersion": "1.0",
                                              "humanoid": {"humanBones": {b: {"node": i} for i, b in enumerate(names)}}}},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": nodes,
        "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accessors,
        "animations": [{"name": "motion", "samplers": samplers, "channels": channels}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode("utf8")
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))
    return {"frames": frames, "durationSec": float(times[-1]) if frames else 0.0}
