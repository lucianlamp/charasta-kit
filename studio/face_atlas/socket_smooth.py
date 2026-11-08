# Soften the rim of the eye recesses of a Kimi head face part (the recess stays, its edge becomes a gentle slope).
# Usage: blender -b --factory-startup --python socket_smooth.py -- IN.fbx OUT.fbx
#   env SLOPE (half width of the slope as a share of the eye width, default 0.12)
# Made for heads generated with white eye-whites painted inside the recesses (sock2 pattern p2): the recess is
# where the texture is neutral white (eye white), not pink (skin). On a front depth map (h = how far forward),
# with s = distance to the recess outline and W = SLOPE * eye width:
#   h_new = h + (blur(h, W/2) - h) * weight (1 within W of the outline, smoothstep down to 0 at 2W)
# The step at the rim becomes a ramp; the floor and the face beyond W keep their shape. Filling the recess to get
# "the face without it" does not work: the floor is cut into a strongly curved face, so the fill lands at floor level.
# Faces near the outline are subdivided twice first so the slope has vertices to bend on. Vertices move along the
# view axis only; UVs and the texture are kept; normals are recomputed where moved.
import bpy, bmesh, sys, os, numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.interpolate import poly_3d_calc
a = sys.argv[sys.argv.index('--') + 1:]; src, dst = a[0], a[1]
SLOPE = float(os.environ.get('SLOPE', '0.12'))
bpy.ops.wm.read_factory_settings(use_empty=True); bpy.ops.import_scene.fbx(filepath=src)
face = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
M = face.matrix_world; Mi = M.inverted(); me = face.data
img = next(n.image for mat in me.materials if mat and mat.node_tree for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image)
tw, th = img.size; tex = np.array(img.pixels[:], np.float32).reshape(th, tw, 4)
old_normals = {}   # position -> custom normal before the edit, for the corners that are not moved
for l in me.loops: old_normals.setdefault(me.vertices[l.vertex_index].co.to_tuple(5), me.corner_normals[l.index].vector.copy())
# front depth map and the eye-white mask, ray by ray
me.calc_loop_triangles(); uvl = me.uv_layers.active.data
V = [M @ v.co for v in me.vertices]; P = np.array([v[:] for v in V]); N = 400
x0, x1 = P[:, 0].min(), P[:, 0].max(); z0, z1 = P[:, 2].min(), P[:, 2].max(); res = (x1 - x0) / N; nz = int((z1 - z0) / res) + 1
LT = list(me.loop_triangles); bvh = BVHTree.FromPolygons(V, [tuple(t.vertices) for t in LT])
h = np.full((nz, N), np.nan); white = np.zeros((nz, N), bool); ys = P[:, 1].min() - 1
for i in range(nz):
    for j in range(N):
        loc, _, idx, _ = bvh.ray_cast(Vector((x0 + (j + .5) * res, ys, z1 - (i + .5) * res)), Vector((0, 1, 0)))
        if loc is None: continue
        h[i, j] = -loc.y; t = LT[idx]; w = poly_3d_calc([V[k] for k in t.vertices], loc)
        uv = sum((uvl[l].uv * w[n] for n, l in enumerate(t.loops)), Vector((0, 0)))
        r, g, b, _ = tex[min(int((uv.y % 1) * th), th - 1), min(int((uv.x % 1) * tw), tw - 1)]
        white[i, j] = min(r, g, b) > 0.8 and r - b < 0.07 and r - g < 0.05   # eye white ~(.99,.99,.98), skin ~(.98,.85,.79)
def blobs(mask):
    lab = np.zeros(mask.shape, int); n = 0
    for (i, j) in zip(*np.nonzero(mask)):
        if lab[i, j]: continue
        n += 1; st = [(i, j)]; lab[i, j] = n
        while st:
            a_, b_ = st.pop()
            for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                c_, d_ = a_ + da, b_ + db
                if 0 <= c_ < mask.shape[0] and 0 <= d_ < mask.shape[1] and mask[c_, d_] and not lab[c_, d_]: lab[c_, d_] = n; st.append((c_, d_))
    return lab, n
def grow(mask, r):
    for _ in range(r): mask = mask | np.roll(mask, 1, 0) | np.roll(mask, -1, 0) | np.roll(mask, 1, 1) | np.roll(mask, -1, 1)
    return mask
lab, n = blobs(white); sizes = np.bincount(lab.ravel())[1:]
keep = [k + 1 for k in np.argsort(sizes)[::-1][:2]]                     # the two eyes
sock = np.isin(lab, keep); outside, _ = blobs(~sock); sock |= (outside != outside[0, 0]) & ~sock   # fill the pupils/outline holes
sock = grow(sock, 3)                                                    # include the dark outline and the wall
hh = np.where(np.isnan(h), np.nanmin(h), h); m = ~np.isnan(h)
edge = sock & ~(np.roll(sock, 1, 0) & np.roll(sock, -1, 0) & np.roll(sock, 1, 1) & np.roll(sock, -1, 1))
ri, rj = np.nonzero(edge); rim = np.stack([x0 + (rj + .5) * res, z1 - (ri + .5) * res], 1)
W = {}; mid = (x0 + x1) / 2
for side in (0, 1):
    pts = rim[(rim[:, 0] > mid) == side]; W[side] = SLOPE * np.ptp(pts[:, 0])
