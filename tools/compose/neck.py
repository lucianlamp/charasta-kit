"""FBX の動きの首を、人の首で曲がる範囲へ収める。

ゲームの動きは、胴をひねるときに頭を敵へ向けたまま残すことがある。Warrior の 2Handed_Attack1 は胸に対して頭が 107 度回り（11 コマが 80 度超え）、腰に対して胸が 84 度回る。
首の骨は全コマ動かず、回転は全部頭の骨に入る。移し替えの誤りではなく元の動きの値で、人の首のひねり（片側 70〜80 度）と胴のひねり（40〜50 度）を超える。

胸から見た頭の回転を回転ベクトルで持ち、次の 3 つをする:
1. 大きさが上限に近づくほど抑える。上限の KNEE の割合までは変えない。
2. 抑えた分は頭が胸へ戻る。計画の chestShare を書くと、その割合だけ胸（と背骨）を頭の向きへ回す。顔の世界の向きが保たれるが、見た目で既定にしなかった（docs/motion-compose.md）。腰と脚は動かさない。
3. 首と頭の骨へ NECK_SHARE で分ける。1 つの関節に回転を集めないので、首の根元のメッシュがつぶれない。

上限は計画の neckLimitDeg（既定 80 度）に、体の首の長さと元の体の比の首の長さの比（1 まで）を掛けた値。首が短い体は曲がる余地が小さい。
"""

from __future__ import annotations

import numpy as np

import clip as C
from soma_vrma import continuous, qinv, qmul, qnormalize, qrot

LIMIT_DEG = 80.0
LIMIT_MIN_DEG, LIMIT_MAX_DEG = 30.0, 180.0     # 180 は補正もしない（抑えない）
KNEE = 2 / 3
NECK_SHARE = 0.5
SPINE_SHARE = 0.5     # 胸へ回す量のうち、背骨へも回す割合
CHEST_SHARE = 0.0     # 上限を超えた分のうち、胸を頭の向きへ回す割合。残りは頭が胸へ戻る


def rotvec(q, folded=True):
    """四元数 [F, 4] の回転ベクトル [F, 3]（ラジアン）。folded は 180 度以内へ折り返す。False は continuous でそろえた列で 180 度を超えても続ける。"""
    if folded:
        q = q * np.where(q[..., 3:4] < 0, -1.0, 1.0)
    s = np.linalg.norm(q[..., :3], axis=-1, keepdims=True)
    return q[..., :3] / np.maximum(s, 1e-12) * 2 * np.arctan2(s, q[..., 3:4])


def from_rotvec(v):
    a = np.linalg.norm(v, axis=-1, keepdims=True)
    return qnormalize(np.concatenate([v * np.sinc(a / 2 / np.pi) / 2, np.cos(a / 2)], -1))


def ease(angle, limit):
    """limit * KNEE までは angle のまま、そこから limit へ漸近する。"""
    knee = limit * KNEE
    return np.where(angle <= knee, angle, knee + (limit - knee) * np.tanh((angle - knee) / (limit - knee)))


def body_limit(limit_deg, neck_length, rest, ratio, has_neck=True):
    """体の首の長さに合わせた上限（度）。neck_length は元の首の長さ（REST の体の m）で、素材に首の骨が無ければ None。ratio は REST の体から rest の体への比。

    体に首の骨が無いときと、LIMIT_MAX_DEG（抑えない）のときは補正しない。補正のあとも LIMIT_MIN_DEG より下げない。
    """
    if not neck_length or not has_neck or limit_deg >= LIMIT_MAX_DEG:
        return float(limit_deg)
    scaled = float(limit_deg) * min(1.0, float(np.linalg.norm(rest["head"] - rest["neck"])) / (neck_length * ratio))
    return max(scaled, LIMIT_MIN_DEG)


def step_max(q):
    """コマの間の回転の最大（度）。"""
    return round(float(np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(q[1:] * q[:-1], 1)), 0, 1))).max()), 1) if len(q) > 1 else 0.0


def solve(m, limit_deg, chest_share=0.0, keep_arms=False):
    """首と頭を上限の中へ収める。返すのは (中間形式, 記録)。

    keep_arms なら腕と手の世界の回転を残す（あとで腕を解き直す）。そうでなければ胸と一緒に回る。limit_deg が LIMIT_MAX_DEG なら抑えず、首と頭へ分けるだけ。
    """
    d = dict(C.world_deltas(m))
    before = qmul(qinv(d["chest"]), d["head"])
    before = continuous(before * (-1.0 if before[0, 3] < 0 else 1.0))     # 最初のコマは短い向きから始める
    v = rotvec(before, folded=False)
    angle = np.linalg.norm(v, axis=1, keepdims=True)
    limit = np.radians(limit_deg)
    held = v if limit_deg >= LIMIT_MAX_DEG else v * (ease(angle, limit) / np.maximum(angle, 1e-12))
    extra = (v - held) * chest_share
    chest = qmul(d["chest"], from_rotvec(extra))
    turn = qmul(chest, qinv(d["chest"]))
    head = qmul(chest, from_rotvec(held))
    moved = np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(head * d["head"], 1)), 0, 1)))
    for b in C.ORDER:
        if b.startswith(("left", "right")) and not b.endswith(("UpperLeg", "LowerLeg", "Foot", "Toes")) and (not keep_arms or b.endswith("Shoulder")):
            d[b] = qmul(turn, d[b])
    d["spine"] = qmul(d["spine"], from_rotvec(extra * SPINE_SHARE))
    d["chest"], d["head"], d["neck"] = chest, head, qmul(chest, from_rotvec(held * NECK_SHARE))
    return C.from_world_deltas(d, m["hips"], m["contacts"]), {
        "limitDeg": round(float(limit_deg), 1), "chestShare": chest_share, "overFrames": int((angle[:, 0] > limit).sum()), "headChestDegMax": round(float(np.degrees(angle.max())), 1), "headChestStepDegMaxBefore": step_max(before),
        "headChestStepDegMax": step_max(from_rotvec(held)), "headMoveDegMax": round(float(moved.max()), 1), "chestTurnDegMax": round(float(np.degrees(np.linalg.norm(extra, axis=1).max())), 1)}


def report(m):
    """胸から見た頭の左右のひねり（左が +）、うなずき（下が +）、首かしげ（左が +）の範囲、回転の大きさの最大、コマの間の変化の最大（度）と、腰から見た胸のひねりの範囲。全コマで測る。"""
    d = C.world_deltas(m)
    q = qmul(qinv(d["chest"]), d["head"])
    front, up = qrot(q, np.broadcast_to([0, 0, 1.0], (len(q), 3))), qrot(q, np.broadcast_to([0, 1.0, 0], (len(q), 3)))
    torso = qrot(qmul(qinv(d["hips"]), d["chest"]), np.broadcast_to([0, 0, 1.0], (len(q), 3)))

    def span(x):
        return [round(float(np.degrees(x.min())), 1), round(float(np.degrees(x.max())), 1)]
    return {"yawDeg": span(np.arctan2(front[:, 0], front[:, 2])), "pitchDeg": span(np.arcsin(np.clip(-front[:, 1], -1, 1))), "rollDeg": span(np.arctan2(up[:, 0], up[:, 1])),
            "angleDegMax": round(float(np.degrees(np.linalg.norm(rotvec(q), axis=1).max())), 1), "stepDegMax": step_max(q), "chestHipsYawDeg": span(np.arctan2(torso[:, 0], torso[:, 2]))}
