"""両手の握りを両腕で解く tools/compose/grip.py の確かめ。Blender は呼ばない。

元の動きは、REST の体が剣を両手で持って振る回転だけの動き。腕と肩幅の違う体へ移す。
"""

import hashlib
import json
import struct
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "tools" / "compose"))
import clip as C  # noqa: E402
import grip as G  # noqa: E402
from soma_vrma import qinv, qmul, qrot, write_vrma  # noqa: E402
from vrma_read import read_vrma  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="charasta-grip-"))

# 上限（度）。今の案の実測より少し上で、片腕だけの解き方が超える値
LIMIT = {"lowerTwistDegMax": 60, "wristTwistDegMax": 60, "wristBendDegMax": 90, "upperTwistDegMax": 60}
ELBOW_STEP_LIMIT = 12    # コマの間の肘の向きの変化の上限（度）。ゆっくりした動きなので飛びがあれば超える


def body(arm=1.0, shoulder=1.0):
    """腕の長さと肩幅を変えた体。長さの比は脚に触らないので body_ratio は 1。"""
    rest = dict(C.REST)
    for s, sign in (("left", 1), ("right", -1)):
        shift = (shoulder - 1) * (C.REST[s + "UpperArm"][0] - C.REST[s + "Shoulder"][0])
        rest[s + "UpperArm"] = C.REST[s + "UpperArm"] + [shift, 0, 0]
        rest[s + "LowerArm"] = rest[s + "UpperArm"] + (C.REST[s + "LowerArm"] - C.REST[s + "UpperArm"]) * arm
        rest[s + "Hand"] = rest[s + "LowerArm"] + (C.REST[s + "Hand"] - C.REST[s + "LowerArm"]) * arm
    return rest


def swing_clip(F=60, side="right", straight=False):
    """武器を持って前で振る回転だけの動き。返すのは (中間形式, 持つ手のローカルの差, 元の体の比の腕の長さ)。straight は途中で両腕がほぼ伸びるコマを入れる。"""
    rest = C.REST
    t = np.linspace(0, 1, F)
    d = {b: np.tile(C.IDENTITY, (F, 1)) for b in C.ORDER}
    hips = np.tile(rest["hips"], (F, 1))
    m0 = C.make({}, hips)
    pos = C.joints(m0)
    # 両手を近づけて体の前で大きく回す。手首は前腕に対してゆっくり少しだけ動く
    grip_center = np.stack([-0.08 + 0.2 * np.sin(t * 2 * np.pi), 1.22 + 0.22 * np.cos(t * np.pi), (0.5 if straight else 0.3) - 0.06 * np.cos(t * 2 * np.pi)], 1)
    grip_gap = np.stack([0.05 * np.cos(t * 2 * np.pi), 0.16 + 0.04 * np.sin(t * np.pi), 0.05 * np.sin(t * 2 * np.pi)], 1)
    targets = {side: grip_center, G.OTHER[side]: grip_center + grip_gap}
    for s, sign in (("left", 1.0), ("right", -1.0)):
        shoulder = pos[s + "UpperArm"]
        axis = G.arm_axes(s, rest)[1]
        al = G.unit(targets[s] - shoulder)
        out = np.array([sign, -1.0, 0])
        side_dir = G.unit(out - al * (al @ out)[:, None])
        d[s + "UpperArm"], d[s + "LowerArm"], _ = G.place_elbow(s, rest, shoulder, targets[s], side_dir, np.array([0, -sign, 0]), G.axis_rotation(axis, np.array(0.0)))
        bend = G.axis_rotation(np.tile([0, 0, 1.0], (F, 1)), np.radians(35 * np.sin(t * 3 * np.pi)))
        d[s + "Hand"] = qmul(qmul(d[s + "LowerArm"], G.axis_rotation(np.tile(axis, (F, 1)), np.radians(sign * 70 * np.sin(t * 2 * np.pi)))), bend)
    m = C.from_world_deltas(d, hips)
    local = qrot(qinv(C.world_deltas(m)[side + "Hand"]), targets[G.OTHER[side]] - targets[side])
    lengths = {s: [float(np.linalg.norm(rest[s + "UpperArm"] - rest[s + "Shoulder"])), *map(float, G.arm_lengths(s, rest))] for s in ("left", "right")}
    return m, local, lengths


