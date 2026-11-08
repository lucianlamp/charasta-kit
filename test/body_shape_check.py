"""体型を変える道具 tools/vrm/body_shape.py の確かめ。test/fixtures/make_humanoid.py の人型で、値ごとに頂点、骨、逆バインド行列、
コライダー、揺れ骨、モーフが決めたとおりに動くことと、静止の姿勢の skinning が新しい頂点と一致することを見る。"""
import copy
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "tools" / "vrm"))
sys.path.insert(0, str(ROOT / "test" / "fixtures"))
import body_shape as B  # noqa: E402
import glb  # noqa: E402
import make_humanoid as H  # noqa: E402
from neck_len import world_mats  # noqa: E402

JS0, BIN0 = H.build()


def run(**values):
    js, b = copy.deepcopy(JS0), bytearray(BIN0)
    rep = B.body_shape(js, b, values)
    return js, b, rep


def prim(js, b, mesh, attr="POSITION"):
    return glb.acc(js, b, js["meshes"][mesh]["primitives"][0]["attributes"][attr]).astype(float)


def joints_of(js, b, mesh):
    a = js["meshes"][mesh]["primitives"][0]["attributes"]
    return glb.acc(js, b, a["JOINTS_0"]).astype(int)[:, 0], glb.acc(js, b, a["WEIGHTS_0"]).astype(float)


def world(js, bone):
    G, _ = world_mats(js["nodes"])
    return G[H.IDX[bone]][:3, 3]


def rest_error(js, b):
    """静止の姿勢で skinning した位置と、頂点の位置の差の最大(m)"""
    G, _ = world_mats(js["nodes"])
    sk = js["skins"][0]
    IB = glb.acc(js, b, sk["inverseBindMatrices"]).reshape(-1, 4, 4)
    M = np.array([G[j] @ IB[k].T for k, j in enumerate(sk["joints"])])
    worst = 0.0
    for mesh in js["meshes"]:
        a = mesh["primitives"][0]["attributes"]
        P = glb.acc(js, b, a["POSITION"]).astype(float)
        J = glb.acc(js, b, a["JOINTS_0"]).astype(int)
        W = glb.acc(js, b, a["WEIGHTS_0"]).astype(float)
        Ph = np.c_[P, np.ones(len(P))]
        S = sum(W[:, c:c + 1] * np.einsum("nij,nj->ni", M[J[:, c]], Ph)[:, :3] for c in range(4))
        worst = max(worst, float(np.abs(S - P).max()))
    return worst


P0, F0, HAIR0 = prim(JS0, BIN0, 0), prim(JS0, BIN0, 1), prim(JS0, BIN0, 2)
J0, W0 = joints_of(JS0, BIN0, 0)
bone_of = lambda name: J0 == H.IDX[name]

# 何も変えない値は、頂点も骨も変えない
js, b, rep = run()
assert all(rep[k] is None for k in ("slim", "shoulder", "neck", "head")), rep
assert bytes(b) == bytes(BIN0) and js["nodes"] == JS0["nodes"]

# 腕: 上腕と前腕の頂点は骨の軸までの距離が 0.8 倍、軸に沿った位置はそのまま。手と胴は動かない。上腕のコライダーは半径と軸に垂直な offset が 0.8 倍
js, b, rep = run(arm=0.8)
P = prim(js, b, 0)
for s in ("left", "right"):
    for bone, child in ((f"{s}UpperArm", f"{s}LowerArm"), (f"{s}LowerArm", f"{s}Hand")):
        sel = bone_of(bone)
        a0 = H.POS[bone]
        u = (H.POS[child] - a0) / np.linalg.norm(H.POS[child] - a0)
        r0 = P0[sel] - a0
        r1 = P[sel] - a0
        perp0 = r0 - np.outer(r0 @ u, u)
        perp1 = r1 - np.outer(r1 @ u, u)
        assert np.allclose(perp1, 0.8 * perp0, atol=1e-6), bone
        assert np.allclose(r1 @ u, r0 @ u, atol=1e-6), bone
for keep in ("leftHand", "hips", "spine", "chest", "leftUpperLeg"):
    assert np.allclose(P[bone_of(keep)], P0[bone_of(keep)]), keep
