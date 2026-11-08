"""Blender のバックグラウンドで FBX を読み、節点の名前と、基準の姿勢と、毎コマのワールドの位置・回転を npz に書く。

    blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python tools/compose/fbx_dump.py -- jobs.json result.json

jobs.json: [{"fbx": "...", "rest": "..." または null, "out": "x.npz"}]
result.json: [{"fbx": "...", "ok": true, "frames": 41, "fps": 30, "kind": "empty"} または {"fbx": "...", "ok": false, "error": "..."}]

アーマチュアの FBX は骨の静止姿勢を基準にする。Warrior のように骨が Empty になる FBX は静止姿勢を持たないので、
キャラの FBX（rest）の最初のコマの姿勢を基準にする。ファイルは書き換えない。
"""
import json
import sys

import bpy
import numpy as np


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path, ignore_leaf_bones=False, automatic_bone_orientation=False)


def quat(m):
    q = m.decompose()[1]
    return [q.x, q.y, q.z, q.w]


def skeleton():
    """(種類, 名前の一覧, ワールドの行列を返す関数, 静止姿勢の行列)。骨が無ければ None。"""
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE" and o.data.bones]
    if arms:
        arm = max(arms, key=lambda o: len(o.data.bones))
        names = [b.name for b in arm.data.bones]
        bones = [arm.pose.bones[n] for n in names]
        rest = [arm.matrix_world @ b.matrix_local for b in arm.data.bones]
        return "armature", names, lambda: [arm.matrix_world @ b.matrix for b in bones], rest
    empties = [o for o in bpy.data.objects if o.type == "EMPTY"]
    if not empties:
        return None
    return "empty", [o.name for o in empties], lambda: [o.matrix_world.copy() for o in empties], None


def frame_range():
    actions = list(bpy.data.actions)
    if not actions:
        return None
    return int(min(a.frame_range[0] for a in actions)), int(max(a.frame_range[1] for a in actions))


def set_frame(scene, f):
    scene.frame_set(f)
    bpy.context.view_layer.update()


def rest_of(path, names, cache):
    """rest の FBX の最初のコマの姿勢を names の並びで返す。返すのは ([(位置, 回転)], 基準に無かった名前)。"""
    if path not in cache:
        load(path)
        sk = skeleton()
        if sk is None:
            raise ValueError("基準の FBX に骨が無い: " + path)
        kind, rest_names, matrices, rest = sk
        if kind == "empty":
            r = frame_range()
            if r:
                set_frame(bpy.context.scene, r[0])
            rest = matrices()
        cache[path] = dict(zip(rest_names, [(list(m.translation), quat(m)) for m in rest]))
    table = cache[path]
    return [table.get(n, ((0, 0, 0), (0, 0, 0, 1))) for n in names], [n for n in names if n not in table]


def dump(job, cache):
    ref, unknown = None, []
    if job.get("rest"):
        load(job["fbx"])
        sk = skeleton()
        if sk is None:
            raise ValueError("骨が無い（メッシュだけの FBX）")
        ref, unknown = rest_of(job["rest"], sk[1], cache)
    load(job["fbx"])
    sk = skeleton()
    if sk is None:
        raise ValueError("骨が無い（メッシュだけの FBX）")
    kind, names, matrices, rest = sk
    r = frame_range()
    if r is None or r[1] <= r[0]:
        raise ValueError("アニメーションが無い")
    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    pos, rot = [], []
    for f in range(r[0], r[1] + 1):
        set_frame(scene, f)
        ms = matrices()
        pos.append([list(m.translation) for m in ms])
        rot.append([quat(m) for m in ms])
    if ref is None:
        if rest is None:
            raise ValueError("骨が Empty で静止姿勢が無いのに、基準の FBX（rest）が無い")
        ref = [(list(m.translation), quat(m)) for m in rest]
    np.savez_compressed(job["out"], names=np.array(names), pos=np.array(pos), rot=np.array(rot),
                        ref_pos=np.array([p for p, _ in ref]), ref_rot=np.array([q for _, q in ref]), fps=fps, unknown=np.array(unknown, dtype=str))
    return {"frames": r[1] - r[0] + 1, "fps": fps, "kind": kind, "bones": len(names)}


def main():
    a = sys.argv[sys.argv.index("--") + 1:]
    jobs = json.load(open(a[0], encoding="utf8"))
    cache, out = {}, []
    for job in jobs:
        try:
            out.append({"fbx": job["fbx"], "ok": True, **dump(job, cache)})
        except Exception as e:
            out.append({"fbx": job["fbx"], "ok": False, "error": str(e).split("\n")[0]})
        json.dump(out, open(a[1], "w", encoding="utf8"), ensure_ascii=False, indent=1)


main()