def within_limits(rep):
    return [(s, k, rep[s][k]) for s in ("left", "right") for k, top in LIMIT.items() if rep[s][k] > top]


def elbow_step(m, side, rest):
    pos = C.joints(m, rest)
    along = G.unit(pos[side + "Hand"] - pos[side + "UpperArm"])
    e = pos[side + "LowerArm"] - pos[side + "UpperArm"]
    out = G.unit(e - along * np.sum(e * along, 1, keepdims=True))
    return np.degrees(np.arccos(np.clip(np.sum(out[1:] * out[:-1], 1), -1, 1))).max()


short = body(arm=0.82, shoulder=0.75)

# 腕の長さと肩幅の違う体で、左右の持ち手とも、前腕のねじれと手首の折れが上限に収まり、片腕だけの解き方は超える
for side in ("right", "left"):
    m, local, arms = swing_clip(side=side)
    out, rec = G.apply(m, local, side, short, arms)
    rep = G.arm_report(out, short)
    print(side, "両腕", rep, rec["weaponMoveCm"], rec["reachShift"])

    assert not within_limits(rep), within_limits(rep)
    assert rec["gapErrorMaxCm"] < 0.1 and rec["reachMissMaxCm"] == 0 and rec["unreachedFrames"] == [], rec
    d0, d1 = C.world_deltas(m), C.world_deltas(out)
    for hand in ("leftHand", "rightHand"):
        assert np.abs(np.sum(d0[hand] * d1[hand], -1)).min() > 1 - 1e-9        # 手の向きは素材のまま
    pos = C.joints(out, short)
    assert np.abs(pos[G.OTHER[side] + "Hand"] - pos[side + "Hand"] - G.gap_for(out, local, side, short)).max() < 1e-3
    for s in ("left", "right"):
        assert np.abs(C.joints(out, short)[s + "UpperArm"] - C.joints(m, short)[s + "UpperArm"]).max() < 1e-9   # 肩は動かない
        bent = np.linalg.norm(pos[s + "LowerArm"] - pos[s + "UpperArm"], axis=1)
        assert np.abs(bent - G.arm_lengths(s, short)[0]).max() < 1e-9
    one, one_rec = G.apply(m, local, side, short)
    one_rep = G.arm_report(one, short)
    print(side, "片腕", one_rep)
    assert within_limits(one_rep), one_rep
    assert one_rec["weaponMoveCm"]["max"] == 0 and one_rec["solve"] == G.OTHER[side] + "-arm"
    assert rec["weaponMoveCm"]["max"] > 1                                       # 持つ手が動いて、その量が記録に残る
    moved = np.linalg.norm(pos[side + "Hand"] - C.joints(m, short)[side + "Hand"], axis=1)
    assert abs(moved.max() * 100 - rec["weaponMoveCm"]["max"]) < 0.06

# 両手の中点は、肩の付け根から元の体の比で組んだ位置に来る
m, local, arms = swing_clip()
narrow = body(shoulder=0.75)
out, rec = G.apply(m, local, "right", narrow, arms)
pos0, d0 = C.joints(m, narrow), C.world_deltas(m)
pos1 = C.joints(out, narrow)
want = (G.source_wrist(pos0, d0, "left", narrow, arms["left"]) + G.source_wrist(pos0, d0, "right", narrow, arms["right"])) / 2
assert rec["reachShift"]["frames"] == 0 and np.abs((pos1["leftHand"] + pos1["rightHand"]) / 2 - want).max() < 1e-3

