"""ExMR の仕上げ（tools/rgbmocap の bvh_cut と plant_feet）の純粋な部分。Blender、RGB MoCap、vrma-pipeline は呼ばない（numpy と scipy は要る）。"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools" / "rgbmocap"))
import bvh_cut  # noqa: E402
import plant_feet  # noqa: E402
import hand_shape_fix as hf  # noqa: E402

# --- 先頭の別カットの検出 ---
calm = np.full(40, 4.0)
assert bvh_cut.find_cut(calm) == 0, "跳びが無ければ何もしない"
s = calm.copy(); s[0] = 100.0
assert bvh_cut.find_cut(s) == 1, "最初の遷移だけ跳ぶなら次のコマ"
s = calm.copy(); s[0], s[1], s[2] = 100.0, 30.0, 3.0   # 跳びのあとに緩和の遷移が続く
assert bvh_cut.find_cut(s) == 2
s = calm.copy(); s[0:4] = [100.0, 50.0, 40.0, 30.0]    # 緩和が長引いても最大 MAX_SETTLE コマ
assert bvh_cut.find_cut(s) == 1 + bvh_cut.MAX_SETTLE
s = calm.copy(); s[20] = 100.0
assert bvh_cut.find_cut(s) == 0, "先頭の窓の外の跳びは動きとして残す"
s = np.full(40, 30.0); s[0] = 70.0
assert bvh_cut.find_cut(s) == 0, "動きが速い動画では、中央値の倍率に届かない遷移は切れ目にしない"
assert bvh_cut.find_cut([100.0, 1.0]) == 0, "短すぎる列は判定しない"

# --- BVH 全体: 2 関節（チャンネルの順が違う）、先頭 2 コマが別のカット ---
HEAD = """HIERARCHY
ROOT Hips
{
  OFFSET 0 1 0
  CHANNELS 6 Xposition Yposition Zposition Yrotation Zrotation Xrotation
  JOINT Spine
  {
    OFFSET 0 0.1 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 0.1 0
    }
  }
}
"""
rows = []
for i in range(14):
    yaw = 170.0 if i < 1 else 0.5 * i   # コマ 0 だけ別のカット
    rows.append(f"{0.1 * i} 1 0 {yaw} 0 0 {i} 0 0")
text = HEAD + "MOTION\nFrames: 14\nFrame Time: 0.0333333\n" + "\n".join(rows) + "\n"
out, rep = bvh_cut.fix_text(text)
assert rep["cut_frame"] == 1 and rep["jump_deg"] > 100, rep
_, _, mh, data = bvh_cut.parse_bvh(out)
assert mh == ["Frames: 14", "Frame Time: 0.0333333"] and data.shape == (14, 9)
assert np.allclose(data[0], data[1]) and np.allclose(data[1:], bvh_cut.parse_bvh(text)[3][1:]), "切れ目より前だけ書き換える"
same, rep2 = bvh_cut.fix_text(out)
assert rep2["cut_frame"] == 0 and same == out, "直した後はもう一度かけても変わらない"

# --- 接地の区間 ---
seg = np.array([[0, 3, 31, 0, 0, 0], [1, 40, 40, 0, 0, 0], [1, 50, 99, 0, 0, 0], [0, 10, 12, 0, 0, 0]], float)
m = plant_feet.contact_masks(seg, 60)
assert m["left"][3:31].all() and not m["left"][31] and not m["left"][2], "足 0 = 左、終了のコマは含まない"
assert m["right"][40] and not m["right"][41], "長さ 0 の区間は 1 コマ"
assert m["right"][50:60].all() and m["right"].shape == (60,), "終了が列の外でも切る"
j = plant_feet.contacts_json(m, 60)
assert j["order"] == ["leftHeel", "leftToe", "rightHeel", "rightToe"] and len(j["frames"]) == 60
assert j["frames"][5] == [1.0, 1.0, 0.0, 0.0] and j["frames"][45] == [0.0, 0.0, 0.0, 0.0] and j["frames"][55] == [0.0, 0.0, 1.0, 1.0]

# --- 平滑 ---
x = np.r_[np.zeros(10), np.ones(10)]
y = plant_feet.smooth(x, 7)
assert len(y) == 20 and np.all(np.diff(y) >= -1e-12) and 0 <= y.min() and y.max() <= 1 + 1e-9, "単調で長さを保つ"
assert plant_feet.smooth(x, 1) is x

# --- 手の補正 v3 ---
# 指全体の曲がり(手のひら側が正)を目標へ動かす範囲を越えない: 目標が +10 度先なら MCP の補正は 0 から +10 まで
assert np.allclose(hf.limit_curl([5, 20, -5, 0], np.array([10.0, 10.0, 10.0, 10.0]), 1.0), [5, 10, 0, 0]), "曲げる目標を越えない、逆向きは 0"
assert np.allclose(hf.limit_curl([-5, -20, 5], np.array([-10.0, -10.0, -10.0]), 1.0), [-5, -10, 0]), "伸ばす目標を越えない"
assert np.allclose(hf.limit_curl([-5, -20, 5], np.array([10.0, 10.0, 10.0]), -1.0), [-5, -10, 0]), "手のひら側が n の逆なら符号を反転して同じ制限"
assert np.allclose(hf.limit_curl([7.0], np.array([0.0]), 1.0), [0.0]), "全体の曲がりがすでに目標なら動かさない"
# 穴の補間: 15 コマまでは補間、それより外は fallback
valid = np.zeros(60, bool); valid[[10, 20]] = True
tg = np.zeros(60); tg[10], tg[20] = 10.0, 20.0
out, miss = hf.fill(tg, valid, np.full(60, -1.0))
assert out[15] == 15.0 and not miss[15], "穴は補間"
assert out[2] == 10.0 and not miss[2], "端でも 15 コマ以内なら最も近い値で補間"
assert miss[50] and out[50] == -1.0, "15 コマより外は fallback"
assert hf.fill(tg, np.zeros(60, bool), np.full(60, 3.0))[1].all(), "使えるコマが無ければ全部 fallback"
# 手のひらの潰れ: 手首原点、中指の付け根 y=1、人差し指と小指が x=±0.3 で三角形の比 0.3、潰れると 0
W = np.zeros((2, 21, 3)); W[:, 9] = [0, 1, 0]
W[0, 5], W[0, 17] = [0.6, 1, 0], [-0.6, 1, 0]
W[1, 5], W[1, 17] = [0.01, 1, 0], [0.0, 1, 0]
r = hf.palm_ratio(W)
assert abs(r[0] - 0.6) < 1e-9 and r[1] < 0.01, r
# 外転は fwd と n の面からの角: 面内なら 0、横軸(across)へ 20 度出れば 20
a = np.array([1.0, 0, 0])
assert abs(hf.abd(np.array([0, 1.0, 0]), a)) < 1e-9
assert abs(hf.abd(np.array([np.sin(np.radians(20)), np.cos(np.radians(20)), 0]), a) - 20) < 1e-6

print("OK exmr polish")
