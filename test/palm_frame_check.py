"""fbx_clip の handFrame palm: 基準の姿勢の手が骨の軸のまわりにねじれていても、手と指の補正で T ポーズの手のひらに戻る。"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools" / "compose"))
import clip as C  # noqa: E402
from fbx_clip import fix_rotations  # noqa: E402
from soma_vrma import qrot  # noqa: E402


def axis_angle(axis, deg):
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    h = np.radians(deg) / 2
    return np.array([*(axis * np.sin(h)), np.cos(h)])


bones = [b for b in C.ORDER if b in C.REST]
found = {b: i for i, b in enumerate(bones)}
ref = np.stack([C.REST[b] for b in bones])
for side, twist in (("left", 160.0), ("right", 91.0)):
    hand = C.REST[side + "Hand"]
    axis = C.REST[side + "MiddleProximal"] - hand
    q = axis_angle(axis, twist)
    for b in bones:   # 手から先だけを手首のまわりに、骨の軸でねじる
        if b.startswith(side) and any(b.startswith(side + f) for f in C.FINGER_JOINTS):
            ref[found[b]] = hand + qrot(q, C.REST[b] - hand)


def palm_error(fix, side):
    def normal(p):
        return np.cross(p[side + "IndexProximal"] - p[side + "Hand"], p[side + "LittleProximal"] - p[side + "Hand"])
    moved = {b: qrot(fix[side + "Hand"], ref[found[b]] - ref[found[side + "Hand"]]) for b in (side + "IndexProximal", side + "LittleProximal")}
    moved[side + "Hand"] = np.zeros(3)
    rest = {b: C.REST[b] for b in (side + "Hand", side + "IndexProximal", side + "LittleProximal")}
    a, b = normal(moved), normal(rest)
    return np.degrees(np.arccos(np.clip(np.dot(a, b) / np.linalg.norm(a) / np.linalg.norm(b), -1, 1)))


bone_fix, palm_fix = fix_rotations(found, ref), fix_rotations(found, ref, palm=True)
for side, twist in (("left", 160.0), ("right", 91.0)):
    before, after = palm_error(bone_fix, side), palm_error(palm_fix, side)
    assert abs(before - twist) < 1.0, (side, before)   # 骨の向きだけでは、ねじれがそのまま残る
    assert after < 0.5, (side, after)                  # palm では戻る
    # 指は手と同じねじれから曲がりだけを足すので、中指の付け根の補正は手と同じ
    d = qrot(palm_fix[side + "MiddleProximal"], ref[found[side + "MiddleIntermediate"]] - ref[found[side + "MiddleProximal"]])
    t = C.REST[side + "MiddleIntermediate"] - C.REST[side + "MiddleProximal"]
    assert np.degrees(np.arccos(np.dot(d, t) / np.linalg.norm(d) / np.linalg.norm(t))) < 0.5, side
# palm を付けなければ手以外の補正は同じ
for b in bones:
    if not any(b.startswith(s + f) for s in ("left", "right") for f in ("Hand", *C.FINGER_JOINTS)):
        assert np.allclose(bone_fix.get(b, C.IDENTITY), palm_fix.get(b, C.IDENTITY)), b
print("palm frame ok")
