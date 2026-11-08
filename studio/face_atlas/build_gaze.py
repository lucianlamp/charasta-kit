# blender -b --factory-startup --python build_gaze.py -- KIT face_expr.blend FACE_DIR GAZE_DIR out.vrm
# Adds a moving gaze to the face-atlas VRM of face_vrm.py (chara3):
#   - the face region material Face_upper gets GAZE_DIR/lid_upper.png (paint_gaze.py: the atlas with the eye openings
#     cut out per cell) with alpha mode MASK; closed-eye cells have no opening and cover the eyes fully
#   - a new mesh EyeBall: the Face_upper triangles around the eyes, EYE_BALL_BACK_MM behind the face along the
#     front projection axis (+Y), with the head's skin weights and normals, material EyeBall = GAZE_DIR/ball.png. Its UVs are the
#     same front projection as the atlas (cam.json), so with no shift it lines up with the openings texel for texel
#   - expressions: each open-eye emotion also shifts EyeBall to its ball cell; lookAt type expression,
#     lookLeft/Right/Up/Down shift the EyeBall UVs by gaze.json gaze_px
# Writes out.vrm and out.blend next to it. The input blend is not changed.
import bpy, sys, os, json, struct, importlib.util
from pathlib import Path
from mathutils import Vector

KIT, blend, FD, GD, out_vrm = [os.path.abspath(a) for a in sys.argv[sys.argv.index('--') + 1:][:5]]
BACK = float(os.environ.get('EYE_BALL_BACK_MM', 0.3)) / 1000
H_IN, V_IN = float(os.environ.get('LOOK_H_DEG', 30)), float(os.environ.get('LOOK_V_DEG', 20))
spec = importlib.util.spec_from_file_location('mt', Path(KIT) / 'scripts/mtoon-export.py')
mt = importlib.util.module_from_spec(spec); spec.loader.exec_module(mt); mt.enable_vrm()
out_vrm = Path(out_vrm).resolve(); out_blend = out_vrm.with_suffix('.blend')
assert out_blend != Path(blend).resolve() and out_vrm.parent != Path(blend).resolve().parent, 'write the outputs to their own folder'
bpy.ops.wm.open_mainfile(filepath=blend)
cam = json.load(open(os.path.join(FD, 'cam.json'))); reg = json.load(open(os.path.join(FD, 'regions.json')))['upper']
G = json.load(open(os.path.join(GD, 'gaze.json')))
S = cam['size']; K = S / cam['ortho_scale']
def proj(p): return ((p.x - cam['center'][0]) * K + S / 2, S / 2 - (p.z - cam['center'][1]) * K)
bx0, by0, bx1, by1 = reg['bbox']; CW, CH = G['cell_px']; assert (bx1 - bx0, by1 - by0) == (CW, CH)
NB = len(G['ball_cells'])
HT = G.get('ball_h', CH)                 # chara3 v2: the ball may have a second row (stretched cells, gaze.json "scaled")
SHADE_BACK = BACK / 2                    # the lid shadow layer sits between the lid and the ball

head = bpy.data.objects['Head']; me = head.data; MH = head.matrix_world.copy(); R3 = MH.to_3x3()
lid = bpy.data.materials['Face_upper']; slot = list(me.materials).index(lid)
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE' and o.data.vrm_addon_extension.spec_version == '1.0')

def set_tex(m, path, name):
    img = bpy.data.images.load(path); img.name = name; img.pack()
    g = m.vrm_addon_extension.mtoon1; ext = g.extensions.vrmc_materials_mtoon
    g.pbr_metallic_roughness.base_color_texture.index.source = img
    if ext.shade_multiply_texture.index.source: ext.shade_multiply_texture.index.source = img
    return g

# ball material: Face_upper's MToon settings (colour factors, shade, toony...), so the drawn pixels shade as before
ball = lid.copy(); ball.name = 'EyeBall'
gb = set_tex(ball, os.path.join(GD, 'ball.png'), 'EyeBall')
for info in (gb.pbr_metallic_roughness.base_color_texture, gb.extensions.vrmc_materials_mtoon.shade_multiply_texture):
    info.index.sampler.wrap_s = info.index.sampler.wrap_t = 'CLAMP_TO_EDGE'
gl = set_tex(lid, os.path.join(GD, 'lid_upper.png'), 'FaceAtlas_upper_lid')
gl.alpha_mode = 'MASK'; gl.alpha_cutoff = 0.5
print('LID', lid.name, gl.alpha_mode, 'BALL normal map', gb.normal_texture.index.source.name if gb.normal_texture.index.source else None)

# ball triangles: Face_upper triangles whose front projection meets an eye box (cell px of gaze.json)
boxes = [(x0 + bx0, y0 + by0, x1 + bx0, y1 + by0) for x0, y0, x1, y1 in G['eye_boxes']]
V = [MH @ v.co for v in me.vertices]; PX = [proj(p) for p in V]
CN = [(R3 @ c.vector).normalized() for c in me.corner_normals]
VN = [Vector() for _ in me.vertices]
for l in me.loops: VN[l.vertex_index] += CN[l.index]
VN = [n.normalized() for n in VN]
polys = []
for poly in me.polygons:
    if poly.material_index != slot: continue
    xs = [PX[v][0] for v in poly.vertices]; ys = [PX[v][1] for v in poly.vertices]
    if any(min(xs) <= x1 and max(xs) >= x0 and min(ys) <= y1 and max(ys) >= y0 for x0, y0, x1, y1 in boxes): polys.append(poly.index)