# 肘の向きはコマの間で続く。ゆっくりした動きで、候補の刻みの段差も回転だけの肘の面の裏返りも出ない
for straight in (False, True):
    m, local, arms = swing_clip(F=120, straight=straight)
    out, rec = G.apply(m, local, "right", short, arms)
    steps = {s: elbow_step(out, s, short) for s in ("left", "right")}
    print("肘の向きの変化の最大", straight, steps, rec["reachShift"])
    assert max(steps.values()) < ELBOW_STEP_LIMIT, steps
    d = C.world_deltas(out)
    for b in ("leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm"):
        step = np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(d[b][1:] * d[b][:-1], 1)), 0, 1))).max()
        assert step < ELBOW_STEP_LIMIT, (b, step)

# 手の向きがコマごとに揺れても、肘は一緒に震えない
m, local, arms = swing_clip(F=120)
d = C.world_deltas(m)
shake = G.axis_rotation(np.tile([0, 0, 1.0], (120, 1)), np.radians(np.where(np.arange(120) % 2, 45.0, -45.0)))
d = {**d, "rightHand": qmul(d["rightHand"], shake)}
out, _ = G.apply(C.from_world_deltas(d, m["hips"]), qrot(qinv(d["rightHand"]), qrot(C.world_deltas(m)["rightHand"], local)), "right", short, arms)
assert elbow_step(out, "right", short) < ELBOW_STEP_LIMIT, elbow_step(out, "right", short)

# 候補の 5 度の刻みの段差は残らない
stairs = np.radians(np.repeat(np.arange(8) * 5.0, 6))
sides = np.stack([np.cos(stairs), np.sin(stairs), np.zeros(len(stairs))], 1)
soft = G.smooth_sides(sides, np.tile([0, 0, 1.0], (len(stairs), 1)))
assert np.degrees(np.arccos(np.clip(np.sum(soft[1:] * soft[:-1], 1), -1, 1))).max() < 2 and abs(np.linalg.norm(soft, axis=1) - 1).max() < 1e-9

# 手首のひねりが 1 コマで 180 度近く跳ぶ: 片道でも往復でも、前腕のロールは 1 コマ 30 度までで、跳んだあとに逆回りのねじれが残らない
forearm = G.arm_axes("left", C.REST)[1]
limit = np.degrees(G.ROLL_STEP) + 1e-6


def turned(degrees):
    return G.axis_rotation(np.tile(forearm, (len(degrees), 1)), np.radians(degrees))


for jump in (174.0, 176.0, 184.0):
    n = 40
    one_way = np.where(np.arange(n) < 10, -jump / 2, jump / 2)
    both_ways = np.where((np.arange(n) >= 10) & (np.arange(n) < 12), jump / 2, -jump / 2)
    for path in (one_way, both_ways):
        lower = np.tile(C.IDENTITY, (n, 1))
        rolled = G.roll_share(lower, turned(path), "left", C.REST)
        roll = np.degrees(G.swing_twist(rolled, np.tile(forearm, (n, 1)))[0])
        left = np.degrees(G.swing_twist(qmul(qinv(rolled), turned(path)), np.tile(forearm, (n, 1)))[0])
        assert np.abs(np.diff(roll)).max() <= limit, (jump, roll)
        wrapped = (path + 180) % 360 - 180
        assert np.abs(roll).max() <= 92.1 and abs(roll[-1] - wrapped[-1] / 2) < 1e-6 and abs(left[-1] - wrapped[-1] / 2) < 1e-6, (jump, roll, left)

    # 動き全体を通しても同じ。右手のひねりが跳んだ先で、前腕と手首のねじれが上限に収まる
    m, local, arms = swing_clip(F=60)
    d = C.world_deltas(m)
    axis = np.tile(G.arm_axes("right", C.REST)[1], (60, 1))
    for frames in (np.arange(60) >= 25, (np.arange(60) >= 25) & (np.arange(60) < 28)):
        hand = qmul(d["rightHand"], G.axis_rotation(axis, np.radians(np.where(frames, jump / 2, -jump / 2))))
        kicked = {**d, "rightHand": hand}
        clip_ = C.from_world_deltas(kicked, m["hips"])
        out, rec = G.apply(clip_, qrot(qinv(hand), qrot(d["rightHand"], local)), "right", short, arms)
        done = C.world_deltas(out)
        for bone in ("leftHand", "rightHand"):
            assert np.abs(np.sum(done[bone] * kicked[bone], -1)).min() > 1 - 1e-9
        for side_ in ("left", "right"):
            ax = np.tile(G.arm_axes(side_, short)[1], (60, 1))
            roll = np.degrees(G.swing_twist(qmul(qinv(done[side_ + "UpperArm"]), done[side_ + "LowerArm"]), ax)[0])
            assert np.abs((np.diff(roll) + 180) % 360 - 180).max() <= limit + 5, (jump, side_, roll)      # 5 度は肘の向きの変化のぶん
        rep = G.arm_report(out, short)
        assert rep["left"]["lowerTwistDegMax"] <= LIMIT["lowerTwistDegMax"] and rep["right"]["lowerTwistDegMax"] <= 95, (jump, rep)
        tail = C.make({b: q[35:] for b, q in out["rotations"].items()}, out["hips"][35:])
        rep = G.arm_report(tail, short)
        assert rep["right"]["lowerTwistDegMax"] <= 95 and rep["right"]["wristTwistDegMax"] <= 95, (jump, rep)   # 元の動きのひねりは最大 162 度で、半分ずつになる

