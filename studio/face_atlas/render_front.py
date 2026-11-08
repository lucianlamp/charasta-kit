# Flat front renders of the head for the face-texture expressions (texture colours only, no lighting).
# Usage: blender -b <character.blend> --python render_front.py -- OUT_DIR [SIZE]
# Writes OUT_DIR/skin.png (the head mesh alone: the faceless skin the atlas cells start from),
# OUT_DIR/with_hair.png (head + hair, for lining up the drawn faces) and OUT_DIR/cam.json (orthographic camera:
# centre, ortho_scale, size; image x grows with world +X, image y grows downwards with world -Z, view along +Y).
import bpy, sys, os, json
from mathutils import Vector
args = sys.argv[sys.argv.index('--') + 1:]; out = args[0]; SIZE = int(args[1]) if len(args) > 1 else 2048
os.makedirs(out, exist_ok=True)
sc = bpy.context.scene
head = bpy.data.objects['Head']; hair = bpy.data.objects.get('Hair')
dg = bpy.context.evaluated_depsgraph_get()
P = [head.matrix_world @ v.co for v in head.evaluated_get(dg).to_mesh().vertices]
x0, x1 = min(p.x for p in P), max(p.x for p in P); z0, z1 = min(p.z for p in P), max(p.z for p in P)
ortho = max(x1 - x0, z1 - z0) * 1.08; centre = Vector(((x0 + x1) / 2, min(p.y for p in P) - 1.0, (z0 + z1) / 2))
cam = bpy.data.objects.new('FaceCam', bpy.data.cameras.new('FaceCam')); sc.collection.objects.link(cam)
cam.data.type = 'ORTHO'; cam.data.ortho_scale = ortho; cam.data.clip_start = 0.01; cam.data.clip_end = 5
cam.location = centre; cam.rotation_euler = (1.5707963, 0, 0); sc.camera = cam
sc.render.resolution_x = sc.render.resolution_y = SIZE; sc.render.film_transparent = True
try: sc.render.engine = 'BLENDER_EEVEE_NEXT'
except TypeError: sc.render.engine = 'BLENDER_EEVEE'
sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'
# texture colours only: each material's base-colour image straight into an emission shader
for o in [head] + ([hair] if hair else []):
    for s in o.material_slots:
        m = s.material
        if not m or not m.node_tree: continue
        nt = m.node_tree; img = next((n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image and 'normal' not in n.image.name.lower()), None)
        out_n = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None) or next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        em = nt.nodes.new('ShaderNodeEmission')
        if img: nt.links.new(img.outputs['Color'], em.inputs['Color'])
        nt.links.new(em.outputs[0], out_n.inputs['Surface'])
for o in sc.objects:
    if o.type == 'MESH': o.hide_render = o not in (head, hair)
def shoot(name, objs):
    for o in (head, hair):
        if o: o.hide_render = o not in objs
    sc.render.filepath = os.path.join(out, name); bpy.ops.render.render(write_still=True)
shoot('with_hair.png', [head, hair])
# skin.png is not rendered: an emission render came out ~17% darker than the texture (205 vs 247) and the atlas
# regions looked grey on the face. Each front-facing triangle of the head is rasterised instead, sampling the
# head texture through its UVs (nearest surface wins), so the skin is the texture's own colour.
import numpy as np
me = head.evaluated_get(dg).to_mesh(); M = head.matrix_world; k = SIZE / ortho
uvd = me.uv_layers.active.data; texs = {}
def tex(mi):
    if mi not in texs:
        m = me.materials[mi]; n = next(n for n in (m.node_tree.nodes if m and m.node_tree else []) if n.type == 'TEX_IMAGE' and n.image)
        w, h = n.image.size; texs[mi] = np.array(n.image.pixels[:], dtype=np.float32).reshape(h, w, 4)
    return texs[mi]
img = np.zeros((SIZE, SIZE, 4), np.float32); depth = np.full((SIZE, SIZE), np.inf, np.float32)
me.calc_loop_triangles()
for lt in me.loop_triangles:
    P3 = [M @ me.vertices[v].co for v in lt.vertices]
    if (P3[1] - P3[0]).cross(P3[2] - P3[0]).y > 0: continue          # faces away from the camera
    xy = np.array([[(p.x - centre.x) * k + SIZE / 2, SIZE / 2 - (p.z - centre.z) * k] for p in P3]); dz = np.array([p.y for p in P3])
    uv = np.array([uvd[l].uv[:] for l in lt.loops])
    x0, y0 = np.floor(xy.min(0)).astype(int).clip(0, SIZE - 1); x1, y1 = np.ceil(xy.max(0)).astype(int).clip(0, SIZE - 1)
    if x1 < x0 or y1 < y0: continue
    gy, gx = np.mgrid[y0:y1 + 1, x0:x1 + 1] + 0.5
    (ax, ay), (bx, by), (cx_, cy_) = xy; den = (by - cy_) * (ax - cx_) + (cx_ - bx) * (ay - cy_)
    if abs(den) < 1e-9: continue
    l0 = ((by - cy_) * (gx - cx_) + (cx_ - bx) * (gy - cy_)) / den; l1 = ((cy_ - ay) * (gx - cx_) + (ax - cx_) * (gy - cy_)) / den; l2 = 1 - l0 - l1
    inside = (l0 >= -1e-4) & (l1 >= -1e-4) & (l2 >= -1e-4)
    if not inside.any(): continue
    z = l0 * dz[0] + l1 * dz[1] + l2 * dz[2]; sub = depth[y0:y1 + 1, x0:x1 + 1]; win = inside & (z < sub)
    if not win.any(): continue
    u = l0 * uv[0, 0] + l1 * uv[1, 0] + l2 * uv[2, 0]; v = l0 * uv[0, 1] + l1 * uv[1, 1] + l2 * uv[2, 1]
    t = tex(lt.material_index); th, tw = t.shape[:2]
    col = t[(np.clip(v, 0, 1) * (th - 1)).astype(int), (np.clip(u, 0, 1) * (tw - 1)).astype(int)]
    sub[win] = z[win]; img[y0:y1 + 1, x0:x1 + 1][win] = col[win]
skin = bpy.data.images.new('skin_flat', SIZE, SIZE, alpha=True); skin.pixels = img[::-1].ravel()
skin.filepath_raw = os.path.join(out, 'skin.png'); skin.file_format = 'PNG'; skin.save()
json.dump({'center': [centre.x, centre.z], 'ortho_scale': ortho, 'size': SIZE}, open(os.path.join(out, 'cam.json'), 'w'), indent=1)
print('FRONT', out, round(ortho, 4), [round(c, 4) for c in centre])
