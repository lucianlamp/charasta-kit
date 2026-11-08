# One skin tone for the head (face, ears, neck stub) and the visible body skin (neck, chest, hands, legs), close to
# the concept art. Only skin texels are recoloured, in CIELAB: lightness keeps every texel's own detail and only its
# mean moves (head and body to the same mean), the colour (a, b) moves to the concept's with 70% of each texel's
# deviation kept (blush, shading tints). Works on copies: the .blend and the source images are not changed.
#   uvdump:  blender -b character.blend --python skin_tone.py -- uvdump OUT_DIR
#            -> OUT_DIR/src_<material>.png (head, upper_body, lower_body) and OUT_DIR/uv_<material>.npz (UV triangles)
#   recolor: python skin_tone.py recolor OUT_DIR CONCEPT.png FACE_UPPER.png ATLAS_MOUTH.png
#            -> OUT_DIR/<material>.png, OUT_DIR/face_upper.png, OUT_DIR/atlas_mouth.png, OUT_DIR/masks.png, stats in
#               OUT_DIR/skin.json. eye_parts.py build uses OUT_DIR=<eye dir>/skin when it exists.
#   bodyshift: python skin_tone.py bodyshift OUT_DIR dL da db [Z_TOP]   (after uvdump)
#            moves only the body's skin texels by a CIELAB delta, and with Z_TOP (world m) also the head texels below
#            it (the head's neck stub); the face keeps its texture. For heads whose texture also holds hair, where
#            recolor would repaint the hair texels
#   shift:   python skin_tone.py shift OUT_DIR dL da db [rR rG rB]
#            moves the face texels of OUT_DIR/head.png (everything above the neck blend, fading in over 2 cm) by a
#            CIELAB delta, to cancel a face/neck difference that remains in the viewer's light (three-vrm shades the
#            face more than the neck). The face texture is already near R = 255, so lightening it in the texture
#            clips red and loses colour (measured: L +6 / a +8 gave a -2.4 in three-vrm). Lighten with the head
#            material's colour factors instead (rR rG rB = linear neck / face ratio measured in the viewer, given to
#            the build as the head's factor multiplier); the texels below the neck blend are divided by the same
#            ratio here (fading out over the 2 cm), so the head's neck stub still meets the body's neck colour.
#            The first run keeps the recolor output as head_recolor.png and every run starts from it.
import sys, os, json

MATS = ('head', 'upper_body', 'lower_body')
# the face renders paler than the body at the same texture colour (measured with skin_measure.py in the same light),
# so the head gets this much more colour
HEAD_GAIN = float(os.environ.get("SKIN_HEAD_GAIN", 1.4))
# env SKIN_L: texture lightness every skin region is moved to (default: the head's mean); SKIN_CHROMA_GAIN (1.35):
# concept colour (a, b) multiplier. chara2 head-6 in three-vrm: the defaults rendered tan (198,156,144) at the neck
# against the concept's (233,192,178); SKIN_L=88 SKIN_CHROMA_GAIN=0.9 moved it toward the concept.
KEEP = 0.7                     # share of each texel's colour deviation from its region mean that is kept


def uvdump(out):
    import bpy
    import numpy as np
    os.makedirs(out, exist_ok=True)
    for name in MATS:
        m = bpy.data.materials[name]; img = m.vrm_addon_extension.mtoon1.pbr_metallic_roughness.base_color_texture.index.source
        cp = img.copy(); cp.filepath_raw = os.path.join(out, f'src_{name}.png'); cp.file_format = 'PNG'; cp.save()
        W, H = img.size; tris = []
        for o in bpy.data.objects:
            if o.type != 'MESH' or name not in [s.material.name for s in o.material_slots if s.material]: continue
            me = o.data; me.calc_loop_triangles(); uv = me.uv_layers.active.data
            slot = [i for i, s in enumerate(o.material_slots) if s.material and s.material.name == name]
            Mw = o.matrix_world; R = Mw.to_3x3(); cn = me.corner_normals
            for t in me.loop_triangles:
                if t.material_index in slot:
                    tris.append([[uv[l].uv[0] * W, (1 - uv[l].uv[1]) * H, *(Mw @ me.vertices[v].co), *(R @ cn[l].vector).normalized()]
                                 for l, v in zip(t.loops, t.vertices)])
        np.savez_compressed(os.path.join(out, f'uv_{name}.npz'), tris=np.array(tris, np.float32), size=np.array([W, H]))
        print('UVDUMP', name, len(tris), 'triangles', (W, H))