# elbowPrior の肘は重力と体の外へ向き、肩の回旋は可動域に収まる。両手の位置は胴を回す前の動きで決める
import anatomy as A  # noqa: E402
import neck as N  # noqa: E402
m, local, arms = swing_clip(F=60)
out, rec = G.apply(m, local, "right", short, arms, body_cost=True)
for side_ in ("left", "right"):
    f = A.arm_frames(out, side_, short)
    assert np.median(f["elbowDown"]) > 0.5 and f["elbowDown"].min() > -0.2, (side_, np.median(f["elbowDown"]), f["elbowDown"].min())


def guard_clip(F=30):
    """腕を肩の高さで前へ出し、肘を下へ向けて両手を顔の前に構える動き。手首は前腕のまま。"""
    rest = C.REST
    t = np.linspace(0, 1, F)
    d = {x: np.tile(C.IDENTITY, (F, 1)) for x in C.ORDER}
    hips = np.tile(rest["hips"], (F, 1))
    pos = C.joints(C.make({}, hips))
    center = np.stack([0.02 * np.sin(t * 6), 1.5 + 0.02 * np.cos(t * 6), 0.3 + 0.02 * np.sin(t * 3)], 1)
    gap = np.tile([0, 0.12, 0.02], (F, 1))
    want = {"right": center, "left": center + gap}
    for s, sign in (("left", 1.0), ("right", -1.0)):
        shoulder = pos[s + "UpperArm"]
        al = G.unit(want[s] - shoulder)
        down = np.array([0.2 * sign, -1.0, 0])
        side_dir = G.unit(down - al * (al @ down)[:, None])
        d[s + "UpperArm"], d[s + "LowerArm"], _ = G.place_elbow(s, rest, shoulder, want[s], side_dir, np.array([0, -sign, 0]), G.axis_rotation(G.arm_axes(s, rest)[1], np.array(0.0)))
        d[s + "Hand"] = d[s + "LowerArm"]
    m = C.from_world_deltas(d, hips)
    return m, qrot(qinv(C.world_deltas(m)["rightHand"]), gap), {s: [float(np.linalg.norm(rest[s + "UpperArm"] - rest[s + "Shoulder"])), *map(float, G.arm_lengths(s, rest))] for s in ("left", "right")}


# 腕を前へ出した構えでも肘は開かない
m, local, arms = guard_clip()
out, rec = G.apply(m, local, "right", short, arms, body_cost=True)
for side_ in ("left", "right"):
    f = A.arm_frames(out, side_, short)
    print("構えの肘", side_, round(float(np.median(f["elbowDown"])), 2), round(float(np.median(f["elbowOut"])), 2))
    assert np.median(f["elbowDown"]) > 0.7, (side_, np.median(f["elbowDown"]), np.median(f["elbowOut"]))
