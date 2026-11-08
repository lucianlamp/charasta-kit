"""Blender のバックグラウンドで FBX を読み、名前を指定したメッシュの頂点と三角形を npz に書く。

    blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python tools/compose/fbx_mesh.py -- X.FBX メッシュの名前 out.npz

頂点は基準の姿勢の世界の座標。Warrior は Blender が皮の重みを読まないので、メッシュは最初のコマでも動かない。
"""
import sys

import bpy
import numpy as np

fbx, name, out = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx, ignore_leaf_bones=False, automatic_bone_orientation=False)
bpy.context.scene.frame_set(1)
bpy.context.view_layer.update()
o = bpy.data.objects[name]
o.data.calc_loop_triangles()
np.savez(out, v=np.array([list(o.matrix_world @ p.co) for p in o.data.vertices]), f=np.array([list(t.vertices) for t in o.data.loop_triangles]))
