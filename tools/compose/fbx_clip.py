"""fbx_dump.py が書いた npz を中間形式にする。

FBX の基準の姿勢は T ポーズとは限らない（Warrior は腕を下ろした姿勢）。骨ごとに、基準の姿勢の骨の向き（子の骨への向き）を
REST の体の T ポーズの向きへ最小の回転で向ける回転 F を求め、ADR 0003 の差 D を次の式で出す:

    D(t) = B * W(t) * W_ref^-1 * B^-1 * F^-1

B は FBX の世界を VRM の世界（Y が上、前が +Z、左が +X）へ向ける回転で、基準の姿勢の骨の位置から求める。座標軸の決めごとに頼らない。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

import clip as C
from bone_maps import detect
import fingers
from grip import OTHER, rotation_between, source_arms
from soma_vrma import qinv, qmul, qnormalize, qrot

# 骨の向きを決める子の骨。順に探して、最初にある骨を使う
CHILD = {
    "spine": ("chest", "upperChest", "neck", "head"), "chest": ("upperChest", "neck", "head"), "upperChest": ("neck", "head"), "neck": ("head",),
    "leftShoulder": ("leftUpperArm",), "rightShoulder": ("rightUpperArm",),
    "leftUpperArm": ("leftLowerArm",), "rightUpperArm": ("rightLowerArm",), "leftLowerArm": ("leftHand",), "rightLowerArm": ("rightHand",),
    "leftHand": ("leftMiddleProximal",), "rightHand": ("rightMiddleProximal",),
    "leftUpperLeg": ("leftLowerLeg",), "rightUpperLeg": ("rightLowerLeg",), "leftLowerLeg": ("leftFoot",), "rightLowerLeg": ("rightFoot",),
    "leftFoot": ("leftToes",), "rightFoot": ("rightToes",),
}
for _side in ("left", "right"):
    for _finger, _joints in C.FINGER_JOINTS.items():
        for _a, _b in zip(_joints, _joints[1:]):
            CHILD[f"{_side}{_finger}{_a}"] = (f"{_side}{_finger}{_b}",)


def find_rest(fbx):
    """Empty の骨の FBX の基準の姿勢にするキャラの FBX を探す。Animations/2Handed_Attack1.FBX なら Characters/2Handed.FBX。"""
    fbx = Path(fbx)
    chars = fbx.parent.parent / "Characters"
    if not chars.is_dir():
        return None
    same = [p for p in chars.iterdir() if p.suffix.lower() == ".fbx" and fbx.stem.lower().startswith(p.stem.lower())]
    return str(max(same, key=lambda p: len(p.stem))) if same else None


def matrix_to_quat(m):
    t = np.trace(m)
    if t > 0:
        s = np.sqrt(t + 1) * 2
        return np.array([(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4])
    k = int(np.argmax(np.diag(m)))
    j, l = (k + 1) % 3, (k + 2) % 3
    s = np.sqrt(1 + m[k, k] - m[j, j] - m[l, l]) * 2
    q = np.zeros(4)
    q[k], q[j], q[l], q[3] = s / 4, (m[j, k] + m[k, j]) / s, (m[l, k] + m[k, l]) / s, (m[l, j] - m[j, l]) / s
    return qnormalize(q)


def basis(ref_pos, found):
    """FBX の世界から VRM の世界への回転 B。上は hips から head、左は右腕の付け根から左腕の付け根。"""
    up = ref_pos[found["head"]] - ref_pos[found["hips"]]
    left = ref_pos[found["leftUpperArm"]] - ref_pos[found["rightUpperArm"]]
    up = up / np.linalg.norm(up)
    left = left - up * np.dot(left, up)
    left = left / np.linalg.norm(left)
    return matrix_to_quat(np.stack([left, up, np.cross(left, up)]))   # 行が VRM の X、Y、Z の向き


def frame_between(a, a2, b, b2):
    """向き a を b へ、さらに a2 の a に垂直な成分を b2 の b に垂直な成分へ移す回転（2 組の向きを合わせる）。"""
    def frame(x, y):
        x = x / np.linalg.norm(x)
        y = y - x * np.dot(y, x)
        y = y / np.linalg.norm(y)
        return np.stack([x, y, np.cross(x, y)], axis=1)
    return matrix_to_quat(frame(b, b2) @ frame(a, a2).T)


def palm_fix(found, ref_v, side):
    """手の F を、指の向き（手首から中指の付け根）と手のひらの横（小指の付け根から人差し指の付け根）の 2 組で決める。
    骨の向きだけで決めると、基準の姿勢の手のひらの向き（ねじれ）がそのまま残る。指の付け根が無ければ None。"""
    hand, mid, idx, lit = (side + n for n in ("Hand", "MiddleProximal", "IndexProximal", "LittleProximal"))
    if not all(b in found for b in (hand, mid, idx, lit)):
        return None
    return frame_between(ref_v[found[mid]] - ref_v[found[hand]], ref_v[found[idx]] - ref_v[found[lit]],
                         C.REST[mid] - C.REST[hand], C.REST[idx] - C.REST[lit])


def fix_rotations(found, ref_v, palm=False):
    """骨ごとの F。子の骨が無い骨は親と同じだけ直す。胴の端（hips、head）は基準の姿勢のまま。
    palm が真なら、手は手のひらの向きまで合わせる（palm_fix）。指は手の F に従う。"""
    fix = {"hips": C.IDENTITY, "head": C.IDENTITY}
    for bone in ["spine", "chest", "upperChest", "neck", *C.ORDER[5:]]:
        if bone not in found:
            continue
        child = next((c for c in CHILD.get(bone, ()) if c in found), None)
        if child is None:
            fix[bone] = fix.get(C.PARENT.get(bone), C.IDENTITY)
            continue
        to = C.REST["chest" if child == "upperChest" else child] - C.REST["chest" if bone == "upperChest" else bone]
        if np.linalg.norm(to) < 1e-6:   # chest の子が upperChest のとき、T ポーズの向きは neck への向きで代える
            to = C.REST["neck"] - C.REST["chest"]
        src = ref_v[found[child]] - ref_v[found[bone]]
        side = "left" if bone.startswith("left") else "right"
        if palm and bone not in ("leftHand", "rightHand") and any(bone.startswith(side + f) for f in C.FINGER_JOINTS) and side + "Hand" in fix:
            # 指は手と同じねじれから始め、残りの曲がりだけを最小の回転で足す
            fix[bone] = qmul(rotation_between(qrot(fix[side + "Hand"], src), to), fix[side + "Hand"])
            continue
        fix[bone] = rotation_between(src, to)
        if palm and bone in ("leftHand", "rightHand"):
            fix[bone] = palm_fix(found, ref_v, bone[:-4]) if palm_fix(found, ref_v, bone[:-4]) is not None else fix[bone]
    return fix


def fbx_to_clip(path, grip=None, hand_pose=None, diameter_cm=fingers.GRIP_DIAMETER_CM, palm=False):
    """npz を読んで (中間形式, 記録) を返す。palm は fix_rotations へ渡す（区間の handFrame が palm のとき）。

    grip は武器を持つ手（right か left）。指定すると、素材の両手首の差を持つ手のローカル座標で表した m["gripLocal"]（[F, 3]、REST の体の m）と、元の体の比の腕の長さ m["gripArms"] を足す。
    回転はどの指定でも同じ。腕を解くのは切り出しと速さのあと（grip.apply）。
    """
    z = np.load(path, allow_pickle=False)
    names = [str(n) for n in z["names"]]
    found, table = detect(names)
    unknown = {str(n) for n in z["unknown"]}
    lost = [names[i] for i in found.values() if names[i] in unknown]
    if lost:
        raise ValueError("基準の FBX に無い骨がある: " + ", ".join(lost[:6]))
    b = basis(z["ref_pos"], found)
    ref_v = qrot(np.broadcast_to(b, z["ref_pos"].shape[:-1] + (4,)), z["ref_pos"])
    fix = fix_rotations(found, ref_v, palm)
    F = len(z["rot"])
    bb, bi = np.broadcast_to(b, (F, 4)), np.broadcast_to(qinv(b), (F, 4))
    moved = {bone: qmul(qmul(bb, qmul(z["rot"][:, i], np.broadcast_to(qinv(z["ref_rot"][i]), (F, 4)))), bi) for bone, i in found.items()}
    deltas, finger_record = fingers.transfer(moved, {bone: qmul(q, np.broadcast_to(qinv(fix[bone]), (F, 4))) for bone, q in moved.items()}, found, ref_v, hand_pose, diameter_cm)
    feet = [found[k] for k in ("leftFoot", "rightFoot", "leftToes", "rightToes") if k in found]
    height = ref_v[found["hips"], 1] - ref_v[feet, 1].min()
    scale = (C.HIPS_HEIGHT - C.REST["leftToes"][1]) / height
    hips = qrot(bb, z["pos"][:, found["hips"]]) * scale
    fps = float(z["fps"])
    info = {"boneTable": table, "bonesMapped": len(found), "fpsIn": fps, "framesIn": F, "bodyScale": round(float(scale), 4),
            "neckLengthM": round(float(np.linalg.norm(ref_v[found["head"]] - ref_v[found["neck"]]) * scale), 4) if "neck" in found else None, "fingers": finger_record}
    times = np.arange(F) / fps
    if not grip:
        rot, h = C.resample(times, deltas, hips)
        return C.from_world_deltas(rot, h), info
    gap = qrot(bb, z["pos"][:, found[OTHER[grip] + "Hand"]] - z["pos"][:, found[grip + "Hand"]]) * scale
    rot, h, local = C.resample(times, deltas, hips, extra=qrot(qinv(deltas[grip + "Hand"]), gap))
    m = C.from_world_deltas(rot, h)
    m["gripLocal"], m["gripArms"] = local, source_arms(ref_v, found, scale)
    return m, info
