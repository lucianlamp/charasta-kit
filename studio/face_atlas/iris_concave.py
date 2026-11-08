# Set the irises of the face texture slightly back into the head, as anime 3D models do, so the gaze seems to follow
# the camera when the head is seen from an angle. Run on character.blend BEFORE `face_vrm.py build`.
# Usage: blender -b <character.blend> --python iris_concave.py -- FACE_DIR OUT.blend NEUTRAL_IMG|IRISES.json
#   FACE_DIR: cam.json (render_front.py), regions.json (face_vrm.py select), align.json (align.py)
#   NEUTRAL_IMG: the neutral drawing aligned by align.py; the two irises are found in it and written to
#                FACE_DIR/irises.json (+ FACE_DIR/irises.png to check by eye). IRISES.json: take them from that file.
#   irises.json: {"irises": [{"center": [x, y], "rx": .., "ry": ..}, ..]} in render pixels (an ellipse per iris,
#                the drawn irises are taller than wide)
#   env IRIS_DEPTH_MM (default 2.5, world millimetres at the model's final scale), IRIS_MIN_VERTS (default 40)
# The Head mesh is subdivided inside each iris until it has IRIS_MIN_VERTS vertices there (UVs, materials and vertex
# weights are interpolated by bmesh), then every vertex inside an iris on the front surface moves along +Y (away from
# the front camera) by depth * (1 - r^2), r = distance from the iris centre in units of its radius. Only Y changes,
# so the front projection, and with it the atlas UVs face_vrm.py gives the face regions, stay exactly the same.
# The custom split normals of the whole mesh are set to the normals of the mesh before the push (new corners take
# them interpolated from the original triangle they lie in), so the toon shading does not show the dent.
# Assumes a rigid head (no shape keys); the regions' bbox in regions.json stays valid (checked by face_vrm.py build).
import bpy, bmesh, sys, os, json, math
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform, intersect_point_tri_2d
args = sys.argv[sys.argv.index('--') + 1:]; D, out_blend, src = args[0], os.path.abspath(args[1]), args[2]
assert out_blend != os.path.abspath(bpy.data.filepath), 'OUT.blend must be a new file'
DEPTH = float(os.environ.get('IRIS_DEPTH_MM', 2.5)) / 1000; MIN_VERTS = int(os.environ.get('IRIS_MIN_VERTS', 40))
cam = json.load(open(os.path.join(D, 'cam.json'))); S = cam['size']; k = S / cam['ortho_scale']
def proj(p): return ((p.x - cam['center'][0]) * k + S / 2, S / 2 - (p.z - cam['center'][1]) * k)

