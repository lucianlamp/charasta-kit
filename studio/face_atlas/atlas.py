# Build the expression atlases for face-texture expressions (one texture per face region, one cell per expression).
# Usage: python atlas.py FACE_DIR name=IMG [name=IMG ...] [--narrow F] [--hair-width PX]   (needs neutral=..., others optional)
#   --mirror: every cell's strokes on the image's left half (the character's right eye and brow) are replaced by the
#   right half mirrored about the midpoint of the two irises of the neutral drawing (olive/green blobs). For drawings
#   where a drawn bang hides part of one eye: the hidden part would stay plain skin and show at oblique angles.
#   blinkLeft / blinkRight are built after the mirror, so winks stay one-sided.
#   --hair-width PX: also drop the drawing's own hair (mask from the neutral drawing, used for all) when it has the colour of the brows (chara3: red hair, red-brown
#   brows of the same colour). Red areas wider than 2*PX render pixels are hair; the hair mask grows back over the
#   narrow strand tips next to them (PX + 4 px), so the thin brows and lashes away from the hair are kept. Without it
#   a drawn bang lying where the model has bare skin was painted on the face as a red streak.
#   --narrow F: squeeze each drawn eye horizontally by F (e.g. 0.85) about its iris centre (FACE_DIR/irises.json from
#   iris_concave.py, same alignment); off by default. Only the eye boxes change (rows around the irises, columns from
#   between the eyes to the upper rect's edge): the eye from its inner corner to the lash tip is scaled, the
#   margin between the eyes stretches to keep the picture continuous, the outer margin left by the squeezed lash tip
#   gets no strokes (plain skin), and the scale tapers to 1 at the box's top and bottom.
#   FACE_DIR: skin.png from render_front.py, align.json from align.py (render px = img px * s + t) and
#   regions.json from `face_vrm.py select` (per region: "rect" = where strokes are taken, "bbox" = cell size)
#   names: neutral, blink, happy, angry, sad, relaxed, surprised (eyes + brows + mouth drawn together)
#          and the visemes aa, ih, ou, ee, oh (whole faces too, but only their mouth is used: they become cells of
#          the mouth region alone and keep the neutral eyes)
# Writes FACE_DIR/atlas_<region>.png and adds each region's "cells" to regions.json. Cell i sits i cell heights
# below cell 0, so an expression shows cell i by shifting the UV by i / len(cells).
# A cell is the model's own flat skin (skin.png) with the drawn strokes laid on top: the strokes are what differs
# from the drawing's own local skin colour, so the drawing's skin tone never reaches the model and the region
# edges stay invisible. Strokes fade out over 3% inside the rect; strands of the drawn hair are left out.
#   env HAIR_COLOR (mint, default | blue): colour of the drawn hair that is left out (chara1: silver-blue hair)
#   env IRIS_COLOR (olive, default | red): iris colour used to find the mirror axis with --mirror (chara1: red irises)
import sys, os, json
import numpy as np
from PIL import Image
from scipy import ndimage
D = sys.argv[1]; argv = sys.argv[2:]; NARROW = None; HAIRW = None
if '--narrow' in argv: i = argv.index('--narrow'); NARROW = float(argv[i + 1]); del argv[i:i + 2]
MIRROR = '--mirror' in argv; argv = [x for x in argv if x != '--mirror']
if '--hair-width' in argv: i = argv.index('--hair-width'); HAIRW = int(argv[i + 1]); del argv[i:i + 2]
imgs = dict(a.split('=', 1) for a in argv)
skin = np.asarray(Image.open(os.path.join(D, 'skin.png')).convert('RGBA')).astype(np.float32)
W = skin.shape[0]; al = json.load(open(os.path.join(D, 'align.json'))); reg = json.load(open(os.path.join(D, 'regions.json')))
def warp(path):
    name = os.path.splitext(os.path.basename(path))[0]; s, tx, ty = al[name]
    I = Image.open(path).convert('RGBA'); I = I.resize((int(I.size[0] * s), int(I.size[1] * s)), Image.LANCZOS)
    c = Image.new('RGBA', (W, W)); c.paste(I, (int(round(tx)), int(round(ty)))); return np.asarray(c).astype(np.float32)
