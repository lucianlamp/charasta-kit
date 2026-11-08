"""FBX の骨の名前と VRM の骨の対応表。名前は小文字の英数字だけにしてから比べる（mixamorig: や B_ のような前置きの違いを吸収する）。

表はどれも内部の名前 upperChest を持てる。upperChest の向きは chest に入る（clip.py）。
"""

from __future__ import annotations

import re

from clip import FINGER_JOINTS

SIDES = (("left", "Left", "l"), ("right", "Right", "r"))
# 無いと動きにならない骨。これ以外（chest、neck、肩、爪先、指）は無ければ親に従う
REQUIRED = ["hips", "spine", "head"] + [s + b for s in ("left", "right") for b in ("UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot")]


def _unity():
    """Unity Humanoid（HumanBodyBones の名前）。Unity の親指の Proximal・Intermediate・Distal は VRM の Metacarpal・Proximal・Distal にあたる。"""
    t = {"hips": "hips", "spine": "spine", "chest": "chest", "upperchest": "upperChest", "neck": "neck", "head": "head"}
    for side, _, _ in SIDES:
        for b in ("Shoulder", "UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot", "Toes"):
            t[(side + b).lower()] = side + b
        for finger, joints in FINGER_JOINTS.items():
            for src, dst in zip(("Proximal", "Intermediate", "Distal"), joints):
                t[f"{side}{finger}{src}".lower()] = f"{side}{finger}{dst}"
    return t


def _mixamo():
    t = {"hips": "hips", "spine": "spine", "spine1": "chest", "spine2": "upperChest", "neck": "neck", "head": "head"}
    for side, src, _ in SIDES:
        for a, b in (("Shoulder", "Shoulder"), ("Arm", "UpperArm"), ("ForeArm", "LowerArm"), ("Hand", "Hand"), ("UpLeg", "UpperLeg"), ("Leg", "LowerLeg"), ("Foot", "Foot"), ("ToeBase", "Toes")):
            t[(src + a).lower()] = side + b
        for finger, name in (("Thumb", "Thumb"), ("Index", "Index"), ("Middle", "Middle"), ("Ring", "Ring"), ("Little", "Pinky")):
            for k, dst in enumerate(FINGER_JOINTS[finger], 1):
                t[f"{src}Hand{name}{k}".lower()] = f"{side}{finger}{dst}"
    return t


def _biped():
    """3ds Max の Biped 由来の名前。Bip01 L Thigh、Explosive の Warrior の B_L_Thigh。"""
    t = {"pelvis": "hips", "spine": "spine", "spine1": "chest", "spine2": "upperChest", "neck": "neck", "head": "head"}
    for side, _, s in SIDES:
        for a, b in (("clavicle", "Shoulder"), ("upperarm", "UpperArm"), ("forearm", "LowerArm"), ("hand", "Hand"), ("thigh", "UpperLeg"), ("calf", "LowerLeg"), ("foot", "Foot"), ("toe0", "Toes")):
            t[s + a] = side + b
        for digit, finger in enumerate(FINGER_JOINTS):
            for k, dst in zip(("", "1", "2"), FINGER_JOINTS[finger]):
                t[f"{s}finger{digit}{k}"] = f"{side}{finger}{dst}"
    return t


TABLES = {"unity-humanoid": _unity(), "mixamo": _mixamo(), "biped": _biped()}


def normalize(name):
    name = re.sub(r"[^a-z0-9]", "", re.split(r"[:|]", name)[-1].lower())
    return re.sub(r"^(bip0*1|b)(?=(l|r)?(pelvis|spine|neck|head|clavicle|upperarm|forearm|hand|thigh|calf|foot|toe0|finger))", "", name)


class BoneMapError(ValueError):
    pass


def detect(names):
    """骨の名前の一覧から対応表を選び、({VRM の骨: 名前の添字}, 表の名前) を返す。必須の骨が足りなければ BoneMapError。"""
    norm = {}
    for i, n in enumerate(names):
        norm.setdefault(normalize(n), i)
    best = None
    for table, entries in TABLES.items():
        found = {dst: norm[src] for src, dst in entries.items() if src in norm}
        missing = [b for b in REQUIRED if b not in found]
        rank = (-len(missing), len(found))
        if best is None or rank > best[0]:
            best = (rank, table, found, missing)
    _, table, found, missing = best
    if missing:
        raise BoneMapError(f"骨の対応が足りない（一番近い表 {table}、{len(found)} 本が対応、無い骨: {', '.join(missing)}）")
    return found, table
