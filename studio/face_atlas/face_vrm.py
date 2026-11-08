# Face-texture expressions: split the face regions into their own materials, map them onto expression atlases and
# export a VRM whose expressions shift the atlas (VRM 1.0 textureTransformBinds). No extra meshes, no shape keys.
#   select: blender -b <character.blend> --python face_vrm.py -- select FACE_DIR rects.json
#           rects.json {"upper": [x0, y0, x1, y1], "mouth": [...]} in render pixels (render_front.py camera);
#           a region may also be a list of rects (their union)
#           writes FACE_DIR/regions.json with each region's "rect" and the "bbox" of the triangles it takes
#   build:  blender -b --factory-startup --python face_vrm.py -- build KIT character.blend FACE_DIR reference.vrm out.vrm
#           (after atlas.py has written atlas_upper.png / atlas_mouth.png and the cell lists into regions.json)
#           env FACE_SKIN_DIR=<skin_tone.py OUT_DIR>: use its recoloured head / body textures (see below)
#           character.blend may be the output of iris_concave.py: the regions are picked again by rect at build, so
#           their triangle count may differ from select (the irises were subdivided); only each region's bbox must be
#           the one select wrote, because the atlas cells were cut to that bbox.
# A triangle belongs to a region when its centre, seen from the front camera, falls inside the rect and it faces
# the camera. Its UVs are the front projection, so the atlas cell is exactly what the camera sees.
import bpy, sys, os, json, struct, importlib.util
from pathlib import Path
from mathutils import Vector
args = sys.argv[sys.argv.index('--') + 1:]; mode = args[0]
def proj(cam, p):
    S = cam['size']; k = S / cam['ortho_scale']
    return ((p.x - cam['center'][0]) * k + S / 2, S / 2 - (p.z - cam['center'][1]) * k)
def pick(face, cam, rects):
    me = face.data; M = face.matrix_world; R = M.to_3x3()
    out = {k: [] for k in rects}
    for poly in me.polygons:
        if (R @ poly.normal).normalized().dot(Vector((0, -1, 0))) < 0.15: continue
        x, y = proj(cam, M @ poly.center)
        # a region is one rect [x0, y0, x1, y1] or a list of them (chara4's mouth: the big rect plus a strip under the
        # mouth, so the open aa's lower edge is covered without taking the chin's side triangles)
        k = next((k for k, r in rects.items() for (x0, y0, x1, y1) in (r if isinstance(r[0], list) else [r])
                  if x0 <= x <= x1 and y0 <= y <= y1), None)
        if k is not None: out[k].append(poly.index)
    return out
def bbox(face, cam, polys):
    M = face.matrix_world; pts = [proj(cam, M @ face.data.vertices[v].co) for p in polys for v in face.data.polygons[p].vertices]
    return [int(min(p[0] for p in pts)) - 2, int(min(p[1] for p in pts)) - 2, int(max(p[0] for p in pts)) + 3, int(max(p[1] for p in pts)) + 3]

if mode == 'select':
    D, rj = args[1], args[2]; rects = json.load(open(rj)); cam = json.load(open(os.path.join(D, 'cam.json')))
    face = bpy.data.objects['Head']; sel = pick(face, cam, rects)
    reg = {k: {'rect': rects[k], 'bbox': bbox(face, cam, v), 'triangles': len(v)} for k, v in sel.items()}
    reg['size'] = cam['size']; json.dump(reg, open(os.path.join(D, 'regions.json'), 'w'), indent=1)
    print('SELECT', {k: (v['triangles'], v['bbox']) for k, v in reg.items() if k != 'size'}); sys.exit(0)

# ---- build ----
KIT, blend, D, ref_vrm, out_vrm = args[1:6]
spec = importlib.util.spec_from_file_location('mt', Path(KIT) / 'scripts/mtoon-export.py')
mt = importlib.util.module_from_spec(spec); spec.loader.exec_module(mt); mt.enable_vrm()
bpy.ops.wm.open_mainfile(filepath=blend)
# env FACE_SKIN_DIR: skin_tone.py output (head.png, upper_body.png, lower_body.png) replaces those materials' base
# colour (and shade multiply) textures, so the face and the neck have one tone. The atlas cells are cut from the head
# texture of render_front.py, so with a recoloured head.png the atlas must be recoloured too (skin_tone.py recolor).
SKIN = os.environ.get('FACE_SKIN_DIR')
for mname in (('head', 'upper_body', 'lower_body') if SKIN else ()):
    f = os.path.join(SKIN, mname + '.png')
    if not os.path.isfile(f) or mname not in bpy.data.materials: continue
    im = bpy.data.images.load(f); im.name = 'skin_' + mname; im.pack()
    g = bpy.data.materials[mname].vrm_addon_extension.mtoon1
    g.pbr_metallic_roughness.base_color_texture.index.source = im
    if g.extensions.vrmc_materials_mtoon.shade_multiply_texture.index.source: g.extensions.vrmc_materials_mtoon.shade_multiply_texture.index.source = im
    print('SKIN', mname, f)
raw = Path(ref_vrm).read_bytes(); n = struct.unpack_from('<I', raw, 12)[0]
keep = {node['name'] for node in json.loads(raw[20:20 + n])['nodes'] if 'mesh' in node}
cam = json.load(open(os.path.join(D, 'cam.json'))); reg = json.load(open(os.path.join(D, 'regions.json')))
regions = [k for k in reg if k != 'size']
face = bpy.data.objects['Head']; me = face.data
sel = pick(face, cam, {k: reg[k]['rect'] for k in regions})
for k in regions:
    b = bbox(face, cam, sel[k])
    assert b == reg[k]['bbox'], f'{k}: region bbox {b} != {reg[k]["bbox"]} from select (the atlas no longer fits)'
    print('PICK', k, len(sel[k]), 'triangles (select:', reg[k]['triangles'], ') bbox', b)