def is_skin(a):
    # b > 0.5 r: the light lower half of an olive iris (180, 160, 70) passed the other tests, the local skin estimate
    # became the iris colour there and the model skin showed through the iris as a pale streak (chara3)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return (a[..., 3] > 128) & (r > 170) & (r >= g) & (g >= b - 5) & (r - b > 20) & (r - g < 90) & (b > 0.5 * r)
def strokes(a):
    m = is_skin(a).astype(np.float32); loc = np.zeros_like(a[..., :3]); wsum = ndimage.gaussian_filter(m, 24) + 1e-4
    for c in range(3): loc[..., c] = ndimage.gaussian_filter(a[..., c] * m, 24) / wsum
    # far inside a large dark shape (chara3's big irises) no skin lies within the blur and the estimate is noise
    # (a pale streak and the highlights came out half transparent): there the drawing's median skin colour is used
    t = np.clip(wsum / 0.05, 0, 1)[..., None]; loc = loc * t + np.median(a[m > 0][:, :3], 0) * (1 - t)
    d = np.sqrt(((a[..., :3] - loc) ** 2).sum(-1))
    alpha = np.clip((d - 14) / 40, 0, 1) * (a[..., 3] / 255)
    r, g, b_ = a[..., 0], a[..., 1], a[..., 2]
    # drawn hair (the model has its own) is the large connected mint area; the iris greens are small blobs closed in
    # by the dark rim, so only components bigger than 2% of the canvas are removed (the iris was being erased)
    mint = (g > r + 8) & ((r + g + b_) / 3 > 140)
    if os.environ.get('HAIR_COLOR', 'mint') == 'blue':      # silver-blue hair: blue above red, darker strands too
        mint = (b_ > r + 12) & (b_ > 80)
    lab, n = ndimage.label(mint); sizes = ndimage.sum(np.ones_like(r), lab, range(1, n + 1))
    big = np.isin(lab, 1 + np.nonzero(sizes > mint.size * 0.02)[0])
    alpha[ndimage.binary_dilation(big, iterations=2)] = 0
    if HAIRW: alpha[HAIR] = 0
    return alpha
def hair_mask(a):
    # found on the neutral drawing only and used for every cell: the edits keep the hair, and a thick angry brow
    # next to a bang was taken for hair when each drawing was masked on its own
    r, g = a[..., 0], a[..., 1]; red = (r - g > 70) & (r > 100) & (a[..., 3] > 128)
    def disk(n): y, x = np.mgrid[-n:n + 1, -n:n + 1]; return x * x + y * y <= n * n
    core = ndimage.binary_opening(red, disk(HAIRW))
    if os.environ.get('HAIR_EDGE') == '1':
        # red irises (chara4: rose-red irises, crimson hair): only red areas that reach outside the upper rect are
        # hair; an iris is closed in by the dark lash and rim and was erased whole without this
        x0, y0, x1, y1 = reg['upper']['rect']; lab, n = ndimage.label(red)
        out = np.ones_like(red); out[y0:y1, x0:x1] = False
        core &= np.isin(lab, np.unique(lab[out & red]))
    hair = ndimage.binary_dilation(core, disk(HAIRW + 4)) & red
    return ndimage.binary_dilation(hair, iterations=8)              # with the dark anti-aliased hair edge