vmap = {}; verts = []; faces = []
for pi in polys:
    f = []
    for vi in me.polygons[pi].vertices:
        # straight back along the front projection (+Y), not along the normal: the UVs are the front projection,
        # and a sideways push (the eyes sit on the curve of the face) moved the ball ~1 texel off the lid
        if vi not in vmap: vmap[vi] = len(verts); verts.append(V[vi] + Vector((0, BACK, 0)))
        f.append(vmap[vi])
    faces.append(f)
bmesh_ = bpy.data.meshes.new('EyeBall'); bmesh_.from_pydata([tuple(v) for v in verts], [], faces); bmesh_.update()
eo = bpy.data.objects.new('EyeBall', bmesh_); head.users_collection[0].objects.link(eo)
eo.parent = rig; eo.matrix_parent_inverse = rig.matrix_world.inverted(); eo.matrix_world = MH.__class__.Identity(4)
mod = eo.modifiers.new('Armature', 'ARMATURE'); mod.object = rig
for g in head.vertex_groups: eo.vertex_groups.new(name=g.name)
for vi, ni in vmap.items():
    for ge in me.vertices[vi].groups:
        if ge.weight > 0: eo.vertex_groups[head.vertex_groups[ge.group].name].add([ni], ge.weight, 'REPLACE')
bmesh_.materials.append(ball)
uv = bmesh_.uv_layers.new(name='UVMap').data; loop_normals = []
worst = 0.0
for k, poly in enumerate(bmesh_.polygons):
    poly.use_smooth = True; src = me.polygons[polys[k]]
    for li, sli in zip(poly.loop_indices, src.loop_indices):
        px, py = PX[me.loops[sli].vertex_index]               # the face vertex's projection: the ball lines up with the lid
        u, v = (px - bx0) / CW, (py - by0) / CH
        worst = max(worst, -u, u - 1, -v, v - 1)
        uv[li].uv = (u / NB, 1 - v * CH / HT)
        loop_normals.append(CN[sli])
bmesh_.normals_split_custom_set(loop_normals)
print('BALL', len(verts), 'vertices', len(faces), 'faces of', sum(p.material_index == slot for p in me.polygons), 'Face_upper; cell overflow', round(worst, 3))
assert worst < 0.02, 'a ball triangle reaches outside its cell'

# ---- lid shadow layer (paint_gaze.py shade.png): the ball triangles again, between the lid and the ball, with the
# lid's own atlas UVs, so it switches cells with the lid and stays put while the ball moves
shade_png = os.path.join(GD, 'shade.png'); so = None
if os.path.isfile(shade_png) and G.get('shade_cells'):
    shm = lid.copy(); shm.name = 'EyeShade'
    gs = set_tex(shm, shade_png, 'EyeShade'); gs.alpha_mode = 'BLEND'
    ext = gs.extensions.vrmc_materials_mtoon
    ext.transparent_with_z_write = False; ext.outline_width_mode = 'none'
    ext.parametric_rim_color_factor = (0.0, 0.0, 0.0); ext.matcap_factor = (0.0, 0.0, 0.0)
    if hasattr(gs, 'emissive_factor'): gs.emissive_factor = (0.0, 0.0, 0.0)
    sverts = [v + Vector((0, SHADE_BACK - BACK, 0)) for v in verts]
    sme = bpy.data.meshes.new('EyeShade'); sme.from_pydata([tuple(v) for v in sverts], [], faces); sme.update()
    so = bpy.data.objects.new('EyeShade', sme); head.users_collection[0].objects.link(so)
    so.parent = rig; so.matrix_parent_inverse = rig.matrix_world.inverted(); so.matrix_world = MH.__class__.Identity(4)
    smod = so.modifiers.new('Armature', 'ARMATURE'); smod.object = rig
    for gname in eo.vertex_groups.keys(): so.vertex_groups.new(name=gname)
    for vi, ni in vmap.items():
        for ge in me.vertices[vi].groups:
            if ge.weight > 0: so.vertex_groups[head.vertex_groups[ge.group].name].add([ni], ge.weight, 'REPLACE')
    sme.materials.append(shm)
    luv = me.uv_layers.active.data; suv = sme.uv_layers.new(name='UVMap').data; snorm = []
    for k, poly in enumerate(sme.polygons):
        poly.use_smooth = True; src = me.polygons[polys[k]]
        for li, sli in zip(poly.loop_indices, src.loop_indices):
            suv[li].uv = tuple(luv[sli].uv); snorm.append(CN[sli])
    sme.normals_split_custom_set(snorm)
    # every expression that moves the lid atlas moves the shadow layer the same way
    v1_ = rig.data.vrm_addon_extension.vrm1; n_b = 0
    for ex_ in list(v1_.expressions.preset.name_to_expression_dict().values()) + list(v1_.expressions.custom):
        for b0 in list(ex_.texture_transform_binds):
            if b0.material == lid:
                b1 = ex_.texture_transform_binds.add(); b1.material = shm; b1.scale = tuple(b0.scale); b1.offset = tuple(b0.offset); n_b += 1
    print('SHADE layer', len(sverts), 'vertices', 'binds copied', n_b, 'cells', G['shade_cells'])