Nrm = prim(js, b, 0, "NORMAL")
assert np.allclose(np.linalg.norm(Nrm, axis=1), 1, atol=1e-5)
arm_col = js["extensions"]["VRMC_springBone"]["colliders"][2]["shape"]["sphere"]
assert abs(arm_col["radius"] - 0.032) < 1e-9 and np.allclose(arm_col["offset"], [0.1, 0.008, 0.016]), arm_col
assert rep["slim"]["colliders"] == 1, rep

# 脚: 太ももは 0.8 倍。足首から脛の 4 割までは 1 へ戻す(足の筒は動かない)
js, b, rep = run(leg=0.8)
P = prim(js, b, 0)
sel = bone_of("leftUpperLeg")
d0 = np.hypot(P0[sel, 0] - 0.08, P0[sel, 2])
d1 = np.hypot(P[sel, 0] - 0.08, P[sel, 2])
assert np.allclose(d1, 0.8 * d0, atol=1e-6)
low = bone_of("leftLowerLeg") & (P0[:, 1] < 0.105)
assert low.any() and np.allclose(P[low], P0[low], atol=1e-6), "足首の頂点は動かない"
assert np.allclose(P[bone_of("leftFoot")], P0[bone_of("leftFoot")])
cap = js["extensions"]["VRMC_springBone"]["colliders"][3]["shape"]["capsule"]
assert abs(cap["radius"] - 0.056) < 1e-9, cap

# 腰: spine の頂点は左右 0.9 倍、前後 0.95 倍(体の中心の縦の線から)。高さは変えない。spine のコライダーは半径 0.9 倍
js, b, rep = run(waist=0.9)
P = prim(js, b, 0)
sel = bone_of("spine")
assert np.allclose(P[sel, 0], 0.9 * P0[sel, 0], atol=1e-6) and np.allclose(P[sel, 2], 0.95 * P0[sel, 2], atol=1e-6) and np.allclose(P[sel, 1], P0[sel, 1])
assert abs(js["extensions"]["VRMC_springBone"]["colliders"][1]["shape"]["sphere"]["radius"] - 0.09) < 1e-9

# 肩幅: 片側 2 cm 狭く。上腕から先の骨と頂点は 2 cm 中へ、胸の下と首と頭は動かない
js, b, rep = run(shoulder=-0.02)
P = prim(js, b, 0)
assert np.allclose(world(js, "leftUpperArm"), H.POS["leftUpperArm"] - [0.02, 0, 0], atol=1e-6)
assert np.allclose(world(js, "rightHand"), H.POS["rightHand"] + [0.02, 0, 0], atol=1e-6)
for s, sg in (("left", 1), ("right", -1)):
    for bone in (f"{s}LowerArm", f"{s}Hand"):
        assert np.allclose(P[bone_of(bone), 0], P0[bone_of(bone), 0] - sg * 0.02, atol=1e-6), bone
for keep in ("hips", "spine", "leftUpperLeg"):
    assert np.allclose(P[bone_of(keep)], P0[bone_of(keep)]), keep
assert np.allclose(world(js, "head"), H.POS["head"]) and np.allclose(prim(js, b, 1), F0)
assert rest_error(js, b) < 1e-5

# 首: 1 cm 伸ばす。頭の骨とその子(髪の揺れ骨)、顔、髪は 1 cm 上へ。首の筒の下の端と胴は動かない
js, b, rep = run(neck=0.01)
P = prim(js, b, 0)
assert np.allclose(world(js, "head"), H.POS["head"] + [0, 0.01, 0]) and np.allclose(world(js, "J_Sec_Hair2_01"), H.POS["J_Sec_Hair2_01"] + [0, 0.01, 0])
assert np.allclose(prim(js, b, 1), F0 + [0, 0.01, 0], atol=1e-6) and np.allclose(prim(js, b, 2), HAIR0 + [0, 0.01, 0], atol=1e-6)
z0, z1 = rep["neck"]["band"]
neck_ring = bone_of("neck") | (J0 == H.IDX["head"])
assert np.allclose(P[neck_ring & (P0[:, 1] <= z0)], P0[neck_ring & (P0[:, 1] <= z0)])
assert np.allclose(P[bone_of("chest")], P0[bone_of("chest")])
assert rest_error(js, b) < 1e-5