base = me.materials[me.polygons[0].material_index]
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE' and o.data.vrm_addon_extension.spec_version == '1.0')
uvl = me.uv_layers.active.data; mats = {}
for k in regions:
    x0, y0, x1, y1 = reg[k]['bbox']; cells = reg[k]['cells']; w, h = x1 - x0, (y1 - y0) * len(cells)
    img = bpy.data.images.load(os.path.join(D, f'atlas_{k}.png')); img.name = f'FaceAtlas_{k}'; img.pack()
    assert img.size[0] == x1 - x0 and img.size[1] == h, f'{k}: atlas size {tuple(img.size)} != bbox {w}x{h}'
    m = base.copy(); m.name = f'Face_{k}'; me.materials.append(m); slot = len(me.materials) - 1
    # same MToon settings as the face (shade colour, toony, rim...): only the textures change. Do not toggle
    # mtoon1.enabled here, it resets the settings (shade colour went 0.51 -> 1.0 and the region looked brighter)
    g = m.vrm_addon_extension.mtoon1; gb = base.vrm_addon_extension.mtoon1
    g.pbr_metallic_roughness.base_color_texture.index.source = img
    if gb.extensions.vrmc_materials_mtoon.shade_multiply_texture.index.source:
        g.extensions.vrmc_materials_mtoon.shade_multiply_texture.index.source = img
    for path in ('extensions.vrmc_materials_mtoon.shade_color_factor', 'extensions.vrmc_materials_mtoon.shading_toony_factor',
                 'extensions.vrmc_materials_mtoon.shading_shift_factor', 'pbr_metallic_roughness.base_color_factor'):
        *obj, attr = path.split('.'); src, dst = gb, g
        for o_ in obj: src, dst = getattr(src, o_), getattr(dst, o_)
        assert tuple(getattr(dst, attr)) == tuple(getattr(src, attr)) if hasattr(getattr(src, attr), '__len__') else getattr(dst, attr) == getattr(src, attr), f'{k}: {path} differs from the face'
    M = face.matrix_world
    for p in sel[k]:
        poly = me.polygons[p]; poly.material_index = slot
        for li in poly.loop_indices:
            px, py = proj(cam, M @ me.vertices[me.loops[li].vertex_index].co)
            # cell 0 is the top of the image; Blender UVs start at the bottom
            uvl[li].uv = ((px - x0) / w, 1 - (py - y0) / h)
    mats[k] = (m, len(cells), cells)
    print('REGION', k, len(sel[k]), 'triangles', 'cells', cells)
ex = rig.data.vrm_addon_extension.vrm1.expressions; p = ex.preset
def bind(expr, **cell_of):
    expr.texture_transform_binds.clear()
    for k, name in cell_of.items():
        m, ncell, cells = mats[k]; i = cells.index(name)
        if i == 0: continue
        b = expr.texture_transform_binds.add(); b.material = m
        b.scale = (1.0, 1.0); b.offset = (0.0, i / ncell)      # glTF UV space: v grows downwards
    expr.is_binary = True
# Every bind is isBinary: an atlas shift cannot blend two cells, a weight of 0.4 would show 40% of the way to the
# next cell (parts of two cells). Binary expressions snap at weight 0.5 instead. Expressions on the same material add
# their offsets, so an emotion blocks blink (both shift the upper atlas) and, when it has its own mouth cell, the
# mouth presets (aa..oh shift the mouth atlas); an emotion without a mouth cell leaves the mouth to lip sync.
emotions = [e for e in ('happy', 'angry', 'sad', 'relaxed', 'surprised') if e in mats['upper'][2]]
for e in emotions:
    kw = {'upper': e}
    if 'mouth' in mats and e in mats['mouth'][2]: kw['mouth'] = e
    bind(getattr(p, e), **kw); getattr(p, e).override_blink = 'block'
    getattr(p, e).override_mouth = 'block' if 'mouth' in kw else 'none'
for v in ('aa', 'ih', 'ou', 'ee', 'oh'):              # visemes: mouth cells only, the eyes stay neutral
    if 'mouth' in mats and v in mats['mouth'][2]: bind(getattr(p, v), mouth=v)
for vrm_name, cell in (('blink', 'blink'), ('blink_left', 'blinkLeft'), ('blink_right', 'blinkRight')):
    if cell in mats['upper'][2]: bind(getattr(p, vrm_name), upper=cell)
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name in keep]
bpy.ops.object.select_all(action='DESELECT')
for o in [rig, *meshes]: o.hide_set(False); o.select_set(True)
bpy.context.view_layer.objects.active = rig
out = Path(out_vrm).resolve(); out.parent.mkdir(parents=True, exist_ok=True); out.unlink(missing_ok=True)
res = bpy.ops.export_scene.vrm(filepath=str(out), armature_object_name=rig.name, export_only_selections=True,
                               export_invisibles=False, use_addon_preferences=False)
assert 'FINISHED' in res and out.is_file(), f'VRM export failed: {res}'
raw = out.read_bytes(); n = struct.unpack_from('<I', raw, 12)[0]; doc = json.loads(raw[20:20 + n])
exprs = doc['extensions']['VRMC_vrm']['expressions']['preset']
print('EXPRESSIONS', {k: [(b['material'], b.get('offset')) for b in v.get('textureTransformBinds', [])] for k, v in exprs.items() if v.get('textureTransformBinds')})
bpy.ops.wm.save_as_mainfile(filepath=str(out.with_suffix('.blend')), copy=True)
print('EXPORT', out, 'INSPECT', mt.inspect_vrm(out))
