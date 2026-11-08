"""FBX の指の移し替え tools/compose/fingers.py の確かめ。Blender は呼ばない。"""

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "tools" / "compose"))
import clip as C  # noqa: E402
import fingers as Fg  # noqa: E402
import grip as G  # noqa: E402
from soma_vrma import qinv, qmul, qrot  # noqa: E402

F = 12
ORDER = ["Hand"] + [j for f in Fg.FINGERS for j in (f + x for x in C.FINGER_JOINTS[f])]


def turn(axis, deg):
    return G.axis_rotation(np.tile(axis, (F, 1)), np.radians(np.broadcast_to(deg, (F,))))


def source(side, tilt, flex, base=(0.0, 0.0, 0.0), thumb=None):
    """腕を下ろした元の体の手。tilt は手を手首の軸のまわりに回した量。flex は (付け根, 中間, 遠位) の屈曲で、数か [F]。base は基準の姿勢ですでに曲がった量（度）。thumb は親指の flex。返すのは (found, ref_v, moved, deltas)。"""
    arm = G.axis_rotation(np.array([0, 0, 1.0]), np.radians(-90.0 if side == "left" else 90.0))     # T ポーズの手を下へ向ける
    roll = G.axis_rotation(np.array([0, 1.0, 0]), np.radians(tilt))
    place = qmul(roll, arm)
    names = [side + b for b in ORDER]
    flat = {b: qrot(place, C.REST[b] - C.REST[side + "Hand"]) for b in names}
    plain = Fg.axes(flat, side)
    pos = dict(flat)
    for finger in Fg.FINGERS:
        joints = C.FINGER_JOINTS[finger]
        hinge = plain[f"{side}{finger}{joints[0]}"][:, 1]
        turned = C.IDENTITY
        for k, j in enumerate(joints[:-1]):                                                          # 基準の姿勢の指を曲げる
            turned = qmul(G.axis_rotation(hinge, np.radians(base[k])), turned)
            step = flat[f"{side}{finger}{joints[k + 1]}"] - flat[f"{side}{finger}{j}"]
            pos[f"{side}{finger}{joints[k + 1]}"] = pos[f"{side}{finger}{j}"] + qrot(turned, step)
    found = {b: i for i, b in enumerate(names)}
    ref_v = np.array([pos[b] for b in names])
    e = Fg.axes(pos, side)
    moved = {side + "Hand": turn([0, 1.0, 0], 30 * np.sin(np.arange(F)))}
    for finger in Fg.FINGERS:
        joints = C.FINGER_JOINTS[finger]
        last = moved[side + "Hand"]
        for j, angle in zip(joints, flex if finger != "Thumb" or thumb is None else thumb):
            bone = f"{side}{finger}{j}"
            last = qmul(last, turn(e[bone][:, 1], angle))
            moved[bone] = last
    fix = G.rotation_between(pos[side + "MiddleProximal"] - pos[side + "Hand"], C.REST[side + "MiddleProximal"] - C.REST[side + "Hand"])
    deltas = {b: qmul(q, np.broadcast_to(qinv(fix), (F, 4))) for b, q in moved.items()}
    return found, ref_v, moved, deltas


# 座標の向き: 手のひらは下、屈曲は手のひらの側へ。親指は手のひらと小指の側の中間へ
for side, sign in Fg.SIDES.items():
    fwd_, across_, n_ = Fg.hand_plane(C.REST, side)
    assert n_[1] < -0.95 and fwd_[0] * sign > 0.9 and across_[2] > 0.9, (fwd_, across_, n_)
    e = Fg.axes(C.REST, side)
    q = G.axis_rotation(e[side + "IndexIntermediate"][:, 1], np.radians(40.0))
    assert qrot(q, e[side + "IndexIntermediate"][:, 0])[1] < -0.5                               # 指の先が下がる
    e_t = e[side + "ThumbDistal"]
    bent = qrot(G.axis_rotation(e_t[:, 1], np.radians(40.0)), e_t[:, 0]) - e_t[:, 0]
    assert bent[1] < -0.1 and bent[2] < -0.1, bent                                               # 親指は下へも小指の側へも曲がる