Wmax = max(W.values()); near = grow(sock, int(2.4 * Wmax / res) + 2)
gi, gj = np.mgrid[0:nz, 0:N]; gx = x0 + (gj + .5) * res; gz = z1 - (gi + .5) * res
sd = np.full((nz, N), -3 * Wmax)                                       # signed distance to the outline, + inside
for i, j in zip(*np.nonzero(near)):
    d = np.sqrt(((rim - (gx[i, j], gz[i, j])) ** 2).sum(1)).min(); sd[i, j] = d if sock[i, j] else -d
def blur(a_, sig):                                                     # separable gaussian
    r = int(3 * sig) + 1; k = np.exp(-0.5 * (np.arange(-r, r + 1) / sig) ** 2); k /= k.sum()
    for ax in (0, 1): a_ = np.apply_along_axis(lambda x: np.convolve(np.pad(x, r, mode='edge'), k, 'valid'), ax, a_)
    return a_
# the depth across the rim band is replaced by a blurred depth (sigma = half the slope width): the step becomes a
# ramp about twice the slope width wide; the weight fades to the original surface at |s| = W
sig = 0.5 * Wmax / res; hb = blur(hh * m, sig) / np.maximum(blur(m.astype(float), sig), 1e-6)
# full weight within W of the outline, fading out by 2W: the painted outline is a few px off the geometric step in
# places, and away from the step blur(h) is h anyway (the face curvature is small at this sigma)
Wg = np.where(gx > mid, W[1], W[0]); q = np.clip((2 * Wg - np.abs(sd)) / Wg, 0, 1); wt = q * q * (3 - 2 * q) * near * m
target = hh + (hb - hh) * wt
def bil(arr, x, z):
    fj = (x - x0) / res - .5; fi = (z1 - z) / res - .5
    i0 = int(np.clip(np.floor(fi), 0, nz - 2)); j0 = int(np.clip(np.floor(fj), 0, N - 2)); a_ = np.clip(fi - i0, 0, 1); b_ = np.clip(fj - j0, 0, 1)
    return (arr[i0, j0] * (1 - a_) * (1 - b_) + arr[i0 + 1, j0] * a_ * (1 - b_) + arr[i0, j0 + 1] * (1 - a_) * b_ + arr[i0 + 1, j0 + 1] * a_ * b_)
Hp = np.ptp(P[:, 2])
def at(p):   # weight of the rim band at p, or None when p is not on the front around an eye
    i = int((z1 - p.z) / res); j = int((p.x - x0) / res)
    if not (0 <= i < nz and 0 <= j < N and near[i, j]): return None
    if bil(m.astype(float), p.x, p.z) < 0.999: return None             # a sample falls off the face (background)
    d = -p.y - bil(hh, p.x, p.z); w_ = bil(wt, p.x, p.z)
    # only vertices on the visible surface; inside the core band also the recess walls (hidden behind the top edge).
    # Where the face edge overlaps the ear or neck behind it the lookup mixes both depths, so those are skipped
    if d > 4 * res or d < -0.05 * Hp or (w_ < 0.99 and d < -4 * res): return None
    return w_, bil(np.abs(sd), p.x, p.z), W[int(p.x > mid)]
bm = bmesh.new(); bm.from_mesh(me)
for _ in range(2):
    sel = {v for v in bm.verts if (r := at(M @ v.co)) and r[1] < 2.2 * r[2]}
    bmesh.ops.subdivide_edges(bm, edges=[e for e in bm.edges if e.verts[0] in sel and e.verts[1] in sel], cuts=1, use_grid_fill=True)
    bmesh.ops.triangulate(bm, faces=[fc for fc in bm.faces if len(fc.verts) > 3])
moved = 0; mx = 0.0
for v in bm.verts:
    p = M @ v.co; r = at(p)
    if not r or r[0] <= 0: continue
    y = -bil(target, p.x, p.z); moved += 1
    if abs(y - p.y) > mx: mx = abs(y - p.y); where = ((p.x - x0) / (x1 - x0), (z1 - p.z) / (z1 - z0), r[1] / r[2])
    v.co = Mi @ Vector((p.x, y, p.z)); v.tag = True
tagged = {v.co.to_tuple(5) for v in bm.verts if v.tag}
bm.to_mesh(me); bm.free(); me.update()
# normals: the moved area gets fresh smooth normals (merged across UV seams by position), the rest keeps its own
acc = {}
for p in me.polygons:
    for vi in p.vertices: key = me.vertices[vi].co.to_tuple(5); acc[key] = acc.get(key, Vector()) + p.normal * p.area
ring = set(tagged)
for e in me.edges:
    ks = [me.vertices[vi].co.to_tuple(5) for vi in e.vertices]
    if ks[0] in tagged or ks[1] in tagged: ring.update(ks)
me.normals_split_custom_set([acc[k].normalized() if k in ring or k not in old_normals else old_normals[k]
                             for k in (me.vertices[l.vertex_index].co.to_tuple(5) for l in me.loops)])
print('SOCKET slope', [round(float(w / Hp * 100), 2) for w in W.values()],
      '% moved', moved, 'max', round(mx / Hp * 100, 2), '% of part height at', [round(float(c), 2) for c in where])
bpy.ops.export_scene.fbx(filepath=dst, path_mode='COPY', embed_textures=True, axis_forward='-Z', axis_up='Y', object_types={'MESH'})