m, local, arms = swing_clip(F=60)
saved, G.ELBOW_PRIOR = G.ELBOW_PRIOR, 0.0
pos0, d0 = C.joints(m, short), C.world_deltas(m)
along = G.unit(pos0["leftHand"] - pos0["leftUpperArm"])
sides = G.elbow_sides(along, pos0["leftLowerArm"] - pos0["leftUpperArm"], d0["chest"])
hinge, twist = G.hinge_of(d0, "left", short)
seen = 0
for k in range(len(G.SWIVEL)):
    du, dl, _ = G.place_elbow("left", short, pos0["leftUpperArm"], pos0["leftHand"], sides[k], hinge, twist)
    cost = G.swivel_body_cost(sides[k], du, dl, d0["leftHand"], "left", short, d0["chest"])
    into = qinv(d0["chest"])
    rot = A.arm_angles(G.unit(qrot(into, qrot(du, np.tile(G.arm_axes("left", short)[0], (60, 1))))), G.unit(qrot(into, qrot(dl, np.tile(G.arm_axes("left", short)[1], (60, 1))))), G.unit(qrot(into, qrot(d0["leftHand"], np.tile([0, -1.0, 0], (60, 1))))), 1.0)["rotation"]
    far = rot > A.ROM["rotation"][1] + 20
    seen += int(far.sum())
    assert (cost[far] >= G.LIMIT_COST * 400).all(), k                                             # 肩の可動域を超えると罰が入る
assert seen > 50
G.ELBOW_PRIOR = saved
assert saved > 0                                                                                 # 肘が向く方向の無理は重力と体の外の向きから測る
along = np.tile([0, 0, 1.0], (60, 1))
du, dl = np.tile(C.IDENTITY, (60, 1)), np.tile(C.IDENTITY, (60, 1))
low = G.swivel_body_cost(np.tile(G.unit(np.array([G.ELBOW_OUT, -1.0, 0])), (60, 1)), du, dl, d0["leftHand"] * 0 + C.IDENTITY, "left", short, np.tile(C.IDENTITY, (60, 1)))
high = G.swivel_body_cost(np.tile(G.unit(np.array([-G.ELBOW_OUT, 1.0, 0])), (60, 1)), du, dl, d0["leftHand"] * 0 + C.IDENTITY, "left", short, np.tile(C.IDENTITY, (60, 1)))
assert np.abs(high - low - saved * 180 ** 2).max() < 1e-3, (high[0], low[0])
d = C.world_deltas(m)
m = C.from_world_deltas({**d, "head": qmul(d["chest"], G.axis_rotation(np.tile([0, 1.0, 0], (60, 1)), np.full(60, np.radians(100.0))))}, m["hips"])
turned, nrec = N.solve(m, 70.0, 1.0, keep_arms=True)
assert nrec["chestTurnDegMax"] > 25
wide = body(arm=1.3)
held, rec = G.apply(turned, local, "right", wide, arms, m)
base, _ = G.apply(m, local, "right", wide, arms)
pa, pb = C.joints(held, wide), C.joints(base, wide)
assert rec["gapErrorMaxCm"] < 0.1 and rec["reachShift"]["frames"] == 0 and np.abs(pa["rightHand"] - pb["rightHand"]).max() < 0.002, (rec, np.abs(pa["rightHand"] - pb["rightHand"]).max())
shifted, _ = G.apply(turned, local, "right", wide, arms)
moved = np.abs(C.joints(shifted, wide)["rightHand"] - pb["rightHand"]).max()
print("origin が無いときの手首の移動", moved)
assert moved > 0.003, moved                                                                       # origin が無いと胴と一緒に動く