# 手が手首の軸のまわりに回った基準の姿勢でも、指は屈曲の軸だけで曲がる。左右とも同じ。手は変わらない
for side, sign in Fg.SIDES.items():
    for tilt in (0.0, 15.0 * sign):
        found, ref_v, moved, deltas = source(side, tilt, (30.0, 60.0, 40.0))
        out, rec = Fg.transfer(moved, deltas, found, ref_v, "source")
        assert np.array_equal(out[side + "Hand"], deltas[side + "Hand"]) and rec["skippedHands"] == [G.OTHER[side]] and not [k for k in rec["overFrames"] if "Thumb" not in k], rec
        angles = Fg.joint_angles(out, side, C.REST)
        for bone, finger, joint in Fg.bones_of(side):
            if finger == "Thumb":
                continue
            want = {"Proximal": 30, "Intermediate": 60, "Distal": 40}[joint]
            assert np.abs(angles[bone][:, 0] - want).max() < 1.0 and np.abs(angles[bone][:, 1:]).max() < 1.0, (side, tilt, bone, angles[bone][0])

# 前の移し方（最小の回転）は、同じ素材で中間の関節が横へ曲がる
found, ref_v, moved, deltas = source("left", 15.0, (30.0, 60.0, 40.0))
e = Fg.axes(C.REST, "left")
old = Fg.components(qmul(qinv(deltas["leftIndexProximal"]), deltas["leftIndexIntermediate"]), e["leftIndexIntermediate"])
assert np.abs(old[:, 1:]).max() > 3, old[0]

# 逆へ曲がる元の値と、横やひねりの値は範囲へ収まる
q = Fg.from_rotvec(np.tile(np.radians(np.array([0.3, -40.0, 25.0])), (F, 1)))
frame_ = np.eye(3)
c = Fg.components(Fg.fit(q, frame_, "Index", "Intermediate"), frame_)
assert np.abs(c).max() < 1e-6, c[0]
c = Fg.components(Fg.fit(Fg.from_rotvec(np.tile(np.radians([0.0, 130.0, 0.0]), (F, 1))), frame_, "Index", "Distal"), frame_)
assert abs(c[0, 0] - Fg.RANGE["Distal"][1]) < 1e-6
c = Fg.components(Fg.fit(Fg.from_rotvec(np.tile(np.radians([10.0, 20.0, 50.0]), (F, 1))), frame_, "Index", "Proximal"), frame_)
assert abs(c[0, 0] - 20) < 1e-6 and abs(c[0, 1] - 30) < 1e-6 and abs(c[0, 2]) < 1e-6            # 付け根の開きは上限まで残り、ひねりは消える

# 親指の中手骨は手の前の向きから 45 度までに戻り、それより小さい値は変えない
fwd = Fg.hand_plane(C.REST, "left")[0]
a_t = Fg.axes(C.REST, "left")["leftThumbMetacarpal"][:, 0]
big = G.axis_rotation(np.tile(G.unit(np.cross(fwd, a_t)), (F, 1)), np.radians(np.full(F, 60.0)))
got = Fg.thumb_forward(big, a_t, fwd)
assert abs(np.degrees(np.arccos(np.clip(qrot(got, np.tile(a_t, (F, 1))) @ fwd, -1, 1))).max() - Fg.THUMB_FORWARD_DEG) < 1e-6
small = np.tile(C.IDENTITY, (F, 1))
assert np.abs(np.abs(np.sum(Fg.thumb_forward(small, Fg.unit(fwd + a_t), fwd) * small, 1)) - 1).max() < 1e-9


def thumb_angle(d, side):
    a = Fg.axes(C.REST, side)[side + "ThumbMetacarpal"][:, 0]
    hand_fwd = Fg.hand_plane(C.REST, side)[0]
    return np.degrees(np.arccos(np.clip(qrot(qinv(d[side + "Hand"]), qrot(d[side + "ThumbMetacarpal"], np.tile(a, (F, 1)))) @ hand_fwd, -1, 1)))


# 親指の中手骨が手の前の向きから 100 度開いた素材: 左右とも 45 度まで戻る。動かない素材の結果は止まったまま
for side in Fg.SIDES:
    found, ref_v, moved, deltas = source(side, 0.0, (30.0, 60.0, 40.0), thumb=(100.0, 20.0, 20.0))
    out, rec = Fg.transfer(moved, deltas, found, ref_v, "source")
    bare = thumb_angle({b: q for b, q in deltas.items()}, side)
    assert np.abs(thumb_angle(out, side) - Fg.THUMB_FORWARD_DEG).max() < 1.0, thumb_angle(out, side)
    assert bare.max() > 70, bare.max()
    local = qmul(qinv(out[side + "Hand"]), out[side + "ThumbMetacarpal"])
    assert np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(local[1:] * local[:-1], 1)), 0, 1))).max() < 1e-3
    assert side + "ThumbMetacarpal" in rec["overFrames"], rec

