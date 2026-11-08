# blender -b --factory-startup --python shift_head.py -- KIT IN.blend OUT.vrm DX DY
# Moves everything that belongs to the head (Head, Hair, EyeBall, EyeShade meshes, the Hair_* spring bones, the head
# collider and the lookAt offset) by (DX, DY) metres in world x / y, so the head's neck sits on the body's neck.
# For a finished face-atlas VRM (IN.blend = the blend build_gaze.py / face_vrm.py saved next to its VRM) whose head was
# placed off the body's neck; measure the two neck centres first. Writes OUT.vrm and OUT.blend; set the meta again after.
import bpy, sys, os, importlib.util
from mathutils import Matrix, Vector
a = sys.argv[sys.argv.index('--') + 1:]; kit, src, out = a[:3]; d = Vector((float(a[3]), float(a[4]), 0))
spec = importlib.util.spec_from_file_location('mt', os.path.join(kit, 'scripts', 'mtoon-export.py')); mt = importlib.util.module_from_spec(spec); spec.loader.exec_module(mt); mt.enable_vrm()
bpy.ops.wm.open_mainfile(filepath=src)
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
for name in ('Head', 'Hair', 'EyeBall', 'EyeShade'):
    o = bpy.data.objects[name]; local = o.matrix_world.inverted().to_3x3() @ d
    o.data.transform(Matrix.Translation(local)); o.data.update()
    print('MOVED', name, tuple(round(x, 4) for x in local))
bpy.context.view_layer.objects.active = rig; bpy.ops.object.mode_set(mode='EDIT')
ld = rig.matrix_world.inverted().to_3x3() @ d; n = 0
for b in rig.data.edit_bones:
    if b.name.startswith('Hair_'): b.head += ld; b.tail += ld; n += 1
bpy.ops.object.mode_set(mode='OBJECT'); print('BONES moved', n)
c = bpy.data.objects['head Collider']; c.matrix_world.translation += d
la = rig.data.vrm_addon_extension.vrm1.look_at; o = la.offset_from_head_bone
la.offset_from_head_bone = (o[0] + d.x, o[1], o[2] - d.y); print('LOOKAT offset', tuple(round(x, 4) for x in la.offset_from_head_bone))
meshes = [x for x in bpy.data.objects if x.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for x in [rig, *meshes]: x.hide_set(False); x.select_set(True)
bpy.context.view_layer.objects.active = rig
res = bpy.ops.export_scene.vrm(filepath=out, armature_object_name=rig.name, export_only_selections=True, export_invisibles=False, use_addon_preferences=False)
assert 'FINISHED' in res, res
bpy.ops.wm.save_as_mainfile(filepath=out[:-4] + '.blend')
print('EXPORT', out, [x.name for x in meshes])
