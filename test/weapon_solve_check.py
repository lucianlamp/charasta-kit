"""武器を主に解く tools/compose/weapon.py と weapon_check.py の確かめ。Blender は呼ばない。

元の動きは、REST の体が両手で武器を持ち、上で構えて、1 コマで 176 度振り下ろす回転だけの動き。腕の違う体へ移す。
"""

import json
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "tools" / "compose"))
import clip as C  # noqa: E402
import grip as G  # noqa: E402
import weapon as W  # noqa: E402
import weapon_check as K  # noqa: E402
import weapon_def as D  # noqa: E402
from soma_vrma import qinv, qmul, qrot  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="charasta-weapon-"))
HEIGHT = float(C.REST["hips"][1] - C.REST["leftToes"][1])
RADII = {**{k: 0.08 for k in K.CAPSULES}, "headTop": 0.15}
AXIS = np.array([0, 0, 1.0])
LENGTH = 1.5


def spin(deg, axis=AXIS):
    deg = np.asarray(deg, dtype=np.float64)
    return G.axis_rotation(np.broadcast_to(axis, deg.shape + (3,)), np.radians(deg))


def definition(hold="right", left_at=0.08):
    """柄頭が原点、+X が刃先の武器。持つ手の握りは T ポーズの手の座標に単位の向き。"""
    free = G.OTHER[hold]
    w = {"name": "test", "hold": hold, "lengthM": LENGTH, "bodyHeightM": HEIGHT, "centerOfMassM": [0.6, 0, 0], "profile": [[0, 0.02], [0.3, 0.02], [0.4, 0.1], [LENGTH, 0.05]],
         "grips": {hold: {"wristM": [0.3, 0, 0], "hand": [0, 0, 0, 1]}, free: {"wristM": [left_at, 0, 0], "hand": [0, 0, 0, 1]}}}
    path = TMP / f"def-{hold}.json"
    path.write_text(json.dumps(w), encoding="utf8")
    return W.read(path)


def body(arm=0.82):
    """腕の短い体。脚と胴は REST のまま。"""
    rest = dict(C.REST)
    for s in ("left", "right"):
        rest[s + "LowerArm"] = rest[s + "UpperArm"] + (C.REST[s + "LowerArm"] - C.REST[s + "UpperArm"]) * arm
        rest[s + "Hand"] = rest[s + "LowerArm"] + (C.REST[s + "Hand"] - C.REST[s + "LowerArm"]) * arm
    return rest


def source_arms():
    return {s: [float(np.linalg.norm(C.REST[s + "UpperArm"] - C.REST[s + "Shoulder"])), *(0.75 * x for x in G.arm_lengths(s, C.REST))] for s in ("left", "right")}


def slam(F=41, key=20, hold="right", down=-176.0, forearm=60.0):
    """上で構えて、key から key+1 の 1 コマで武器を down 度回す。腕は前へ出す。武器の回転は持つ手の回転そのもの。"""
    deg = np.where(np.arange(F) <= key, 2.0 * (key - np.arange(F)).clip(0, 8), down)
    d = {b: np.tile(C.IDENTITY, (F, 1)) for b in C.ORDER}
    for s, sign in (("left", -1.0), ("right", 1.0)):
        d[s + "UpperArm"] = spin(np.full(F, sign * 85.0), np.array([0, 1.0, 0]))
        d[s + "LowerArm"] = spin(sign * np.where(np.arange(F) <= key, 130.0, forearm), np.array([0, 1.0, 0]))     # 前腕も 1 コマで回る。手の補間は親の回転の影響を受ける
        d[s + "Hand"] = spin(deg) if s == hold else qmul(spin(deg), spin(np.full(F, 40.0), np.array([1.0, 0, 0])))     # もう一方の手は握りから 40 度ずれている
    return C.from_world_deltas(d, np.tile(C.REST["hips"], (F, 1)))


# 上限を超えるコマの間だけ伸び、ゆっくりの間は speed のまま。ならしても元より短くならない
steps = np.array([5.0, 5, 5, 5, 176, 0, 0, 0, 0])
frames = W.stretch_steps(steps, 1, 30.0)
assert frames[4] >= 176 / 30 and frames[0] == 1 and frames[-1] == 1 and (frames >= 1).all() and frames[3] > 1, frames
assert W.stretch_steps(np.full(9, 5.0), 0.6, 30.0).min() == 1 / 0.6
assert np.allclose(W.stretch_steps(np.full(9, 5.0), 1, 30.0), 1)

