"""頭(Head で始まるメッシュ)の正面を平行投影で撮る。align.mode direct の x0, y0, dxdpx を、顔の絵の虹彩の中心と合わせて決めるのに使う。
画像の中心が正面の (cy の高さ, x=0)、1 画素 = size/px m。out.json に値を書く。出力は絶対パスで渡す。
"$BLENDER" -b --factory-startup --python-exit-code 1 --python front_view.py -- <model.vrm> <out.png> [cy] [size]
"""
import bpy, sys, json
a = sys.argv[sys.argv.index('--')+1:]
src, out = a[0], a[1]
CX, CY, S, N = 0.0, float(a[2]) if len(a) > 2 else 1.36, float(a[3]) if len(a) > 3 else 0.24, 1200
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in bpy.data.objects:
    if o.type == 'MESH' and not o.name.startswith('Head'): o.hide_render = True
sc = bpy.context.scene
cam = bpy.data.cameras.new('c'); cam.type = 'ORTHO'; cam.ortho_scale = S
co = bpy.data.objects.new('c', cam); sc.collection.objects.link(co); sc.camera = co
co.location = (CX, -2.0, CY)  # glTF の +Z(正面)は Blender の -Y
co.rotation_euler = (1.5708, 0, 0)
sc.render.resolution_x = sc.render.resolution_y = N
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'FLAT'; sc.display.shading.color_type = 'TEXTURE'
sc.render.film_transparent = True
sc.view_settings.view_transform = 'Standard'
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
json.dump({'cx': CX, 'cy': CY, 'size': S, 'px': N}, open(out + '.json', 'w'))