# 片腕が届かないとき: 差を保ったまま中点だけが動き、両手の誤差は残らない。動いたコマと量が記録に残る
m, local, arms = swing_clip(straight=True)
lop = dict(short)
lop["rightLowerArm"] = lop["rightUpperArm"] + (short["rightLowerArm"] - short["rightUpperArm"]) * 0.6
lop["rightHand"] = lop["rightLowerArm"] + (short["rightHand"] - short["rightLowerArm"]) * 0.6
out, rec = G.apply(m, local, "right", lop, arms)
print("右腕が短い体", rec)
assert rec["reachShift"]["frames"] > 3 and rec["reachShift"]["maxCm"] > 1, rec
assert rec["gapErrorMaxCm"] < 0.05 and rec["reachMissMaxCm"] == 0 and rec["unreachedFrames"] == [], rec
pos = C.joints(out, lop)
reach = sum(G.arm_lengths("right", lop)) * G.REACH
assert (np.linalg.norm(pos["rightHand"] - pos["rightUpperArm"], axis=1) <= reach + 1e-6).all()
assert np.linalg.norm(np.diff(pos["rightHand"], axis=0), axis=1).max() < 0.03                 # 届く範囲へ戻すところで手首は飛ばない

# 両腕が同時に届かないとき: 届かないコマと足りない距離が記録に残り、値は壊れない
far = np.tile([0, 0, 1.6], (len(local), 1))
out, rec = G.apply(m, far, "right", lop, arms)
print("両手の差が腕より長い", {k: rec[k] for k in ("reachMissMaxCm", "gapErrorMaxCm")}, len(rec["unreachedFrames"]))
assert len(rec["unreachedFrames"]) == len(local) and rec["reachMissMaxCm"] > 1 and rec["gapErrorMaxCm"] > 1, rec
assert all(np.isfinite(q).all() for q in out["rotations"].values())

# 腕がずっと伸びた素材でも肘の蝶番を決められる（肘は体の前へ曲がる）
d = {b: np.tile(C.IDENTITY, (20, 1)) for b in C.ORDER}
flat = C.from_world_deltas(d, np.tile(C.REST["hips"], (20, 1)))
for s, sign in (("left", 1.0), ("right", -1.0)):
    hinge, _ = G.hinge_of(C.world_deltas(flat), s, C.REST)
    assert np.isfinite(hinge).all() and hinge[1] * sign < -0.9, hinge

# 肩の骨が無い素材は上腕の付け根から組む
m, local, arms = swing_clip()
pos0, d0 = C.joints(m, C.REST), C.world_deltas(m)
assert np.abs(G.source_wrist(pos0, d0, "left", C.REST, [0.0, *arms["left"][1:]]) - pos0["leftHand"]).max() < 1e-9

# 肘の一定のツイストを読んで、解いたあとも保つ
wrist_axis = G.arm_axes("left", C.REST)[1]
d = dict(d0)
d["leftLowerArm"] = qmul(d["leftLowerArm"], G.axis_rotation(np.tile(wrist_axis, (60, 1)), np.full(60, np.radians(20.0))))
_, read = G.hinge_of(d, "left", C.REST)
assert abs(np.degrees(G.swing_twist(read, wrist_axis)[0]) - 20) < 0.5, read
du, dl, _ = G.place_elbow("left", C.REST, pos0["leftUpperArm"], pos0["leftHand"], G.unit(pos0["leftLowerArm"] - pos0["leftUpperArm"]), np.array([0, -1.0, 0]), read)
assert np.abs(np.degrees(G.swing_twist(qmul(qinv(du), dl), np.tile(wrist_axis, (60, 1)))[0]) - 20).max() < 0.5