# 1 コマで 176 度回す動き: 1 本の軸で上限以内に分かれる。短い回り方で、前のコマと同じ向きに回る
m = slam()
weapon = definition()
source = K.weapon_rotation(m, weapon)
st = K.angle_steps(source)
assert abs(st.max() - 176) < 1e-6
timed, turned = W.retime(m, source, st, 1, 30.0)
done = K.angle_steps(turned)
assert done.max() <= 30 + 1e-6, done.max()
assert C.frames(timed) > C.frames(m) + 4
fast = np.flatnonzero(done > 25)
delta = qmul(turned[fast + 1], qinv(turned[fast]))
assert (delta[:, 2] * np.sign(delta[:, 3]) / np.linalg.norm(delta[:, :3], axis=1) < -0.99).all(), delta                   # 全部のコマが同じ軸の同じ向き
assert np.abs(np.sum(turned[-1] * source[-1], -1)) > 1 - 1e-9 and C.frames(C.retime(m, 1)) == C.frames(m)
assert W.fast_steps(source, st) == [{"step": 20, "deg": 176.0, "sameWay": 1.0}]

# 体の違う体で解く: 左右の持ち手で、握りは滑らず、手の向きは握りのまま、武器の回転は 1 コマの上限以内
rest = body()
arms = source_arms()
for hold, speed in (("right", 1), ("right", 0.6), ("left", 1)):
    weapon = definition(hold)
    m = slam(hold=hold)
    out, rec = W.solve(m, weapon, rest, RADII, arms, speed, 30.0)
    rep = K.report(out, weapon, rest, RADII)
    print(hold, speed, rec, rep)
    assert rep["rotationStepDegMax"] <= 30.01 and rep["gripSlipCm"]["max"] < 0.05, rep
    assert rec["framesOut"] == C.frames(out) and rec["framesOut"] > 41 and rec["fastSteps"][0]["step"] == 20 and rec["reachMissMaxCm"] == 0, rec
    d = C.world_deltas(out)
    free = G.OTHER[hold]
    assert np.abs(np.sum(d[hold + "Hand"] * d[free + "Hand"], -1)).min() > 1 - 1e-9     # 同じ握りの向きなので両手の向きは同じ
    pos = C.joints(out, rest)
    assert abs(np.linalg.norm(pos[free + "Hand"] - pos[hold + "Hand"], axis=1) - 0.22 * K.body_scale(weapon, rest)).max() < 1e-4

# 指は手からの回転を保つ。手の向きが素材と変わっても、指の付け根だけが折れない
m = slam()
curl = dict(m["rotations"])
for bone in C.FINGER_NAMES:
    curl[bone] = np.tile(spin(np.array(25.0), np.array([0, 1.0, 0])), (41, 1))
weapon = definition()
out, _ = W.solve(C.make(curl, m["hips"]), weapon, rest, RADII, arms, 1, 30.0)
for bone in C.FINGER_NAMES:
    assert np.abs(out["rotations"][bone] - curl[bone][0]).max() < 1e-6, bone

# 比べる値: 回転だけの動きは 176 度が残り、握りは滑る
plain = K.report(slam(), definition(), rest, RADII)
assert plain["rotationStepDegMax"] > 170 and plain["gripSlipCm"]["max"] > 1, plain

# 刃先の速さ: 手首を止めて 1 コマ 6 度で回すと、刃先は手首からの距離 × 角速度
n = 31
d = {b: np.tile(C.IDENTITY, (n, 1)) for b in C.ORDER}
d["rightHand"] = spin(6.0 * np.arange(n))
still = C.from_world_deltas(d, np.tile(C.REST["hips"], (n, 1)))
weapon = definition()
rep = K.report(still, weapon, C.REST, RADII)
expect = (LENGTH - 0.3) * 2 * np.sin(np.radians(3)) * C.FPS
assert abs(rep["tipSpeedMpsMax"] - expect) < 0.06 and rep["rotationStepDegMax"] == 6.0 and rep["angularSpeedDegPerSecMax"] == 180, rep
assert abs(rep["centerOfMassSpeedMpsMax"] - 0.3 * 2 * np.sin(np.radians(3)) * C.FPS) < 0.06, rep

# 地面: 刃先の下がる動きを解くと、地面に入るコマが消える。刃先は浮きすぎない
down = slam(down=-90.0, forearm=130.0)
hips = down["hips"] - [0, 0.33, 0]                                                  # 低い構えで、刃先が地面より下へ出る
crouch = C.make(down["rotations"], hips)
weapon = definition()
long_arms = body(1.0)
before = K.report(crouch, weapon, long_arms, RADII)
assert before["ground"]["frames"] > 5 and before["ground"]["depthCm"] > 5, before
original_ground = C.ground
C.ground = lambda x: x                                                              # 足の高さをそろえると低い構えが消えるので、ここだけ切る
out, rec = W.solve(crouch, weapon, long_arms, RADII, arms, 1, 30.0)
C.ground = original_ground
after = K.report(out, weapon, long_arms, RADII)
print("地面", before["ground"], after["ground"], rec)
assert after["ground"]["frames"] == 0 and rec["pushCm"]["max"] > 1 and after["sweptSteps"]["ground"] == 0, after
world = K.world_joints(out, long_arms)
low = K.weapon_points(K.weapon_rotation(out, weapon), world["rightHand"], weapon["points"], weapon, K.body_scale(weapon, long_arms))[:, :, 1].min(1)
assert low.min() < 0.03, low.min()                                                  # 離しすぎない