# 屈曲が時間で変わる素材: コマごとに追う。親指の中手骨も、固定の姿勢に動きが足される
wave = 30 + 25 * np.sin(np.arange(F) / 2)
for side in Fg.SIDES:
    found, ref_v, moved, deltas = source(side, 8.0, (wave, 60 + wave / 2, 40.0), thumb=(100 + wave / 5, 20.0, 20.0))
    out, _ = Fg.transfer(moved, deltas, found, ref_v, "source")
    angles = Fg.joint_angles(out, side, C.REST)
    assert np.abs(angles[side + "IndexProximal"][:, 0] - wave).max() < 1.5, angles[side + "IndexProximal"][:, 0]
    assert np.abs(angles[side + "RingIntermediate"][:, 0] - (60 + wave / 2)).max() < 1.5
    local = qmul(qinv(out[side + "Hand"]), out[side + "ThumbMetacarpal"])
    moved_deg = np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(local * local[:1], 1)), 0, 1)))
    want = np.abs(wave - wave[0]) / 5
    assert np.abs(moved_deg - want).max() < 0.5, (moved_deg, want)                               # 中手骨の動きは消えない

# 基準の姿勢で曲がった指: 屈曲の軸は反転せず、関節の曲がりがそのまま読める。親指も同じ
for side in Fg.SIDES:
    found, ref_v, moved, deltas = source(side, 0.0, (0.0, 0.0, 0.0), base=(0.0, 100.0, 0.0))
    out, _ = Fg.transfer(moved, deltas, found, ref_v, "source")
    angles = Fg.joint_angles(out, side, C.REST)
    for finger in ("Index", "Little"):
        bone = side + finger + "Intermediate"
        assert abs(angles[bone][0, 0] - 100) < 2 and np.abs(angles[bone][0, 1:]).max() < 2, (bone, angles[bone][0])
    found, ref_v, moved, deltas = source(side, 0.0, (0.0, 0.0, 0.0), base=(110.0, 0.0, 0.0))     # 付け根が手のひらの法線を超えて曲がる
    source_axes = Fg.axes({k: ref_v[i] for k, i in found.items()}, side)
    plain = Fg.hand_plane({k: ref_v[i] for k, i in found.items()}, side)
    hinge = G.unit(np.cross(plain[0], plain[2]))
    for bone in (side + "IndexProximal", side + "IndexIntermediate", side + "ThumbMetacarpal", side + "ThumbProximal", side + "ThumbDistal"):
        assert source_axes[bone][:, 1] @ (hinge if "Thumb" not in bone else G.unit(np.cross(plain[0], plain[2] - plain[1]))) > 0.3, bone
    assert abs(source_axes[side + "IndexIntermediate"][:, 1] @ source_axes[side + "IndexProximal"][:, 1] - 1) < 0.05

# 手の面に対して斜めに曲がる指でも、子の骨は親の屈曲の軸を引き継ぐ
pos = dict(C.REST)
root = Fg.axes(C.REST, "left")["leftIndexProximal"]
slant = G.unit(root[:, 1] + 0.7 * root[:, 2])
pos["leftIndexDistal"] = pos["leftIndexIntermediate"] + qrot(G.axis_rotation(slant, np.radians(100.0)), C.REST["leftIndexDistal"] - C.REST["leftIndexIntermediate"])
pos["leftIndexIntermediate"] = pos["leftIndexProximal"] + (C.REST["leftIndexIntermediate"] - C.REST["leftIndexProximal"])
e = Fg.axes(pos, "left")
a_child = e["leftIndexIntermediate"][:, 0]
want = G.unit(e["leftIndexProximal"][:, 1] - a_child * (a_child @ e["leftIndexProximal"][:, 1]))
assert abs(e["leftIndexIntermediate"][:, 1] @ want - 1) < 1e-6 and abs(Fg.root_flex(a_child, Fg.hand_plane(pos, "left")[2], want) @ want - 1) > 0.02

# 指の骨が足りない手は前の移し方のまま。記録に残る
found, ref_v, moved, deltas = source("right", 0.0, (30.0, 60.0, 40.0))
partial = {k: v for k, v in found.items() if k != "rightRingDistal"}
out, rec = Fg.transfer(moved, deltas, partial, ref_v, "source")
assert all(np.array_equal(out[b], deltas[b]) for b in deltas) and rec["skippedHands"] == ["left", "right"], rec