def srgb_to_lab(rgb):
    import numpy as np
    c = rgb / 255.0; c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lab_to_srgb(lab):
    import numpy as np
    fy = (lab[..., 0] + 16) / 116; fx = fy + lab[..., 1] / 500; fz = fy - lab[..., 2] / 200
    f = np.stack([fx, fy, fz], -1); xyz = np.where(f ** 3 > 216 / 24389, f ** 3, (116 * f - 16) / (24389 / 27)) * np.array([0.95047, 1.0, 1.08883])
    M = np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]])
    c = np.clip(xyz @ M.T, 0, 1); c = np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)
    return np.clip(c * 255, 0, 255)


NECK_BLEND = 0.03               # m: height over which the head's neck stub fades into the body neck colour


def zraster(tris, size=4096):
    # per texel: world position (x, y, z) interpolated over the UV triangles (nan where no triangle)
    import numpy as np
    out = np.full((size, size, tris.shape[2] - 2), np.nan, np.float32)
    for t in tris:
        P = t[:, :2]; V = t[:, 2:]; x0, y0 = np.floor(P.min(0)).astype(int).clip(0, size - 1); x1, y1 = np.ceil(P.max(0)).astype(int).clip(0, size - 1)
        gy, gx = np.mgrid[y0:y1 + 1, x0:x1 + 1] + 0.5; (ax, ay), (bx, by), (cx, cy) = P
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-9: continue
        l0 = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / den; l1 = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / den; l2 = 1 - l0 - l1
        ins = (l0 >= -0.02) & (l1 >= -0.02) & (l2 >= -0.02)
        val = l0[..., None] * V[0] + l1[..., None] * V[1] + l2[..., None] * V[2]
        sub = out[y0:y1 + 1, x0:x1 + 1]; sub[ins] = val[ins]
    return out


def skin_mask(out, name):
    # (texture, skin texels): the head mesh is all skin; on the body only the skin-coloured texels of its islands
    import numpy as np
    from PIL import Image, ImageDraw
    from scipy import ndimage
    def is_skin(rgb):
        lab = srgb_to_lab(rgb); L, A, B = lab[..., 0], lab[..., 1], lab[..., 2]; hue = np.degrees(np.arctan2(B, A)); ch = np.hypot(A, B)
        # warm, not pink/red ribbons, not white cloth, not dark cloth
        return (L > 45) & (ch > 6) & (ch < 55) & (hue > 15) & (hue < 85)
    src = np.asarray(Image.open(os.path.join(out, f'src_{name}.png')).convert('RGB')).astype(np.float32)
    d = np.load(os.path.join(out, f'uv_{name}.npz')); H, W = src.shape[:2]
    uvm = Image.new('L', (W, H)); dr = ImageDraw.Draw(uvm)
    for t in d['tris']: dr.polygon([tuple(p[:2]) for p in t], fill=255)
    uvm = ndimage.binary_dilation(np.asarray(uvm) > 0, iterations=3)
    m = uvm & (is_skin(src) if name != 'head' else np.ones(uvm.shape, bool))
    if name != 'head':
        # per UV island: an island that is mostly skin keeps its skin texels, a cloth island with a few warm
        # texels (plaid, shading) keeps none
        lab_, n_ = ndimage.label(uvm); frac = ndimage.mean(m, lab_, range(1, n_ + 1))
        m &= np.isin(lab_, 1 + np.nonzero(np.asarray(frac) > 0.4)[0])
    return src, m


def body_shift(out, dL, da, db, z_top=None):
    # bodyshift: the body's skin texels (upper_body, lower_body) move by a CIELAB delta and the head is left as it is.
    # For heads whose texture also holds hair (chara3: the Head shares a Tripo atlas with red hair strands), where
    # recolor turned the red texels on the head olive; the delta is the face - neck difference measured in the viewer.
    import numpy as np
    from PIL import Image
    from scipy import ndimage
    for name in MATS[1:]:
        src, m = skin_mask(out, name); w = ndimage.gaussian_filter(m.astype(np.float32), 1.5) * m
        lab = srgb_to_lab(src) + w[..., None] * np.array([dL, da, db], np.float32)
        Image.fromarray(lab_to_srgb(lab).astype(np.uint8)).save(os.path.join(out, f'{name}.png'))
        print('BODYSHIFT', name, (dL, da, db), 'skin texels', int(m.sum()))
    if z_top is None:
        Image.open(os.path.join(out, 'src_head.png')).save(os.path.join(out, 'head.png')); return
    # Z_TOP: the head's own neck stub (chara3: the visible neck is the head mesh down to 5 cm below the chin, painted
    # 5 L darker and redder than the face) takes the same delta below Z_TOP, fading in over NECK_BLEND downwards
    src = np.asarray(Image.open(os.path.join(out, 'src_head.png')).convert('RGB')).astype(np.float32)
    z = zraster(np.load(os.path.join(out, 'uv_head.npz'))['tris'], src.shape[0])[..., 2]
    hole = np.isnan(z); z = z[tuple(ndimage.distance_transform_edt(hole, return_distances=False, return_indices=True))]
    w = np.clip((z_top - z) / NECK_BLEND, 0, 1); w = w * w * (3 - 2 * w)
    lab = srgb_to_lab(src) + w[..., None] * np.array([dL, da, db], np.float32)
    Image.fromarray(lab_to_srgb(lab).astype(np.uint8)).save(os.path.join(out, 'head.png'))
    print('BODYSHIFT head below z', z_top, 'texels moved fully', int((w > 0.99).sum()))


