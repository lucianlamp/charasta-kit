# Bake a transparent overlay drawn on the face drawing (e.g. a cheek blush made by image_gen as a transparent PNG)
# into the head's own base-colour texture, through the same front projection as the face atlas, so the overlay is
# continuous across the edges of the atlas regions without any extra mesh (a decal mesh floated and shaded differently,
# chara1) and without vertex colours (MToon ignores them).
# Usage: blender -b character.blend --python bake_overlay.py -- FACE_DIR OVERLAY.png DRAWING_NAME OUT.blend
#   FACE_DIR      render_front.py's cam.json and align.py's align.json (DRAWING_NAME's entry places the overlay)
#   OVERLAY.png   RGBA on the drawing's canvas (same size as the drawing that align.json was made for)
#   OUT.blend     a copy of the blend with the head texture replaced (packed); the input blend is not changed
# Only the front-facing head triangles take the overlay, fading from 0.35 to 0.15 of the facing (the projection must
# not wrap round the sides). Each texel of those triangles is mapped UV -> surface point -> front render px -> drawing
# px, and the overlay pixel there is alpha-composited onto the texel.
import bpy, sys, os, json
import numpy as np
from mathutils import Vector

face_dir, overlay_p, name, out_blend = sys.argv[sys.argv.index('--') + 1:][:4]
cam = json.load(open(os.path.join(face_dir, 'cam.json'))); s, tx, ty = json.load(open(os.path.join(face_dir, 'align.json')))[name]
SIZE = cam['size']; k = SIZE / cam['ortho_scale']; cx, cz = cam['center']
ov_img = bpy.data.images.load(overlay_p); ow, oh = ov_img.size
ov = np.array(ov_img.pixels[:], dtype=np.float32).reshape(oh, ow, 4)[::-1]          # top row first
head = bpy.data.objects['Head']; dg = bpy.context.evaluated_depsgraph_get()
me = head.evaluated_get(dg).to_mesh(); M = head.matrix_world
mat = me.materials[0]; node = next(n for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image)
tex_img = node.image; tw, th = tex_img.size
tex = np.array(tex_img.pixels[:], dtype=np.float32).reshape(th, tw, 4)              # bottom row first (UV v up)
uvd = me.uv_layers.active.data; me.calc_loop_triangles(); done = 0
for lt in me.loop_triangles:
    P3 = [M @ me.vertices[v].co for v in lt.vertices]
    n = (P3[1] - P3[0]).cross(P3[2] - P3[0]).normalized(); facing = -n.y
    wf = min(1.0, max(0.0, (facing - 0.15) / 0.2))
    if wf <= 0: continue
    uv = np.array([uvd[l].uv[:] for l in lt.loops]) * [tw, th]
    x0, y0 = np.floor(uv.min(0)).astype(int).clip(0, [tw - 1, th - 1]); x1, y1 = np.ceil(uv.max(0)).astype(int).clip(0, [tw - 1, th - 1])
    gy, gx = np.mgrid[y0:y1 + 1, x0:x1 + 1] + 0.5
    (ax, ay), (bx, by), (qx, qy) = uv; den = (by - qy) * (ax - qx) + (qx - bx) * (ay - qy)
    if abs(den) < 1e-9: continue
    l0 = ((by - qy) * (gx - qx) + (qx - bx) * (gy - qy)) / den; l1 = ((qy - ay) * (gx - qx) + (ax - qx) * (gy - qy)) / den; l2 = 1 - l0 - l1
    inside = (l0 >= -1e-3) & (l1 >= -1e-3) & (l2 >= -1e-3)
    if not inside.any(): continue
    X = l0 * P3[0].x + l1 * P3[1].x + l2 * P3[2].x; Z = l0 * P3[0].z + l1 * P3[1].z + l2 * P3[2].z
    rx = (X - cx) * k + SIZE / 2; ry = SIZE / 2 - (Z - cz) * k                         # front render px
    dx = ((rx - tx) / s).astype(int); dy = ((ry - ty) / s).astype(int)                 # drawing px
    ok = inside & (dx >= 0) & (dx < ow) & (dy >= 0) & (dy < oh)
    if not ok.any(): continue
    o = ov[dy[ok], dx[ok]]; a = o[:, 3:4] * wf
    sub = tex[y0:y1 + 1, x0:x1 + 1]; t = sub[ok]
    t[:, :3] = t[:, :3] * (1 - a) + o[:, :3] * a; sub[ok] = t; done += int((a[:, 0] > 0.01).sum())
tex_img.pixels = tex.ravel(); tex_img.pack()
bpy.ops.wm.save_as_mainfile(filepath=out_blend, copy=True)
print('BAKED overlay texels', done, 'into', tex_img.name, tw, th, '->', out_blend)
