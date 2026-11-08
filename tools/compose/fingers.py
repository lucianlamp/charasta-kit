"""指の関節を測り、FBX の指を VRM の指の関節へ移す。

座標は骨ごとに、骨の軸 a、屈曲の軸 f、横の開きの軸 s の 3 本で決める。
手の面: fwd は手首から中指の付け根、across は小指の付け根から人差し指の付け根、手のひらの法線 n = fwd × across（右手は符号を変える）。
付け根の骨の屈曲の軸 f は手の面から決める: a × n（指が手のひらの側へ曲がると正）。親指は手のひらと小指の側の中間へ曲がるので a × (n - across)。
子の骨は親の f を a に直交させて引き継ぐ。基準の姿勢で曲がった指でも向きが反転しない。
関節の回転は親の座標から見た骨の座標の回転で、回転ベクトルの f、s、a の成分を屈曲、横の開き、ひねりと呼ぶ。T ポーズが 0。

移すときは手の座標から指の座標までの回転を、元の体の基準の姿勢の座標で読み、T ポーズの座標へ置く。姿勢と動きを分ける: クリップの中央値の関節の回転 L0 を RANGE へ収めて
親指の中手骨を手の前の向きから THUMB_FORWARD_DEG までに戻した固定の姿勢 P を作り、出力は P * (L0^-1 * L(t)) を LOOSE へ収めた値にする。動きは消えない。
Warrior の親指の中手骨は手の前の向きから 100 度近く開き、手のひらの法線を向く（元の動きの値）。VRM の親指の付け根は手首に近いので、そのままだと親指が手首の側へ折れて見える。
手の回転には触らないので、腕と握りは変わらない。

指が動かず握っている素材は、元の回転を移さず、柄の太さの筒を包む固定の姿勢にする（Warrior の指は全コマ固定で、握っているだけ）。計画の handPose と gripDiameterCm で選べる。
手の寸法は VRoid の手の比（手首から中指の付け根の長さ L を 1 にした値）で持つ。筒の太さは手の全長との比なので、どのキャラにも同じ比で当たり、1 本の VRMA を共有できる。
"""

from __future__ import annotations

import numpy as np

import clip as C
from grip import axis_rotation, matrix_quat
from soma_vrma import continuous, qinv, qmul, qnormalize, qrot

SIDES = {"left": 1.0, "right": -1.0}
FINGERS = tuple(C.FINGER_JOINTS)
# 固定の姿勢の範囲 (屈曲の下限, 屈曲の上限, 横の開きの絶対値, ひねりの絶対値)。中間と遠位の関節は屈曲だけ
# 親指の第 1 関節の 50 度は人の MP 関節の屈曲（50〜60 度）の下の端。2Handed_Attack1 で 70 度だと親指の先が柄の手前へ折れた（sample-b の 4 案の比較）。第 2 関節の 80 度は人の IP 関節の屈曲
RANGE = {"Proximal": (-30.0, 100.0, 30.0, 0.0), "Intermediate": (0.0, 110.0, 0.0, 0.0), "Distal": (0.0, 90.0, 0.0, 0.0), "ThumbMetacarpal": (-20.0, 70.0, 45.0, 30.0), "ThumbProximal": (0.0, 50.0, 0.0, 0.0), "ThumbDistal": (0.0, 80.0, 0.0, 0.0)}
# 動きを足したあとの緩い範囲
LOOSE = {"Proximal": (-40.0, 110.0, 40.0, 30.0), "Intermediate": (-10.0, 120.0, 15.0, 15.0), "Distal": (-10.0, 100.0, 15.0, 15.0), "ThumbMetacarpal": (-60.0, 90.0, 75.0, 60.0), "ThumbProximal": (-20.0, 80.0, 20.0, 20.0), "ThumbDistal": (-10.0, 90.0, 20.0, 20.0)}
# 手の座標（前、親指の側、手のひらの法線）の VRoid の手の寸法。単位は L。指は (付け根の位置, 3 本の骨の長さ)
HAND = {"Index": ((0.97, 0.25, 0.03), (0.50, 0.30, 0.36)), "Middle": ((1.00, 0.00, 0.00), (0.55, 0.34, 0.37)), "Ring": ((0.96, -0.22, -0.02), (0.50, 0.32, 0.36)), "Little": ((0.88, -0.42, -0.05), (0.40, 0.25, 0.32))}
HAND_LENGTH = 2.27           # 手首から中指の先までの長さ（L）
HUMAN_HAND_CM = 18.0         # 大人の手の長さ。gripDiameterCm はこの手での太さ
FINGER_RADIUS = 0.25         # 筒から指の骨の中心線までの間（L）。実メッシュが筒へ入らない値
PALM_SURFACE = 0.32          # 手のひらの面の高さ（L）
GRIP_DIAMETER_CM = 3.2       # 片手剣、両手剣の柄の太さ
GRIP_FWD = 0.72              # 筒の中心の手の前の向きの位置（L）
GRIP_TILT_DEG = 20.0         # 筒の軸の、親指の側から手の前へ倒す角度。柄は人差し指の付け根から小指の側の手首へ斜めに通る
# 親指の関節の回転（左手。右手は鏡像）。手のひらを見て、親指が付け根から人差し指と中指の先の側へ斜めに横切る値を、全キャラの頂点で探した（先の骨は小指の側を向く）。既定の太さの値
FIST_THUMB = {'Metacarpal': [0.66057, -0.05617, -0.24645, 0.70694], 'Proximal': [0.01118, 0.08571, -0.01118, 0.99619], 'Distal': [0.06414, 0.4917, -0.06414, 0.86603]}
THUMB_CLOSE_DEG = (45.0, 75.0)       # 指が動く手で、4 本の指の中間の関節の屈曲の平均がこの間のコマは親指を握りの形へ寄せる
STILL_DEG, CLOSED_DEG = 5.0, 45.0    # 関節の動きがこれより小さく、中間の関節の屈曲がこれより大きい素材を握っていると読む
SLACK = 10.0                 # 素材が RANGE を超えたと数えるときの許し
THUMB_FORWARD_DEG = 45.0     # 親指の中手骨と手の前の向きの角度の上限。REST の T ポーズが 45 度


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def rotvec(q):
    q = q * np.where(q[..., 3:4] < 0, -1.0, 1.0)
    s = np.linalg.norm(q[..., :3], axis=-1, keepdims=True)
    return q[..., :3] / np.maximum(s, 1e-12) * 2 * np.arctan2(s, q[..., 3:4])


