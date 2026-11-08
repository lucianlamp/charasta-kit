"""キャラの持ち込みの試験: GLB を読み、簡単な床と光で 1 コマを Cycles で撮る。
    blender -b --factory-startup --python tools/test_frame.py -- out.glb frame out.png
"""
import sys
import time
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib import studio as St  # noqa: E402

glb, frame, out = sys.argv[sys.argv.index('--') + 1:]
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
t0 = time.time()
bpy.ops.import_scene.gltf(filepath=glb, import_pack_images=True, merge_vertices=False, bone_heuristic='BLENDER')
print('import', round(time.time() - t0, 1), [o.type for o in bpy.data.objects][:8], len(bpy.data.actions))
s = bpy.context.scene
s.frame_set(int(frame))
s.render.engine = 'CYCLES'
St.use_best_device(s)
s.cycles.samples = 64
s.cycles.use_denoising = True
s.render.resolution_x, s.render.resolution_y = 1080, 1920
s.render.resolution_percentage = 50
bpy.ops.mesh.primitive_plane_add(size=20)
floor = bpy.context.object
mat = bpy.data.materials.new('floor')
mat.use_nodes = True
b = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
b.inputs['Base Color'].default_value = (0.02, 0.02, 0.03, 1)
b.inputs['Roughness'].default_value = 0.15
floor.data.materials.append(mat)
bpy.ops.object.light_add(type='AREA', location=(2, -2, 4))
bpy.context.object.data.energy = 900
bpy.context.object.data.size = 3
bpy.ops.object.camera_add(location=(0, -4.5, 1.1), rotation=(1.5, 0, 0))
s.camera = bpy.context.object
s.camera.data.lens = 50
w = bpy.data.worlds.new('w')
w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.1, 0.12, 0.2, 1)
s.world = w
s.render.filepath = out
t0 = time.time()
bpy.ops.render.render(write_still=True)
print('render', round(time.time() - t0, 1))
