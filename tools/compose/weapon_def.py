"""FBX のメッシュと動きから武器の定義（JSON）を作る。定義は数値だけで、メッシュは入れない。

    python tools/compose/weapon_def.py --character Characters/2Handed.FBX --animation Animations/2Handed_Attack1.FBX --mesh Mesh-TwoHanded-Weapon --hold right --out warrior-2handed.json [--work DIR] [--mesh-out mesh.json]

武器は持つ手の骨に重み 1 で付いていて、基準の姿勢のメッシュの位置が持つ手の基準の姿勢に対応する前提。
もう一方の手の握りは、動きの中で一番多くのコマが集まる手首の位置と、そのコマの手の向き。
--mesh-out は確認の撮影に使う頂点と三角形を別に書く（配布物に入れない）。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

import clip as C
import grip as Grip
from bone_maps import detect
from fbx_clip import basis, fbx_to_clip, fix_rotations, matrix_to_quat
from soma_vrma import qinv, qmul, qnormalize, qrot

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import charasta_paths as P  # noqa: E402

BLENDER = P.find_blender()   # 環境変数 VRMA_BLENDER、PATH、標準の場所の順。無ければ None
SAME_GRIP = 0.01            # 同じ握りとみなす手首の距離（武器の単位）
RING = 0.03                 # 断面の幅を読むときの、柄の軸に沿った幅（武器の単位）


def frame_of(points, near):
    """頂点 [V, 3] の主軸から武器の座標を決める。返すのは (列が X、Y、Z の回転行列, 原点)。X は near に近い端から遠い端へ、Y は 2 番目の主軸。"""
    center = points.mean(0)
    _, _, axes = np.linalg.svd(points - center)
    x, y = axes[0], axes[1]
    along = (points - center) @ x
    if np.linalg.norm(center + x * along.min() - near) > np.linalg.norm(center + x * along.max() - near):
        x, along = -x, -along
    return np.stack([x, y, np.cross(x, y)], 1), center + x * along.min()


def center_of_mass(points, faces):
    """閉じたメッシュの、密度が一定のときの重心（符号つきの四面体の体積）。"""
    tri = points[faces]
    volume = np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])) / 6
    return (tri.sum(1) / 4 * volume[:, None]).sum(0) / volume.sum()


def parts_of(profile):
    """断面の環の並びから柄、鍔、刃の範囲を読む。環のない一番長い間が刃、2 番目に長い間が柄の握るところ。"""
    s = profile[:, 0]
    gaps = np.argsort(np.diff(s))[::-1]
    blade, grip = int(gaps[0]), int(gaps[1])
    return {"handle": [0.0, float(s[grip + 1])], "guard": [float(s[grip + 1]), float(s[blade])], "blade": [float(s[blade]), float(s[-1])]}


def define(verts, faces, dump, clip, hold, name):
    """verts は基準の姿勢の世界の座標、dump は fbx_dump の npz、clip は fbx_to_clip(dump, hold) の中間形式。返すのは (定義, 武器の座標の頂点)。"""
    z = np.load(dump, allow_pickle=False)
    found, _ = detect([str(n) for n in z["names"]])
    free = Grip.OTHER[hold]
    b = basis(z["ref_pos"], found)
    ref_v = qrot(np.broadcast_to(b, z["ref_pos"].shape[:-1] + (4,)), z["ref_pos"])
    fix = fix_rotations(found, ref_v)
    feet = [found[k] for k in ("leftFoot", "rightFoot", "leftToes", "rightToes") if k in found]
    height = float(ref_v[found["hips"], 1] - ref_v[feet, 1].min())
    wrist_ref = z["ref_pos"][found[hold + "Hand"]]
    in_hand = qrot(np.broadcast_to(fix[hold + "Hand"], (len(verts), 4)), qrot(np.broadcast_to(b, (len(verts), 4)), verts - wrist_ref))    # T ポーズの持つ手の座標（手首が原点）
    frame, origin = frame_of(in_hand, np.zeros(3))
    local = (in_hand - origin) @ frame
    rings = np.unique(np.round(local[:, 0], 2))
    profile = np.array([[s, np.abs(local[np.abs(local[:, 0] - s) < RING, 1]).max()] for s in rings])
    to_hand = qnormalize(matrix_to_quat(frame))     # 武器の座標から T ポーズの持つ手の座標へ
    d = C.world_deltas(clip)
    n = C.frames(clip)
    W = qmul(d[hold + "Hand"], np.broadcast_to(to_hand, (n, 4)))
    wrist = (-origin) @ frame
    source_scale = (C.HIPS_HEIGHT - C.REST["leftToes"][1]) / height    # gripLocal は REST の体の m で、30 fps に直してある
    other = qrot(np.broadcast_to(qinv(to_hand), (n, 4)), clip["gripLocal"] / source_scale) + wrist
    apart = np.linalg.norm(other[:, None] - other[None], axis=2)
    pick = int(np.argmax((apart < SAME_GRIP).sum(1)))
    near = apart[pick] < SAME_GRIP
    other_hand = qmul(qinv(W[pick]), d[free + "Hand"][pick])
    length = float(local[:, 0].max())
    return {"name": name, "unit": "FBX の単位のまま。bodyHeightM と比べて体の大きさへ縮める", "hold": hold, "lengthM": round(length, 4), "bodyHeightM": round(height, 4), "lengthPerBodyHeight": round(length / height, 4),
            **{k + "M": [round(x, 3) for x in v] for k, v in parts_of(profile).items()}, "centerOfMassM": np.round(center_of_mass(local, faces), 4).tolist(), "profile": np.round(profile, 3).tolist(),
            "grips": {hold: {"wristM": np.round(wrist, 4).tolist(), "hand": np.round(qinv(to_hand), 6).tolist()}, free: {"wristM": np.round(other[near].mean(0), 4).tolist(), "hand": np.round(other_hand, 6).tolist()}},
            "framesAtFreeGrip": int(near.sum())}, local


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    for k in ("--character", "--animation", "--mesh", "--out"):
        p.add_argument(k, required=True)
    p.add_argument("--hold", default="right", choices=("right", "left"))
    p.add_argument("--work", default=".")
    p.add_argument("--mesh-out")
    a = p.parse_args()
    work = Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    mesh, dump, jobs, result = work / "weapon-mesh.npz", work / "weapon-dump.npz", work / "weapon-jobs.json", work / "weapon-result.json"
    jobs.write_text(json.dumps([{"fbx": a.animation, "rest": a.character, "out": str(dump)}]), encoding="utf8")
    base = [P.need(BLENDER, "Blender", "VRMA_BLENDER"), "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python"]
    subprocess.run([*base, str(HERE / "fbx_mesh.py"), "--", a.character, a.mesh, str(mesh)], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([*base, str(HERE / "fbx_dump.py"), "--", str(jobs), str(result)], check=True, stdout=subprocess.DEVNULL)
    z = np.load(mesh)
    clip, _ = fbx_to_clip(dump, a.hold)
    definition, local = define(z["v"], z["f"], dump, clip, a.hold, Path(a.out).stem)
    Path(a.out).write_text(json.dumps(definition, ensure_ascii=False, indent=1), encoding="utf8")
    if a.mesh_out:
        Path(a.mesh_out).write_text(json.dumps({"v": np.round(local, 4).tolist(), "f": z["f"].tolist()}), encoding="utf8")
    print({k: definition[k] for k in ("lengthM", "bodyHeightM", "lengthPerBodyHeight", "centerOfMassM", "handleM", "guardM", "bladeM", "framesAtFreeGrip")})


if __name__ == "__main__":
    main()