def from_rotvec(v):
    a = np.linalg.norm(v, axis=-1, keepdims=True)
    return qnormalize(np.concatenate([v * np.sinc(a / 2 / np.pi) / 2, np.cos(a / 2)], -1))


def bones_of(side):
    return [(f"{side}{f}{j}", f, j) for f in FINGERS for j in C.FINGER_JOINTS[f]]


def hand_plane(rest, side):
    fwd = unit(rest[side + "MiddleProximal"] - rest[side + "Hand"])
    across = unit(rest[side + "IndexProximal"] - rest[side + "LittleProximal"])
    across = unit(across - fwd * np.dot(across, fwd))
    return fwd, across, unit(np.cross(fwd, across)) * SIDES[side]


def root_flex(a, toward, hinge):
    """付け根の骨の屈曲の軸。a × toward で、a が toward に近いか超えたときも hinge（手の前の向き × toward）の側を保つ。"""
    f = np.cross(a, toward)
    if np.linalg.norm(f) < 0.2:
        f = hinge - a * (a @ hinge)
    f = unit(f)
    return f if f @ hinge >= 0 else -f


def frame(a, f):
    """骨の軸 a と屈曲の軸 f から、列が a, f, s の行列を作る。"""
    f = unit(f - a * (a @ f))
    return np.stack([a, f, unit(np.cross(a, f))], 1)


def axes(rest, side):
    """手と指の骨ごとの座標 {骨: 行列}。遠位の骨の軸は親と同じ（先の骨が無い）。"""
    fwd, across, n = hand_plane(rest, side)
    out = {side + "Hand": frame(fwd, unit(np.cross(fwd, n)))}
    for finger in FINGERS:
        joints = C.FINGER_JOINTS[finger]
        toward = n - across if finger == "Thumb" else n
        f = None
        for k, j in enumerate(joints):
            bone = f"{side}{finger}{j}"
            a = unit(rest[f"{side}{finger}{joints[k + 1]}"] - rest[bone]) if k + 1 < len(joints) else out[f"{side}{finger}{joints[k - 1]}"][:, 0]
            f = root_flex(a, toward, unit(np.cross(fwd, toward))) if f is None else f
            out[bone] = frame(a, f)
            f = out[bone][:, 1]
    return out


def range_key(finger, joint):
    return "Thumb" + joint if finger == "Thumb" else joint


def components(q, e):
    """関節の回転 q（T ポーズの世界の向き）を、骨の座標 e の (屈曲, 横の開き, ひねり) にする（度）。"""
    v = np.degrees(rotvec(q))
    return np.stack([v @ e[:, 1], v @ e[:, 2], v @ e[:, 0]], -1)