# 体: カプセルに入る武器は離れる向きへ動く。回転は変えない
wrist = np.tile(C.REST["chest"] + [0, 0, 0.33], (20, 1))
turned = np.tile(spin(-90.0, np.array([0, 1.0, 0])), (20, 1))                       # 刃先が体の前（+Z）を向く
body_j = K.world_joints(C.make({}, np.tile(C.REST["hips"], (20, 1))), C.REST)
parts = K.capsules(body_j, RADII)
pts = K.weapon_points(turned, wrist, weapon["points"], weapon, 1.0)
assert K.collisions(pts, parts)["body"].min() > 0
push = W.clear(turned, wrist, weapon, 1.0, parts)
assert K.collisions(K.weapon_points(turned, wrist + push, weapon["points"], weapon, 1.0), parts)["body"].max() == 0
assert push[:, 2].min() > 0.05, push[:3]
assert K.collisions(K.weapon_points(turned, wrist + push * 0, weapon["points"], weapon, 1.0), parts)["body"].max() > 0

# 動かす量のならし: 元のコマの量を保ち、1 コマの変化が小さい
raw = np.zeros((30, 3))
raw[12:18, 1] = 0.1
soft = W.spread(raw)
assert (soft[12:18, 1] >= 0.1 - 1e-9).all() and np.abs(np.diff(soft, axis=0)).max() < 0.04 and soft[0, 1] == 0, soft[:, 1]

# 手首の限界: ひねりが限界を超える肘の向きを避ける
F = 12
arm = slam(F=F, key=30)
pos, d = C.joints(arm, rest), C.world_deltas(arm)
shoulder, target = pos["rightUpperArm"], pos["rightHand"]
hand = qmul(d["rightLowerArm"], G.axis_rotation(np.tile(G.arm_axes("right", rest)[1], (F, 1)), np.radians(np.full(F, 165.0))))
hinge, twist = G.hinge_of(d, "right", rest)


def worst(limits):
    along = G.unit(target - shoulder)
    sides = G.elbow_sides(along, pos["rightLowerArm"] - shoulder, d["chest"])
    chosen = G.choose_swivel(sides, d["rightShoulder"], hand, "right", rest, shoulder, target, hinge, twist, limits)
    _, dl, _ = G.place_elbow("right", rest, shoulder, target, chosen, hinge, twist)
    return np.degrees(np.abs(G.swing_twist(qmul(qinv(dl), hand), np.tile(G.arm_axes("right", rest)[1], (F, 1)))[0])).max()


print("手首のひねり", worst(False), worst(True))
assert worst(True) < worst(False) - 5 and worst(True) <= G.TWIST_LIMIT + 15

# カプセルの半径: 骨から頂点までの距離の 90 パーセンタイル。頂点の無い骨は既定の値
real = K.vrm_vertices
ring = np.array([[0.2 * np.cos(a), 0.7, 0.2 * np.sin(a)] for a in np.linspace(0, 6.28, 50)]) + [C.REST["rightUpperLeg"][0], 0, C.REST["rightUpperLeg"][2]]
K.vrm_vertices = lambda path: {"rightUpperLeg": ring, "head": np.array([[0, 1.9, 0.0]])}
got = K.body_radii("x", C.REST)
K.vrm_vertices = real
assert abs(got["rightThigh"] - 0.2) < 1e-6 and got["leftThigh"] == K.DEFAULT_RADIUS and abs(got["headTop"] - (1.9 - C.REST["head"][1])) < 1e-6, got

# 定義: 主軸は柄頭から遠い方が +X。箱の重心。環の間で柄、鍔、刃を読む
box = np.array([[x, y, z] for x in (0.0, 1.0) for y in (-0.1, 0.1) for z in (-0.02, 0.02)])
tri = np.array([[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]])
turned_box = box @ np.array([[0, 1.0, 0], [-1.0, 0, 0], [0, 0, 1.0]])
frame, origin = D.frame_of(turned_box + [0.2, 0.3, 0], np.array([0.2, 0.3, 0.0]))
local = (turned_box + [0.2, 0.3, 0] - origin) @ frame
assert abs(local[:, 0].min()) < 1e-9 and abs(local[:, 0].max() - 1) < 1e-9
assert np.abs(D.center_of_mass(box + [0.5, 0, 0], tri) - [1.0, 0, 0]).max() < 1e-9
assert D.parts_of(np.array([[0, 0.1], [0.1, 0.1], [0.5, 0.3], [0.6, 0.3], [2.0, 0.3], [2.1, 0.1]])) == {"handle": [0.0, 0.5], "guard": [0.5, 0.6], "blade": [0.6, 2.1]}

print("OK")