def narrow(a):
    x0, y0, x1, y1 = reg['upper']['rect']; out = a.copy(); xs = np.arange(W, dtype=np.float64)
    for e in json.load(open(os.path.join(D, 'irises.json')))['irises']:
        (ex, ey), rx, ry = e['center'], e['rx'], e['ry']; side = -1 if ex < W / 2 else 1     # side: towards the outer corner
        outer_box = x1 - 1 if side > 0 else x0 + 1; inner_box = ex - side * 1.6 * rx
        reach = min(2.5 * rx, abs(outer_box - ex) - 4)                                 # lash tip, inside the box
        r0, r1 = int(ey - 1.5 * ry), int(ey + 1.35 * ry); taper = 0.15 * (r1 - r0)
        for y in range(max(r0, 0), min(r1, W)):
            t = min(1.0, (y - r0) / taper, (r1 - y) / taper); f = 1 - (1 - NARROW) * t * t * (3 - 2 * t)
            src = sorted([inner_box, ex - side * 1.3 * rx, ex + side * reach, outer_box])
            dst = sorted([inner_box, ex - side * 1.3 * rx * f, ex + side * reach * f, outer_box])
            lo, hi = int(src[0]), int(src[-1]) + 1; xq = np.interp(xs[lo:hi], dst, src)    # dst column -> src column
            for c in range(4): out[y, lo:hi, c] = np.interp(xq, xs, a[y, :, c])
            # the outer margin (between the squeezed lash tip and the rect edge) would stretch whatever lies in the few
            # pixels at the rect edge (a drawn hair line became a dark block): it is left without strokes (plain skin)
            m0, m1 = sorted([ex + side * reach * f, outer_box]); out[y, int(m0) + 1:int(m1) + 1, 3] = 0
    return out
F = {k: warp(v) for k, v in imgs.items()}
if NARROW: F = {k: narrow(v) for k, v in F.items()}; print('NARROW', NARROW)
HAIR = hair_mask(F['neutral']) if HAIRW else None
A = {k: strokes(v) for k, v in F.items()}
if MIRROR:
    n_ = F['neutral']; r_, g_, b_ = n_[..., 0], n_[..., 1], n_[..., 2]; x0_, y0_, x1_, y1_ = reg['upper']['rect']
    iris = (g_ > b_ + 40) & (r_ < 210) & (g_ > 70) & (A['neutral'] > 0.9); iris[:y0_] = iris[y1_:] = False
    if os.environ.get('IRIS_COLOR', 'olive') == 'red':
        iris = (r_ - g_ > 80) & (r_ > 100) & (A['neutral'] > 0.9); iris[:y0_] = iris[y1_:] = False
    iris[:, :x0_] = iris[:, x1_:] = False; xs_ = np.nonzero(iris)[1]; mid0 = float(np.median(xs_))
    axis = (float(np.median(xs_[xs_ < mid0])) + float(np.median(xs_[xs_ >= mid0]))) / 2; ax2 = int(round(2 * axis))
    print('MIRROR axis x', round(axis, 1), 'iris x medians', [round(float(np.median(xs_[xs_ < mid0]))), round(float(np.median(xs_[xs_ >= mid0])))])
    cols = np.arange(int(axis)); src = np.clip(ax2 - cols, 0, W - 1)
    for k in F: F[k][:, cols] = F[k][:, src]; A[k][:, cols] = A[k][:, src]
fx = np.nonzero(is_skin(F['neutral']))[1]; cx = float(np.median(fx))
RAW = os.environ.get('ATLAS_RAW') == '1'; GAIN = {}
# OVERLAY=PNG OVERLAY_ALIGN=NAME: a transparent layer drawn on the drawing's canvas (a cheek blush made by image_gen),
# composited over every cell with NAME's alignment; bake_overlay.py puts the same layer into the head texture, so it
# is continuous across the region edges
OVL = None
if os.environ.get('OVERLAY'):
    _s, _tx, _ty = al[os.environ['OVERLAY_ALIGN']]
    _I = Image.open(os.environ['OVERLAY']).convert('RGBA'); _I = _I.resize((int(_I.size[0] * _s), int(_I.size[1] * _s)), Image.LANCZOS)
    _c = Image.new('RGBA', (W, W)); _c.paste(_I, (int(round(_tx)), int(round(_ty)))); OVL = np.asarray(_c).astype(np.float32)
