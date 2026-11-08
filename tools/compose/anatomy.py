"""腕の姿勢を解剖の言葉で測り、人の可動域と比べる。座標は胸の座標（+Z 前、+Y 上、+X 左）で、どの体でも同じ定義。

- 挙上 elevation: 腕を下ろした向きから上腕までの角度。180 が真上。
- 水平内外転 horizontal: 水平面での上腕の向き。真横が 0、前が 90、体の反対側へ出ると 90 を超える、後ろが負。挙上が 30〜150 度のコマだけ測る。
- 肘の屈曲 flexion: 伸ばして 0。
- 上腕の回旋 rotation: 腕を下ろして肘を 90 度曲げ、前腕が前を向く姿勢が 0。そこから最小の回転で腕を今の向きへ運んだ前腕の向きとの差。内旋が +。
  肘が 15 度未満か、挙上が 150 度を超えるコマは測らない（軸が定まらない）。
- 前腕の回内 pronation: 肘の曲がる面に手のひらの法線がある姿勢が 0（親指が肘の内側を向く）。回内が +。肘が 15 度未満のコマは測らない。
- 肘が向く方向 elbowDown、elbowOut、elbowBack: 肩と手首を結ぶ線から肘へ向かう単位ベクトルの、下、体の外、後ろの成分。
"""

from __future__ import annotations

import numpy as np

import clip as C
from soma_vrma import qinv, qrot

ROM = {"horizontal": (-30.0, 130.0), "flexion": (0.0, 150.0), "rotation": (-90.0, 70.0), "pronation": (-85.0, 85.0)}
SIGN = {"left": 1.0, "right": -1.0}


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def signed_angle(a, b, axis):
    return np.degrees(np.arctan2(np.sum(np.cross(a, b) * axis, -1), np.sum(a * b, -1)))


def arm_angles(u, f, palm, s):
    """胸の座標の上腕の向き u、前腕の向き f、手のひらの法線 palm（[..., 3]）から角度の辞書を返す。s は SIGN の値。"""
    elevation = np.degrees(np.arccos(np.clip(-u[..., 1], -1, 1)))
    horizontal = np.degrees(np.arctan2(u[..., 2], u[..., 0] * s))
    flexion = np.degrees(np.arccos(np.clip(np.sum(u * f, -1), -1, 1)))
    down = np.broadcast_to([0, -1.0, 0], u.shape)
    axis, dot = np.cross(down, u), np.clip(np.sum(down * u, -1, keepdims=True), -0.999999, 1)
    front = np.broadcast_to([0, 0, 1.0], u.shape)
    carried = front + np.cross(axis, front) + np.cross(axis, np.cross(axis, front)) / (1 + dot)     # 最小の回転（ロドリゲス）で腕を下ろした姿勢から運ぶ
    bent = unit(f - u * np.sum(u * f, -1, keepdims=True))
    rotation = signed_angle(unit(carried - u * np.sum(carried * u, -1, keepdims=True)), bent, u) * s
    normal = unit(np.cross(u, f)) * s
    flat = unit(palm - f * np.sum(palm * f, -1, keepdims=True))
    pronation = signed_angle(normal, flat, f) * s
    straight = flexion < 15
    return {"elevation": elevation, "horizontal": np.where((elevation > 30) & (elevation < 150), horizontal, np.nan), "flexion": flexion,
            "rotation": np.where(straight | (elevation > 150), np.nan, rotation), "pronation": np.where(straight, np.nan, pronation)}


def arm_frames(m, side, rest):
    """腕のコマごとの値の辞書（度と単位ベクトルの成分）。"""
    pos, d = C.joints(m, rest), C.world_deltas(m)
    n = C.frames(m)
    into = qinv(d["chest"])
    shoulder, elbow, wrist = pos[side + "UpperArm"], pos[side + "LowerArm"], pos[side + "Hand"]
    u, f = unit(qrot(into, elbow - shoulder)), unit(qrot(into, wrist - elbow))
    palm = unit(qrot(into, qrot(d[side + "Hand"], np.broadcast_to([0, -1.0, 0], (n, 3)))))
    along = unit(qrot(into, wrist - shoulder))
    e = qrot(into, elbow - shoulder)
    side_dir = unit(e - along * np.sum(e * along, 1, keepdims=True))
    return {**arm_angles(u, f, palm, SIGN[side]), "elbowDown": -side_dir[:, 1], "elbowOut": side_dir[:, 0] * SIGN[side], "elbowBack": -side_dir[:, 2]}


def over(frames, key):
    """可動域を超えるコマの数。"""
    low, high = ROM[key]
    v = frames[key]
    return int(np.sum((v < low) | (v > high)))


def summary(m, rest):
    """左右の腕の範囲、可動域を超えるコマの数、肘が上を向くコマ（下の成分が -0.5 未満）の数。"""
    out = {}
    for s in SIGN:
        f = arm_frames(m, s, rest)
        row = {}
        for k in ("elevation", "horizontal", "flexion", "rotation", "pronation"):
            row[k] = [round(float(np.nanmin(f[k])), 1), round(float(np.nanmax(f[k])), 1)]
            if k in ROM:
                row[k + "Over"] = over(f, k)
        row["elbowDownMin"] = round(float(f["elbowDown"].min()), 2)
        row["elbowUpFrames"] = int((f["elbowDown"] < -0.5).sum())
        row["elbowOutMin"] = round(float(f["elbowOut"].min()), 2)
        out[s] = row
    return out