# 頭: 0.9 倍。顔の頂点は中心 C からの距離が 0.9 倍、モーフの差分も 0.9 倍。頭のコライダーと髪の当たりも 0.9 倍。胴は動かない
js, b, rep = run(head=0.9)
C = np.array(rep["head"]["center"])
F = prim(js, b, 1)
assert np.allclose(F - C, 0.9 * (F0 - C), atol=2e-4)
mo0 = glb.acc(JS0, BIN0, JS0["meshes"][1]["primitives"][0]["targets"][0]["POSITION"])
mo1 = glb.acc(js, b, js["meshes"][1]["primitives"][0]["targets"][0]["POSITION"])
assert np.allclose(mo1, 0.9 * mo0, atol=1e-7)
sp = js["extensions"]["VRMC_springBone"]
assert abs(sp["colliders"][0]["shape"]["sphere"]["radius"] - 0.09) < 1e-9 and np.allclose(sp["colliders"][0]["shape"]["sphere"]["offset"], [0, 0.09, 0])
assert all(abs(j["hitRadius"] - 0.018) < 1e-9 for s in sp["springs"][:2] for j in s["joints"])
assert all(abs(j["hitRadius"] - 0.02) < 1e-9 for j in sp["springs"][2]["joints"]), "スカートの当たりは変えない"
assert np.allclose(prim(js, b, 0)[bone_of("chest")], P0[bone_of("chest")])
assert rest_error(js, b) < 1e-5

# 全部を一度に: 静止の姿勢の skinning が新しい頂点と一致する(逆バインド行列と節点がそろっている)
js, b, rep = run(head=0.94, neck=0.0075, shoulder=-0.024, arm=0.8, waist=0.95, leg=0.9)
assert rest_error(js, b) < 1e-5
assert len(js["nodes"]) == len(JS0["nodes"]) and [s["name"] for s in js["extensions"]["VRMC_springBone"]["springs"]] == [s["name"] for s in JS0["extensions"]["VRMC_springBone"]["springs"]]

# 範囲の外と、VRM 0.x は止める
for bad in ({"head": 1.5}, {"arm": 0.1}, {"neck": 0.2}):
    try:
        run(**bad)
        raise AssertionError(f"止まらない: {bad}")
    except ValueError as e:
        assert "から" in str(e)
vrm0 = copy.deepcopy(JS0)
vrm0["extensions"] = {"VRM": {}}
try:
    B.body_shape(vrm0, bytearray(BIN0), {"arm": 0.9})
    raise AssertionError("VRM 0.x で止まらない")
except ValueError as e:
    assert "VRM 1.0" in str(e)

# CLI: 書き出したファイルを読み直せる。範囲の外は終了コード 2
tmp = Path(tempfile.mkdtemp(prefix="charasta-body-"))
src, out = tmp / "in.vrm", tmp / "out.vrm"
glb.save(str(src), copy.deepcopy(JS0), bytearray(BIN0))
env = {**os.environ, "PYTHONUTF8": "1"}
r = subprocess.run([sys.executable, str(ROOT / "tools" / "vrm" / "body_shape.py"), str(src), str(out), "--arm", "0.9", "--neck", "0.005"], capture_output=True, text=True, env=env)
assert r.returncode == 0, r.stderr
js2, b2 = glb.load(str(out))
assert rest_error(js2, b2) < 1e-5 and abs(world(js2, "head")[1] - 1.315) < 1e-6
r = subprocess.run([sys.executable, str(ROOT / "tools" / "vrm" / "body_shape.py"), str(src), str(out), "--head", "2"], capture_output=True, text=True, env=env)
assert r.returncode == 2 and "head" in r.stderr, r.stderr
r = subprocess.run([sys.executable, str(ROOT / "tools" / "vrm" / "body_shape.py"), str(src), "--probe"], capture_output=True, text=True, env=env)
assert r.returncode == 0 and '"neckBand"' in r.stdout, r.stdout
print("OK body_shape")
