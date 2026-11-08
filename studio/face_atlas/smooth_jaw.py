# Subdivide and smooth the jaw of the rigged head mesh, so the chin can be rounded (chara4: the 376-vertex head had
# one long triangle from the chin tip to the neck, and the side profile stayed a sharp corner however the chin moved).
# Usage: blender -b character.blend --python smooth_jaw.py -- OUT.blend Z_TOP [CUTS] [ITER]
#   Z_TOP  world height (m) above which nothing changes (put it at the mouth line)
#   CUTS   edge cuts per edge of the jaw faces (default 2)   ITER  smoothing passes over the new inner vertices (default 6)
# Faces of Head whose centre is below Z_TOP and in front of the middle of the head are subdivided; bmesh
# interpolates UVs and vertex groups (skin weights) for the new vertices. Vertices on the edge of that area keep their
# place, so the seam with the rest of the head and with the neck does not move.
import bpy, bmesh, sys
from mathutils import Vector
a = sys.argv[sys.argv.index('--') + 1:]
out, ztop = a[0], float(a[1]); cuts = int(a[2]) if len(a) > 2 else 2; iters = int(a[3]) if len(a) > 3 else 6
CENTRE_HOLD = 0.02     # m: x smoothing fades to none at the chin's centre line over this distance
h = bpy.data.objects['Head']; M = h.matrix_world
bm = bmesh.new(); bm.from_mesh(h.data); bm.faces.ensure_lookup_table()
ys = sorted((M @ v.co).y for v in bm.verts); ymid = ys[len(ys) // 2]
faces = [f for f in bm.faces if (M @ f.calc_center_median()).z < ztop and (M @ f.calc_center_median()).y < ymid]
edges = list({e for f in faces for e in f.edges})
border = {v for e in edges for v in e.verts if any(f not in faces for f in e.link_faces) or len(e.link_faces) < 2}
before = len(bm.verts)
res = bmesh.ops.subdivide_edges(bm, edges=edges, cuts=cuts, use_grid_fill=True, smooth=0.0)
new = [v for v in res['geom_inner'] + res['geom_split'] if isinstance(v, bmesh.types.BMVert)]
area = {v for f in bm.faces if (M @ f.calc_center_median()).z < ztop and (M @ f.calc_center_median()).y < ymid for v in f.verts}
movable = [v for v in area if v not in border]
# the chin's centre line before smoothing: x of the lowest front vertex of the area
x0 = (M @ min(area, key=lambda v: (M @ v.co).z).co).x
for _ in range(iters):
    # x is smoothed too (without it the jaw stayed lumpy from the front), but held near the centre line: the
    # triangulation differs left and right, and free x averaging pulled the chin tip 5 mm sideways (chara4)
    old = {v: v.co.copy() for v in movable}
    bmesh.ops.smooth_vert(bm, verts=movable, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    for v in movable:
        w = min(1.0, abs((M @ old[v]).x - x0) / CENTRE_HOLD)
        v.co.x = old[v].x + (v.co.x - old[v].x) * w
bm.to_mesh(h.data); bm.free(); h.data.update()
bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
print('SMOOTH_JAW faces', len(faces), 'verts', before, '->', len(h.data.vertices), 'smoothed', len(movable), '->', out)
