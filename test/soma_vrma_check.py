"""tools/soma_vrma.py の移し替えの確かめ（test/motion-gen.test.mjs から呼ぶ。numpy だけ）。

作りものの SOMA の骨（tools/motionbricks_gen.py の FAKE_SKELETON）に乱数の姿勢を入れ、移し替えた VRM の骨を
T ポーズの骨の上で組み立て直したとき、各骨の向き（親から子への向き）が SOMA と同じになることを確かめる。
書いた VRMA を読み直して、回転とhips の位置がそのまま入っていることも確かめる。成功なら最後に OK を出す。
"""

import json
import struct
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from motionbricks_gen import FAKE_SKELETON  # noqa: E402
from soma_vrma import BONES, forward_kinematics, qmul, qnormalize, qrot, retarget, write_vrma  # noqa: E402

rng = np.random.default_rng(1)
names = [n for n, _, _ in FAKE_SKELETON]
parents = [p for _, p, _ in FAKE_SKELETON]
rest = np.zeros((len(names), 7))
rest[:, :3] = [o for _, _, o in FAKE_SKELETON]
rest[:, 6] = 1.0
F = 20
local = np.repeat(rest[None], F, 0)
local[:, :, 3:] = qnormalize(rest[None, :, 3:] + rng.normal(0, 0.35, (F, len(names), 4)))
local[:, 0, :3] = rest[0, :3] + rng.normal(0, 0.3, (F, 3))

motion = retarget(names, parents, rest, local, 30)
pos, _ = forward_kinematics(parents, local)
rest_pos, _ = forward_kinematics(parents, rest)
index = {n: i for i, n in enumerate(names)}
bone_names = [b for b, _, _ in BONES]
parent_of = {b: p for b, _, p in BONES}

# VRM の骨のワールドの回転を、ローカルの回転を親から順にかけて組み立てる
world = {}
for b in bone_names:
    q = motion["rotations"][b]
    world[b] = q if parent_of[b] is None else qmul(world[parent_of[b]], q)

# 最初のコマで向きをそろえた回転（Y 軸まわり）を、SOMA の向きと比べる前に戻す
fwd0 = qrot(world["hips"][0], np.array([0.0, 0.0, 1.0]))
assert abs(fwd0[0]) < 1e-6 and fwd0[2] > 0, f"最初のコマの前が +Z でない: {fwd0}"
som_fwd = qrot(qmul(local[0, 0, 3:], np.array([0, 0, 0, 1.0])), np.array([0.0, 0.0, 1.0]))
angle = np.arctan2(som_fwd[0], som_fwd[2])
undo = np.array([0.0, np.sin(angle / 2), 0.0, np.cos(angle / 2)])

worst = 0.0
for b, s, p in BONES:
    kids = [c for c, _, cp in BONES if cp == b]
    if not kids:
        continue
    # SOMA で直接の子になっているものだけ比べる（spine -> chest は間に Spine2 がある）
    direct = [c[1] for c in BONES if c[0] in kids and parents[index[c[1]]] == index[s]]
    if not direct:
        continue
    child = direct[0]
    want = pos[:, index[child]] - pos[:, index[s]]
    want /= np.linalg.norm(want, axis=-1, keepdims=True)
    bone = rest_pos[index[child]] - rest_pos[index[s]]
    got = qrot(qmul(np.broadcast_to(undo, (F, 4)), world[b]), np.broadcast_to(bone, (F, 3)))
    got /= np.linalg.norm(got, axis=-1, keepdims=True)
    worst = max(worst, float(np.abs(got - want).max()))
assert worst < 1e-6, f"骨の向きが合わない（最大の差 {worst}）"

# VRM の骨のワールドの回転は、SOMA の静止姿勢からのワールドの回転の差そのもの
_, rot = forward_kinematics(parents, local)
_, rest_rot = forward_kinematics(parents, rest)
for b, s, _ in BONES:
    d = qmul(rot[:, index[s]], rest_rot[index[s]] * np.array([-1, -1, -1, 1.0]))
    g = qmul(np.broadcast_to(undo, (F, 4)), world[b])
    err = np.minimum(np.abs(g - d).max(-1), np.abs(g + d).max(-1)).max()
    assert err < 1e-6, f"{b} のワールドの回転が合わない（{err}）"

# 書いた VRMA を読み直す
with tempfile.TemporaryDirectory() as d:
    out = Path(d) / "m.vrma"
    meta = write_vrma(out, motion)
    buf = out.read_bytes()
    jl = struct.unpack_from("<I", buf, 12)[0]
    js = json.loads(buf[20:20 + jl])
    bin_ = buf[20 + jl + 8:]
    assert meta["frames"] == F
    hb = js["extensions"]["VRMC_vrm_animation"]["humanoid"]["humanBones"]
    assert set(hb) == set(bone_names)
    for node in js["nodes"]:
        assert "rotation" not in node, "静止姿勢の節点に回転がある（T ポーズで回転なしのはず）"

    def read(acc_i, width):
        a = js["accessors"][acc_i]
        v = js["bufferViews"][a["bufferView"]]
        return np.frombuffer(bin_, np.float32, a["count"] * width, v["byteOffset"]).reshape(a["count"], width)

    anim = js["animations"][0]
    for ch in anim["channels"]:
        s = anim["samplers"][ch["sampler"]]
        b = js["nodes"][ch["target"]["node"]]["name"]
        if ch["target"]["path"] == "rotation":
            assert np.abs(read(s["output"], 4) - motion["rotations"][b]).max() < 1e-6
        else:
            assert b == "hips"
            assert np.abs(read(s["output"], 3) - motion["hips"]).max() < 1e-5
    t = read(anim["samplers"][0]["input"], 1)[:, 0]
    assert abs(t[1] - 1 / 30) < 1e-6 and js["accessors"][anim["samplers"][0]["input"]]["max"][0] == t[-1]

# その場（inplace）は、進んだ分を引く
walk = np.repeat(rest[None], 61, 0)
walk[:, 0, 2] += np.linspace(0, 3, 61)
keep = retarget(names, parents, rest, walk, 30)["hips"]
still = retarget(names, parents, rest, walk, 30, root_motion="inplace")["hips"]
assert keep[-1, 2] - keep[0, 2] > 2.9, keep[-1]
assert np.abs(still[:, [0, 2]]).max() < 1e-6, np.abs(still[:, [0, 2]]).max()
print("OK", worst)
