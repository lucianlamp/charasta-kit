"""両手で持つ武器の握りを保つ。

回転だけの移し替えは、肩幅や腕の長さが素材と違うと、両手首の位置の関係を保たない（Warrior の両手剣では、振りかぶる間に左手が右手より鍔の側へ出た）。
既定の solve_both は両腕を解く:
1. 両手の中点を、肩から先を元の体の比で組んだ位置へ戻す。両手首の差は素材のまま。両腕が届かないコマは、差を保ったまま中点だけを最小の距離で動かす。
2. 肘の向き（肩と手首を結ぶ線のまわりの回転）を、手首の折れとひねりと上腕のねじれが小さく、コマの間でなめらかになるように選ぶ。body_cost（計画の elbowPrior）なら、肘が重力と体の外へ向き、肩と前腕が可動域に収まることも足す。
3. 手首のひねりの SHARE の割合を前腕のロールへ移す。ロールは 1 コマ ROLL_STEP までしか動かさず、追いきれない分は手首に残す。
one_arm は持つ手を動かさず、もう一方の腕だけを 2 本の骨の IK で解く。肘は元の動きの曲がる面に残すので、腕の長さが違う体ではねじれる。
どちらも手の向きは素材のまま。体つきは VRMA を当てるキャラの体（vrm_rest）で計算する。

差は持つ手のローカル座標で持つ（武器は持つ手に固定なので、この座標で一定に近い）。世界の座標で補間すると、手が回る間のコマで間隔が縮む。
腕を解くのは切り出しと速さのあとで、誤差もそのあとのコマで測る。

ねじれの定義: 親から見た回転 L を、T ポーズの骨の軸 a まわりのツイストと残りのスイングに L = S * T で分ける。
上腕は親が肩で軸が上腕、前腕は親が上腕で軸が前腕、手首は親が前腕で軸が前腕（スイングが手首の折れ、ツイストが手首のひねり）。
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

import anatomy
import check
import clip as C
from soma_vrma import qinv, qmul, qnormalize, qrot, write_vrma
from vrma_read import read_vrma

REACH = 0.999       # 腕を伸ばしきる長さの割合
OTHER = {"right": "left", "left": "right"}
SWIVEL = np.radians(np.arange(-180, 180, 5.0))      # 肘の向きの候補
SWIVEL_STEP_COST = 3.0                              # コマの間の肘の向きの変化（度）の 2 乗の重み。手首と上腕の無理（度の 2 乗）と同じ単位
SHARE = 0.5                                         # 手首のひねりを前腕のロールへ移す割合
ROLL_STEP = np.radians(30.0)                        # 前腕のロールの 1 コマの変化の上限
TWIST_LIMIT, BEND_LIMIT = 100.0, 80.0               # 武器を主に解くときの手首のひねりと折れの限界（度）
LIMIT_COST = 20.0                                   # 限界を超えた分の 2 乗の重み
# 以下の 3 つは計画の elbowPrior を書いたときだけ効く。見た目で既定にしなかった（docs/motion-compose.md）
ELBOW_PRIOR = 1.0                                   # 肘が向く方向の無理（度）の 2 乗の重み
ELBOW_OUT = 0.25                                    # 肘が向く方向の、重力に対する体の外の割合
# chest を渡したときの上腕のねじれの重み。上腕のねじれは T ポーズから測るので、腕を前へ出して肘を下へ向ける自然な姿勢で大きくなる。
# 重み 1 では肘が横へ開いた（2Handed_Attack1 の左肘の下の成分の中央値 0.53、元の動き 0.75）。
BODY_UPPER_TWIST = 0.25


def rotation_between(a, b):
    """向き a を向き b へ移す最小の回転。"""
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    c, d = np.cross(a, b), float(np.dot(a, b))
    if d < -0.999999:
        axis = np.cross(a, [1.0, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0, 1.0, 0])
        return qnormalize(np.array([*(axis / np.linalg.norm(axis)), 0.0]))
    return qnormalize(np.array([c[0], c[1], c[2], 1 + d]))


def vrm_bones(path):
    """VRM に実在する humanoid の骨の名前の集合。"""
    buf = Path(path).read_bytes()
    ext = json.loads(buf[20:20 + struct.unpack_from("<I", buf, 12)[0]]).get("extensions", {})
    return set(ext["VRMC_vrm"]["humanoid"]["humanBones"]) if "VRMC_vrm" in ext else {b["bone"] for b in ext["VRM"]["humanoid"]["humanBones"]}


def vrm_rest(path):
    """VRM の T ポーズの骨の位置を、REST と同じ形（Y が上、前が +Z、左が +X）で返す。無い骨は親の位置にそろえ、指は REST のまま手首へ寄せる。"""
    buf = Path(path).read_bytes()
    length = struct.unpack_from("<I", buf, 12)[0]
    js = json.loads(buf[20:20 + length])
    ext = js.get("extensions", {})
    if "VRMC_vrm" in ext:
        bones = {k: v["node"] for k, v in ext["VRMC_vrm"]["humanoid"]["humanBones"].items()}
        turn = np.array([1.0, 1.0, 1.0])
    elif "VRM" in ext:
        bones = {b["bone"]: b["node"] for b in ext["VRM"]["humanoid"]["humanBones"]}
        turn = np.array([-1.0, 1.0, -1.0])     # VRM 0 は体の前が -Z
    else:
        raise SystemExit("VRM ではない: " + str(path))
    nodes = js["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}

    def world(i):
        n = nodes[i]
        t = np.array(n.get("translation", (0, 0, 0)), dtype=np.float64)
        q = np.array(n.get("rotation", (0, 0, 0, 1)), dtype=np.float64)
        if i not in parent:
            return t, q
        pp, pq = world(parent[i])
        return pp + qrot(pq, t), qmul(pq, q)

    rest = dict(C.REST)
    for b in C.ORDER:
        p = C.PARENT[b]
        if b in bones:
            rest[b] = world(bones[b])[0] * turn
        elif p is not None:
            rest[b] = rest[p] + C.REST[b] - C.REST[p]
    return rest


def body_ratio(rest):
    """REST の体の長さを rest の体へ縮める比。fbx_clip の bodyScale と同じ、hips から爪先までの高さの比。"""
    return (rest["hips"][1] - rest["leftToes"][1]) / (C.HIPS_HEIGHT - C.REST["leftToes"][1])


def gap_for(m, local, side, rest):
    """持つ手のローカル座標の差 local（REST の体の m）を、rest の体の世界の差にする。"""
    return qrot(C.world_deltas(m)[side + "Hand"], local * body_ratio(rest))


def gap_error(m, gap, side, rest):
    """コマごとの、もう一方の手首の目標からの距離（m）。"""
    pos = C.joints(m, rest)
    return np.linalg.norm(pos[OTHER[side] + "Hand"] - pos[side + "Hand"] - gap, axis=1)


def apply(m, local, side, rest, arms=None, origin=None, body_cost=False):
    """切り出しと速さのあとの中間形式の腕を解く。arms（source_arms の値）があれば両腕、None なら one_arm。返すのは (中間形式, 記録)。"""
    gap = gap_for(m, local, side, rest)
    return one_arm(m, gap, side, rest) if arms is None else solve_both(m, gap, side, rest, arms, origin, body_cost)


def unit(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def axis_rotation(axis, angle):
    """軸 axis（[..., 3]）のまわりに angle（ラジアン、[...]）回す四元数。"""
    return np.concatenate([axis * np.sin(angle / 2)[..., None], np.cos(angle / 2)[..., None]], -1)


def between(a, b):
    """rotation_between の [F, 3] の版。"""
    a, b = unit(a), unit(b)
    q = np.concatenate([np.cross(a, b), 1 + np.sum(a * b, -1, keepdims=True)], -1)
    for i in np.flatnonzero(q[:, 3] < 1e-6):
        q[i] = rotation_between(a[i], b[i])
    return qnormalize(q)


def matrix_quat(r):
    """回転行列 [F, 3, 3] の四元数 [F, 4]。"""
    x, y, z = r[:, 0, 0], r[:, 1, 1], r[:, 2, 2]
    k = np.stack([
        np.stack([1 + x - y - z, r[:, 0, 1] + r[:, 1, 0], r[:, 0, 2] + r[:, 2, 0], r[:, 2, 1] - r[:, 1, 2]], 1),
        np.stack([r[:, 0, 1] + r[:, 1, 0], 1 - x + y - z, r[:, 1, 2] + r[:, 2, 1], r[:, 0, 2] - r[:, 2, 0]], 1),
        np.stack([r[:, 0, 2] + r[:, 2, 0], r[:, 1, 2] + r[:, 2, 1], 1 - x - y + z, r[:, 1, 0] - r[:, 0, 1]], 1),
        np.stack([r[:, 2, 1] - r[:, 1, 2], r[:, 0, 2] - r[:, 2, 0], r[:, 1, 0] - r[:, 0, 1], 1 + x + y + z], 1)], 1)
    return qnormalize(k[np.arange(len(r)), np.argmax(np.diagonal(k, axis1=1, axis2=2), 1)])


def swing_twist(q, axis):
    """q（[F, 4]）を、軸 axis まわりのツイスト角（ラジアン、符号つき）とスイング角（ラジアン）にする。"""
    v, w = q[..., :3], q[..., 3]
    p = np.sum(v * axis, -1)
    twist = (2 * np.arctan2(p, w) + np.pi) % (2 * np.pi) - np.pi
    return twist, 2 * np.arctan2(np.linalg.norm(v - p[..., None] * axis, axis=-1), np.sqrt(w * w + p * p))


def arm_axes(side, rest):
    return unit(rest[side + "LowerArm"] - rest[side + "UpperArm"]), unit(rest[side + "Hand"] - rest[side + "LowerArm"])


def arm_lengths(side, rest):
    return np.linalg.norm(rest[side + "LowerArm"] - rest[side + "UpperArm"]), np.linalg.norm(rest[side + "Hand"] - rest[side + "LowerArm"])


def hinge_of(d, side, rest):
    """回転だけの動きの前腕の回転から、T ポーズの座標の肘の蝶番の軸と、一定のツイストの回転を読む。腕がずっと伸びていて読めないときは、肘が体の前へ曲がる軸。"""
    lower = qmul(qinv(d[side + "UpperArm"]), d[side + "LowerArm"])
    axis = arm_axes(side, rest)[1]
    twist = axis_rotation(axis, np.median(swing_twist(lower, np.broadcast_to(axis, (len(lower), 3)))[0]))
    swing = qmul(lower, np.broadcast_to(qinv(twist), lower.shape))
    v = swing[:, :3] * np.sign(swing[:, 3:4])
    bent = np.linalg.norm(v, axis=1) > 0.2
    hinge = unit(np.median(unit(v[bent]), axis=0)) if bent.any() else unit(np.cross(axis, [0, 0, 1.0]))
    return hinge, twist


def elbow_sides(along, ref, chest):
    """肘が出る向きの候補 [候補, F, 3]。基準は ref（回転だけの肘）。ref が肩と手首の線に乗るコマは胸の下向き。along は単位ベクトル。"""
    first = ref - along * np.sum(ref * along, -1, keepdims=True)
    flat = np.linalg.norm(first, axis=1) < 1e-3
    down = qrot(chest, np.broadcast_to([0, -1.0, 0], along.shape))
    first[flat] = (down - along * np.sum(down * along, -1, keepdims=True))[flat]
    first = unit(first)
    second = np.cross(along, first)
    return np.stack([first * np.cos(g) + second * np.sin(g) for g in SWIVEL])


def place_elbow(side, rest, shoulder, target, side_dir, hinge, twist):
    """肩、手首の目標、肘が出る向きから (上腕の D, 前腕の D, 目標までの足りない距離) を返す。前腕は肘の蝶番の回りにだけ曲げる。"""
    a, b = arm_lengths(side, rest)
    upper_axis, lower_axis = arm_axes(side, rest)
    to = target - shoulder
    c0 = np.linalg.norm(to, axis=-1)
    c = np.clip(c0, abs(a - b) + 1e-4, (a + b) * REACH)
    along = to / c0[:, None]
    x = (a * a - b * b + c * c) / (2 * c)
    elbow = along * x[:, None] + side_dir * np.sqrt(np.maximum(a * a - x * x, 0))[:, None]
    u = unit(elbow)
    f = unit(along * c[:, None] - elbow)
    n = unit(np.cross(u, f))
    h = unit(hinge - upper_axis * np.dot(hinge, upper_axis))
    from_t = np.stack([upper_axis, h, np.cross(upper_axis, h)], -1)
    to_t = np.stack([u, n, np.cross(u, n)], -1)
    du = matrix_quat(to_t @ from_t.T)
    base = qmul(du, np.broadcast_to(twist, du.shape))
    dl = qmul(between(qrot(base, np.broadcast_to(lower_axis, f.shape)), f), base)
    return du, dl, c0 - c


def roll_share(dl, hand, side, rest):
    """手の向きを変えずに、手首のひねりの SHARE の割合を前腕のロールへ移す。

    ひねりは 1 コマで 180 度近く跳ぶことがあり、続けて読むと向きが定まらない。目標はコマごとに折り返した値（-180〜180 度）の SHARE 倍で、ロールは 1 コマ ROLL_STEP までで追う。
    """
    axis = np.broadcast_to(arm_axes(side, rest)[1], dl.shape[:-1] + (3,))
    goal = swing_twist(qmul(qinv(dl), hand), axis)[0] * SHARE
    roll = goal.copy()
    for i in range(1, len(roll)):
        roll[i] = roll[i - 1] + np.clip(goal[i] - roll[i - 1], -ROLL_STEP, ROLL_STEP)
    return qmul(dl, axis_rotation(axis, roll))


def swivel_body_cost(sides_k, du, dl, hand, side, rest, chest):
    """肘の向きの候補 1 つの解剖の無理 [F]: 肘が重力と体の外へ向くこと、肩と前腕の可動域。"""
    n = len(du)
    sign = anatomy.SIGN[side]
    want = unit(np.broadcast_to([0, -1.0, 0], (n, 3)) + qrot(chest, np.broadcast_to([sign * ELBOW_OUT, 0, 0], (n, 3))))
    tilt = np.degrees(np.arccos(np.clip(np.sum(want * sides_k, 1), -1, 1)))
    upper_axis, lower_axis = arm_axes(side, rest)
    into = qinv(chest)
    u = unit(qrot(into, qrot(du, np.broadcast_to(upper_axis, (n, 3)))))
    f = unit(qrot(into, qrot(dl, np.broadcast_to(lower_axis, (n, 3)))))
    palm = unit(qrot(into, qrot(hand, np.broadcast_to([0, -1.0, 0], (n, 3)))))
    angles = anatomy.arm_angles(u, f, palm, sign)
    excess = np.zeros(n)
    for key in ("horizontal", "rotation", "pronation"):
        low, high = anatomy.ROM[key]
        v = np.nan_to_num(angles[key], nan=(low + high) / 2)
        excess += np.maximum(0, v - high) ** 2 + np.maximum(0, low - v) ** 2
    return ELBOW_PRIOR * tilt ** 2 + LIMIT_COST * excess


def choose_swivel(sides, parent, hand, side, rest, shoulder, target, hinge, twist, wrist_limits=False, chest=None):
    """コマごとの肘の向きを動的計画法で選ぶ。無理は手首の折れ、手首のひねり、上腕のねじれ（度）の 2 乗の和で、コマの間の向きの変化も足す。返すのは [F, 3]。

    wrist_limits は手首の限界（TWIST_LIMIT、BEND_LIMIT）を超えた分に重い罰を足す。武器を速く回すコマで、ひねりが 180 度をまたいで腕の裏返しへ逃げるのを防ぐ。
    chest（胸の D）を渡すと swivel_body_cost を足す。
    """
    upper_axis, lower_axis = arm_axes(side, rest)
    n, count = sides.shape[1], sides.shape[0]
    cost = np.zeros((n, count))
    for k in range(count):
        du, dl, _ = place_elbow(side, rest, shoulder, target, sides[k], hinge, twist)
        wrist_twist, wrist_bend = swing_twist(qmul(qinv(dl), hand), np.broadcast_to(lower_axis, (n, 3)))
        upper_twist = swing_twist(qmul(qinv(parent), du), np.broadcast_to(upper_axis, (n, 3)))[0]
        cost[:, k] = np.degrees(wrist_bend) ** 2 + np.degrees(wrist_twist * (1 - SHARE)) ** 2 + (1.0 if chest is None else BODY_UPPER_TWIST) * np.degrees(upper_twist) ** 2
        if wrist_limits:
            cost[:, k] += LIMIT_COST * (np.maximum(0, np.degrees(np.abs(wrist_twist)) - TWIST_LIMIT) ** 2 + np.maximum(0, np.degrees(wrist_bend) - BEND_LIMIT) ** 2)
        if chest is not None:
            cost[:, k] += swivel_body_cost(sides[k], du, dl, hand, side, rest, chest)
    best, back = cost[0].copy(), np.zeros((n, count), int)
    for i in range(1, n):
        step = np.degrees(np.arccos(np.clip(sides[:, i] @ sides[:, i - 1].T, -1, 1)))
        total = best[None, :] + SWIVEL_STEP_COST * step ** 2
        back[i], best = total.argmin(1), total.min(1) + cost[i]
    path = np.zeros(n, int)
    path[-1] = best.argmin()
    for i in range(n - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    return sides[path, np.arange(n)]


def smooth_sides(chosen, along):
    """候補の刻みの段差を消す。手首の位置は変わらない。"""
    pad = np.concatenate([chosen[:1], chosen[:1], chosen, chosen[-1:], chosen[-1:]])
    soft = np.stack([np.convolve(pad[:, k], np.array([1, 2, 3, 2, 1]) / 9, "valid") for k in range(3)], 1)
    return unit(soft - along * np.sum(soft * along, -1, keepdims=True))


def source_arms(ref_v, found, scale):
    """元の体の比の腕の長さ {left: [肩, 上腕, 前腕]、right: ...}（REST の体の m）。肩の骨が無い素材は肩を 0 にする。"""
    def length(a, b):
        return float(np.linalg.norm(ref_v[found[b]] - ref_v[found[a]]) * scale) if a in found else 0.0
    return {s: [length(s + "Shoulder", s + "UpperArm"), length(s + "UpperArm", s + "LowerArm"), length(s + "LowerArm", s + "Hand")] for s in OTHER}


def source_wrist(pos, d, side, rest, lengths):
    """この体の肩の付け根から、元の体の比の長さで腕を組んだ手首の位置 [F, 3]。"""
    bones = [side + b for b in ("Shoulder", "UpperArm", "LowerArm", "Hand")]
    at = pos[bones[0] if lengths[0] > 0 else bones[1]]
    for bone, child, length in zip(bones, bones[1:], lengths):
        at = at + qrot(d[bone], np.broadcast_to(unit(rest[child] - rest[bone]), at.shape)) * length * body_ratio(rest)
    return at


def reachable(mid, gap, starts, reach):
    """両手首の差 gap を保って両腕が届く中点のうち、mid に一番近い点。starts と reach は腕の順 (+gap/2 の腕, -gap/2 の腕)。2 つの球の共通部分への Dykstra の射影。"""
    def ball(p, center, radius):
        to = p - center
        far = np.linalg.norm(to, axis=1, keepdims=True)
        return center + to * np.minimum(1, radius / far)
    x, p, q = mid.copy(), 0.0, 0.0
    for _ in range(64):
        y = ball(x + p, starts[0] - gap / 2, reach[0])
        p = x + p - y
        x = ball(y + q, starts[1] + gap / 2, reach[1])
        q = y + q - x
    return x


def solve_arms(pos, d, targets, rest, wrist_limits=False, body_cost=False):
    """targets の (腕, 手首の目標 [F, 3]) ごとに、肘の向きを選んで腕を解く。手の向きは d のまま。返すのは (世界の差 D, 腕ごとの足りない距離)。"""
    out, miss = dict(d), {}
    for s, target in targets:
        hinge, twist = hinge_of(d, s, rest)
        shoulder = pos[s + "UpperArm"]
        along = unit(target - shoulder)
        sides = elbow_sides(along, pos[s + "LowerArm"] - shoulder, d["chest"])
        chosen = smooth_sides(choose_swivel(sides, d[s + "Shoulder"], d[s + "Hand"], s, rest, shoulder, target, hinge, twist, wrist_limits, d["chest"] if body_cost else None), along)
        du, dl, short = place_elbow(s, rest, shoulder, target, chosen, hinge, twist)
        out[s + "UpperArm"], out[s + "LowerArm"] = du, roll_share(dl, d[s + "Hand"], s, rest)
        miss[s] = np.abs(short)
    return out, miss


def solve_both(m, gap, side, rest, arms, origin=None, body_cost=False):
    """両手首の差（もう一方 - side、[F, 3]）を保って両腕を解く。返すのは (中間形式, 記録)。

    origin は胴を回す前の動き。両手の位置はこの動きで決める（胴を回しても武器の道筋は変わらない）。
    """
    free = OTHER[side]
    pos, d = C.joints(m, rest), C.world_deltas(m)
    first, first_d = (pos, d) if origin is None else (C.joints(origin, rest), C.world_deltas(origin))
    mid = (source_wrist(first, first_d, "left", rest, arms["left"]) + source_wrist(first, first_d, "right", rest, arms["right"])) / 2
    starts = pos[free + "UpperArm"], pos[side + "UpperArm"]
    moved = reachable(mid, gap, starts, [sum(arm_lengths(s, rest)) * REACH for s in (free, side)])
    shift = np.linalg.norm(moved - mid, axis=1)
    out, miss = solve_arms(pos, d, ((free, moved + gap / 2), (side, moved - gap / 2)), rest, body_cost=body_cost)
    result = C.from_world_deltas(out, m["hips"], m["contacts"])
    err = gap_error(result, gap, side, rest)
    lost = np.flatnonzero(miss["left"] + miss["right"] > 5e-5)
    weapon = np.linalg.norm(C.joints(result, rest)[side + "Hand"] - first[side + "Hand"], axis=1)
    return result, {"solve": "both-arms", "holdHand": side, "reachMissMaxCm": round(float(max(miss["left"].max(), miss["right"].max()) * 100), 2), "gapErrorMaxCm": round(float(err.max() * 100), 2),
                    "reachShift": {"frames": int((shift > 5e-5).sum()), "maxCm": round(float(shift.max() * 100), 2)}, "unreachedFrames": lost.tolist(),
                    "weaponMoveCm": {"max": round(float(weapon.max() * 100), 1), "median": round(float(np.median(weapon) * 100), 1)}}


def arm_report(m, rest):
    """左右の腕のねじれ、手首の折れとひねりの全コマの最大（度）と、この体で手か肘が胴に入るコマの数。"""
    d = C.world_deltas(m)
    out = {}
    for s in OTHER:
        upper_axis, lower_axis = arm_axes(s, rest)
        n = len(d[s + "Hand"])

        def angles(parent, bone, axis):
            twist, swing = swing_twist(qmul(qinv(d[parent]), d[bone]), np.broadcast_to(axis, (n, 3)))
            return float(np.degrees(np.abs(twist).max())), float(np.degrees(swing.max()))
        upper_twist = angles(s + "Shoulder", s + "UpperArm", upper_axis)[0]
        lower_twist = angles(s + "UpperArm", s + "LowerArm", lower_axis)[0]
        wrist_twist, wrist_bend = angles(s + "LowerArm", s + "Hand", lower_axis)
        out[s] = {"upperTwistDegMax": round(upper_twist, 1), "lowerTwistDegMax": round(lower_twist, 1), "wristTwistDegMax": round(wrist_twist, 1), "wristBendDegMax": round(wrist_bend, 1)}
    out["handInBodyFrames"] = int(check.hand_in_body(C.joints(m, rest)).sum())
    return out


def solve_vrma(path, track, fps, side, model, arms, speed=1):
    """回転だけの VRMA の両腕を解いて上書きする（fbx_to_vrma_blender.py の続き）。track は持つ手のローカル座標の差 [F, 3]（model の体の m、コマは fps）、arms は REST の体の m。"""
    m, rest = read_vrma(path), vrm_rest(model)
    local = C.stretch(np.asarray(track, dtype=np.float64) / body_ratio(rest), fps / C.FPS)
    if speed != 1:
        m, local = C.retime(m, speed), C.stretch(local, speed)
    out, rec = apply(m, local, side, rest, arms)
    write_vrma(path, out, generator="charasta tools/compose fbx_to_vrma_blender")
    return {**rec, "frames": C.frames(out), "arms": arm_report(out, rest)}


def one_arm(m, gap, side, rest):
    """side の手を動かさず、もう一方の手首を side の手首 + gap（[F, 3]）へ IK で動かす。返すのは (中間形式, 記録)。"""
    free = OTHER[side]
    upper, lower, hand = free + "UpperArm", free + "LowerArm", free + "Hand"
    pos = C.joints(m, rest)
    d = C.world_deltas(m)
    a = np.linalg.norm(rest[lower] - rest[upper])
    b = np.linalg.norm(rest[hand] - rest[lower])
    n = C.frames(m)
    du, dl = d[upper].copy(), d[lower].copy()
    miss = np.zeros(n)
    for f in range(n):
        s, target = pos[upper][f], pos[side + "Hand"][f] + gap[f]
        to = target - s
        c0 = np.linalg.norm(to)
        c = np.clip(c0, abs(a - b) + 1e-4, (a + b) * REACH)
        miss[f] = abs(c0 - c)
        along = to / c0
        elbow = pos[lower][f] - s
        side_dir = elbow - along * np.dot(elbow, along)        # 肘が出る向き。元の動きの曲がる面
        if np.linalg.norm(side_dir) < 1e-4:
            side_dir = qrot(d["chest"][f], np.array([0, -1.0, 0]))
            side_dir = side_dir - along * np.dot(side_dir, along)
        side_dir = side_dir / np.linalg.norm(side_dir)
        x = (a * a - b * b + c * c) / (2 * c)
        new_elbow = along * x + side_dir * np.sqrt(max(a * a - x * x, 0.0))
        r1 = rotation_between(elbow, new_elbow)
        du[f] = qmul(r1, du[f])
        lower_now = qrot(r1, pos[hand][f] - pos[lower][f])
        r2 = rotation_between(lower_now, along * c - new_elbow)
        dl[f] = qmul(qmul(r2, r1), dl[f])
    d[upper], d[lower] = du, dl
    out = C.from_world_deltas(d, m["hips"], m["contacts"])
    err = gap_error(out, gap, side, rest)
    return out, {"solve": free + "-arm", "holdHand": side, "reachMissMaxCm": round(float(miss.max() * 100), 2), "gapErrorMaxCm": round(float(err.max() * 100), 2),
                 "reachShift": {"frames": 0, "maxCm": 0.0}, "unreachedFrames": np.flatnonzero(miss > 5e-5).tolist(), "weaponMoveCm": {"max": 0.0, "median": 0.0}}