def recolor(out, concept, face_upper, atlas_mouth):
    import numpy as np
    from PIL import Image, ImageDraw
    from scipy import ndimage
    # concept skin: the median of skin-like pixels of the concept sheet
    cc = np.asarray(Image.open(concept).convert('RGB')).reshape(-1, 3).astype(np.float32)
    r, g, b = cc.T; sk = (r > 180) & (r > g + 20) & (g > b - 5) & (r - b > 30) & (r - b < 90) & (g > 150)
    target_rgb = np.median(cc[sk], 0); T = srgb_to_lab(target_rgb[None])[0]
    stats = {'concept_rgb': target_rgb.round(1).tolist(), 'concept_lab': T.round(1).tolist()}
    regions = {}
    for name in MATS:
        src, m = skin_mask(out, name)
        lab = srgb_to_lab(src); sel = lab[m]
        regions[name] = (src, lab, m, sel.mean(0))
        stats[name] = {'texels': int(m.sum()), 'mean_lab': sel.mean(0).round(1).tolist()}
    # lightness: every region to the head's mean; colour: the concept's (a, b) scaled by how much the toon light
    # darkens the texture (render chroma ~ texture chroma * L_render / L_texture)
    Lh = float(os.environ.get('SKIN_L', regions['head'][3][0]))     # target texture lightness (default: the head's mean)
    k = float(os.environ.get('SKIN_CHROMA_GAIN', 1.35))
    ab_t = T[1:] * k
    stats['target_texture_lab'] = [round(float(Lh), 1), *ab_t.round(1).tolist()]
    def local_mean(lab, m, sigma=48):
        # colour of the skin around each texel (inside the mask only): the target replaces it, the detail on top stays
        wm = ndimage.gaussian_filter(m.astype(np.float32), sigma) + 1e-6
        return np.stack([ndimage.gaussian_filter(lab[..., c] * m, sigma) / wm for c in range(3)], -1)
    def apply(lab, mean, w, loc=None, gain=1.0):
        new = lab.copy(); new[..., 0] = lab[..., 0] + (Lh - mean[0])
        ref = loc[..., 1:] if loc is not None else mean[1:]
        new[..., 1:] = ab_t * np.asarray(gain)[..., None] + KEEP * (lab[..., 1:] - ref)
        return lab * (1 - w[..., None]) + new * w[..., None]
    # head texels: position and normal per texel; the extra colour only where the face looks forward or up (under
    # the jaw the surface faces down and is lit like the neck)
    zh = zraster(np.load(os.path.join(out, 'uv_head.npz'))['tris'])
    with np.errstate(invalid='ignore'):
        head_gain = 1 + (HEAD_GAIN - 1) * np.nan_to_num(np.clip((zh[..., 5] + 0.7) / 0.3, 0, 1), nan=1.0)
    prev = []
    for name, (src, lab, m, mean) in regions.items():
        w = ndimage.gaussian_filter(m.astype(np.float32), 1.5) * m      # soft inside the mask edge, 0 outside
        res = lab_to_srgb(apply(lab, mean, w, local_mean(lab, m), head_gain if name == 'head' else 1.0))
        Image.fromarray(res.astype(np.uint8)).save(os.path.join(out, f'{name}.png'))
        prev.append(Image.fromarray((m * 255).astype(np.uint8)).resize((512, 512)))
        stats[name]['after_lab'] = srgb_to_lab(res[m]).mean(0).round(1).tolist()
    # the face paint and the mouth cells are the head's skin with strokes: skin-like pixels take the head's change
    hmean = regions['head'][3]
    for path, name in ((face_upper, 'face_upper.png'), (atlas_mouth, 'atlas_mouth.png')):
        im = Image.open(path).convert('RGBA'); a = np.asarray(im).astype(np.float32); lab = srgb_to_lab(a[..., :3])
        dE = np.sqrt(((lab - hmean) ** 2).sum(-1)); w = np.clip((30 - dE) / 10, 0, 1)
        a[..., :3] = lab_to_srgb(apply(lab, hmean, w, local_mean(lab, w > 0.5, 24), HEAD_GAIN)); Image.fromarray(a.astype(np.uint8), 'RGBA').save(os.path.join(out, name))
    # the neck: the head mesh's neck stub ends on the body's neck. Its texels blend into the body neck's colour over
    # the last NECK_BLEND of height, so the seam has the same colour on both sides
    zmap = lambda name: zraster(np.load(os.path.join(out, f'uv_{name}.npz'))['tris'])
    zb = zmap('upper_body')
    hb = np.asarray(Image.open(os.path.join(out, 'head.png')).convert('RGB')).astype(np.float32); ub = np.asarray(Image.open(os.path.join(out, 'upper_body.png')).convert('RGB')).astype(np.float32)
    mb = regions['upper_body'][2]; z0 = float(np.nanmin(zh[..., 2]))
    with np.errstate(invalid='ignore'):
        neck_b = mb & (np.abs(zb[..., 0]) < 0.045) & (zb[..., 2] > z0 - 0.02) & (zb[..., 2] < z0 + 0.03) & (zb[..., 1] < 0.03)
    tgt = srgb_to_lab(ub[neck_b]).mean(0); lh = srgb_to_lab(hb)
    zz = zh[..., 2]; t_ = np.where(np.isfinite(zz), np.clip((z0 + NECK_BLEND - zz) / NECK_BLEND, 0, 1), 0); t_ = t_ * t_ * (3 - 2 * t_)
    stub = t_ > 0; loc = local_mean(lh, stub, 16)
    lh2 = lh.copy(); lh2[stub] = lh[stub] + (tgt - loc[stub]) * t_[stub, None]
    Image.fromarray(lab_to_srgb(lh2).astype(np.uint8)).save(os.path.join(out, 'head.png'))
    stats['neck'] = {'head_stub_bottom_z': round(z0, 4), 'body_neck_texels': int(neck_b.sum()), 'body_neck_lab': tgt.round(1).tolist(),
                     'stub_texels': int(stub.sum()), 'stub_lab_before': srgb_to_lab(hb[t_ > 0.8]).mean(0).round(1).tolist() if (t_ > 0.8).any() else None}
    sheet = Image.new('L', (512 * len(prev), 512)); [sheet.paste(p, (512 * i, 0)) for i, p in enumerate(prev)]; sheet.save(os.path.join(out, 'masks.png'))
    json.dump(stats, open(os.path.join(out, 'skin.json'), 'w'), indent=1); print('SKIN', json.dumps(stats))