def cell(name, region):
    x0, y0, x1, y1 = reg[region]['bbox']; r = reg[region]['rect']
    if isinstance(r[0], list): r = [min(q[0] for q in r), min(q[1] for q in r), max(q[2] for q in r), max(q[3] for q in r)]   # several rects: their outline
    rx0, ry0, rx1, ry1 = r
    if RAW:
        # the drawing as it is (an image_gen face is drawn cleanly; re-extracting its strokes over the model skin faded
        # the lower lids and cut the eye corners, chara4): only placed on the front projection and tinted by one gain
        # per channel so its skin matches the model skin; where the drawing is empty the model skin shows
        src = F[name][y0:y1, x0:x1]; base = skin[y0:y1, x0:x1]
        sa = (src[..., 3:4] / 255) if src.shape[2] == 4 else np.ones(src.shape[:2] + (1,))
        # one gain per drawing over the whole face (a gain per region left a seam at the mouth region's edge, chara4)
        if name not in GAIN:
            fa = (F[name][..., 3:4] / 255) if F[name].shape[2] == 4 else np.ones(F[name].shape[:2] + (1,))
            dsa = is_skin(F[name]) & (fa[..., 0] > 0.99) & (skin[..., 3] > 0)
            GAIN[name] = np.median(skin[..., :3][dsa], 0) / np.maximum(np.median(F[name][..., :3][dsa], 0), 1) if dsa.sum() > 100 else np.ones(3)
        gain = GAIN[name]
        out = base.copy(); out[..., :3] = base[..., :3] * (1 - sa) + np.clip(src[..., :3] * gain, 0, 255) * sa; out[..., 3] = 255
        if OVL is not None:
            o = OVL[y0:y1, x0:x1]; oa = o[..., 3:4] / 255; out[..., :3] = out[..., :3] * (1 - oa) + o[..., :3] * oa
        return out
    out = skin[y0:y1, x0:x1].copy(); src = F[name][y0:y1, x0:x1]; a = A[name][y0:y1, x0:x1].copy()
    yy, xx = np.mgrid[y0:y1, x0:x1]; ramp = 0.03 * max(rx1 - rx0, ry1 - ry0)
    a *= np.clip(np.minimum.reduce([xx - rx0, rx1 - xx, yy - ry0, ry1 - yy]) / ramp, 0, 1)
    out[..., :3] = out[..., :3] * (1 - a[..., None]) + src[..., :3] * a[..., None]; out[..., 3] = 255
    return out
def wink(region, closed_side):           # the character's left eye is on the image's right
    o, c = cell('neutral', region), cell('blink', region); mid = int(cx - reg[region]['bbox'][0])
    if closed_side == 'right': o[:, mid:] = c[:, mid:]
    else: o[:, :mid] = c[:, :mid]
    return o
order = [k for k in ('neutral', 'blink', 'happy', 'angry', 'sad', 'relaxed', 'surprised') if k in F]
visemes = [k for k in ('aa', 'ih', 'ou', 'ee', 'oh') if k in F]
for region in [k for k in reg if k != 'size']:
    names = order if region == 'upper' else [k for k in order if k != 'blink'] + (visemes if region == 'mouth' else [])
    tiles = [cell(n, region) for n in names]
    if region == 'upper' and 'blink' in F:
        tiles += [wink(region, 'right'), wink(region, 'left')]; names = names + ['blinkLeft', 'blinkRight']
    Image.fromarray(np.concatenate(tiles, 0).clip(0, 255).astype(np.uint8), 'RGBA').save(os.path.join(D, f'atlas_{region}.png'))
    reg[region]['cells'] = names; print('ATLAS', region, reg[region]['bbox'], names)
json.dump(reg, open(os.path.join(D, 'regions.json'), 'w'), indent=1)
