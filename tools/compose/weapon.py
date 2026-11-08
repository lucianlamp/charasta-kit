"""武器を剛体として、その姿勢を主に腕を解く（計画の weapon）。

武器の定義（JSON、weapon_def.py が作る）: 座標は柄頭が原点、+X が刃先、+Y が刃の幅、単位は FBX のまま。grips に手首の位置と手の向きを持つ。
解き方:
1. 素材の持つ手の回転から武器の回転 W(t) を読む。1 コマの回転が上限を超える間だけ時刻を伸ばす（stretch_steps）。体も同じ時刻で動くので、振りの間のコマが増えて、動き全体が少し長くなる。
2. 武器の位置は、持つ手の手首を肩の付け根から元の体の比の長さで組んだ位置（grip.source_wrist）に置く。腕の曲がりが元に近く保たれ、手首の折れが増えない。
3. 武器が地面や体に入るコマだけ武器を動かす（clear）。動かす量は前後のコマへ広げてなめらかにする。回転は変えない。
4. 両手の手首は握り点、手の向きは柄に対する握りに固定して、腕を解く。肘の向きは grip と同じ選び方に、手首の限界の罰を足す。

W(t) は短い回り方で補間する。回り方の確かめは steps の sameWay（前のコマの回転の軸との内積）に残す。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import clip as C
import grip as Grip
import weapon_check as Check
from soma_vrma import qinv, qmul, qrot

MAX_STEP_DEG = 30.0     # 1 コマ（1/30 秒）の武器の回転の上限。900 度/秒
FAST_STEP_DEG = 90.0    # 記録に残す速い回転の角度
CLEARANCE = 0.01        # 体から離す距離（m）
GROUND_CLEARANCE = 0.002    # 地面から離す距離（m）
SPREAD = 4              # 動かす量を前後へ広げるコマ
PASSES = 10             # 動かす量を求める繰り返しの回数
DONE = 5e-4             # 足りない量がこれより小さければ終える（m）


def read(path):
    """定義の JSON を読み、計算に使う形を足す。"""
    w = json.loads(Path(path).read_text(encoding="utf8"))
    length = w["lengthM"]
    rows = np.array(w["profile"], dtype=np.float64)
    along = np.unique(np.concatenate([rows[:, 0], np.arange(0, length, length / 10)]))
    half = np.interp(along, rows[:, 0], rows[:, 1])
    w["points"] = np.array([[s, h * k, 0.0] for s, h in zip(along, half) for k in (-1, 0, 1)])
    w["centerOfMassM"] = np.array(w["centerOfMassM"], dtype=np.float64)
    w["wrist"] = {k: np.array(v["wristM"], dtype=np.float64) for k, v in w["grips"].items()}
    w["hand"] = {k: np.array(v["hand"], dtype=np.float64) for k, v in w["grips"].items()}
    return w


def stretch_steps(steps, speed, limit):
    """素材のコマの間ごとの、出すコマの数 [F-1]。上限を超える間は角度に比例して伸ばし、段差が出ないように前後へならす。ならしても元より短くしない。"""
    frames = np.maximum(1 / speed, steps / limit)
    soft = np.convolve(np.pad(frames, 2, mode="edge"), np.array([1, 2, 3, 2, 1]) / 9, "valid")
    return np.maximum(frames, soft)


def retime(m, W, steps, speed, limit):
    """stretch_steps の時刻で全部の骨と武器を動かす。武器は親の骨を介さず直接補間するので、速い間も 1 本の軸で一定に回る。返すのは (中間形式, W)。"""
    times = np.concatenate([[0], np.cumsum(stretch_steps(steps, speed, limit))]) / C.FPS
    bones = {**m["rotations"], "weapon": W}
    if m["contacts"] is None:
        rot, hips = C.resample(times, bones, m["hips"])
        out = rot.pop("weapon")
        return C.make(rot, hips), out
    rot, hips, contacts = C.resample(times, bones, m["hips"], extra=m["contacts"])
    out = rot.pop("weapon")
    return C.make(rot, hips, contacts), out


def fast_steps(W, steps):
    """速い回転のコマの間の記録。sameWay は前のコマの回転の軸とこのコマの軸の内積で、負なら短い回り方が前の動きに逆らっている。"""
    delta = qmul(W[1:], qinv(W[:-1]))
    delta = delta * np.where(delta[:, 3:4] < 0, -1.0, 1.0)
    axis = delta[:, :3] / np.maximum(np.linalg.norm(delta[:, :3], axis=1, keepdims=True), 1e-9)
    return [{"step": int(k), "deg": round(float(steps[k]), 1), "sameWay": round(float(axis[k] @ axis[k - 1]), 2) if k else None} for k in np.flatnonzero(steps > FAST_STEP_DEG)]


def spread(raw, width=SPREAD):
    """コマごとの動かす量を前後 width コマへ広げてならす。広げる幅とならす幅が同じなので、元のコマの量は保たれる。"""
    n = len(raw)
    size = np.linalg.norm(raw, axis=1)
    held = np.array([raw[max(0, f - width) + int(size[max(0, f - width):f + width + 1].argmax())] for f in range(n)])
    window = np.hanning(2 * width + 3)[1:-1]
    pad = np.pad(held, ((width, width), (0, 0)), mode="edge")
    return np.stack([np.convolve(pad[:, k], window / window.sum(), "valid") for k in range(3)], 1)


def shortfall(W, wrist, weapon, scale, parts):
    """武器が地面と体から離れるのに足りない量 [F, 3]。wrist は持つ手の世界の位置。地面は真上へ、体はカプセルの線分から離れる向きへ。"""
    pts = Check.weapon_points(W, wrist, weapon["points"], weapon, scale)
    frames = np.arange(len(W))
    need = np.zeros((len(W), 3))
    need[:, 1] = np.maximum(0, GROUND_CLEARANCE - pts[:, :, 1].min(1))
    for _, a, b, r in parts:
        dist, near = Check.segment_distance(pts, a[:, None], b[:, None])
        i = dist.argmin(1)
        off = (pts - near)[frames, i]
        lack = np.maximum(0, r + CLEARANCE - dist[frames, i])
        need += off / np.maximum(dist[frames, i], 1e-9)[:, None] * lack[:, None]
    return need


def clear(W, wrist, weapon, scale, parts):
    """武器を地面と体から離す量 [F, 3]。コマごとに解いてから広げ、広げたあとも足りないコマがあれば足す。"""
    raw = np.zeros_like(wrist)
    for _ in range(PASSES):
        need = shortfall(W, wrist + raw, weapon, scale, parts)
        if np.abs(need).max() < DONE:
            break
        raw = raw + need
    push = spread(raw)
    for _ in range(PASSES):
        need = shortfall(W, wrist + push, weapon, scale, parts)
        if np.abs(need).max() < DONE:
            break
        raw = raw + need
        push = spread(raw)
    return push


def solve(m, weapon, rest, radii, arms, speed=1, limit=MAX_STEP_DEG):
    """切り出したあとの中間形式から、速さを変え、足の高さをそろえ、武器を主に腕を解く。arms は元の体の比の腕の長さ。返すのは (中間形式, 記録)。"""
    hold, free = weapon["hold"], Grip.OTHER[weapon["hold"]]
    source = Check.weapon_rotation(m, weapon)
    steps = Check.angle_steps(source)
    timed, W = retime(m, source, steps, speed, limit)
    timed = C.ground(timed)
    n = C.frames(timed)
    pos, d = C.joints(timed, rest), dict(C.world_deltas(timed))
    for s in (hold, free):
        d[s + "Hand"] = qmul(W, np.broadcast_to(weapon["hand"][s], (n, 4)))
    for bone in C.FINGER_NAMES:     # 指は手からの回転を保つ
        d[bone] = qmul(d[C.PARENT[bone]], timed["rotations"][bone])
    scale = Check.body_scale(weapon, rest)
    hand_gap = qrot(W, np.broadcast_to((weapon["wrist"][free] - weapon["wrist"][hold]) * scale, (n, 3)))
    wrist = Grip.source_wrist(pos, C.world_deltas(timed), hold, rest, arms[hold])
    body = Check.world_joints(timed, rest)
    push = clear(W, wrist + body["hips"] - pos["hips"], weapon, scale, Check.capsules(body, radii))
    mid = wrist + hand_gap / 2 + push
    starts = pos[free + "UpperArm"], pos[hold + "UpperArm"]
    moved = Grip.reachable(mid, hand_gap, starts, [sum(Grip.arm_lengths(s, rest)) * Grip.REACH for s in (free, hold)])
    shift = np.linalg.norm(moved - mid, axis=1)
    out, miss = Grip.solve_arms(pos, d, ((free, moved + hand_gap / 2), (hold, moved - hand_gap / 2)), rest, wrist_limits=True)
    size = np.linalg.norm(push, axis=1)
    return C.from_world_deltas(out, timed["hips"], timed["contacts"]), {
        "solve": "weapon", "holdHand": hold, "lengthOnBodyM": round(weapon["lengthM"] * scale, 3), "maxStepDeg": limit, "framesIn": C.frames(m), "framesOut": n, "fastSteps": fast_steps(source, steps),
        "pushCm": {"frames": int((size > 5e-4).sum()), "max": round(float(size.max() * 100), 1)}, "reachShift": {"frames": int((shift > 5e-5).sum()), "maxCm": round(float(shift.max() * 100), 2)},
        "reachMissMaxCm": round(float(max(miss[free].max(), miss[hold].max()) * 100), 2)}
