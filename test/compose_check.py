"""tools/compose の確かめ（test/compose.test.mjs から呼ぶ。numpy だけ。Blender、Kimodo、MotionBricks は使わない）。成功なら最後に OK を出す。"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "compose"))
import check  # noqa: E402
import clip as C  # noqa: E402
from bone_maps import BoneMapError, detect, normalize  # noqa: E402
from fbx_clip import fbx_to_clip  # noqa: E402
from records import BRIDGE_LICENSE, KIMODO_LICENSE, merge_licenses  # noqa: E402
from soma_vrma import continuous, qmul, qnormalize, qrot, qyaw, write_vrma  # noqa: E402
from vrma_read import on_times, read_vrma  # noqa: E402

rng = np.random.default_rng(3)
TMP = Path(tempfile.mkdtemp(prefix="compose-check-"))


def random_clip(n=30, seed=1):
    r = np.random.default_rng(seed)
    rot = {b: qnormalize(np.array([0, 0, 0, 1.0]) + r.normal(0, 0.2, 4) + np.cumsum(r.normal(0, 0.005, (n, 4)), 0)) for b in C.ORDER}
    hips = np.stack([np.linspace(0, 1, n), np.full(n, 0.95), np.linspace(0, 2, n)], 1)
    return C.make(rot, hips)


def same(a, b, tol=1e-4):
    return all(np.abs(np.sum(a["rotations"][k] * b["rotations"][k], -1)).min() > 1 - tol for k in C.ORDER) and np.abs(a["hips"] - b["hips"]).max() < 1e-3


# 中間形式を VRMA に書いて読み直すと、指まで同じ動きに戻る
m = random_clip()
write_vrma(TMP / "a.vrma", m)
assert same(m, read_vrma(TMP / "a.vrma"))
half = on_times(np.array([0.0, 1.0]), continuous(np.stack([C.IDENTITY, -qyaw(0.1)])), np.array([0.5]))
assert abs(2 * np.arctan2(half[0, 1], half[0, 3])) < 0.06                                     # 符号が逆のキーの間で遠回りしない
C.save(TMP / "a.npz", m)
assert same(m, C.load(TMP / "a.npz"))

# 素材の upperChest は chest に入り、首のワールドの向きは保たれる
d = C.world_deltas(m)
d2 = dict(d)
d2["upperChest"] = qnormalize(d["chest"] + 0.3)
d2["neck"] = d["neck"]
back = C.world_deltas(C.from_world_deltas(d2, m["hips"]))
assert np.abs(np.sum(back["neck"] * d["neck"], -1)).min() > 1 - 1e-6
assert np.abs(np.sum(back["chest"] * d2["upperChest"], -1)).min() > 1 - 1e-6

# 1/50 秒のコマを 30 fps に直す
t = np.arange(51) / 50
line = np.stack([t, t * 0, t * 0], 1)
qz = np.stack([np.zeros(51), np.sin(t / 2), np.zeros(51), np.cos(t / 2)], 1)
rot, h = C.resample(t, {"hips": qz}, line)
assert len(h) == 31 and abs(h[15, 0] - 0.5) < 1e-9 and abs(2 * np.arctan2(rot["hips"][15, 1], rot["hips"][15, 3]) - 0.5) < 1e-6

# 骨の名前の対応表
assert normalize("mixamorig:LeftForeArm") == "leftforearm" and normalize("B_L_Thigh") == "lthigh" and normalize("Bip01 R Calf") == "rcalf"
mixamo = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"] + [s + b for s in ("Left", "Right") for b in ("Shoulder", "Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase", "HandThumb1", "HandIndex1", "HandPinky3")]
found, table = detect(["mixamorig:" + n for n in mixamo])
assert table == "mixamo" and found["leftLowerLeg"] == mixamo.index("LeftLeg") and found["leftThumbMetacarpal"] == mixamo.index("LeftHandThumb1") and found["rightLittleDistal"] == mixamo.index("RightHandPinky3")
unity = ["Hips", "Spine", "Chest", "UpperChest", "Neck", "Head"] + [s + b for s in ("Left", "Right") for b in ("Shoulder", "UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot", "Toes", "ThumbProximal", "IndexIntermediate")]
found, table = detect(unity)
assert table == "unity-humanoid" and found["upperChest"] == 3 and found["leftThumbMetacarpal"] == unity.index("LeftThumbProximal")
biped = ["B_Pelvis", "B_Spine", "B_Spine1", "B_Neck", "B_Head"] + [f"B_{s}_{b}" for s in "LR" for b in ("Clavicle", "UpperArm", "Forearm", "Hand", "Thigh", "Calf", "Foot", "Toe0", "Finger0", "Finger21")]
found, table = detect(biped)
assert table == "biped" and found["leftThumbMetacarpal"] == biped.index("B_L_Finger0") and found["rightMiddleIntermediate"] == biped.index("B_R_Finger21")
try:
    detect(["Hips", "Spine", "Head", "LeftArm"])
    raise AssertionError("足りない骨で止まらなかった")
except BoneMapError as e:
    assert "rightHand" in str(e) or "rightUpperLeg" in str(e)


# FBX の移し替え: Z が上、前が -Y の世界で、腕を下ろした基準の姿勢の骨。骨のローカルの軸はばらばらでも結果は変わらない
def fbx_fixture(path, arm_angle):
    """左腕だけを肩まわりに arm_angle（ラジアン、0 で下ろしたまま、pi/2 で真横）まで上げる 10 コマの npz を書く。"""
    names = ["B_Pelvis", "B_Spine", "B_Spine1", "B_Neck", "B_Head", "B_L_UpperArm", "B_L_Forearm", "B_L_Hand", "B_R_UpperArm", "B_R_Forearm", "B_R_Hand",
             "B_L_Thigh", "B_L_Calf", "B_L_Foot", "B_L_Toe0", "B_R_Thigh", "B_R_Calf", "B_R_Foot", "B_R_Toe0"]
    ref_pos = np.array([[0, 0, 1.3], [0, 0, 1.45], [0, 0, 1.65], [0, 0, 1.95], [0, 0, 2.1],
                        [0.4, 0, 1.9], [0.4, 0, 1.55], [0.4, 0, 1.3], [-0.4, 0, 1.9], [-0.4, 0, 1.55], [-0.4, 0, 1.3],
                        [0.15, 0, 1.3], [0.15, 0, 0.75], [0.15, 0, 0.2], [0.15, -0.25, 0.02], [-0.15, 0, 1.3], [-0.15, 0, 0.75], [-0.15, 0, 0.2], [-0.15, -0.25, 0.02]])
    ref_rot = qnormalize(rng.normal(0, 1, (len(names), 4)))   # 骨のローカルの軸の取り方は結果に関わらない
    F = 10
    pos = np.broadcast_to(ref_pos, (F, *ref_pos.shape)).copy()
    rot = np.broadcast_to(ref_rot, (F, *ref_rot.shape)).copy()
    swing = np.array([0, -np.sin(arm_angle / 2), 0, np.cos(arm_angle / 2)])   # Y 軸まわりの回転で、下向き（-Z）の腕を +X（左）へ上げる
    for j in (5, 6, 7):
        rot[:, j] = qmul(swing, ref_rot[j])
    for j in (6, 7):
        pos[:, j] = ref_pos[5] + qrot(swing, ref_pos[j] - ref_pos[5])
    np.savez_compressed(path, names=np.array(names), pos=pos, rot=rot, ref_pos=ref_pos, ref_rot=ref_rot, fps=30.0, unknown=np.array([], dtype=str))


fbx_fixture(TMP / "up.npz", np.pi / 2)
up, info = fbx_to_clip(TMP / "up.npz")
assert info["boneTable"] == "biped"
pos = C.joints(up)
arm = (pos["leftHand"] - pos["leftUpperArm"])[0]
assert arm[0] > 0.5 and abs(arm[1]) < 0.05 and abs(arm[2]) < 0.05, arm       # 真横に上げた腕は VRM の T ポーズの向き（+X）になる
fbx_fixture(TMP / "down.npz", 0.0)
down, _ = fbx_to_clip(TMP / "down.npz")
pos = C.joints(down)
arm = (pos["leftHand"] - pos["leftUpperArm"])[0]
assert arm[1] < -0.5 and abs(arm[0]) < 0.05 and abs(arm[2]) < 0.05, arm       # 腕を下ろした姿勢は VRM でも腕が下を向く
right = (pos["rightHand"] - pos["rightUpperArm"])[0]
assert right[1] < -0.5
assert (pos["leftToes"] - pos["leftFoot"])[0, 2] > 0.05                        # 爪先は +Z（前）
assert (pos["leftUpperLeg"] - pos["rightUpperLeg"])[0, 0] > 0.1                # 左が +X

# 両手で持つ武器: 肩幅の違う体でも、左手首は素材の両手首の差の位置に来る。右手は動かない
from fbx_clip import basis  # noqa: E402
from grip import apply as apply_grip, one_arm, vrm_rest  # noqa: E402
narrow = {k: v * [0.7, 1, 1] for k, v in C.REST.items()}
pose = random_clip(12, 5)
rotated = {b: q for b, q in pose["rotations"].items()}
for b in C.ORDER:
    if b not in ("rightUpperArm", "rightLowerArm", "rightHand", "leftUpperArm", "leftLowerArm"):
        rotated[b] = np.tile(C.IDENTITY, (12, 1))
pose = C.make(rotated, pose["hips"], np.ones((12, 4)))
before = C.joints(pose, narrow)
want = np.tile([0.15, -0.1, 0.25], (12, 1))
want[:, 0] += before["leftUpperArm"][:, 0] - before["rightHand"][:, 0] - 0.4     # 左の肩から届く位置
held, rec = one_arm(pose, want, "right", narrow)
after = C.joints(held, narrow)
assert rec["reachMissMaxCm"] == 0 and rec["gapErrorMaxCm"] < 0.1, rec
assert np.abs(after["leftHand"] - after["rightHand"] - want).max() < 1e-3
assert np.abs(after["rightHand"] - before["rightHand"]).max() < 1e-9
assert np.abs(np.sum(C.world_deltas(held)["leftHand"] * C.world_deltas(pose)["leftHand"], -1)).min() > 1 - 1e-9   # 手の向きは素材のまま
assert held["contacts"].min() == 1.0

# 基準の向きが違っても B は回転を正しく求める（Z が上で前が +Y、±X、-Y、Y が上で前が -Z、+Z）
for left, up in (([-1, 0, 0], [0, 0, 1]), ([0, -1, 0], [0, 0, 1]), ([0, 1, 0], [0, 0, 1]), ([1, 0, 0], [0, 0, 1]), ([-1, 0, 0], [0, 1, 0]), ([1, 0, 0], [0, 1, 0])):
    left, up = np.array(left, dtype=float), np.array(up, dtype=float)
    points = np.array([[0, 0, 0], up, left * 0.3 + up * 0.8, -left * 0.3 + up * 0.8])
    q = basis(points, {"hips": 0, "head": 1, "leftUpperArm": 2, "rightUpperArm": 3})
    assert np.abs(qrot(q, left) - [1, 0, 0]).max() < 1e-9 and np.abs(qrot(q, up) - [0, 1, 0]).max() < 1e-9, (left, up)


def pair_fixture(path, front=(0, -1.0, 0)):
    """両手を体の前で近づけて動かす 31 コマの npz。両腕とも回り、左手が遅れるので両手首の差が変わる。front は基準の姿勢の体の前。"""
    names = ["B_Pelvis", "B_Spine", "B_Spine1", "B_Neck", "B_Head", "B_L_UpperArm", "B_L_Forearm", "B_L_Hand", "B_R_UpperArm", "B_R_Forearm", "B_R_Hand",
             "B_L_Thigh", "B_L_Calf", "B_L_Foot", "B_L_Toe0", "B_R_Thigh", "B_R_Calf", "B_R_Foot", "B_R_Toe0"]
    ref_pos = np.array([[0, 0, 1.3], [0, 0, 1.45], [0, 0, 1.65], [0, 0, 1.95], [0, 0, 2.1],
                        [0.4, 0, 1.9], [0.4, 0, 1.55], [0.4, 0, 1.3], [-0.4, 0, 1.9], [-0.4, 0, 1.55], [-0.4, 0, 1.3],
                        [0.15, 0, 1.3], [0.15, 0, 0.75], [0.15, 0, 0.2], [0.15, -0.25, 0.02], [-0.15, 0, 1.3], [-0.15, 0, 0.75], [-0.15, 0, 0.2], [-0.15, -0.25, 0.02]])
    ref_rot = qnormalize(np.random.default_rng(9).normal(0, 1, (len(names), 4)))
    F = 31
    pos = np.broadcast_to(ref_pos, (F, *ref_pos.shape)).copy()
    rot = np.broadcast_to(ref_rot, (F, *ref_rot.shape)).copy()
    t = np.arange(F) / (F - 1)
    for arm, sign, angle in (((5, 6, 7), 1, np.radians(30 + 8 * np.sin(t * 3))), ((8, 9, 10), -1, np.radians(25 + 40 * t))):
        swing = np.stack([np.zeros(F), sign * np.sin(angle / 2), np.zeros(F), np.cos(angle / 2)], 1)    # 下げた腕を体の内側へ振る
        for j in arm:
            rot[:, j] = qmul(swing, np.broadcast_to(ref_rot[j], (F, 4)))
        for j in arm[1:]:
            pos[:, j] = ref_pos[arm[0]] + qrot(swing, np.broadcast_to(ref_pos[j] - ref_pos[arm[0]], (F, 3)))
    if tuple(front) != (0, -1.0, 0):
        turn = np.array([0, 0, np.sin(np.pi / 2), np.cos(np.pi / 2)])    # Z 軸まわり 180 度で、体の前が +Y になる
        rot = qmul(np.broadcast_to(turn, rot.shape), rot)
        ref_rot = qmul(np.broadcast_to(turn, ref_rot.shape), ref_rot)
        pos = qrot(np.broadcast_to(turn, rot.shape), pos)
        ref_pos = qrot(np.broadcast_to(turn, ref_rot.shape), ref_pos)
    np.savez_compressed(path, names=np.array(names), pos=pos, rot=rot, ref_pos=ref_pos, ref_rot=ref_rot, fps=30.0, unknown=np.array([], dtype=str))
    return pos[:, names.index("B_L_Hand")], pos[:, names.index("B_R_Hand")]


l_src, r_src = pair_fixture(TMP / "pair.npz")
SCALE = (C.HIPS_HEIGHT - C.REST["leftToes"][1]) / 1.28


def source_gap(side, ratio=1.0):
    """元の両手首の差（もう一方 - 持つ手）を VRM の世界の向きにした値。元の世界は Z が上で前が -Y。"""
    d = (l_src - r_src) if side == "right" else (r_src - l_src)
    return np.stack([d[:, 0], d[:, 2], -d[:, 1]], 1) * SCALE * ratio


# 体つきの違う体でも、右持ちと左持ちの両方で、元の両手首の差に合う。届くデータなので reachMiss は 0
ratio = narrow["hips"][1] / C.HIPS_HEIGHT
for side in ("right", "left"):
    raw, info = fbx_to_clip(TMP / "pair.npz", side)
    assert abs(info["bodyScale"] - SCALE) < 1e-3 and "grip" not in info
    out_clip, rec = apply_grip(raw, raw["gripLocal"], side, narrow)
    assert rec["reachMissMaxCm"] == 0 and rec["gapErrorMaxCm"] < 0.1, rec
    pos = C.joints(out_clip, narrow)
    other = "left" if side == "right" else "right"
    assert np.abs(pos[other + "Hand"] - pos[side + "Hand"] - source_gap(side, ratio)).max() < 1e-3, side
    held_before = C.joints(raw, narrow)[side + "Hand"]
    assert np.abs(pos[side + "Hand"] - held_before).max() < 1e-9                               # 持つ手は動かない

# grip なしの出力は grip の指定で変わらない
plain, _ = fbx_to_clip(TMP / "pair.npz")
withg, _ = fbx_to_clip(TMP / "pair.npz", "right")
assert all(np.array_equal(plain["rotations"][k], withg["rotations"][k]) for k in C.ORDER) and np.array_equal(plain["hips"], withg["hips"])
assert "gripLocal" not in plain
assert np.allclose(withg["gripArms"]["left"], [0, 0.35 * SCALE, 0.25 * SCALE])   # 肩の骨が無い素材。長さは bodyScale で縮む

# 前が +Y の FBX でも同じ結果になる（基準の向きの回転のトレースが 0 以下）
pair_fixture(TMP / "pair-y.npz", front=(0, 1.0, 0))
flip, _ = fbx_to_clip(TMP / "pair-y.npz")
assert all(np.abs(np.abs(np.sum(flip["rotations"][k] * plain["rotations"][k], -1)) - 1).max() < 1e-9 for k in C.ORDER)


RIGID_GAP = np.array([0.15, 0, 0.1])


def rigid_fixture(path, fps=30.0, F=25):
    """両手が持つ手の座標に固定された、1 コマに 40 度回る剛体の武器。pair_fixture の骨を使う。両手首の距離はどのコマも同じ。"""
    z = np.load(TMP / "pair.npz")
    names = [str(n) for n in z["names"]]
    right, left = names.index("B_R_Hand"), names.index("B_L_Hand")
    pos = np.tile(z["pos"][-1], (F, 1, 1))     # 右腕を体の前へ振った最後のコマ。左の肩から両手に届く
    rot = np.tile(z["rot"][-1], (F, 1, 1))
    angle = np.radians(40) * np.arange(F)
    spin = np.stack([np.zeros(F), np.sin(angle / 2), np.zeros(F), np.cos(angle / 2)], 1)    # 元の世界の前後の軸まわり
    rot[:, right] = qmul(spin, rot[:, right])
    rot[:, left] = qmul(spin, rot[:, left])
    pos[:, left] = pos[:, right] + qrot(spin, np.broadcast_to(RIGID_GAP, (F, 3)))
    np.savez_compressed(path, names=z["names"], pos=pos, rot=rot, ref_pos=z["ref_pos"], ref_rot=z["ref_rot"], fps=fps, unknown=np.array([], dtype=str))


# VRM の T ポーズの骨の位置を読む（VRM 1 と、体の前が -Z の VRM 0）


def vrm_file(path, ext_name, ext, nodes):
    js = json.dumps({"asset": {"version": "2.0"}, "nodes": nodes, "extensions": {ext_name: ext}}).encode("utf8")
    js += b" " * ((4 - len(js) % 4) % 4)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, 20 + len(js)) + struct.pack("<II", len(js), 0x4E4F534A) + js)


nodes = [{"name": "root", "children": [1], "translation": [0, 0.1, 0]}, {"name": "hips", "translation": [0, 0.8, 0], "children": [2]}, {"name": "hand", "translation": [0.5, 0.3, 0.1]}]
vrm_file(TMP / "one.vrm", "VRMC_vrm", {"humanoid": {"humanBones": {"hips": {"node": 1}, "leftHand": {"node": 2}}}}, nodes)
body = vrm_rest(TMP / "one.vrm")
assert np.abs(body["hips"] - [0, 0.9, 0]).max() < 1e-9 and np.abs(body["leftHand"] - [0.5, 1.2, 0.1]).max() < 1e-9
vrm_file(TMP / "zero.vrm", "VRM", {"humanoid": {"humanBones": [{"bone": "hips", "node": 1}, {"bone": "leftHand", "node": 2}]}}, nodes)
assert np.abs(vrm_rest(TMP / "zero.vrm")["leftHand"] - [-0.5, 1.2, -0.1]).max() < 1e-9
turned = [{**nodes[0], "rotation": [0, np.sin(np.pi / 4), 0, np.cos(np.pi / 4)]}, nodes[1], nodes[2]]    # 親が Y 軸まわりに 90 度回っている
vrm_file(TMP / "turn.vrm", "VRMC_vrm", {"humanoid": {"humanBones": {"hips": {"node": 1}, "leftHand": {"node": 2}}}}, turned)
assert np.abs(vrm_rest(TMP / "turn.vrm")["leftHand"] - [0.1, 1.2, -0.5]).max() < 1e-9

rest = C.make({}, np.tile(C.REST["hips"], (2, 1)))
assert abs(float(C.ground(rest)["hips"][0, 1]) - C.REST["hips"][1]) < 1e-9     # T ポーズは足が床にある

# 足の高さと速さからの接地
stand = C.make({}, np.tile(C.REST["hips"], (20, 1)) + [[0, 0, 0]])
assert C.estimate_contacts(stand).min() == 1.0
fly = C.make({}, np.stack([np.zeros(20), np.full(20, 1.2), np.linspace(0, 6, 20)], 1))
assert C.estimate_contacts(fly).max() == 0.0

# 前の区間の終わりに向きと位置を合わせる
a = C.make({"hips": np.tile(qyaw(np.pi / 2), (12, 1))}, np.stack([np.linspace(0, 1.1, 12), np.full(12, 1.0), np.zeros(12)], 1))
b = C.make({}, np.stack([np.zeros(12), np.full(12, 1.0), np.linspace(0, 1.1, 12)], 1))
placed = C.place_after(a, b, gap=0.5)
assert abs(C.heading(placed["rotations"]["hips"][0]) - np.pi / 2) < 1e-6
assert np.abs(placed["hips"][0] - [1.6, 1.0, 0]).max() < 1e-9 and placed["hips"][-1, 0] > placed["hips"][0, 0] + 1
assert np.linalg.norm(C.place_after(a, b, seconds=1.0)["hips"][0] - [4.1, 1.0, 0]) < 1e-6     # 両端の速さ 3 m/s で 1 秒
stop = C.make({"hips": np.tile(qyaw(np.pi / 2), (12, 1))}, np.tile([1.1, 1.0, 0], (12, 1)))
assert np.linalg.norm(C.place_after(stop, b, seconds=1.0)["hips"][0] - [2.1, 1.0, 0]) < 1e-6  # 止まった状態から踏み込むなら 1 m/s までに抑える

# 補間のつなぎは両端の値の間にあり、端で速さが跳ばない
bridge = C.interpolate(a, placed, 20)
assert C.frames(bridge) == 20 and bridge["hips"][:, 0].min() > 1.1 and bridge["hips"][:, 0].max() < 1.6
step0 = np.linalg.norm(bridge["hips"][0] - a["hips"][-1])
assert step0 < 0.1
lunge = C.make({}, np.stack([np.zeros(12), np.full(12, 1.0), np.linspace(0, 1.8, 12)], 1))   # 止まった区間から 5 m/s で踏み込む
near = C.make({}, np.tile([0, 1.0, -1.2], (12, 1)))
assert np.diff(C.interpolate(near, lunge, 36)["hips"][:, 2]).min() > -1e-9                    # hips が後ろへ戻らない

# 継ぎ目で接地を切る。継ぎ目の前後 1 コマの全部の足が 0 になり、接地の区間が 2 つに分かれる
c1, c2 = C.make({}, np.zeros((10, 3)), np.ones((10, 4))), C.make({}, np.zeros((10, 3)), np.ones((10, 4)))
joined, seams = C.concat([c1, c2])
assert seams == [10] and joined["contacts"][9:11].max() == 0 and joined["contacts"][8].min() == 1 and joined["contacts"][11].min() == 1

# その場は道筋を引いて接地を持たない
walk = C.make({}, np.stack([np.linspace(0, 3, 60), np.full(60, 1.0), np.zeros(60)], 1), np.ones((60, 4)))
still = C.inplace(walk)
assert np.abs(still["hips"][:, 0]).max() < 0.1 and still["contacts"].max() == 0

# 最初のコマで +Z を向き原点に来る
ff = C.face_forward(a)
assert abs(C.heading(ff["rotations"]["hips"][0])) < 1e-6 and np.abs(ff["hips"][0, [0, 2]]).max() < 1e-9

# 速さを変える
slow = C.retime(C.make({}, np.zeros((31, 3)), np.ones((31, 4))), 0.5)
assert C.frames(slow) == 61 and slow["contacts"].min() == 1.0                                 # 接地も同じ時刻へ直す

# 確かめの数値: 跳びのある継ぎ目で値が上がる
smooth = C.make({}, np.stack([np.zeros(60), np.full(60, 1.0), np.linspace(0, 2, 60)], 1), np.ones((60, 4)))
jump = C.make({}, smooth["hips"] + (np.arange(60)[:, None] >= 30) * [1, 0, 0.0], np.ones((60, 4)))
spans = [{"label": "x", "start": 0, "end": 60}]
quiet, loud = check.report(smooth, [30], spans), check.report(jump, [30], spans)
assert loud["seams"][0]["speedMaxMps"] > 20 > quiet["seams"][0]["speedMaxMps"] and loud["footSlide"]["all"]["p95CmPerSec"] >= 0
assert quiet["footSlide"]["all"]["meanCmPerSec"] < 200 and quiet["handInBody"]["frames"] == 0
hand = C.joints(smooth)
hand["leftHand"] = hand["chest"].copy()
assert check.hand_in_body(hand).all()

# 許諾: 一番厳しい条件が全体の条件になり、全区間の条件が残る
personal = {"holder": "P", "summary": "個人利用のみ。公開・再配布・商用利用は不可（動画の公開も不可）", "redistribution": False}
evaluation = {"holder": "E", "summary": "評価用", "redistribution": False, "evaluationOnly": True}
free = {"holder": "F", "summary": "再配布できる", "redistribution": True}
merged = merge_licenses([{"part": "a", "license": free}, {"part": "b", "license": personal}, {"part": "c", "license": KIMODO_LICENSE}])
assert merged["summary"].startswith("個人利用のみ") and merged["redistribution"] is False and "evaluationOnly" not in merged and len(merged["terms"]) == 3
merged = merge_licenses([{"part": "a", "license": personal}, {"part": "b", "license": evaluation}])
assert merged["evaluationOnly"] is True and merged["summary"].startswith("評価用")
assert merge_licenses([{"part": "a", "license": free}])["redistribution"] is True

# 計画から 1 本を作る（--fake。文章は作りものの動き、つなぎは補間）
write_vrma(TMP / "b.vrma", random_clip(40, 2))
plan = {"bridge": {"seconds": 0.4}, "segments": [
    {"source": "text", "label": "歩く", "prompt": "A person walks.", "seconds": 2},
    {"source": "vrma", "label": "踊る", "path": str(TMP / "b.vrma"), "trim": [0, 1], "license": personal},
    {"source": "vrma", "label": "短いつなぎ", "path": str(TMP / "a.vrma"), "root": "inplace", "bridge": {"seconds": 0.2}, "license": free},
]}
plan_file = TMP / "plan.json"
plan_file.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf8")
out = TMP / "out"
r = subprocess.run([sys.executable, str(ROOT / "tools/compose/compose.py"), str(plan_file), "--out", str(out), "--fake"], capture_output=True, text=True, encoding="utf8", env={"PYTHONUTF8": "1", **os.environ})
assert r.returncode == 0, r.stderr
final = read_vrma(out / "motion.vrma")
gen = json.loads((out / "generated.json").read_text(encoding="utf8"))
lic = json.loads((out / "license.json").read_text(encoding="utf8"))
rep = json.loads((out / "report.json").read_text(encoding="utf8"))
assert "grip" not in rep
contacts = json.loads((out / "contacts.json").read_text(encoding="utf8"))
expect = 61 + 12 + 31 + 6 + 30
assert C.frames(final) == expect == gen["frames"] == len(contacts["frames"]) == rep["frames"], (C.frames(final), gen["frames"])
assert [s["end"] - s["start"] for s in gen["spans"]] == [61, 12, 31, 6, 30] and [b["method"] for b in gen["bridges"]] == ["interpolate", "interpolate"]
assert gen["bridges"][0]["reason"] == "--fake" and len(rep["seams"]) == 4
assert lic["summary"].startswith("個人利用のみ") and [t["part"] for t in lic["terms"]] == ["区間: 歩く", "区間: 踊る", "区間: 短いつなぎ"]
assert np.abs(final["hips"][0, [0, 2]]).max() < 1e-6 and abs(C.heading(final["rotations"]["hips"][0])) < 1e-3



def compose(plan_body, out_name):
    plan_file.write_text(json.dumps(plan_body, ensure_ascii=False), encoding="utf8")
    return subprocess.run([sys.executable, str(ROOT / "tools/compose/compose.py"), str(plan_file), "--out", str(TMP / out_name), "--fake"], capture_output=True, text=True, encoding="utf8", env={"PYTHONUTF8": "1", **os.environ})


# パスの区間に許諾が無ければ止まる。横に motion.json があっても推測で読まない
library = TMP / "lib"
folder = library / "motions" / "dance-1"
folder.mkdir(parents=True)
shutil.copyfile(TMP / "b.vrma", folder / "motion.vrma")
record = {"id": "dance-1", "sha256": "abc", "source": {"path": "x"}, "license": {"holder": "保管場所", "summary": "商用利用可（ユーザーの指定）", "redistribution": False, "commercialUse": "allowed"}}
(folder / "motion.json").write_text(json.dumps(record, ensure_ascii=False), encoding="utf8")
text_seg = {"source": "text", "label": "歩く", "prompt": "A person walks.", "seconds": 2}
r = compose({"segments": [text_seg, {"source": "vrma", "label": "踊る", "path": str(folder / "motion.vrma")}]}, "no")
assert r.returncode != 0 and "license が無い" in r.stderr

# 保管場所のモーションは ID で読み、motion.json の license をそのまま使う
r = compose({"library": str(library), "bridge": {"seconds": 0.2}, "segments": [text_seg, {"source": "vrma", "label": "踊る", "motion": "dance-1"}]}, "lib")
assert r.returncode == 0, r.stderr
lic = json.loads((TMP / "lib/license.json").read_text(encoding="utf8"))
term = next(t for t in lic["terms"] if t["part"] == "区間: 踊る")
assert term["summary"] == record["license"]["summary"] and term["commercialUse"] == "allowed" and term["holder"] == "保管場所" and "商用利用可（ユーザーの指定）" in lic["summary"]
seg = json.loads((TMP / "lib/generated.json").read_text(encoding="utf8"))["segments"][1]
assert seg["motionRecord"]["id"] == "dance-1" and seg["motionRecord"]["sha256"] == "abc"

# 保管場所のモーションの横の contacts.json を読む（推定しない）。列は名前で並べ替え、fps が違えば 30 fps へ直す
folder2 = library / "motions" / "steps-1"
folder2.mkdir(parents=True)
shutil.copyfile(TMP / "b.vrma", folder2 / "motion.vrma")
(folder2 / "motion.json").write_text(json.dumps({**record, "id": "steps-1", "contacts": "contacts.json"}, ensure_ascii=False), encoding="utf8")
(folder2 / "contacts.json").write_text(json.dumps({"fps": 15, "order": ["rightToe", "rightHeel", "leftToe", "leftHeel"],
                                                   "frames": [[1, 1, 0, 0] if k < 10 else [0, 0, 0, 0] for k in range(20)]}), encoding="utf8")
r = compose({"library": str(library), "segments": [{"source": "vrma", "label": "足", "motion": "steps-1"}]}, "contacts")
assert r.returncode == 0, r.stderr
got = np.asarray(json.loads((TMP / "contacts/contacts.json").read_text(encoding="utf8"))["frames"])
assert len(got) == C.frames(read_vrma(folder2 / "motion.vrma")), len(got)
assert (got[:18, 2:] == 1).all() and (got[:, :2] == 0).all() and (got[21:] == 0).all() and 0 < got[19, 2] < 1, got[:22]
assert json.loads((TMP / "contacts/generated.json").read_text(encoding="utf8"))["segments"][0]["motionRecord"]["contacts"] == "contacts.json"
r = compose({"library": str(library), "segments": [{"source": "vrma", "label": "踊る", "motion": "dance-1"}]}, "nocontacts")   # 横に無ければ今までどおり推定する
assert r.returncode == 0, r.stderr
assert not np.array_equal(np.asarray(json.loads((TMP / "nocontacts/contacts.json").read_text(encoding="utf8"))["frames"]), got)

# 古い MotionBricks の記録（evaluationOnly が無く、見本の動きの許諾を持つ）は評価用として読む。記録そのものは書き換えない
folder3 = library / "motions" / "mb-old"
folder3.mkdir(parents=True)
shutil.copyfile(TMP / "b.vrma", folder3 / "motion.vrma")
old_lic = {"holder": "NVIDIA", "summary": "MotionBricks で生成", "redistribution": False, "terms": [{"part": "見本", "license": "NVIDIA Sample Data Evaluation License（rev. Jan. 16, 2026）"}]}
(folder3 / "motion.json").write_text(json.dumps({**record, "id": "mb-old", "license": old_lic}, ensure_ascii=False), encoding="utf8")
before = (folder3 / "motion.json").read_bytes()
r = compose({"library": str(library), "bridge": {"seconds": 0.2}, "segments": [{"source": "vrma", "label": "a", "motion": "dance-1"}, {"source": "vrma", "label": "b", "motion": "mb-old"}]}, "evalonly")
assert r.returncode == 0, r.stderr
assert json.loads((TMP / "evalonly/license.json").read_text(encoding="utf8"))["evaluationOnly"] is True and (folder3 / "motion.json").read_bytes() == before

# ID の区間に計画の許諾を重ねると止まる。無い ID も止まる
r = compose({"library": str(library), "segments": [{"source": "vrma", "label": "踊る", "motion": "dance-1", "license": personal}]}, "both")
assert r.returncode != 0 and "同時に書けない" in r.stderr
r = compose({"library": str(library), "segments": [{"source": "vrma", "label": "踊る", "motion": "no-such"}]}, "missing")
assert r.returncode != 0 and "no-such" in r.stderr
r = compose({"library": str(library), "segments": [{"source": "vrma", "label": "踊る", "motion": "dance-1", "grip": "right"}]}, "grip")
assert r.returncode != 0 and "grip は asset" in r.stderr

# 保管場所の外の VRMA（きゃらすたが写した確認待ちのジョブの結果）は、計画の contacts の接地を読み、motionRecord をそのまま残す
outside = TMP / "job-result"
outside.mkdir()
shutil.copyfile(folder2 / "motion.vrma", outside / "motion.vrma")
shutil.copyfile(folder2 / "contacts.json", outside / "contacts.json")
job_record = {"id": None, "library": str(library), "sha256": "def", "source": {"path": "jobs/j1/cand/2/motion.vrma", "pack": "Kimodo で生成（文章から）"}, "contacts": "contacts.json",
              "job": {"id": "j1", "type": "motion-text", "candidate": 2}}
r = compose({"segments": [{"source": "vrma", "label": "候補", "path": str(outside / "motion.vrma"), "contacts": str(outside / "contacts.json"), "license": personal, "motionRecord": job_record}]}, "jobseg")
assert r.returncode == 0, r.stderr
assert np.array_equal(np.asarray(json.loads((TMP / "jobseg/contacts.json").read_text(encoding="utf8"))["frames"]), got)
assert json.loads((TMP / "jobseg/generated.json").read_text(encoding="utf8"))["segments"][0]["motionRecord"] == job_record
for bad in ({"source": "vrma", "label": "x", "motion": "dance-1", "contacts": str(outside / "contacts.json")}, {"source": "vrma", "label": "x", "motion": "dance-1", "motionRecord": job_record},
            {**text_seg, "contacts": str(outside / "contacts.json")}):
    r = compose({"library": str(library), "segments": [bad]}, "badrecord")
    assert r.returncode != 0 and "path の vrma の区間だけ" in r.stderr, r.stderr

# モデルの利用条件の記録は lib/model-licenses.json から読む。値は 1 か所にまとめる前の records.py と同じ
assert KIMODO_LICENSE == {"holder": "NVIDIA（Kimodo）、Meta（Llama 3）",
                          "summary": "Kimodo-SOMA-RP-v1.2（NVIDIA Open Model License）で文章から生成。文章の埋め込みに LLM2Vec（MIT）と Meta Llama 3 8B Instruct（Meta Llama 3 Community License）を使った",
                          "redistribution": False}
assert BRIDGE_LICENSE == {"holder": "NVIDIA（MotionBricks）",
                          "summary": "MotionBricks のモデル（NVIDIA Open Model Agreement）で区間の間を生成。文脈と目標は前後の区間のポーズで、見本の動きは使っていない",
                          "redistribution": False}

# 計画の model で握りを解く経路（Blender を呼ばないように dump の npz を置く）。全コマの誤差が report.json に出る
sys.path.insert(0, str(ROOT / "tools" / "compose"))
import compose as compose_tool  # noqa: E402
fbx = TMP / "pair.fbx"
fbx.write_bytes(b"fbx")
attack = {"source": "asset", "label": "攻撃", "path": str(fbx), "grip": "right", "speed": 0.6, "trim": [0, 0.8], "license": personal}
work = TMP / "gripwork"
(work / "cache").mkdir(parents=True)
rigid_fixture(TMP / "rigid.npz")
shutil.copyfile(TMP / "rigid.npz", work / "cache" / f"fbx-{compose_tool.asset_key(attack)}.dump.npz")
r = compose({"segments": [attack]}, "nomodel")
assert r.returncode != 0 and "model が要る" in r.stderr
body_names = [b for b in C.ORDER if b not in C.FINGER_NAMES]
model_nodes = [{"name": b, "translation": [float(x) for x in (C.REST[b] - (C.REST[C.PARENT[b]] if C.PARENT[b] else 0)) * [0.95, 0.9, 1]]} for b in body_names]
for k, b in enumerate(body_names):
    kids = [i for i, c in enumerate(body_names) if C.PARENT[c] == b]
    if kids:
        model_nodes[k]["children"] = kids
vrm_file(TMP / "body.vrm", "VRMC_vrm", {"humanoid": {"humanBones": {b: {"node": k} for k, b in enumerate(body_names)}}}, model_nodes)
plan_file.write_text(json.dumps({"model": str(TMP / "body.vrm"), "bridge": {"seconds": 0.2}, "segments": [text_seg, attack]}, ensure_ascii=False), encoding="utf8")
r = subprocess.run([sys.executable, str(ROOT / "tools/compose/compose.py"), str(plan_file), "--out", str(TMP / "gripout"), "--work", str(work), "--fake"], capture_output=True, text=True, encoding="utf8", env={"PYTHONUTF8": "1", **os.environ})
assert r.returncode == 0, r.stderr
rep = json.loads((TMP / "gripout/report.json").read_text(encoding="utf8"))
seg = json.loads((TMP / "gripout/generated.json").read_text(encoding="utf8"))["segments"][1]
assert rep["grip"][0]["gapErrorMaxCm"] < 0.1 and rep["grip"][0]["frames"] == 41, rep["grip"]
span = next(x for x in json.loads((TMP / "gripout/generated.json").read_text(encoding="utf8"))["spans"] if x["label"] == "攻撃")
final_pos = C.joints(read_vrma(TMP / "gripout/motion.vrma"), vrm_rest(TMP / "body.vrm"))
final_gap = np.linalg.norm(final_pos["leftHand"] - final_pos["rightHand"], axis=1)[span["start"]:span["end"]]
assert final_gap.max() - final_gap.min() < 0.001, (final_gap.min(), final_gap.max())          # つないだあとも両手首の距離は一定
assert seg["retarget"]["grip"]["body"]["vrm"] == str(TMP / "body.vrm") and len(seg["retarget"]["grip"]["body"]["sha256"]) == 64
assert "weapon" not in rep and "weapon" not in seg["retarget"]

# 計画の weapon の経路。全部のコマの値が report.json に出て、grip の値は出ない。speed は武器の解き方の中で使う
sword = TMP / "sword.json"
sword.write_text(json.dumps({"name": "t", "hold": "right", "lengthM": 1.2, "bodyHeightM": 0.99, "centerOfMassM": [0.5, 0, 0], "profile": [[0, 0.02], [1.2, 0.05]],
                             "grips": {"right": {"wristM": [0.3, 0, 0], "hand": [0, 0, 0, 1]}, "left": {"wristM": [0.1, 0, 0], "hand": [0, 0, 0, 1]}}}), encoding="utf8")
armed = {k: v for k, v in attack.items() if k != "grip"} | {"weapon": str(sword)}
plan_file.write_text(json.dumps({"model": str(TMP / "body.vrm"), "bridge": {"seconds": 0.2}, "segments": [text_seg, armed]}, ensure_ascii=False), encoding="utf8")
r = subprocess.run([sys.executable, str(ROOT / "tools/compose/compose.py"), str(plan_file), "--out", str(TMP / "weaponout"), "--work", str(work), "--fake"], capture_output=True, text=True, encoding="utf8", env={"PYTHONUTF8": "1", **os.environ})
assert r.returncode == 0, r.stderr
rep = json.loads((TMP / "weaponout/report.json").read_text(encoding="utf8"))
seg = json.loads((TMP / "weaponout/generated.json").read_text(encoding="utf8"))["segments"][1]
assert "grip" not in rep and rep["weapon"][0]["gripSlipCm"]["max"] < 0.05 and rep["weapon"][0]["frames"] >= 41, rep["weapon"]
assert seg["retarget"]["weapon"]["solve"] == "weapon" and seg["weapon"] == str(sword)
for bad, word in (({"source": "vrma", "label": "x", "motion": "dance-1", "weapon": str(sword)}, "weapon は"), ({**armed, "grip": "right"}, "weapon は")):
    r = compose({"library": str(library), "model": str(TMP / "body.vrm"), "segments": [bad]}, "badweapon")
    assert r.returncode != 0 and word in r.stderr, r.stderr
r = compose({"segments": [armed]}, "nomodelweapon")
assert r.returncode != 0 and "weapon は" in r.stderr

# 区間ごとの持つ手で読む。後ろの区間の持つ手を使い回さない
asked = []
original_clip = compose_tool.fbx_to_clip


def spy_clip(path, side, hand_pose=None, diameter_cm=3.2):
    asked.append((Path(path).name, side))
    return original_clip(path, side, hand_pose, diameter_cm)


compose_tool.fbx_to_clip = spy_clip
mixed = TMP / "mixed"
mixed.mkdir()
pair = [dict(attack), {**attack, "grip": "left"}, {k: v for k, v in attack.items() if k != "grip"}]
for k, s in enumerate(pair):
    (mixed / f"{k}.fbx").write_bytes(str(k).encode())
    s["path"] = str(mixed / f"{k}.fbx")
    shutil.copyfile(TMP / "rigid.npz", mixed / f"fbx-{compose_tool.asset_key(s)}.dump.npz")
compose_tool.make_assets(pair, mixed)
compose_tool.fbx_to_clip = original_clip
assert [side for _, side in asked] == ["right", "left", None], asked

# 武器の定義: 30 fps でない FBX でも手首の位置を読める。もう一方の手首は素材の両手首の差の位置
import weapon_def  # noqa: E402
rigid_fixture(TMP / "rigid24.npz", fps=24.0)
source, _ = fbx_to_clip(TMP / "rigid24.npz", "right")
bar = np.array([[x, y, 0.0] for x in (0.0, 1.0) for y in (-0.05, 0.05)] + [[x, 0.0, 0.01] for x in (0.2, 0.3)])
tris = np.array([[0, 1, 4], [1, 3, 4], [0, 4, 2], [2, 4, 3]])
defined, _ = weapon_def.define(bar, tris, TMP / "rigid24.npz", source, "right", "t")
apart = np.linalg.norm(np.array(defined["grips"]["left"]["wristM"]) - defined["grips"]["right"]["wristM"])
assert abs(apart - np.linalg.norm(RIGID_GAP)) < 1e-3 and defined["framesAtFreeGrip"] == C.frames(source), (apart, RIGID_GAP)

restp = {**attack, "gripBody": "rest"}
plan_file.write_text(json.dumps({"bridge": {"seconds": 0.2}, "segments": [text_seg, restp]}, ensure_ascii=False), encoding="utf8")
r = subprocess.run([sys.executable, str(ROOT / "tools/compose/compose.py"), str(plan_file), "--out", str(TMP / "gripout2"), "--work", str(work), "--fake"], capture_output=True, text=True, encoding="utf8", env={"PYTHONUTF8": "1", **os.environ})
assert r.returncode == 0, r.stderr
assert json.loads((TMP / "gripout2/generated.json").read_text(encoding="utf8"))["segments"][1]["retarget"]["grip"]["body"] == "rest"


def spin_distance(npz, speed):
    """load_segment を通した区間の両手首の距離 [F] と、解いた記録。"""
    m, _ = fbx_to_clip(npz, "right")
    cache = TMP / "spin"
    cache.mkdir(exist_ok=True)
    s = {"source": "asset", "label": "x", "grip": "right", "speed": speed, "cache": cache / "clip.npz", "gapFile": cache / "grip.npz"}
    C.save(s["cache"], m)
    np.savez(s["gapFile"], local=m["gripLocal"], **m["gripArms"])
    pos = C.joints(compose_tool.load_segment(s, cache))
    return np.linalg.norm(pos["leftHand"] - pos["rightHand"], axis=1), s["gripRecord"]


# 速い剛体の武器を speed 0.5 で解く。間のコマ（元の動きで 20 度回った位置）でも両手首の距離は一定
distance, rec = spin_distance(TMP / "rigid.npz", 0.5)
assert len(distance) == 49 and rec["reachMissMaxCm"] == 0
assert distance.max() - distance.min() < 0.001, (distance.min(), distance.max())
assert abs(distance[0] - np.linalg.norm(RIGID_GAP) * SCALE) < 0.001

# 30 fps でない素材の直しでも、間のコマの距離は一定
rigid_fixture(TMP / "rigid24.npz", fps=24.0)
distance, rec = spin_distance(TMP / "rigid24.npz", 1)
assert len(distance) == 31 and distance.max() - distance.min() < 0.001, (distance.min(), distance.max())

# 同じラベルの区間でも、誤差はそれぞれの区間で測る
again = {**attack, "speed": 1}
plan_file.write_text(json.dumps({"model": str(TMP / "body.vrm"), "bridge": {"seconds": 0.2}, "segments": [attack, again]}, ensure_ascii=False), encoding="utf8")
r = subprocess.run([sys.executable, str(ROOT / "tools/compose/compose.py"), str(plan_file), "--out", str(TMP / "gripout3"), "--work", str(work), "--fake"], capture_output=True, text=True, encoding="utf8", env={"PYTHONUTF8": "1", **os.environ})
assert r.returncode == 0, r.stderr
rows = json.loads((TMP / "gripout3/report.json").read_text(encoding="utf8"))["grip"]
assert [x["frames"] for x in rows] == [41, 25] and max(x["gapErrorMaxCm"] for x in rows) < 0.1, rows
assert all(x["solve"] == "both-arms" for x in rows), rows

# report.json の grip に、左右の腕のねじれ、手首の折れ、武器の位置の変化、届かなかったコマ、手が体に入るコマが出る
row = rows[0]
assert set(row["arms"]) == {"left", "right", "handInBodyFrames"} and set(row["arms"]["left"]) == {"upperTwistDegMax", "lowerTwistDegMax", "wristTwistDegMax", "wristBendDegMax"}, row
assert row["weaponMoveCm"]["max"] > 0 and set(row["reachShift"]) == {"frames", "maxCm"} and row["unreachedFrames"] == [], row

# elbowPrior は明示したときだけ効く。計画にも区間にも書ける
assert json.loads((TMP / "gripout3/generated.json").read_text(encoding="utf8"))["segments"][0]["elbowPrior"] is False
for body_, name_ in (({"elbowPrior": True, "segments": [attack]}, "gripout5"), ({"segments": [{**attack, "elbowPrior": True}]}, "gripout6")):
    plan_file.write_text(json.dumps({"model": str(TMP / "body.vrm"), "bridge": {"seconds": 0.2}, **body_}, ensure_ascii=False), encoding="utf8")
    r = subprocess.run([sys.executable, str(ROOT / "tools/compose/compose.py"), str(plan_file), "--out", str(TMP / name_), "--work", str(work), "--fake"], capture_output=True, text=True, encoding="utf8", env={"PYTHONUTF8": "1", **os.environ})
    assert r.returncode == 0, r.stderr
    assert json.loads((TMP / name_ / "generated.json").read_text(encoding="utf8"))["segments"][0]["elbowPrior"] is True
r = compose({"model": str(TMP / "body.vrm"), "segments": [{**attack, "elbowPrior": "yes"}]}, "badprior")
assert r.returncode != 0 and "elbowPrior は true" in r.stderr, r.stderr

# 指の記録は report.json に出る。指の骨の無い素材は両手とも移さない
row = json.loads((TMP / "gripout3/report.json").read_text(encoding="utf8"))["fingers"][0]
assert row["skippedHands"] == ["left", "right"] and row["overFrames"] == {}, row

# handPose は asset の区間に fist か source で書く
assert compose_tool.asset_key(attack) != compose_tool.asset_key({**attack, "handPose": "fist"}) != compose_tool.asset_key({**attack, "handPose": "fist", "gripDiameterCm": 4})
for wrong in (0.5, 9):
    r = compose({"model": str(TMP / "body.vrm"), "segments": [{**attack, "gripDiameterCm": wrong}]}, "badgrip")
    assert r.returncode != 0 and "gripDiameterCm は" in r.stderr, r.stderr
r = compose({"library": str(library), "segments": [{"source": "vrma", "label": "踊る", "motion": "dance-1", "gripDiameterCm": 3}]}, "badgrip2")
assert r.returncode != 0 and "gripDiameterCm は" in r.stderr, r.stderr
for wrong in ({"handPose": "open"},):
    r = compose({"model": str(TMP / "body.vrm"), "segments": [{**attack, **wrong}]}, "badhand")
    assert r.returncode != 0 and "handPose は" in r.stderr, r.stderr
r = compose({"library": str(library), "segments": [{"source": "vrma", "label": "踊る", "motion": "dance-1", "handPose": "fist"}]}, "badhand2")
assert r.returncode != 0 and "handPose は" in r.stderr, r.stderr

# handPose と gripDiameterCm は手ごとにも書ける
r = compose({"model": str(TMP / "body.vrm"), "segments": [{**attack, "handPose": {"left": "open"}}]}, "badhand3")
assert r.returncode != 0 and "handPose は" in r.stderr, r.stderr
r = compose({"model": str(TMP / "body.vrm"), "segments": [{**attack, "gripDiameterCm": {"left": 20}}]}, "badgrip3")
assert r.returncode != 0 and "gripDiameterCm は" in r.stderr, r.stderr
assert compose_tool.asset_key({**attack, "handPose": {"left": "fist"}}) != compose_tool.asset_key(attack)

# gripSolve: 片腕の解き方は明示したときだけ。持つ手は動かない
left_only = {**attack, "gripSolve": "left-arm"}
plan_file.write_text(json.dumps({"model": str(TMP / "body.vrm"), "bridge": {"seconds": 0.2}, "segments": [left_only]}, ensure_ascii=False), encoding="utf8")
r = subprocess.run([sys.executable, str(ROOT / "tools/compose/compose.py"), str(plan_file), "--out", str(TMP / "gripout4"), "--work", str(work), "--fake"], capture_output=True, text=True, encoding="utf8", env={"PYTHONUTF8": "1", **os.environ})
assert r.returncode == 0, r.stderr
row = json.loads((TMP / "gripout4/report.json").read_text(encoding="utf8"))["grip"][0]
assert row["solve"] == "left-arm" and row["weaponMoveCm"]["max"] == 0 and row["gapErrorMaxCm"] < 0.1, row
assert json.loads((TMP / "gripout4/generated.json").read_text(encoding="utf8"))["segments"][0]["gripSolve"] == "left-arm"
for wrong in ("right-arm", "both", "elbow"):
    r = compose({"model": str(TMP / "body.vrm"), "segments": [{**attack, "gripSolve": wrong}]}, "badsolve")
    assert r.returncode != 0 and "gripSolve は" in r.stderr, r.stderr

print("OK")