def joint_angles(d, side, rest):
    """D からコマごとの {骨: [F, 3]（屈曲, 横の開き, ひねり、度）}。"""
    e = axes(rest, side)
    return {bone: components(qmul(qinv(d[C.PARENT[bone]]), d[bone]), e[bone]) for bone, _, _ in bones_of(side)}


def over(v, finger, joint):
    """RANGE を SLACK より超えるコマの数 (屈曲, 横の開き, ひねり)。"""
    low, high, spread, twist = RANGE[range_key(finger, joint)]
    return int(((v[:, 0] < low - SLACK) | (v[:, 0] > high + SLACK)).sum()), int((np.abs(v[:, 1]) > spread + SLACK).sum()), int((np.abs(v[:, 2]) > twist + SLACK).sum())


def fit(q, e, finger, joint, table=RANGE):
    """関節の回転を table の範囲へ収める。"""
    low, high, spread, twist = table[range_key(finger, joint)]
    c = components(q, e)
    flex, side_, roll = np.clip(c[:, 0], low, high), np.clip(c[:, 1], -spread, spread), np.clip(c[:, 2], -twist, twist)
    return from_rotvec(np.radians(flex[:, None] * e[:, 1] + side_[:, None] * e[:, 2] + roll[:, None] * e[:, 0]))


def thumb_forward(q, axis, fwd):
    """親指の中手骨 q（手から見た回転）を、骨の軸が手の前の向きから THUMB_FORWARD_DEG までに入るように戻す。"""
    a = qrot(q, np.broadcast_to(axis, q[:, :3].shape))
    extra = np.arccos(np.clip(a @ fwd, -1, 1)) - np.radians(THUMB_FORWARD_DEG)
    return qmul(axis_rotation(unit(np.cross(a, fwd)), np.maximum(extra, 0)), q)


def middle(q):
    """クリップの中央値の回転。"""
    q = continuous(q * (-1.0 if q[0, 3] < 0 else 1.0))
    return qnormalize(np.median(q, axis=0))


def grip_circle(diameter_cm):
    """筒の半径 R（L）と、手の座標の軸の向き、中心 (前, 親指の側, 手のひらの側)。"""
    radius = diameter_cm / HUMAN_HAND_CM * HAND_LENGTH / 2
    tilt = np.radians(GRIP_TILT_DEG)
    return radius, np.array([np.sin(tilt), np.cos(tilt), 0.0]), np.array([GRIP_FWD, 0.0, PALM_SURFACE + radius])


def wrap_finger(knuckle, lengths, diameter_cm):
    """指を手の断面（前と手のひらの法線の面）で筒に巻く。返すのは (付け根, 中間, 遠位) の屈曲（度）。

    骨の中心線は筒の中心から rho の円の上に節を置く。rho は、骨の中点が筒から指の太さだけ離れる距離。
    """
    radius, axis, center = grip_circle(diameter_cm)
    c = center + axis * (knuckle[1] - center[1]) / axis[1]          # 指の横の位置の筒の中心
    rho = np.hypot(radius + FINGER_RADIUS, max(lengths) / 2)
    to = np.array([c[0] - knuckle[0], c[2] - knuckle[2]])
    far = np.linalg.norm(to)
    angle = np.arctan2(to[1], to[0])
    reach = np.arccos(np.clip((far ** 2 + lengths[0] ** 2 - rho ** 2) / (2 * far * lengths[0]), -1, 1))
    half = [np.arcsin(min(1.0, x / (2 * rho))) for x in lengths]
    first = angle - reach
    joint = np.array([knuckle[0], knuckle[2]]) + lengths[0] * np.array([np.cos(first), np.sin(first)]) - np.array([c[0], c[2]])
    second = np.arctan2(joint[1], joint[0]) + np.pi / 2 + half[1]    # 円の接線から中心の側へ回した弦の向き
    return np.degrees(first), np.degrees((second - first + np.pi) % (2 * np.pi) - np.pi), np.degrees(half[1] + half[2])


def fist_pose(side, diameter_cm=GRIP_DIAMETER_CM):
    """柄の太さの筒を包む関節の回転 {骨: [4]}。"""
    e = axes(C.REST, side)
    close = (GRIP_DIAMETER_CM / HUMAN_HAND_CM * HAND_LENGTH / 2 + FINGER_RADIUS) / (diameter_cm / HUMAN_HAND_CM * HAND_LENGTH / 2 + FINGER_RADIUS)
    out = {}
    for bone, finger, joint in bones_of(side):
        if finger == "Thumb":
            x, y, z, w = FIST_THUMB[joint]
            q = qnormalize(np.array([x, y, z, w] if side == "left" else [x, -y, -z, w]))
            out[bone] = q if joint == "Metacarpal" else from_rotvec(rotvec(q[None]) * close)[0]
        else:
            flex = wrap_finger(*HAND[finger], diameter_cm)[C.FINGER_JOINTS[finger].index(joint)]
            out[bone] = axis_rotation(e[bone][:, 1], np.radians(flex))
    return out


