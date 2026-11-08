"""Blender の機能で FBX の動きを VRM へ移し、VRM Add-on で VRMA に書き出す。

    blender --background --python-exit-code 1 --python tools/compose/fbx_to_vrma_blender.py -- --fbx A.FBX --rest B.FBX --vrm model.vrm --out out.vrma [--grip right] [--speed 0.6] [--save x.blend] [--info x.json]

手で直すための経路。自動でつなぐのは compose.py（Python の移し替え）で、Blender で開いて直すときにこちらを使う。使い分けは docs/motion-compose.md。

流れ:
1. rest の FBX の最初のコマを基準の姿勢として読む。
2. 動きの FBX と VRM を同じ場面に読み、FBX の全体を空の親（src_root）の下に置く。親の回転が FBX の世界から VRM の世界への回転、
   親の一様な拡大が体の比で、hips の位置はこの親を通して縮む。
3. FBX の骨ごとに子の空（tgt.*）を作る。ローカルの回転を W_ref^-1 B^-1 F^-1 R_rest に固定すると、そのワールドの回転が
   D(t) * R_rest（D は基準の姿勢からの差、R_rest は VRM の骨の静止姿勢のワールドの回転）になる。VRM の骨は Copy Rotation（ワールド）でこれに従う。
4. --grip のとき、元の両手首の差を持つ手のローカル座標で読み、元の体の比の腕の長さと一緒に grip.solve_vrma へ渡す。
5. ベイクしてコンストレイントを外し、Add-on の export_scene.vrma で書く。
6. --grip のとき、書いた VRMA を --speed のあとで compose.py の grip と同じ関数で解き直して上書きする。
7. --save の .blend には最後の動きを読み戻すので、開いた動きが書いた VRMA と同じになる。
"""
import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import addon_utils
import bpy
from bpy_extras import anim_utils
from mathutils import Matrix, Quaternion, Vector

import clip as C
import grip as Grip
from bone_maps import detect
from fbx_clip import CHILD

clock = {}
t0 = time.perf_counter()


def lap(name):
    global t0
    now = time.perf_counter()
    clock[name] = round(now - t0, 3)
    t0 = now


def load_fbx(path):
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path, ignore_leaf_bones=False, automatic_bone_orientation=False)


def frame_range():
    return int(min(a.frame_range[0] for a in bpy.data.actions)), int(max(a.frame_range[1] for a in bpy.data.actions))


def read_ref(path):
    """rest の FBX の最初のコマの、節点のワールドの行列。"""
    load_fbx(path)
    bpy.context.scene.frame_set(frame_range()[0])
    bpy.context.view_layer.update()
    return {o.name: o.matrix_world.copy() for o in bpy.data.objects if o.type == "EMPTY"}


def basis(pos):
    """FBX の世界から Blender の VRM の世界（左 +X、上 +Z、前 -Y）への回転。fbx_clip.basis と同じ決め方。"""
    up = (pos["head"] - pos["hips"]).normalized()
    left = pos["leftUpperArm"] - pos["rightUpperArm"]
    left = (left - up * left.dot(up)).normalized()
    front = left.cross(up)
    return Matrix((left, -front, up)).to_quaternion()


def fixes(ref_v, rest, found):
    """骨ごとの F: 基準の姿勢の骨の向きを VRM の T ポーズの向きへ向ける最小の回転。fbx_clip.fix_rotations と同じ。向きの先は VRM の体の実際の骨。"""
    q0 = Quaternion()
    out = {"hips": q0, "head": q0}
    for bone in ["spine", "chest", "upperChest", "neck", *C.ORDER[5:]]:
        if bone not in found or bone not in rest:
            continue
        child = next((c for c in CHILD.get(bone, ()) if c in found and c in rest), None)
        if child is None:
            out[bone] = out.get(C.PARENT.get(bone), q0)
            continue
        out[bone] = (ref_v[child] - ref_v[bone]).rotation_difference(rest[child] - rest[bone])
    return out


def humanoid_bones(arm):
    table = arm.data.vrm_addon_extension.vrm1.humanoid.human_bones.human_bone_name_to_human_bone()
    return {k.value: v.node.bone_name for k, v in table.items() if v.node.bone_name}


def empty(name, parent=None):
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    o.parent = parent
    o.rotation_mode = "QUATERNION"
    return o


