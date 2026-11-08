"""モーションをつなぐ道具の中間形式。どの素材もこの形にそろえてから扱う。numpy だけを使う。

形は tools/soma_vrma.py の retarget() が返す辞書に、接地と指を足したもの:
    {"rest": {骨: 位置}, "rotations": {骨: [F, 4]}, "hips": [F, 3], "fps": 30, "contacts": [F, 4]（無ければ None）, "bones": 骨の表}

- 骨は VRM 1.0 の正規化した骨。回転は親の骨から見たローカルで、T ポーズで単位。親子は soma_vrma.BONES と FINGERS。
- upperChest は持たない。素材にあれば、その向きを chest に入れる（ADR 0003 と同じ。首と肩の向きが保たれる）。
- hips は REST の体（SOMA、hips の高さ 1.0121 m）のメートル。three-vrm-animation がキャラの hips の高さとの比で縮める。
- contacts の並びは docs/foot-ik.md と同じ（左かかと・左爪先・右かかと・右爪先の信頼度 0〜1）。
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from soma_vrma import BONES, continuous, qinv, qmul, qnormalize, qrot, qyaw, smooth_track  # noqa: E402

FPS = 30
HIPS_HEIGHT = 1.0121
# REST の体の、体の骨の T ポーズの位置（MotionBricks の SOMA の reference_local_transforms から出した値）
REST = {
    "hips": (0, 1.0121, 0), "spine": (0, 1.0634, -0.0001), "chest": (0, 1.2077, -0.0082), "neck": (0, 1.4712, -0.0092), "head": (0, 1.6101, 0.0336),
    "leftShoulder": (0.0161, 1.4418, 0.0413), "leftUpperArm": (0.1638, 1.4418, -0.0131), "leftLowerArm": (0.453, 1.4418, -0.0131), "leftHand": (0.7233, 1.4418, -0.0131),
    "rightShoulder": (-0.0161, 1.4418, 0.0413), "rightUpperArm": (-0.1638, 1.4418, -0.0131), "rightLowerArm": (-0.453, 1.4418, -0.0131), "rightHand": (-0.7233, 1.4418, -0.0131),
    "leftUpperLeg": (0.1001, 0.9293, 0.0224), "leftLowerLeg": (0.1001, 0.4963, 0.0224), "leftFoot": (0.1001, 0.072, 0.0224), "leftToes": (0.1001, 0.0216, 0.1544),
    "rightUpperLeg": (-0.1001, 0.9293, 0.0224), "rightLowerLeg": (-0.1001, 0.4963, 0.0224), "rightFoot": (-0.1001, 0.072, 0.0224), "rightToes": (-0.1001, 0.0216, 0.1544),
}
REST = {k: np.array(v, dtype=np.float64) for k, v in REST.items()}
FINGER_JOINTS = {"Thumb": ("Metacarpal", "Proximal", "Distal"), "Index": ("Proximal", "Intermediate", "Distal"), "Middle": ("Proximal", "Intermediate", "Distal"),
                 "Ring": ("Proximal", "Intermediate", "Distal"), "Little": ("Proximal", "Intermediate", "Distal")}
FINGER_BASE = {"Thumb": (0.02, -0.01, 0.03), "Index": (0.08, 0, 0.03), "Middle": (0.085, 0, 0.0), "Ring": (0.08, 0, -0.02), "Little": (0.07, 0, -0.04)}


def _fingers():
    """指の骨 [(骨, None, 親)] と T ポーズの位置。VRMA の指の位置は再生に使われないので、向きが分かる程度の値でよい。"""
    bones, rest = [], {}
    for side, sign in (("left", 1.0), ("right", -1.0)):
        for finger, joints_ in FINGER_JOINTS.items():
            parent = side + "Hand"
            at = REST[parent] + np.array(FINGER_BASE[finger]) * [sign, 1, 1]
            step = np.array((0.02, 0, 0.02) if finger == "Thumb" else (0.03, 0, 0)) * [sign, 1, 1]
            for j in joints_:
                bone = f"{side}{finger}{j}"
                bones.append((bone, None, parent))
                rest[bone] = at.copy()
                parent, at = bone, at + step
    return bones, rest


FINGERS, _finger_rest = _fingers()
REST.update(_finger_rest)
ALL_BONES = BONES + FINGERS
PARENT = {b: p for b, _, p in ALL_BONES}
ORDER = [b for b, _, _ in ALL_BONES]        # 親が先
FINGER_NAMES = [b for b, _, _ in FINGERS]
IDENTITY = np.array([0.0, 0.0, 0.0, 1.0])
CONTACT_ORDER = ["leftHeel", "leftToe", "rightHeel", "rightToe"]
FEET = (("leftFoot", "leftToes"), ("rightFoot", "rightToes"))


def make(rotations, hips, contacts=None):
    """足りない骨は単位の回転で埋めて、中間形式の辞書を作る。"""
    hips = np.asarray(hips, dtype=np.float64)
    full = {b: continuous(qnormalize(np.asarray(rotations[b], dtype=np.float64))) if b in rotations else np.tile(IDENTITY, (len(hips), 1)) for b in ORDER}
    return {"rest": REST, "rotations": full, "hips": hips, "fps": FPS, "bones": ALL_BONES,
            "contacts": None if contacts is None else np.asarray(contacts, dtype=np.float64)}


def frames(m):
    return len(m["hips"])


def save(path, m):
    arrays = {"hips": m["hips"], **{"rot_" + b: q for b, q in m["rotations"].items()}}
    if m["contacts"] is not None:
        arrays["contacts"] = m["contacts"]
    np.savez_compressed(path, **arrays)


def load(path):
    with np.load(path) as z:
        rot = {k[4:]: z[k] for k in z.files if k.startswith("rot_")}
        return make(rot, z["hips"], z["contacts"] if "contacts" in z.files else None)


def world_deltas(m):
    """骨ごとの、T ポーズからのワールドの回転の差 D。VRM の正規化した骨のワールドの回転そのもの。"""
    d = {}
    for b in ORDER:
        p = PARENT[b]
        d[b] = m["rotations"][b] if p is None else qmul(d[p], m["rotations"][b])
    return d


def from_world_deltas(deltas, hips, contacts=None):
    """D から中間形式を作る。upperChest があれば chest に入れ、無い骨は親の向きに従わせる。"""
    deltas = dict(deltas)
    if "upperChest" in deltas:
        deltas["chest"] = deltas.pop("upperChest")
    full = {}
    for b in ORDER:
        if b in deltas:
            full[b] = deltas[b]
        else:
            full[b] = full[PARENT[b]]
    rot = {b: full[b] if PARENT[b] is None else qmul(qinv(full[PARENT[b]]), full[b]) for b in ORDER}
    return make(rot, hips, contacts)


def joints(m, rest=REST):
    """rest の体（既定は REST）で組み立てた、骨のワールドの位置 {骨: [F, 3]}。"""
    pos, d = {}, world_deltas(m)
    for b in ORDER:
        p = PARENT[b]
        pos[b] = m["hips"] if p is None else pos[p] + qrot(d[p], np.broadcast_to(rest[b] - rest[p], (frames(m), 3)))
    return pos


def slerp(a, b, u):
    """同じ形の四元数 a から b への補間。u は 0〜1（形は [..., 1]）。"""
    a, b, u = np.asarray(a), np.asarray(b), np.asarray(u, dtype=np.float64)
    dot = np.sum(a * b, -1, keepdims=True)
    b = np.where(dot < 0, -b, b)
    angle = np.arccos(np.clip(np.abs(dot), 0, 1))
    near = angle < 1e-5
    s = np.where(near, 1.0, np.sin(angle))
    wa = np.where(near, 1 - u, np.sin((1 - u) * angle) / s)
    wb = np.where(near, u, np.sin(u * angle) / s)
    return qnormalize(wa * a + wb * b)


def resample(times, rotations, hips, fps=FPS, extra=None):
    """時刻 times（秒）のコマを fps の等間隔に直す。回転は隣のコマの球面補間、位置は線形。extra があれば同じ時刻へ線形に直して 3 つ目に返す。"""
    times = np.asarray(times, dtype=np.float64)
    times = times - times[0]
    n = int(np.floor(times[-1] * fps + 1e-3)) + 1   # VRMA の時刻は float32
    at = np.arange(n) / fps
    i = np.clip(np.searchsorted(times, at, side="right") - 1, 0, len(times) - 2)
    u = ((at - times[i]) / np.maximum(times[i + 1] - times[i], 1e-9))[:, None]
    rot = {}
    for b, q in rotations.items():
        q = continuous(q)
        rot[b] = slerp(q[i], q[i + 1], u)
    if extra is not None:
        return rot, hips[i] * (1 - u) + hips[i + 1] * u, extra[i] * (1 - u) + extra[i + 1] * u
    return rot, hips[i] * (1 - u) + hips[i + 1] * u


def trim_span(m, start=0.0, end=None):
    """start〜end 秒のコマの範囲 (a, b)。b は含まない。"""
    a = int(round(start * m["fps"]))
    b = frames(m) if end is None else min(frames(m), int(round(end * m["fps"])) + 1)
    if b - a < 2:
        raise ValueError(f"切り出した区間が短すぎる: {start}〜{end} 秒")
    return a, b


def trim(m, start=0.0, end=None):
    """start〜end 秒を切り出す。"""
    a, b = trim_span(m, start, end)
    return make({k: v[a:b] for k, v in m["rotations"].items()}, m["hips"][a:b], None if m["contacts"] is None else m["contacts"][a:b])


def retime(m, speed):
    """再生の速さを変える（0.5 で 2 倍の長さ）。"""
    times = np.arange(frames(m)) / (m["fps"] * speed)
    rot, h = resample(times, m["rotations"], m["hips"], m["fps"])
    return make(rot, h, None if m["contacts"] is None else stretch(m["contacts"], speed, m["fps"]))


def stretch(track, speed, fps=FPS):
    """retime と同じ時刻へ、コマごとの値 [F, n] を線形に直す。"""
    times = np.arange(len(track)) / (fps * speed)
    at = np.arange(int(np.floor(times[-1] * fps + 1e-3)) + 1) / fps
    return np.stack([np.interp(at, times, track[:, k]) for k in range(track.shape[1])], 1)


def ground(m):
    """足の裏が床に来るように hips の高さを一定の量だけずらす。低い側の 3 パーセンタイルを床とする。"""
    pos = joints(m)
    low = np.min([pos[b][:, 1] - REST[b][1] for pair in FEET for b in pair], axis=0)
    return make(m["rotations"], m["hips"] - [0, np.percentile(low, 3), 0], m["contacts"])


# 足の高さと速さからの接地の判定。docs/foot-ik.md の height の判定の値を、脚の長さ 0.6 m から REST の体（0.85 m）へ比で延ばした
LEG_SCALE = 0.85 / 0.6
HEIGHT_ON, SPEED_ON, FLOOR_MAX = 0.02 * LEG_SCALE, 0.35 * LEG_SCALE, 0.06 * LEG_SCALE


def estimate_contacts(m):
    """接地が無い素材の接地を、足の高さと速さから推定する。信頼度は 0 か 1。"""
    pos = joints(m)
    out = np.zeros((frames(m), 4))
    for k, bone in enumerate(b for pair in FEET for b in pair):
        h = pos[bone][:, 1] - REST[bone][1]
        speed = np.linalg.norm(np.gradient(pos[bone][:, [0, 2]], axis=0), axis=1) * m["fps"]
        slow = speed <= SPEED_ON
        near = h[slow & (h <= FLOOR_MAX)]
        if len(near):
            out[:, k] = (h - np.median(near) <= HEIGHT_ON) & slow
    return out


def heading(rotation):
    """hips の回転の、体の前の水平の角度（+Z を 0、Y 軸まわり）。"""
    f = qrot(rotation, np.array([0.0, 0.0, 1.0]))
    return float(np.arctan2(f[0], f[2]))


def end_velocity(m, last=True, span=6):
    """端の hips の水平の速さのベクトル [x, 0, z]（m/s）。"""
    n = min(span, frames(m) - 1)
    h = m["hips"]
    d = h[-1] - h[-1 - n] if last else h[n] - h[0]
    return d * [1, 0, 1] / (n / m["fps"])


WALK_SPEED = 1.0


def place_after(a, b, gap=None, seconds=0.0):
    """b を a の終わりの向きと位置に合わせる。

    gap を省くと、つなぎの秒数と両端の速さの平均から離れる量を決める。gap（m）を書くと a の終わりの体の前へその量だけ離す。
    """
    ya = heading(a["rotations"]["hips"][-1])
    turn = qyaw(ya - heading(b["rotations"]["hips"][0]))
    t = np.broadcast_to(turn, (frames(b), 4))
    rot = dict(b["rotations"])
    rot["hips"] = qmul(t, rot["hips"])
    moved = qrot(t, b["hips"] - b["hips"][0] * [1, 0, 1])
    if gap is None:
        va = end_velocity(a, True)
        step = seconds * (va + qrot(turn, end_velocity(b, False))) / 2
        limit = seconds * max(WALK_SPEED, np.linalg.norm(va))   # 始めに踏み込む動きの速さを、そのままつなぎの距離にしない
        step = step * min(1.0, limit / max(np.linalg.norm(step), 1e-6))
    else:
        step = np.array([np.sin(ya), 0.0, np.cos(ya)]) * gap
    return make(rot, moved + a["hips"][-1] * [1, 0, 1] + step, b["contacts"])


def inplace(m):
    """hips の水平の位置から 1 秒の移動平均の道筋を引く（soma_vrma.retarget と同じ）。足が床を滑るのが動きそのものなので接地は持たない。"""
    h = m["hips"].copy()
    h[:, [0, 2]] -= smooth_track(h[:, [0, 2]], max(1, int(round(m["fps"]))))
    return make(m["rotations"], h, np.zeros((frames(m), 4)))


def smootherstep(x):
    return x * x * x * (x * (6 * x - 15) + 10)


def interpolate(a, b, count):
    """a の最後のコマから b の最初のコマまでの count コマを補間で作る。回転は球面補間、hips は両端の速さを保つ 3 次の曲線。"""
    u = (np.arange(1, count + 1) / (count + 1))[:, None]
    s = smootherstep(u)
    rot = {k: slerp(np.broadcast_to(a["rotations"][k][-1], (count, 4)), np.broadcast_to(b["rotations"][k][0], (count, 4)), s) for k in ORDER}
    t = (count + 1) / a["fps"]
    p0, p1 = a["hips"][-1], b["hips"][0]
    v0, v1 = end_velocity(a, True) * t, end_velocity(b, False) * t
    limit = 3 * np.linalg.norm(p1 - p0)   # 接線がこれより長いと曲線が折り返して、hips が後ろへ戻る
    v0 = v0 * min(1.0, limit / max(np.linalg.norm(v0), 1e-9))
    v1 = v1 * min(1.0, limit / max(np.linalg.norm(v1), 1e-9))
    h = (2 * u**3 - 3 * u**2 + 1) * p0 + (u**3 - 2 * u**2 + u) * v0 + (-2 * u**3 + 3 * u**2) * p1 + (u**3 - u**2) * v1
    return make(rot, h, np.zeros((count, 4)))


def fill_fingers(bridge, a, b):
    """MotionBricks は指を動かさないので、つなぎの間の指は a の終わりから b の始めへ補間する。"""
    n = frames(bridge)
    s = smootherstep((np.arange(1, n + 1) / (n + 1))[:, None])
    rot = dict(bridge["rotations"])
    for k in FINGER_NAMES:
        rot[k] = slerp(np.broadcast_to(a["rotations"][k][-1], (n, 4)), np.broadcast_to(b["rotations"][k][0], (n, 4)), s)
    return make(rot, bridge["hips"], bridge["contacts"])


def concat(parts, cut=1):
    """区間を順につなぐ。継ぎ目の前後 cut コマは接地を 0 にする。返すのは (中間形式, 継ぎ目のコマの一覧)。

    接地の区間が継ぎ目をまたぐと、足の IK が足を留めたまま体だけが次の区間へ動き、膝立ちなどの姿勢が崩れる。
    """
    rot = {k: np.concatenate([p["rotations"][k] for p in parts], 0) for k in ORDER}
    hips = np.concatenate([p["hips"] for p in parts], 0)
    cont = np.concatenate([p["contacts"] if p["contacts"] is not None else np.zeros((frames(p), 4)) for p in parts], 0)
    seams, at = [], 0
    for p in parts[:-1]:
        at += frames(p)
        seams.append(at)
        cont[max(0, at - cut):at + cut] = 0
    return make(rot, hips, cont), seams


def face_forward(m):
    """全体を、最初のコマで体が +Z を向き、hips の真下が原点に来るように動かす。"""
    turn = np.broadcast_to(qyaw(-heading(m["rotations"]["hips"][0])), (frames(m), 4))
    rot = dict(m["rotations"])
    rot["hips"] = qmul(turn, rot["hips"])
    h = qrot(turn, m["hips"])
    h[:, [0, 2]] -= h[0, [0, 2]]
    return make(rot, h, m["contacts"])