# 脚の比が 1 でない体: 両手首の差と元の体の比の腕の長さは、hips から爪先までの高さの比で縮む
small = dict(short)
small["leftToes"] = short["leftToes"] + [0, 0.2, 0]
ratio = (small["hips"][1] - 0.2 - C.REST["leftToes"][1]) / (C.HIPS_HEIGHT - C.REST["leftToes"][1])
assert abs(G.body_ratio(small) - ratio) < 1e-9 and ratio < 0.85
out, rec = G.apply(m, local, "right", small, arms)
pos = C.joints(out, small)
assert np.abs(np.linalg.norm(pos["leftHand"] - pos["rightHand"], axis=1) - np.linalg.norm(local, axis=1) * ratio).max() < 1e-3, rec
start = C.joints(m, small)
chain = start["leftShoulder"] + sum(qrot(d0[a], np.tile(G.unit(small[b] - small[a]), (60, 1))) * length * ratio for a, b, length in zip(("leftShoulder", "leftUpperArm", "leftLowerArm"), ("leftUpperArm", "leftLowerArm", "leftHand"), arms["left"]))
assert np.abs(G.source_wrist(start, d0, "left", small, arms["left"]) - chain).max() < 1e-9

# 既定の解き方は見た目で選んだ。数値が変わったら本番の動きが変わるので止める
m, local, arms = swing_clip(F=30)
out, _ = G.apply(m, local, "right", short, arms)
digest = hashlib.sha1(b"".join((np.round(out["rotations"][b], 4) + 0.0).tobytes() for b in ("leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm"))).hexdigest()[:12]
assert digest == "2c10657883f3", digest

# Blender の経路の続き: 回転だけの VRMA を速さのあとで解き直す。track は体の長さの m で、30 fps でなくてもよい
names = [b for b in C.ORDER if b not in C.FINGER_NAMES]
nodes = [{"name": b, "translation": [float(x) for x in short[b] - (short[C.PARENT[b]] if C.PARENT[b] else 0)]} for b in names]
for k, b in enumerate(names):
    kids = [i for i, c in enumerate(names) if C.PARENT[c] == b]
    if kids:
        nodes[k]["children"] = kids
data = json.dumps({"asset": {"version": "2.0"}, "nodes": nodes, "extensions": {"VRMC_vrm": {"humanoid": {"humanBones": {b: {"node": k} for k, b in enumerate(names)}}}}}).encode("utf8")
data += b" " * (-len(data) % 4)
model = TMP / "body.vrm"
model.write_bytes(b"glTF" + struct.pack("<II", 2, 20 + len(data)) + struct.pack("<I", len(data)) + b"JSON" + data)
rest = G.vrm_rest(model)
m, local, arms = swing_clip()
for fps, speed, frames in ((30.0, 0.6, 99), (24.0, 1, 74)):
    vrma = TMP / f"blender-{fps:.0f}.vrma"
    write_vrma(vrma, {**m, "fps": fps}, "test")
    rec = G.solve_vrma(vrma, local * G.body_ratio(rest), fps, "right", model, arms, speed)
    done = read_vrma(vrma)
    assert rec["solve"] == "both-arms" and rec["frames"] == C.frames(done) == frames, rec
    assert rec["gapErrorMaxCm"] < 0.1 and not within_limits(rec["arms"]), rec

# track は体の長さの m で渡す。比が 1 でない体でも二重に縮まない
scaled = dict(rest)
scaled["leftToes"] = rest["leftToes"] + [0, 0.2, 0]
js = json.loads(data)
js["nodes"][names.index("leftToes")]["translation"] = [float(x) for x in scaled["leftToes"] - scaled["leftFoot"]]
data = json.dumps(js).encode("utf8")
data += b" " * (-len(data) % 4)
model.write_bytes(b"glTF" + struct.pack("<II", 2, 20 + len(data)) + struct.pack("<I", len(data)) + b"JSON" + data)
write_vrma(TMP / "scaled.vrma", m, "test")
track = np.tile([0.0, 0.18, 0.02], (60, 1))
rec = G.solve_vrma(TMP / "scaled.vrma", track, 30.0, "right", model, arms)
pos = C.joints(read_vrma(TMP / "scaled.vrma"), scaled)
assert G.body_ratio(scaled) < 0.85 and np.abs(np.linalg.norm(pos["leftHand"] - pos["rightHand"], axis=1) - np.linalg.norm(track, axis=1)).max() < 1e-3, rec

print("OK")