def copy_location(owner, target, sub="", **kw):
    c = owner.constraints.new("COPY_LOCATION")
    c.target, c.target_space, c.owner_space = target, "WORLD", "WORLD"
    if sub:
        c.subtarget = sub
    for k, v in kw.items():
        setattr(c, k, v)
    return c


def finished(result, what):
    """Add-on の演算子は失敗しても例外にせず CANCELLED を返す。"""
    if result != {"FINISHED"}:
        raise RuntimeError(f"{what} に失敗した: {sorted(result)}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--fbx", required=True)
    p.add_argument("--rest", required=True)
    p.add_argument("--vrm", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--grip", choices=["right", "left"], help="武器を持つ手。書いた VRMA の両腕を解き直す")
    p.add_argument("--speed", type=float, default=1.0, help="--grip のとき、腕を解く前にかける再生の速さ")
    p.add_argument("--save")
    p.add_argument("--info")
    a = p.parse_args(sys.argv[sys.argv.index("--") + 1:])

    addon_utils.enable("bl_ext.blender_org.vrm", default_set=False)
    ref = read_ref(a.rest)
    lap("read rest FBX")

    load_fbx(a.fbx)
    scene = bpy.context.scene
    f0, f1 = frame_range()
    scene.frame_start, scene.frame_end = f0, f1
    fbx_objects = list(bpy.data.objects)
    names = [o.name for o in fbx_objects if o.type == "EMPTY"]
    found, table = detect(names)
    found = {k: names[v] for k, v in found.items()}
    bpy.ops.import_scene.vrm(filepath=a.vrm)
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    if not arm.data.vrm_addon_extension.is_vrm1():
        raise RuntimeError(f"VRM 1.0 ではない: {a.vrm}。先に vrma-pipeline の tools/convert_vrm0_to_1.py で変換する")
    # hips が親の骨につながっていると location が効かない。Add-on の import_scene.vrma も同じ理由で切っている
    bones = humanoid_bones(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    arm.data.edit_bones[bones["hips"]].use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    lap("read FBX and VRM")

    rest = {k: arm.data.bones[n].head_local.copy() for k, n in bones.items()}
    rest_rot = {k: arm.data.bones[n].matrix_local.to_quaternion() for k, n in bones.items()}
    ref_pos = {k: ref[n].to_translation() for k, n in found.items()}
    ref_rot = {k: ref[n].to_quaternion() for k, n in found.items()}
    b = basis(ref_pos)
    ref_v = {k: b @ v for k, v in ref_pos.items()}
    fix = fixes(ref_v, rest, found)
    feet = [k for k in ("leftFoot", "rightFoot", "leftToes", "rightToes") if k in found]
    scale = (rest["hips"].z - rest["leftToes"].z) / (ref_v["hips"].z - min(ref_v[k].z for k in feet))

    # 親: 最初のコマの体を前へ向け、hips の真下を原点へ置く
    scene.frame_set(f0)
    bpy.context.view_layer.update()
    src = {k: bpy.data.objects[n] for k, n in found.items()}
    front = (b @ src["hips"].matrix_world.to_quaternion() @ ref_rot["hips"].inverted() @ b.inverted()) @ Vector((0, -1, 0))
    root = empty("src_root")
    root.rotation_quaternion = Quaternion((0, 0, 1), -math.atan2(front.x, -front.y)) @ b
    root.scale = (scale, scale, scale)
    for o in fbx_objects:
        if o.parent is None:
            o.parent = root
    bpy.context.view_layer.update()
    h = src["hips"].matrix_world.to_translation()
    root.location = (-h.x, -h.y, 0.0)

    # 骨ごとの目標の空
    drive = dict(found)
    if "upperChest" in bones and "upperChest" not in found:
        drive["upperChest"] = found["chest"]     # 素材に無い骨は親と同じ差で動かす（fbx_clip の upperChest と同じ）
        fix["upperChest"] = fix["chest"]
        ref_rot["upperChest"] = ref_rot["chest"]
    for k, name in drive.items():
        if k not in bones:
            continue
        tgt = empty("tgt." + k, bpy.data.objects[name])
        tgt.rotation_quaternion = ref_rot[k].inverted() @ b.inverted() @ fix[k].inverted() @ rest_rot[k]
        pb = arm.pose.bones[bones[k]]
        c = pb.constraints.new("COPY_ROTATION")
        c.target, c.target_space, c.owner_space, c.mix_mode = tgt, "WORLD", "WORLD", "REPLACE"
    hips = arm.pose.bones[bones["hips"]]
    copy_location(hips, src["hips"])
    lap("build constraints")

    # 足の高さ: compose の ground と同じく、足の 4 つの骨の高さの低い側の 3 パーセンタイルを床にする
    low = []
    for f in range(f0, f1 + 1):
        scene.frame_set(f)
        bpy.context.view_layer.update()
        low.append(min((arm.matrix_world @ arm.pose.bones[bones[k]].matrix).translation.z - rest[k].z for k in feet))
    low_sorted = sorted(low)
    i = 0.03 * (len(low) - 1)
    floor = low_sorted[int(i)] + (low_sorted[min(int(i) + 1, len(low) - 1)] - low_sorted[int(i)]) * (i - int(i))
    root.location.z = -floor
    bpy.context.view_layer.update()
    lap("ground")

    info = {"bonesMapped": len(found), "boneTable": table, "bodyScale": round(scale, 4), "frames": f1 - f0 + 1, "fps": scene.render.fps, "floorShiftM": round(-floor, 4)}

    grip_track = None
    if a.grip:
        # 素材の両手首の差を、持つ手の T ポーズの座標（VRM の世界の向き）で読む。切り出しや速さの前のコマ
        free, rows = Grip.OTHER[a.grip], []
        hold = arm.pose.bones[bones[a.grip + "Hand"]]
        for f in range(f0, f1 + 1):
            scene.frame_set(f)
            bpy.context.view_layer.update()
            turn = (arm.matrix_world @ hold.matrix).to_quaternion() @ rest_rot[a.grip + "Hand"].inverted()
            rows.append(turn.inverted() @ (src[free + "Hand"].matrix_world.to_translation() - src[a.grip + "Hand"].matrix_world.to_translation()))
        grip_track = [(v.x, v.z, -v.y) for v in rows]
        lap("read grip")

    # ベイク
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="POSE")
    wanted = set(bones.values())
    for pb in arm.pose.bones:
        pb.select = pb.name in wanted
    options = anim_utils.BakeOptions(only_selected=True, do_pose=True, do_object=False, do_visual_keying=True, do_constraint_clear=True, do_parents_clear=False, do_clean=False,
                                     do_location=True, do_rotation=True, do_scale=False, do_bbone=False, do_custom_props=False)
    action = anim_utils.bake_action(arm, action=None, frames=range(f0, f1 + 1), bake_options=options)
    arm.animation_data.action = action
    bpy.ops.object.mode_set(mode="OBJECT")
    lap("bake")
    # --out は全部終わってから置き換える。途中で失敗しても前の出力が残る
    out = Path(a.out)
    work = out.with_name(out.stem + ".tmp" + out.suffix)
    try:
        finished(bpy.ops.export_scene.vrma(filepath=str(work), armature_object_name=arm.name), "VRMA の書き出し")
        lap("export VRMA")
        if a.grip:
            arms = Grip.source_arms(ref_v, {k: k for k in ref_v}, (C.HIPS_HEIGHT - C.REST["leftToes"][1]) / (ref_v["hips"].z - min(ref_v[k].z for k in feet)))
            info["grip"] = Grip.solve_vrma(work, grip_track, scene.render.fps / scene.render.fps_base, a.grip, a.vrm, arms, a.speed)
            lap("solve arms")
            if a.save:
                finished(bpy.ops.import_scene.vrma(filepath=str(work), armature_object_name=arm.name), "VRMA の読み戻し")
                scene.frame_start, scene.frame_end = (int(x) for x in arm.animation_data.action.frame_range)
        os.replace(work, out)
    finally:
        work.unlink(missing_ok=True)
    if a.save:
        bpy.ops.wm.save_as_mainfile(filepath=a.save)
    info["clock"] = clock
    info["seconds"] = round(sum(clock.values()), 3)
    print("RESULT", json.dumps(info, ensure_ascii=False))
    if a.info:
        json.dump(info, open(a.info, "w", encoding="utf8"), ensure_ascii=False, indent=1)


main()