def shift(out, dL, da, db, ratio=(1.0, 1.0, 1.0)):
    import numpy as np
    from PIL import Image
    from scipy import ndimage
    src = os.path.join(out, 'head_recolor.png')
    if not os.path.isfile(src): Image.open(os.path.join(out, 'head.png')).save(src)
    rgb = np.asarray(Image.open(src).convert('RGB')).astype(np.float32)
    z = zraster(np.load(os.path.join(out, 'uv_head.npz'))['tris'], rgb.shape[0])[..., 2]
    hole = np.isnan(z); idx = ndimage.distance_transform_edt(hole, return_distances=False, return_indices=True)
    z = z[tuple(idx)]                                         # UV padding texels take the height of the nearest triangle
    z0 = float(np.nanmin(z)) + NECK_BLEND; w = np.clip((z - z0) / 0.02, 0, 1); w = w * w * (3 - 2 * w)
    lab = srgb_to_lab(rgb) + w[..., None] * np.array([dL, da, db], np.float32)
    c = lab_to_srgb(lab) / 255; c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    c = c * np.asarray(ratio, np.float32) ** (w[..., None] - 1)              # undo the material ratio below the face
    c = np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.clip(c, 0, 1) ** (1 / 2.4) - 0.055)
    Image.fromarray(np.clip(c * 255 + 0.5, 0, 255).astype(np.uint8)).save(os.path.join(out, 'head.png'))
    print('SHIFT head.png by Lab', (dL, da, db), 'ratio', tuple(ratio), 'above z', round(z0, 4), 'texels moved fully', int((w > 0.99).sum()))


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    if argv[0] == 'uvdump': uvdump(argv[1])
    elif argv[0] == 'recolor': recolor(*argv[1:5])
    elif argv[0] == 'bodyshift': body_shift(argv[1], *map(float, argv[2:5]), *([float(argv[5])] if len(argv) > 5 else []))
    elif argv[0] == 'shift': shift(argv[1], *map(float, argv[2:5]), *([tuple(map(float, argv[5:8]))] if len(argv) >= 8 else []))
