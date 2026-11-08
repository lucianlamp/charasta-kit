"""tools/vrma_stats.py の確かめ(test/motion-text.test.mjs から呼ぶ。numpy だけ)。

作りものの SOMA の骨で、歩く動き(進みながら脚を前後に振る)と、立ったまま手を振るだけの動き(手を振る間も hips は動かず、脚は動かない)を
VRMA に書き、歩く方だけが hips の道のりと太ももの振れで「歩いている」と判定できる数になることを確かめる。成功なら最後に OK を出す。
"""
import argparse
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import motionbricks_gen as mg  # noqa: E402
from soma_vrma import retarget, write_vrma  # noqa: E402
from vrma_stats import stats  # noqa: E402


def build(path, walk):
    names, parents, rest, local, _, _ = mg.fake_motion(argparse.Namespace(seconds=4.0, speed=1.2))
    if not walk:
        local[:, 0, 2] = 0.0   # その場に立つ
        for leg in ("LeftLeg", "RightLeg"):
            local[:, names.index(leg), 3:] = [0, 0, 0, 1]
        arm = names.index("RightArm")   # 右腕を大きく振る
        t = np.arange(len(local)) / mg.FPS
        local[:, arm, 5] = np.sin(1.0 * np.sin(2 * np.pi * 1.5 * t) / 2)
        local[:, arm, 6] = np.cos(1.0 * np.sin(2 * np.pi * 1.5 * t) / 2)
    write_vrma(path, retarget(names, parents, rest, local, mg.FPS))


d = Path(tempfile.mkdtemp())
build(d / "walk.vrma", True)
build(d / "wave.vrma", False)
w, s = stats(str(d / "walk.vrma")), stats(str(d / "wave.vrma"))
assert w["frames"] == 121 and abs(w["fps"] - 30) < 0.01, w
assert w["hipsPathM"] > 4.0 and w["hipsStraightM"] > 4.0, w   # 1.2 m/s × 4 秒
assert w["legSwingDeg"] > 20 and w["maxAngleDeg"]["leftUpperLeg"] > 20, w
assert s["hipsPathM"] < 0.01 and s["legSwingDeg"] < 1 and s["maxAngleDeg"]["leftUpperLeg"] < 1, s   # 立ったまま
assert s["maxAngleDeg"]["rightUpperArm"] > 45, s   # 手は大きく振れている(腕だけ動く動きは、歩いたことにならない)
print("OK", w["hipsPathM"], w["legSwingDeg"], s["maxAngleDeg"]["rightUpperArm"])