# 親指の第 1 関節は上限で止まり、第 2 関節は握りこぶしの素材で止まらない。曲がりは屈曲だけ
found, ref_v, moved, deltas = source("left", 0.0, (0.0, 70.0, 75.0))
out, rec = Fg.transfer(moved, deltas, found, ref_v, "source")
angles = Fg.joint_angles(out, "left", C.REST)
for j, top in (("Proximal", 50), ("Distal", 75)):
    assert abs(angles["leftThumb" + j][:, 0] - top).max() < 1.0 and np.abs(angles["leftThumb" + j][:, 1:]).max() < 1.0, (j, angles["leftThumb" + j][0])
assert rec["overFrames"]["leftThumbProximal"] == [F, 0, 0], rec

# 指が動かず握っている素材は筒を包む形になる。素材の握り方に左右されない。右手は左手の鏡像
for side in Fg.SIDES:
    results = []
    for flex in ((35.0, 85.0, 85.0), (60.0, 70.0, 40.0)):
        found, ref_v, moved, deltas = source(side, 0.0, flex, thumb=(0.0, 10.0, 10.0))
        out, rec = Fg.transfer(moved, deltas, found, ref_v)
        assert rec["fist"] == [side], rec
        results.append(out)
    angles = Fg.joint_angles(results[0], side, C.REST)
    for bone, finger, joint in Fg.bones_of(side):
        if finger != "Thumb":
            want = Fg.wrap_finger(*Fg.HAND[finger], Fg.GRIP_DIAMETER_CM)[C.FINGER_JOINTS[finger].index(joint)]
            assert abs(angles[bone][:, 0] - want).max() < 1e-6 and np.abs(angles[bone][:, 1:]).max() < 1e-6, bone
        hand0, hand1 = results[0][side + "Hand"], results[1][side + "Hand"]
        assert np.abs(np.abs(np.sum(qmul(qinv(hand0), results[0][bone]) * qmul(qinv(hand1), results[1][bone]), 1)) - 1).max() < 1e-9, bone
left, right = Fg.fist_pose("left"), Fg.fist_pose("right")
for bone, finger, joint in Fg.bones_of("left"):
    q = left[bone]
    assert np.abs(np.abs(np.sum(np.array([q[0], -q[1], -q[2], q[3]]) * right["right" + bone[4:]])) - 1) < 1e-6, bone


def ring(finger, diameter):
    """指の節の手の断面の位置 [(前, 手のひらの側)]。"""
    knuckle, lengths = Fg.HAND[finger]
    flex = Fg.wrap_finger(knuckle, lengths, diameter)
    at, angle, out = np.array([knuckle[0], knuckle[2]]), 0.0, []
    for bend, length in zip(flex, lengths):
        angle += np.radians(bend)
        next_ = at + length * np.array([np.cos(angle), np.sin(angle)])
        out.append((at, next_))
        at = next_
    return out


# 指の節は筒の中心から同じ距離の円の上に載り、骨の中点は筒から離れ、指先は手のひらの側へ閉じる
for diameter in (2.5, 3.2, 4.5):
    radius, axis, center = Fg.grip_circle(diameter)
    for finger in Fg.HAND:
        knuckle = Fg.HAND[finger][0]
        c3 = center + axis * (knuckle[1] - center[1]) / axis[1]
        c = np.array([c3[0], c3[2]])
        rho = np.hypot(radius + Fg.FINGER_RADIUS, max(Fg.HAND[finger][1]) / 2)
        segments = ring(finger, diameter)
        for a, b in segments[:]:
            assert abs(np.linalg.norm(b - c) - rho) < 1e-6, (finger, diameter)
            assert np.linalg.norm((a + b) / 2 - c) >= radius + Fg.FINGER_RADIUS * 0.6, (finger, diameter)
        assert segments[-1][1][1] > radius, (finger, diameter)