def detect(path):
    # Iris = the dark, not reddish blob (iris rim and its dark upper half; the eyelashes are red-brown) grown through
    # the iris colours (dark, green, yellow, saturated) that are not skin, sclera or lashes; its bounding box is the
    # ellipse. Sampled every G render pixels inside the upper region's rect, each half of the face on its own.
    G = 2; name = os.path.splitext(os.path.basename(path))[0]; s, tx, ty = json.load(open(os.path.join(D, 'align.json')))[name]
    im = bpy.data.images.load(path); w, h = im.size
    a = np.array(im.pixels[:], np.float32).reshape(h, w, 4)[::-1] * 255          # rows from the top, 0..255
    x0, y0, x1, y1 = json.load(open(os.path.join(D, 'regions.json')))['upper']['rect']
    X, Y = np.meshgrid(np.arange(x0, x1, G) + G / 2, np.arange(y0, y1, G) + G / 2)
    ix, iy = ((X - tx) / s).astype(int), ((Y - ty) / s).astype(int); ok = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
    c = np.zeros(X.shape + (4,), np.float32); c[ok] = a[iy[ok], ix[ok]]
    r, g, b, al = c[..., 0], c[..., 1], c[..., 2], c[..., 3] > 128; lum = (r + g + b) / 3
    sat = c[..., :3].max(-1) - c[..., :3].min(-1)
    dark = al & (lum < 130) & (r - g < 15)
    iris = dark | (al & (g >= r) & (lum < 215) & (g - b > 15)) | (al & (g >= r - 5) & (lum < 235) & (sat > 25))
    found = []
    for half in (X < S / 2, X >= S / 2):
        d = (dark & half).astype(np.float32); n = 15                         # densest dark spot = seed
        cs = np.pad(d, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
        hh, ww = d.shape
        yy, xx = np.mgrid[0:hh, 0:ww]; ya, yb = np.clip(yy - n, 0, hh), np.clip(yy + n + 1, 0, hh); xa, xb = np.clip(xx - n, 0, ww), np.clip(xx + n + 1, 0, ww)
        box = cs[yb, xb] - cs[ya, xb] - cs[yb, xa] + cs[ya, xa]
        sy, sx = np.unravel_index(np.argmax(box), box.shape)
        blob = np.zeros_like(iris); blob[sy, sx] = True; m = iris & half
        while True:                                                          # flood fill through the iris colours
            grow = blob.copy(); grow[1:] |= blob[:-1]; grow[:-1] |= blob[1:]; grow[:, 1:] |= blob[:, :-1]; grow[:, :-1] |= blob[:, 1:]
            grow &= m
            if (grow == blob).all(): break
            blob = grow
        bx, by = X[blob], Y[blob]
        e = {'center': [float(bx.min() + bx.max()) / 2, float(by.min() + by.max()) / 2],
             'rx': float(bx.max() - bx.min() + G) / 2, 'ry': float(by.max() - by.min() + G) / 2}
        assert 0.5 < e['rx'] / e['ry'] < 2 and e['rx'] < (x1 - x0) / 4, f'iris detection leaked: {e}'
        found.append(e); print('IRIS', {k_: (round(v, 1) if isinstance(v, float) else [round(q, 1) for q in v]) for k_, v in e.items()}, 'pixels', int(blob.sum()))
    # overlay: the drawing inside the rect with the ellipses in red
    ov = c.copy(); ov[..., 3] = 255
    for e in found:
        q = np.sqrt(((X - e['center'][0]) / e['rx']) ** 2 + ((Y - e['center'][1]) / e['ry']) ** 2); ov[np.abs(q - 1) < 0.012] = (255, 0, 0, 255)
    img = bpy.data.images.new('irises', ov.shape[1], ov.shape[0], alpha=True); img.pixels = (ov[::-1] / 255).ravel()
    img.filepath_raw = os.path.join(D, 'irises.png'); img.file_format = 'PNG'; img.save()
    json.dump({'irises': found}, open(os.path.join(D, 'irises.json'), 'w'), indent=1)
    return found

irises = json.load(open(src))['irises'] if src.lower().endswith('.json') else detect(src)
face = bpy.data.objects['Head']; me = face.data; M = face.matrix_world; Mi = M.inverted()
assert not me.shape_keys, 'Head has shape keys: only the basis would be pushed'
def rn(p, e):
    x, y = proj(p); return math.hypot((x - e['center'][0]) / e['rx'], (y - e['center'][1]) / e['ry'])
# the mesh before any change: positions, triangles and corner normals (custom normals included) for the normal transfer
V0 = [v.co.copy() for v in me.vertices]
T0 = [(tuple(t.vertices), tuple(t.loops)) for t in me.loop_triangles]; TP = {}
for i, t in enumerate(me.loop_triangles): TP.setdefault(t.polygon_index, []).append(i)
N0 = [Vector(n.vector) for n in me.corner_normals]
UV0 = [Vector(l.uv) for l in me.uv_layers.active.data]
bm = bmesh.new(); bm.from_mesh(me)
src_l = bm.faces.layers.int.new('iris_src')              # which original polygon each new face came from
for f in bm.faces: f[src_l] = f.index
def front_flags():
    # a vertex is on the front surface when a ray from the front camera reaches it before any other part of the head
    bm.verts.ensure_lookup_table(); bm.verts.index_update(); bm.normal_update(); W = [M @ v.co for v in bm.verts]
    bvh = BVHTree.FromPolygons(W, [[v.index for v in f.verts] for f in bm.faces]); y0 = min(p.y for p in W) - 1
    flags = []
    for p in W:
        hit = bvh.ray_cast(Vector((p.x, y0, p.z)), Vector((0, 1, 0)))[0]
        flags.append(hit is None or hit.y > p.y - 1e-4)
    return W, flags
for it in range(8):
    W, front = front_flags()
    counts = [sum(1 for v in bm.verts if front[v.index] and rn(W[v.index], e) < 1) for e in irises]
    print('SUBDIV', it, 'vertices inside', counts)
    if min(counts) >= MIN_VERTS: break
    R = M.to_3x3(); edges = set()
    for e, n in zip(irises, counts):
        if n >= MIN_VERTS: continue
        c2 = Vector(e['center'])
        for f in bm.faces:
            if (R @ f.normal).y >= 0: continue                               # faces away from the camera
            P = [W[v.index] for v in f.verts]; pts = P + [sum(P, Vector()) / len(P)] + [(P[i] + P[i - 1]) / 2 for i in range(len(P))]
            P2 = [Vector(proj(p)) for p in P]
            if any(rn(p, e) < 1 for p in pts) or (len(P2) == 3 and intersect_point_tri_2d(c2, *P2)):
                edges.update(f.edges)
    bmesh.ops.subdivide_edges(bm, edges=list(edges), cuts=1, use_grid_fill=True)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
else:
    raise SystemExit(f'could not reach {MIN_VERTS} vertices per iris')
poly_src = [f[src_l] for f in bm.faces]; bm.faces.layers.int.remove(src_l)
bm.to_mesh(me); bm.free(); me.update()
# normals: every corner takes the corner normal of the original triangle it lies in, interpolated at its position.
# The original polygon is tracked through the subdivision (a nearest-triangle lookup picked the wrong triangle where
# the head intersects itself, e.g. at the ear roots of a reshaped head)
cn = [None] * len(me.loops); uv_err = 0.0; uvl = me.uv_layers.active.data
def bary(co, ti):
    a, b, c = T0[ti][0]; return barycentric_transform(co, V0[a], V0[b], V0[c], Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
for poly in me.polygons:
    tris = TP[poly_src[poly.index]]
    for li in poly.loop_indices:
        co = me.vertices[me.loops[li].vertex_index].co
        ti = max(tris, key=lambda t: min(bary(co, t))); w = bary(co, ti); (la, lb, lc) = T0[ti][1]
        cn[li] = (N0[la] * w.x + N0[lb] * w.y + N0[lc] * w.z).normalized()
        uv_err = max(uv_err, (uvl[li].uv - (UV0[la] * w.x + UV0[lb] * w.y + UV0[lc] * w.z)).length)
# push back along +Y (world) on the front surface only
bm = bmesh.new(); bm.from_mesh(me); W, front = front_flags(); bm.free(); pushed = [0] * len(irises); deepest = 0.0
for v in me.vertices:
    if not front[v.index]: continue
    for i, e in enumerate(irises):
        q = rn(W[v.index], e)
        if q < 1:
            p = W[v.index].copy(); p.y += DEPTH * (1 - q * q); v.co = Mi @ p; pushed[i] += 1; deepest = max(deepest, DEPTH * (1 - q * q)); break
me.normals_split_custom_set(cn); me.update()
# checks: nothing moved across the view, weights and UVs kept
moved = max(max(abs((M @ me.vertices[i].co).x - (M @ V0[i]).x), abs((M @ me.vertices[i].co).z - (M @ V0[i]).z)) for i in range(len(V0)))
bad_w = sum(1 for v in me.vertices if not v.groups or any(g.group >= len(face.vertex_groups) for g in v.groups))
wsum = [sum(g.weight for g in v.groups) for v in me.vertices]
print('IRIS_CONCAVE vertices', len(V0), '->', len(me.vertices), 'triangles', len(T0), '->', len(me.polygons),
      'pushed', pushed, 'deepest mm', round(deepest * 1000, 3), 'max x/z drift', moved, 'vertices without valid weights', bad_w, 'weight sum range', (round(min(wsum), 4), round(max(wsum), 4)),
      'max uv error', uv_err)
# uv error up to ~1e-3 from barycentric coordinates in sliver triangles (ragged ear roots of a reshaped head)
assert moved < 1e-6 and bad_w == 0 and uv_err < 1e-3
bpy.ops.wm.save_as_mainfile(filepath=out_blend, copy=True)
print('SAVED', out_blend)
