"""RGB MoCap の motion.bvh を、動きを焼いた FBX にする（Blender のバックグラウンドで動かす）。

  blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python bvh_to_fbx.py -- in.bvh out.fbx

骨だけの FBX。基準の姿勢は BVH の OFFSET の姿勢のまま（tools/compose が rest として同じ FBX を読む）。
フレームの範囲は動きの範囲に合わせる（合わせないと、場面の既定の 250 コマで書かれる）。
"""
import sys

import bpy

a = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_anim.bvh(filepath=a[0], axis_forward="-Z", axis_up="Y", update_scene_fps=True, update_scene_duration=True)
arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
arm.name = "Armature"
s, e = map(int, arm.animation_data.action.frame_range)
sc = bpy.context.scene
sc.frame_start, sc.frame_end = s, e
bpy.context.view_layer.objects.active = arm
arm.select_set(True)
bpy.ops.export_scene.fbx(filepath=a[1], use_selection=True, object_types={"ARMATURE"}, add_leaf_bones=False, bake_anim=True,
                         bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False, bake_anim_force_startend_keying=True, bake_anim_simplify_factor=0)
print("BVH_TO_FBX", s, e, sc.render.fps, len(arm.data.bones))