# 手のひらを見て、親指は付け根から小指の側へ斜めに横切る。左右は鏡像で、先の骨は手の前と小指の側を向く
for side, sign in Fg.SIDES.items():
    pose = Fg.fist_pose(side)
    E = np.array(Fg.hand_plane(C.REST, side))
    names = [side + "Thumb" + j for j in C.FINGER_JOINTS["Thumb"]]
    q, p, prev, at = C.IDENTITY, np.zeros(3), side + "Hand", {}
    for b in names:
        p = p + qrot(q, C.REST[b] - C.REST[prev])
        q = qmul(q, pose[b])
        at[b], prev = (p, q), b
    tip_dir = E @ qrot(at[names[2]][1], G.unit(C.REST[names[2]] - C.REST[names[1]]))
    tip = E @ (at[names[2]][0] + qrot(at[names[2]][1], C.REST[names[2]] - C.REST[names[1]]))
    base = E @ at[names[0]][0]
    assert tip_dir[1] < -0.3 and tip_dir[0] > 0.5, (side, tip_dir)
    assert tip[1] < base[1] and tip[0] > base[0] + 0.03, (side, tip, base)

# 筒が太いほど指は開き、計画の太さが効く
thin, thick = Fg.fist_pose("left", 2.5), Fg.fist_pose("left", 4.5)
found, ref_v, moved, deltas = source("left", 0.0, (35.0, 85.0, 85.0))
small_hand = Fg.joint_angles(Fg.transfer(moved, deltas, found, ref_v, None, 2.5)[0], "left", C.REST)
large_hand = Fg.joint_angles(Fg.transfer(moved, deltas, found, ref_v, None, 4.5)[0], "left", C.REST)
for bone in ("leftIndexProximal", "leftMiddleIntermediate", "leftRingDistal"):
    assert small_hand[bone][0, 0] > large_hand[bone][0, 0] + 3, bone
assert np.degrees(2 * np.arccos(np.clip(abs(float(thin["leftThumbDistal"] @ thick["leftThumbDistal"])), 0, 1))) > 3

# 開いた手と、指が動く素材は移す。handPose で選べる
found, ref_v, moved, deltas = source("left", 0.0, (10.0, 20.0, 10.0))
assert Fg.transfer(moved, deltas, found, ref_v)[1]["fist"] == []
found, ref_v, moved, deltas = source("left", 0.0, (wave, 60 + wave, 60.0))
out, rec = Fg.transfer(moved, deltas, found, ref_v)
assert rec["fist"] == [] and np.ptp(Fg.joint_angles(out, "left", C.REST)["leftIndexProximal"][:, 0]) > 30, rec
assert Fg.transfer(moved, deltas, found, ref_v, "fist")[1]["fist"] == ["left"]
found, ref_v, moved, deltas = source("left", 0.0, (35.0, 85.0, 85.0))
assert Fg.transfer(moved, deltas, found, ref_v, "source")[1]["fist"] == []

# 指が動く手でも、閉じたコマの親指は握りの形へ寄る。開いたコマは元の親指のまま
wave_ = 10 + 80 * (np.arange(F) / (F - 1))
for side in Fg.SIDES:
    found, ref_v, moved, deltas = source(side, 0.0, (10.0, wave_, 30.0), thumb=(10.0, 20.0, 10.0))
    out, rec = Fg.transfer(moved, deltas, found, ref_v)
    assert rec["fist"] == [], rec
    fist = Fg.fist_pose(side)
    for j in C.FINGER_JOINTS["Thumb"]:
        bone = side + "Thumb" + j
        local = qmul(qinv(out[C.PARENT[bone]]), out[bone])
        assert abs(abs(float(local[-1] @ fist[bone])) - 1) < 1e-6, bone
    assert abs(Fg.joint_angles(out, side, C.REST)[side + "ThumbProximal"][0, 0] - 20) < 1.5

# 手ごとに handPose と太さを書ける
both = {}
for side in Fg.SIDES:
    found, ref_v, moved, deltas = source(side, 0.0, (35.0, 85.0, 85.0))
    for key, pose_ in (("left", {"left": "fist", "right": "source"}), ("right", {"left": "source", "right": "fist"})):
        rec = Fg.transfer(moved, deltas, found, ref_v, pose_)[1]
        assert rec["fist"] == ([side] if key == side else []), (side, key, rec)
    wide = Fg.transfer(moved, deltas, found, ref_v, "fist", {side: 4.5})[0]
    plain = Fg.transfer(moved, deltas, found, ref_v, "fist", 3.2)[0]
    narrow = Fg.transfer(moved, deltas, found, ref_v, "fist", 4.5)[0]
    assert np.array_equal(wide[side + "IndexProximal"], narrow[side + "IndexProximal"]) and not np.array_equal(plain[side + "IndexProximal"], narrow[side + "IndexProximal"])

print("OK")