def closing(locals_, target, side):
    """コマごとの指の閉じ具合（0〜1）。"""
    flex = np.mean([components(locals_[f"{side}{f}Intermediate"], target[f"{side}{f}Intermediate"])[:, 0] for f in FINGERS if f != "Thumb"], axis=0)
    return np.clip((flex - THUMB_CLOSE_DEG[0]) / (THUMB_CLOSE_DEG[1] - THUMB_CLOSE_DEG[0]), 0, 1)


def clenched(locals_, target, side):
    """指が動かず握っている素材か。"""
    still = max(float(np.degrees(np.abs(rotvec(qmul(np.broadcast_to(qinv(middle(q)), q.shape), q))).max())) for q in locals_.values())
    flex = [components(middle(locals_[f"{side}{f}Intermediate"])[None], target[f"{side}{f}Intermediate"])[0, 0] for f in FINGERS if f != "Thumb"]
    return still < STILL_DEG and float(np.mean(flex)) > CLOSED_DEG


def transfer(moved, deltas, found, ref_v, hand_pose=None, diameter_cm=GRIP_DIAMETER_CM):
    """deltas の指の骨を直して返す。moved は {骨: 基準の姿勢からの世界の回転 [F, 4]}。hand_pose は fist、source、None（素材から決める）。diameter_cm は握る筒の太さ。どちらも {"left": ..., "right": ...} で手ごとに書ける。

    返すのは (D の辞書, 記録)。記録の overFrames は関節ごとの RANGE を超えるコマの数 [屈曲, 横の開き, ひねり]、fist はグーにした手、skippedHands は指の骨が足りず前の移し方のままの手。
    """
    out = dict(deltas)
    source = {k: ref_v[i] for k, i in found.items()}
    record = {"overFrames": {}, "fist": [], "skippedHands": []}
    for side in SIDES:
        needed = [side + "Hand"] + [b for b, _, _ in bones_of(side)]
        if not all(b in found for b in needed):
            record["skippedHands"].append(side)
            continue
        src, target = axes(source, side), axes(C.REST, side)
        quat = {b: matrix_quat(e[None])[0] for b, e in src.items()}
        goal = {b: matrix_quat(e[None])[0] for b, e in target.items()}
        locals_ = {}
        for bone, finger, joint in bones_of(side):
            parent = C.PARENT[bone]
            n = len(moved[bone])
            joint_src = qmul(qmul(np.broadcast_to(qinv(quat[parent]), (n, 4)), qmul(qinv(moved[parent]), moved[bone])), np.broadcast_to(quat[bone], (n, 4)))
            locals_[bone] = qmul(qmul(np.broadcast_to(goal[parent], (n, 4)), joint_src), np.broadcast_to(qinv(goal[bone]), (n, 4)))
        pose_here = hand_pose.get(side) if isinstance(hand_pose, dict) else hand_pose
        if pose_here == "fist" or (pose_here is None and clenched(locals_, target, side)):
            record["fist"].append(side)
            for bone, q in fist_pose(side, diameter_cm.get(side, GRIP_DIAMETER_CM) if isinstance(diameter_cm, dict) else diameter_cm).items():
                out[bone] = qmul(out[C.PARENT[bone]], np.broadcast_to(q, out[C.PARENT[bone]].shape))
            continue
        close = closing(locals_, target, side)[:, None] if pose_here is None else None     # source と書いた手は元の親指のまま
        grip_thumb = fist_pose(side)
        for bone, finger, joint in bones_of(side):
            local, n, parent = locals_[bone], len(locals_[bone]), C.PARENT[bone]
            e = target[bone]
            count = over(components(local, e), finger, joint)
            if any(count):
                record["overFrames"][bone] = list(count)
            rest_pose = middle(local)[None]
            pose = fit(rest_pose, e, finger, joint)
            if joint == "Metacarpal":
                pose = thumb_forward(pose, e[:, 0], hand_plane(C.REST, side)[0])
            motion = qmul(np.broadcast_to(qinv(rest_pose), (n, 4)), local)
            moved_joint = fit(qmul(np.broadcast_to(pose, (n, 4)), motion), e, finger, joint, LOOSE)
            if finger == "Thumb" and close is not None:     # 閉じたコマの親指は手のひらを斜めに横切る。元の値のままだと手首の側で横を向く
                moved_joint = C.slerp(moved_joint, np.broadcast_to(grip_thumb[bone], (n, 4)), close)
            out[bone] = qmul(out[parent], moved_joint)
    return out, record