# ---- expressions and lookAt
v1 = rig.data.vrm_addon_extension.vrm1; p = v1.expressions.preset
EMO = {'happy': p.happy, 'angry': p.angry, 'sad': p.sad, 'relaxed': p.relaxed, 'surprised': p.surprised}
SC = G.get('scaled', {})
for name, ex in EMO.items():
    if name in SC:
        # the stretched copy: uv' = s * uv + o (glTF, v down), so a lookAt offset moves this cell's iris by 1/s
        k = SC[name]['scale']; ox, oy = SC[name]['offset_px']
        b = ex.texture_transform_binds.add(); b.material = ball; b.scale = (k, k); b.offset = (ox / (CW * NB), oy / HT)
    elif name in G['ball_cells'] and G['ball_cells'].index(name) > 0:
        b = ex.texture_transform_binds.add(); b.material = ball; b.scale = (1.0, 1.0); b.offset = (G['ball_cells'].index(name) / NB, 0.0)
du, dv = G['gaze_px'][0] / (CW * NB), G['gaze_px'][1] / HT
la = v1.look_at; la.type = 'expression'
for rm, inp in ((la.range_map_horizontal_inner, H_IN), (la.range_map_horizontal_outer, H_IN), (la.range_map_vertical_up, V_IN), (la.range_map_vertical_down, V_IN)):
    rm.input_max_value = inp; rm.output_scale = 1.0
# glTF UV (v down). lookLeft = the avatar's left = +X = image right: the iris moves to +u, so the UVs shift by -du
for ex, off in ((p.look_left, (-du, 0.0)), (p.look_right, (du, 0.0)), (p.look_up, (0.0, dv)), (p.look_down, (0.0, -dv))):
    ex.morph_target_binds.clear(); ex.texture_transform_binds.clear(); ex.is_binary = False
    b = ex.texture_transform_binds.add(); b.material = ball; b.scale = (1.0, 1.0); b.offset = off
mid = sum((Vector(v) for v in verts), Vector()) / len(verts); hb = rig.matrix_world @ rig.data.bones['head'].head_local
la.offset_from_head_bone = (mid.x - hb.x, mid.z - hb.z, -(mid.y - hb.y))
print('LOOKAT du dv (uv)', round(du, 5), round(dv, 5), 'input deg', H_IN, V_IN, 'offset', tuple(round(x, 4) for x in la.offset_from_head_bone))

# ---- export (the meshes of the input VRM + EyeBall)
src_vrm = Path(blend).with_suffix('.vrm'); raw = src_vrm.read_bytes(); nj = struct.unpack_from('<I', raw, 12)[0]
keep = {node['name'] for node in json.loads(raw[20:20 + nj])['nodes'] if 'mesh' in node} | {eo.name} | ({so.name} if so else set())
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name in keep]
bpy.ops.object.select_all(action='DESELECT')
for o in [rig, *meshes]: o.hide_set(False); o.select_set(True)
bpy.context.view_layer.objects.active = rig
out_vrm.parent.mkdir(parents=True, exist_ok=True); out_vrm.unlink(missing_ok=True)
res = bpy.ops.export_scene.vrm(filepath=str(out_vrm), armature_object_name=rig.name, export_only_selections=True,
                               export_invisibles=False, use_addon_preferences=False)
assert 'FINISHED' in res and out_vrm.is_file(), f'VRM export failed: {res}'
raw = out_vrm.read_bytes(); nj = struct.unpack_from('<I', raw, 12)[0]; doc = json.loads(raw[20:20 + nj])
vrm = doc['extensions']['VRMC_vrm']; ex = vrm['expressions']['preset']
print('EXPRESSIONS', {k: [(doc['materials'][b['material']]['name'], [round(x, 4) for x in b.get('offset', [0, 0])], b.get('scale')) for b in v.get('textureTransformBinds', [])] for k, v in ex.items() if v.get('textureTransformBinds')})
print('BINARY', {k: v.get('isBinary') for k, v in ex.items() if v.get('textureTransformBinds')})
print('LOOKAT', vrm['lookAt'])
print('MATERIALS', [(m_['name'], m_.get('alphaMode', 'OPAQUE'), m_.get('alphaCutoff')) for m_ in doc['materials']])
print('NODES', [n_['name'] for n_ in doc['nodes'] if 'mesh' in n_])
bpy.ops.wm.save_as_mainfile(filepath=str(out_blend))
print('EXPORT', out_vrm, 'BLEND', out_blend, 'INSPECT', mt.inspect_vrm(out_vrm))
