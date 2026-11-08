"""首の範囲 tools/compose/neck.py の確かめ。Blender は呼ばない。"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "tools" / "compose"))
import anatomy as A  # noqa: E402
import clip as C  # noqa: E402
import compose  # noqa: E402
import grip as G  # noqa: E402
import neck as N  # noqa: E402
from soma_vrma import qinv, qmul, qrot, write_vrma  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="charasta-neck-"))
UP = np.array([0, 1.0, 0])


def turn(deg, axis=UP):
    deg = np.asarray(deg, dtype=float)
    return G.axis_rotation(np.broadcast_to(axis, deg.shape + (3,)), np.radians(deg))


def twisted_clip(head_yaw, chest_yaw=None):
    """胸を chest_yaw だけ回し、頭は胸から見て head_yaw 回す動き。腕も動かす。"""
    n = len(head_yaw)
    d = {b: np.tile(C.IDENTITY, (n, 1)) for b in C.ORDER}
    t = np.linspace(0, 1, n)
    d["chest"] = turn(np.zeros(n) if chest_yaw is None else chest_yaw)
    d["neck"] = d["chest"]
    d["head"] = qmul(d["chest"], turn(head_yaw))
    for s, sign in (("left", 1.0), ("right", -1.0)):
        d[s + "Shoulder"] = d["chest"]
        d[s + "UpperArm"] = qmul(d["chest"], turn(sign * 60 * t, [0, 0, 1.0]))
        d[s + "LowerArm"] = qmul(d[s + "UpperArm"], turn(40 * t))
        d[s + "Hand"] = qmul(d[s + "LowerArm"], turn(20 * t, [1.0, 0, 0]))
    return C.from_world_deltas(d, np.tile(C.REST["hips"], (n, 1)), np.ones((n, 4)))


def angle(a, b):
    return np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(a * b, -1)), 0, 1)))


# 上限を超えるコマだけ頭が胸へ戻り、頭の向きは逆に回らない。首と頭へ半分ずつ入る
yaw = np.concatenate([np.linspace(0, 107, 20), np.linspace(107, -10, 20)])
m = twisted_clip(yaw, -0.8 * yaw)
out, rec = N.solve(m, 68.0)
d0, d1 = C.world_deltas(m), C.world_deltas(out)
rep = N.report(out)
print(rec, rep)
assert rec["limitDeg"] == 68 and rec["headChestDegMax"] == 107 and rec["overFrames"] == int((np.abs(yaw) > 68).sum()), rec
assert rep["angleDegMax"] <= 68 and rep["yawDeg"][1] <= 68 and rep["yawDeg"][1] > 60 and rep["yawDeg"][0] < -9, rep
rel = qmul(qinv(d1["chest"]), d1["head"])
assert (np.sum(N.rotvec(rel) * UP, 1) * yaw >= -1e-9).all()                                     # 符号は元のまま
split = qmul(qinv(d1["chest"]), d1["neck"]), qmul(qinv(d1["neck"]), d1["head"])
assert np.abs(angle(split[0], np.tile(C.IDENTITY, (40, 1))) - angle(split[1], np.tile(C.IDENTITY, (40, 1)))).max() < 1e-6
assert angle(split[0], np.tile(C.IDENTITY, (40, 1))).max() <= 34.01
small = np.abs(yaw) <= 68 * N.KNEE
assert angle(d1["head"], d0["head"])[small].max() < 1e-5                                         # 上限の 2/3 までは頭の世界の向きを変えない
assert angle(d1["head"], d0["head"])[~small].max() > 30
steps = angle(rel[1:], rel[:-1])
assert steps.max() < 10, steps.max()                                                             # 滑らかな動きは滑らかなまま

# 腕と握りと胴は 1 ミリも動かない
p0, p1 = C.joints(m), C.joints(out)
for bone in ("hips", "chest", "leftHand", "rightHand", "leftLowerArm", "rightLowerArm", "leftUpperArm", "rightUpperArm", "leftFoot", "rightFoot"):
    assert np.abs(p0[bone] - p1[bone]).max() < 1e-9, bone
for bone in ("hips", "spine", "chest", "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm", "leftHand", "rightHand"):
    assert angle(d0[bone], d1[bone]).max() < 1e-5, bone
assert np.array_equal(out["contacts"], m["contacts"])

# 四元数の符号が逆から始まっても同じ結果になる
d = C.world_deltas(m)
flipped, _ = N.solve(C.from_world_deltas({**d, "head": -d["head"]}, m["hips"], m["contacts"]), 68.0)
assert angle(C.world_deltas(flipped)["neck"], C.world_deltas(out)["neck"]).max() < 1e-5

# 既定は頭が胸へ戻る。胸と背骨は回らない
assert N.LIMIT_DEG == 80 and N.CHEST_SHARE == 0
golden = hashlib.sha1(b"".join((np.round(out["rotations"][b], 4) + 0.0).tobytes() for b in ("spine", "chest", "neck", "head"))).hexdigest()[:12]
assert golden == "241b70382e58", golden     # 既定の解き方は見た目で選んだ。数値が変わったら本番の動きが変わるので止める

# 体の首が短いほど上限が下がり、長い体では設定のまま。首の骨が無い素材は設定のまま
rest = dict(C.REST)
rest["neck"] = C.REST["head"] - (C.REST["head"] - C.REST["neck"]) * 0.5
half = float(np.linalg.norm(rest["head"] - rest["neck"]))
assert abs(N.body_limit(80, half / 0.85, rest, 1.0) - 68) < 1e-6
assert N.body_limit(80, half * 0.5, rest, 1.0) == 80 and N.body_limit(80, None, rest, 1.0) == 80
assert abs(N.body_limit(80, half / 0.85 / 0.5, rest, 0.5) - 68) < 1e-6

# 体に首の骨が無いときと 180 は補正しない。補正のあとも 30 度より下げない
assert N.body_limit(80, half / 0.85, rest, 1.0, has_neck=False) == 80
assert N.body_limit(180, half * 4, rest, 1.0) == 180
assert N.body_limit(40, half * 4, rest, 1.0) == 30

# ease は角度の列で: 傾きは 1 以下、単調、膝の前では等しく膝で続き、limit でも上限より小さい
for limit_ in (np.radians(30.0), np.radians(70.0), np.radians(180.0)):
    grid = np.linspace(0, np.pi * 1.5, 4001)
    eased = N.ease(grid, limit_)
    slope = np.diff(eased) / np.diff(grid)
    knee = limit_ * N.KNEE
    assert (slope <= 1 + 1e-9).all() and (slope >= 0).all() and (eased[grid <= knee] == grid[grid <= knee]).all()
    assert np.abs(np.diff(slope)).max() < 0.01 and eased[-1] <= limit_ and N.ease(np.array([limit_]), limit_)[0] < limit_
    assert 0.2 < slope[np.searchsorted(grid, limit_)] < 0.8                                       # 折れ線ではなく漸近する

# 斜めの軸でも向きを保って大きさだけ抑える
oblique = G.unit(np.array([0.5, 0.7, -0.4]))
yaw = np.linspace(0, 120, 30)
m = twisted_clip(np.zeros(30))
d = C.world_deltas(m)
d["head"] = turn(yaw, oblique)
out, _ = N.solve(C.from_world_deltas(d, m["hips"]), 60.0)
got = N.rotvec(qmul(qinv(C.world_deltas(out)["chest"]), C.world_deltas(out)["head"]))
assert np.degrees(np.linalg.norm(got, axis=1)).max() <= 60 and np.abs(G.unit(got[5:]) - oblique).max() < 1e-6

# 胸から見た頭が 180 度をまたいでも、折り返さずに続く
yaw = np.linspace(150, 210, 30)
d = C.world_deltas(twisted_clip(np.zeros(30)))
d["head"] = turn(yaw)
out, rec = N.solve(C.from_world_deltas(d, m["hips"]), 180.0)
split = qmul(qinv(C.world_deltas(out)["chest"]), C.world_deltas(out)["neck"])
assert N.step_max(split) < 3 and rec["headChestDegMax"] > 205, (N.step_max(split), rec)
out, rec = N.solve(C.from_world_deltas(d, m["hips"]), 70.0)
assert N.step_max(qmul(qinv(C.world_deltas(out)["chest"]), C.world_deltas(out)["head"])) < 3

# 胴を回す: 顔の世界の向きを保って胸を回し、頭の上限に収まる。腰と脚と接地は動かない。腕は残すか、胸と一緒に回す
yaw = np.concatenate([np.linspace(0, 107, 20), np.linspace(107, -10, 20)])
m = twisted_clip(yaw, -0.8 * yaw)
d0, p0 = C.world_deltas(m), C.joints(m)
out, rec = N.solve(m, 68.0, 1.0, keep_arms=True)
d1, p1 = C.world_deltas(out), C.joints(out)
assert rec["chestTurnDegMax"] > 35 and rec["headMoveDegMax"] < 1e-3 and N.report(out)["angleDegMax"] <= 68, rec
assert angle(d0["head"], d1["head"]).max() < 1e-3 and abs(angle(d0["chest"], d1["chest"]).max() - rec["chestTurnDegMax"]) < 0.1
assert 0.4 < angle(d0["spine"], d1["spine"]).max() / rec["chestTurnDegMax"] < 0.6
assert N.report(out)["chestHipsYawDeg"][0] > -55 > N.report(m)["chestHipsYawDeg"][0]
for bone in ("hips", "leftUpperLeg", "rightUpperLeg", "leftFoot", "rightFoot", "leftToes"):
    assert np.abs(p0[bone] - p1[bone]).max() < 1e-9 and angle(d0[bone], d1[bone]).max() < 1e-5, bone
for bone in ("leftUpperArm", "leftLowerArm", "leftHand", "rightHand"):
    assert angle(d0[bone], d1[bone]).max() < 1e-5, bone                                          # keep_arms は世界の回転を残す
assert angle(d0["leftShoulder"], d1["leftShoulder"]).max() > 35                                  # 肩は胸と一緒に回る
follow, _ = N.solve(m, 68.0, 1.0)
rel0, rel1 = qmul(qinv(d0["chest"]), d0["leftHand"]), qmul(qinv(C.world_deltas(follow)["chest"]), C.world_deltas(follow)["leftHand"])
assert angle(rel0, rel1).max() < 1e-3                                                            # 握りを解かない区間の腕は胸に付いていく
assert np.abs(C.joints(follow)["leftToes"] - p0["leftToes"]).max() < 1e-9 and np.abs(C.joints(follow)["rightFoot"] - p0["rightFoot"]).max() < 1e-9
half_way, rec = N.solve(m, 68.0, 0.5)
assert 0.45 < rec["chestTurnDegMax"] / N.solve(m, 68.0, 1.0)[1]["chestTurnDegMax"] < 0.55 and rec["headMoveDegMax"] > 10

# 解剖の定義: 既知の姿勢
for s, sign in A.SIGN.items():
    down, front, side_ = np.array([0, -1.0, 0]), np.array([0, 0, 1.0]), np.array([sign, 0, 0])
    a = A.arm_angles(down, front, -side_, sign)                                                  # 腕を下ろして前腕は前、手のひらは内
    assert abs(a["elevation"]) < 1e-3 and abs(a["flexion"] - 90) < 1e-6 and abs(a["rotation"]) < 1e-6 and abs(a["pronation"]) < 1e-6, a
    assert abs(A.arm_angles(down, -side_, down * 0 + front * -1, sign)["rotation"] - 90) < 1e-6   # 前腕が腹の前は内旋
    assert abs(A.arm_angles(down, front, down, sign)["pronation"] - 90) < 1e-6                    # 手のひらが下は回内
    assert abs(A.arm_angles(down, front, -down, sign)["pronation"] + 90) < 1e-6
    assert abs(A.arm_angles(front, np.array([0, 1.0, 0]), -side_, sign)["horizontal"] - 90) < 1e-6 and abs(A.arm_angles(side_, front, down, sign)["horizontal"]) < 1e-6
    assert abs(A.arm_angles(side_, front, down, sign)["elevation"] - 90) < 1e-6 and np.isnan(A.arm_angles(side_, side_, down, sign)["rotation"])

# 計画: 上限は設定で、report.json と generated.json に出る。文章と VRMA の区間には当たらない
sys.path.insert(0, str(ROOT / "test"))
fbx = TMP / "attack.fbx"
fbx.write_bytes(b"fbx")
vrma = TMP / "plain.vrma"
held = twisted_clip(np.full(30, 100.0))
write_vrma(vrma, held, "test")
personal = {"holder": "テスト", "summary": "テスト", "redistribution": False}


def plan(body, name):
    f = TMP / f"{name}.json"
    f.write_text(json.dumps(body, ensure_ascii=False), encoding="utf8")
    return subprocess.run([sys.executable, str(ROOT / "tools/compose/compose.py"), str(f), "--out", str(TMP / name), "--work", str(TMP / "work"), "--fake"], capture_output=True, text=True, encoding="utf8", env={"PYTHONUTF8": "1", **os.environ})


r = plan({"bridge": {"seconds": 0.2}, "segments": [{"source": "vrma", "label": "踊る", "path": str(vrma), "license": personal}]}, "plain")
assert r.returncode == 0, r.stderr
assert "neck" not in json.loads((TMP / "plain/report.json").read_text(encoding="utf8"))
assert "neckLimitDeg" not in json.loads((TMP / "plain/generated.json").read_text(encoding="utf8"))["segments"][0]
kept = C.world_deltas(compose.read_vrma(TMP / "plain/motion.vrma"))
assert angle(qmul(qinv(kept["chest"]), kept["head"]), turn(np.full(30, 100.0))).max() < 0.01     # VRMA の区間の頭は 100 度のまま

asset = {"source": "asset", "label": "攻撃", "path": str(fbx), "license": personal}
key = compose.asset_key(asset)
cache = TMP / "work/cache"
names = ["B_Pelvis", "B_Spine", "B_Spine1", "B_Neck", "B_Head", "B_L_UpperArm", "B_L_Forearm", "B_L_Hand", "B_R_UpperArm", "B_R_Forearm", "B_R_Hand", "B_L_Thigh", "B_L_Calf", "B_L_Foot", "B_L_Toe0", "B_R_Thigh", "B_R_Calf", "B_R_Foot", "B_R_Toe0"]
ref_pos = np.array([[0, 0, 1.3], [0, 0, 1.45], [0, 0, 1.65], [0, 0, 1.95], [0, 0, 2.1], [0.4, 0, 1.9], [0.7, 0, 1.9], [0.95, 0, 1.9], [-0.4, 0, 1.9], [-0.7, 0, 1.9], [-0.95, 0, 1.9],
                    [0.15, 0, 1.3], [0.15, 0, 0.75], [0.15, 0, 0.2], [0.15, -0.25, 0.02], [-0.15, 0, 1.3], [-0.15, 0, 0.75], [-0.15, 0, 0.2], [-0.15, -0.25, 0.02]])
F = 31
rot = np.tile(C.IDENTITY, (F, len(names), 1))
rot[:, 4] = turn(np.linspace(0, 107, F), [0, 0, 1.0])         # FBX の世界は Z が上
pos = np.tile(ref_pos, (F, 1, 1))
np.savez_compressed(cache / f"fbx-{key}.dump.npz", names=np.array(names), pos=pos, rot=rot, ref_pos=ref_pos, ref_rot=np.tile(C.IDENTITY, (len(names), 1)), fps=30.0, unknown=np.array([], dtype=str))
for name, extra, limit in (("default", {}, 80.0), ("set", {"neckLimitDeg": 60}, 60.0), ("planset", None, 50.0), ("low", {"neckLimitDeg": 30}, 30.0), ("high", {"neckLimitDeg": 180}, 180.0)):
    body = {"bridge": {"seconds": 0.2}, "segments": [{**asset, **(extra or {})}]}
    if extra is None:
        body["neckLimitDeg"] = 50
    r = plan(body, name)
    assert r.returncode == 0, r.stderr
    row = json.loads((TMP / name / "report.json").read_text(encoding="utf8"))["neck"][0]
    seg = json.loads((TMP / name / "generated.json").read_text(encoding="utf8"))["segments"][0]
    print(name, row)
    assert row["limitDeg"] == limit and row["headChestDegMax"] == 107 and row["angleDegMax"] <= min(limit + 0.1, 107) and abs(row["yawDeg"][1]) > 25, row
    assert row["chestTurnDegMax"] == 0 and (row["headMoveDegMax"] > 0) == (limit < 180) and "stepDegMax" in row and "headChestStepDegMaxBefore" in row and "chestHipsYawDeg" in row, row
    assert seg["chestShare"] == 0 and seg["neckLimitDeg"] == limit and seg["retarget"]["neck"]["limitDeg"] == limit and seg["retarget"]["neckLengthM"] > 0.05, seg
for bad in (10, 200):
    r = plan({"segments": [{**asset, "neckLimitDeg": bad}]}, "bad")
    assert r.returncode != 0 and "neckLimitDeg は" in r.stderr, r.stderr
r = plan({"bridge": {"seconds": 0.2}, "segments": [{**asset, "chestShare": 1}]}, "still")
row = json.loads((TMP / "still/report.json").read_text(encoding="utf8"))["neck"][0]
assert r.returncode == 0 and row["chestTurnDegMax"] > 20 and row["headMoveDegMax"] == 0, (r.stderr, row)
r = plan({"chestShare": 1, "bridge": {"seconds": 0.2}, "segments": [asset]}, "planstill")
assert r.returncode == 0 and json.loads((TMP / "planstill/report.json").read_text(encoding="utf8"))["neck"][0]["chestTurnDegMax"] > 20, r.stderr
r = plan({"segments": [{**asset, "elbowPrior": True}]}, "bad")
assert r.returncode != 0 and "elbowPrior は grip" in r.stderr, r.stderr
r = plan({"segments": [{**asset, "chestShare": 2}]}, "bad")
assert r.returncode != 0 and "chestShare は" in r.stderr, r.stderr
for source in ({"source": "vrma", "label": "踊る", "path": str(vrma), "license": personal}, {"source": "text", "label": "歩く", "prompt": "x", "seconds": 1}):
    for key in ("neckLimitDeg", "chestShare"):
        r = plan({"segments": [{**source, key: 60}]}, "bad")
        assert r.returncode != 0 and "asset の区間だけ" in r.stderr, r.stderr
r = plan({"neckLimitDeg": 60, "chestShare": 0.5, "bridge": {"seconds": 0.2}, "segments": [{"source": "text", "label": "歩く", "prompt": "x", "seconds": 1}]}, "textplan")
assert r.returncode == 0 and "neck" not in json.loads((TMP / "textplan/report.json").read_text(encoding="utf8")), r.stderr    # 計画の値は text の区間に当たらない

print("OK")
