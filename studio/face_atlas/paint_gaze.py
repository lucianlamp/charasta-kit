# python paint_gaze.py FACE_DIR OUT_DIR
# Splits the expression atlas of face_vrm.py / atlas.py (FACE_DIR/atlas_upper.png, one cell per expression, cells
# stacked vertically) into two layers for a moving gaze:
#   OUT_DIR/lid_upper.png  the same atlas with alpha 0 in each cell's eye opening (iris + white + highlights); used
#                          with alpha mode MASK on the face, so the closed-eye cells (no opening) cover the eyes fully
#   OUT_DIR/ball.png       the eye layer behind it: white with a full oval iris per eye, one cell per open-eye
#                          expression side by side; inside each opening it holds the drawn pixels, so with the gaze
#                          straight ahead the face shows the drawing as before
#   OUT_DIR/gaze.json      cell lists, mirror axis, gaze shift in texels, eye boxes for picking the ball triangles
# The atlas was built with atlas.py --mirror: in every cell but the winks the image-left eye (the character's right)
# is the image-right eye mirrored, and so are its highlights. Here the image-right eye of each cell is used: the
# image-left eye of the ball is that eye mirrored without its highlights, and the highlights are copied over
# without mirroring, so both eyes have them on the same side (as the drawings draw/*.png have them).
import sys, os, json
import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.optimize import least_squares

D, O = sys.argv[1], sys.argv[2]; os.makedirs(os.path.join(O, 'chk'), exist_ok=True)
reg = json.load(open(os.path.join(D, 'regions.json')))['upper']; CELLS = reg['cells']
ATL = np.asarray(Image.open(os.path.join(D, 'atlas_upper.png')).convert('RGBA')).astype(np.float32)
W = ATL.shape[1]; CH = ATL.shape[0] // len(CELLS); assert CH * len(CELLS) == ATL.shape[0]
GAZE_H = float(os.environ.get('GAZE_H', 0.10))      # how far the iris passes the opening's side edge, share of iris width
GAZE_V = float(os.environ.get('GAZE_V', 0.08))      # same for the lower edge, share of iris height
TOP_PX = int(os.environ.get('TOP_BAND_PX', 8))       # band under the lash where the ball uses the built iris (see below)
WINKS = {'blinkLeft': 'L', 'blinkRight': 'R'}       # cell -> side that stays open (L = image left)
# chara3 v2: lid shadow on its own layer. In these cells the drawing darkens the iris right under the lid (relaxed:
# its upper ~70 px); on the ball that darkening moved down with the iris when looking down. It goes to
# OUT_DIR/shade.png instead (black with alpha a(y), a fixed layer between the lid and the ball, same atlas layout as
# the lid), and the ball gets the drawing un-darkened (drawn / (1 - a)), so with the gaze straight ahead
# ball * (1 - a) is the drawing again.
SHADE_CELLS = [c for c in os.environ.get('SHADE_CELLS', 'relaxed').split(',') if c]
SHADE_PX = int(os.environ.get('SHADE_PX', 70)); SHADE_MAX = float(os.environ.get('SHADE_MAX', 0.75))
# chara3 v2: cells whose gaze moves less. The ball holds such a cell a second time, stretched by s in a row below the
# normal cells; that expression shows it through a texture-transform scale of s, so the same lookAt UV offset
# moves its iris by 1/s (surprised: the iris is small in a narrow white ring and was cut at the ring's edge).
SCALED = {k: float(v) for k, v in (x.split(':') for x in os.environ.get('SCALED_CELLS', 'surprised:2.0').split(',') if x)}
# IRIS_COLOR (olive, default | red): colour classes of the drawn iris and lash in classes() (chara1: red irises)
IRIS_COLOR = os.environ.get('IRIS_COLOR', 'olive')
# HOLE_MASK: the eye openings given as a picture in upper-cell px (white = iris and white of the eye), made by asking
# the image generator to paint the eyeballs of the neutral drawing green (chara4: dark maroon lashes and the dark top
# of the rose iris have the same colour, so the colour classes put the lashes into the opening)
HOLE = np.asarray(Image.open(os.environ['HOLE_MASK']).convert('L')) > 127 if os.environ.get('HOLE_MASK') else None
yy, xx = np.mgrid[0:CH, 0:W]


def classes(c):
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    iris = (2 * g - r - b > 5) & (r > 20) & (r < 215) & (b < 85)          # olive: g above the r/b mean (lash brown is below), blue low (the cream highlight rims are not)
    white = (np.minimum(np.minimum(r, g), b) > 165) & (r - b < 62)
    skinlike = (r > 185) & (r - b > 55)                                   # the highlights took the model skin in atlas.py
    lash = (r < 150) & (r - g > 15) & (g - b < 25)                         # dark brown: the lower iris has r - g > 15 too but g - b > 50
    if IRIS_COLOR == 'red':                                               # chara1: crimson-to-rose iris, near-black lash
        iris = (r - g > 65) & (r > 90) & (b > g - 8)                      # iris g - b -9..8; brows (130, 70, 60) and shaded skin g - b >= 10
        skinlike = (r > 185) & (r - b > 40) & (g > 170)                   # the rose lower iris has r - b > 55 too, but g ~ 125
        lash = (r < 110) & (r - g < 45) & (b < g + 5) & (r + g + b > 30)  # the dark iris top (108, 36, 49) has r - g > 70; not the empty black
    # only the lash lines themselves: small dark-brown bits on the iris rim are not lash (they made the band under
    # the lash cut the top of the surprised iris)
    lab, k = ndimage.label(lash); sz = ndimage.sum(lash, lab, range(1, k + 1))
    lash = np.isin(lab, 1 + np.nonzero(sz >= 1500)[0])
    return iris, white, skinlike, lash


def fill(img, good, sig):
    # colours of the good pixels spread into the others (normalised convolution, fine to coarse)
    out = img.copy(); g = good.astype(np.float32); done = good.copy()
    for s in sig:
        w = ndimage.gaussian_filter(g, s)
        f = np.stack([ndimage.gaussian_filter(img[..., k] * g, s) for k in range(3)], -1) / (w[..., None] + 1e-6)
        new = (w > 0.02) & ~done; out[new] = f[new]; done |= new
    return out, done


def ell_r(p, x, y):
    cx, cy, a, b, th = p; c, s = np.cos(th), np.sin(th); u = (x - cx) * c + (y - cy) * s; v = -(x - cx) * s + (y - cy) * c
    return np.sqrt((u / a) ** 2 + (v / b) ** 2)


def boundary_pts(irisf, lash, skinlike=None):
    # oval edge samples: the iris rim where it meets the white or the skin below; not next to the lash, and in the
    # upper half not next to skin-coloured pixels (a highlight cut open by the lash, angry)
    edge = irisf & ~ndimage.binary_erosion(irisf)
    near_lash = ndimage.binary_dilation(lash, iterations=5)
    ys_ = np.nonzero(irisf)[0]; upper = yy < (ys_.min() + ys_.max()) / 2
    near_hl = (ndimage.binary_dilation(skinlike, iterations=3) & upper) if skinlike is not None else np.zeros_like(irisf)
    y, x = np.nonzero(edge & ~near_lash & ~near_hl); return x.astype(float), y.astype(float)


def fit(x, y, p0, shape=None):
    # shape = (a0, b0, th0): only the centre and a common scale are fitted (lids hide much of some irises)
    if shape is None:
        f = lambda q: (ell_r(q, x, y) - 1) * np.sqrt(q[2] * q[3]); q0 = p0
    else:
        a0, b0, th0 = shape; f = lambda q: (ell_r((q[0], q[1], a0 * q[2], b0 * q[2], th0), x, y) - 1) * np.sqrt(a0 * b0) * q[2]; q0 = [p0[0], p0[1], 1.0]
    q = least_squares(f, q0, loss='soft_l1', f_scale=1.5).x
    p = tuple(q) if shape is None else (q[0], q[1], shape[0] * q[2], shape[1] * q[2], shape[2])
    res = np.abs(ell_r(p, x, y) - 1) * np.sqrt(p[2] * p[3])
    return p, float(np.median(res)), float(np.percentile(res, 90))


def eye_R(c, half, sk, flip=False):
    # the image-right eye of a cell. Opening = iris and white among the drawn strokes (where the cell differs from
    # the model skin that atlas.py laid them on), not lash; the highlights, which atlas.py left as model skin, are
    # closed in by filling holes. Colour classes alone missed the grey inner rim of the surprised white ring, and
    # the ball then showed a second iris edge there once the iris moved.
    iris, white, skinlike, lash = classes(c)
    stroke = np.abs(c - sk).max(-1) > 10
    # whiteness from r - g (skin ~48, the white ~17) over the drawn strokes, smoothed: the white's soft fade into
    # the skin is split at its middle by a smooth line (a hard r - g threshold cut it into blobs that moved with
    # the eye as pale drops)
    wmap = np.clip((50 - (c[..., 0] - c[..., 1])) / 20, 0, 1) * stroke      # the faint outer part of the surprised ring too
    hm = np.where(lash, 0, np.maximum(iris.astype(np.float32), wmap)) * half
    cand = ndimage.gaussian_filter(hm, 3.0) > 0.5
    lab, k = ndimage.label(cand); sz = ndimage.sum(np.ones_like(lab), lab, range(1, k + 1))
    if HOLE is not None:
        raw = (HOLE[:, ::-1] if flip else HOLE) & half
        if raw.sum() < 3000: return None
    else:
        if k == 0: return None
        j = 1 + int(np.argmax(sz))
        if (iris & (lab == j)).sum() < 3000: return None
        raw = ndimage.binary_fill_holes(lab == j)
    # small skin-coloured chips on the opening's edge, mostly bordered by it (a gap in the drawn iris rim at its
    # bottom), belong to the opening: on the lid they stood out as a pale bump once the iris moved
    lab2, k2 = ndimage.label(skinlike & ~raw & half & ndimage.binary_dilation(raw, iterations=12))
    for j2 in range(1, k2 + 1):
        m = lab2 == j2; ring = ndimage.binary_dilation(m, iterations=2) & ~m
        if m.sum() < 600 and raw[ring].mean() > 0.5: raw |= m
    # smooth outline: notches and waves of a few px showed on the iris edge (and as specks) once it moved under the
    # lid. The drawn iris (and its dark rim) stays wholly inside: iris pixels left on the lid stayed behind as dark
    # specks when the iris moved away.
    hole0 = ndimage.gaussian_filter(raw.astype(np.float32), 5.0) > 0.5
    hole0 = ndimage.binary_fill_holes(hole0 | ndimage.binary_dilation(raw & (iris | (c.mean(-1) < 120)) & ~lash, iterations=1))
    # close small bays the union leaves in the outline (a few-texel lid bump showed below the iris looking up)
    yy_, xx_ = np.mgrid[-4:5, -4:5]
    hole0 = ndimage.binary_fill_holes(ndimage.binary_closing(hole0, structure=xx_ ** 2 + yy_ ** 2 <= 16) & ~lash)
    irisf = ndimage.binary_fill_holes(iris & hole0) | (iris & hole0)
    return dict(hole0=hole0, iris=iris & hole0, irisf=irisf, white=white & hole0, skinlike=skinlike, lash=lash)


bx0, by0, bx1, by1 = reg['bbox']
SKIN = np.asarray(Image.open(os.path.join(D, 'skin.png')).convert('RGB')).astype(np.float32)[by0:by1, bx0:bx1]
half_R = xx > W / 2
cells = {n: ATL[i * CH:(i + 1) * CH] for i, n in enumerate(CELLS)}
ER = {n: eye_R(cells[n][..., :3], half_R, SKIN) for n in CELLS if n not in WINKS}
OPEN = [n for n in CELLS if n not in WINKS and ER[n] is not None]
print('OPEN cells', OPEN, 'closed', [n for n in CELLS if n not in WINKS and ER[n] is None])
assert OPEN[0] == 'neutral'
# mirror axis of atlas.py (cell px): from the neutral openings of both eyes
iris_L = eye_R(cells['neutral'][..., :3][:, ::-1], half_R, SKIN[:, ::-1], flip=True)                 # the image-left eye seen mirrored
xl = W - 1 - np.nonzero(iris_L['hole0'])[1]; xr = np.nonzero(ER['neutral']['hole0'])[1]
AX2 = int(round(xl.min() + xr.max()))
if abs(AX2 - int(round(xl.max() + xr.min()))) > int(os.environ.get('MIRROR_TOL', 2)):
    # chara4: the white of the image-left eye leaked towards the cell edge (39 px from it), so the openings differ;
    # the irises are the mirrored strokes themselves and give the axis
    print('openings not symmetric', xl.min(), xl.max(), xr.min(), xr.max(), '- axis from the irises')
    xl = W - 1 - np.nonzero(iris_L['irisf'])[1]; xr = np.nonzero(ER['neutral']['irisf'])[1]
    AX2 = int(round(xl.min() + xr.max()))
# an atlas made from the drawing as it is (atlas.py ATLAS_RAW=1, not --mirror) has eyes a few px off mirror image:
# MIRROR_TOL allows that, and the axis is then the mean of the outer and inner estimates
TOL = int(os.environ.get('MIRROR_TOL', 2)); AX2b = int(round(xl.max() + xr.min()))
assert abs(AX2 - AX2b) <= TOL, f'atlas eyes not mirrored ({AX2} vs {AX2b}; MIRROR_TOL={TOL})'
AX2 = int(round((AX2 + AX2b) / 2))
def mirror(img): src = np.clip(AX2 - np.arange(W), 0, W - 1); return img[:, src]
print('MIRROR x\' = %d - x' % AX2)

# ---- iris ovals: neutral free, the others with the neutral shape (centre + scale)
n0 = ER['neutral']; x, y = boundary_pts(n0['irisf'], n0['lash'])          # neutral: no highlight touches the lash
ys, xs = np.nonzero(n0['irisf']); p0 = (xs.mean(), ys.mean(), (xs.max() - xs.min()) / 2, (ys.max() - ys.min()) / 2, 0.0)
PN, med, p90 = fit(x, y, p0); print('ELLIPSE neutral', np.round(PN, 3).tolist(), 'residual med/p90 px', round(med, 2), round(p90, 2))
P = {'neutral': PN}
for n in OPEN[1:]:
    e = ER[n]; x, y = boundary_pts(e['irisf'], e['lash'], e['skinlike']); ys, xs = np.nonzero(e['irisf'])
    P[n], med, p90 = fit(x, y, (xs.mean(), ys.mean()), shape=PN[2:])
    print('ELLIPSE', n, np.round(P[n], 3).tolist(), 'residual med/p90 px', round(med, 2), round(p90, 2), 'points', len(x))

# ---- neutral full iris (R): drawn iris pixels, the part under the lash filled from them
def oval_alpha(p): return np.clip((1 - ell_r(p, xx, yy)) * np.sqrt(p[2] * p[3]) + 0.5, 0, 1)
def build(n):
    c = cells[n][..., :3]; e = ER[n]; p = P[n]; Ea = oval_alpha(p); E = Ea > 0.5
    known = e['iris'] & ndimage.binary_erosion(E, iterations=2)              # drawn iris, not its anti-aliased rim
    # highlights: small pale blobs (skin-coloured core, cream rim) inside the oval that are mostly bordered by iris
    # (the lid skin of relaxed / sad inside the oval is large and bordered by lash and skin)
    pale = (c[..., 2] > 90) & ~e['iris']                                    # the iris never has blue above ~70
    cand = ndimage.binary_opening(ndimage.binary_erosion(E, iterations=10) & pale, iterations=1)   # 10 px in: a skin chip on the rim is no highlight
    lab, k = ndimage.label(cand); hl = np.zeros_like(cand)
    for j in range(1, k + 1):
        m = lab == j; ring = ndimage.binary_dilation(m, iterations=3) & ~m
        if m.sum() < 2500 and e['iris'][ring].mean() > 0.4: hl |= m
    # the iris colours come from drawn iris pixels away from the oval rim and from the highlights' faint outer ring
    # (its darker pixels pass as iris and left a ghost ring on the mirrored eye)
    known = known & ~ndimage.binary_dilation(hl, iterations=6)
    # ... and from below the band under the lash (its dark lash / iris mix moved with the iris as a dark line)
    known = known & ~ndimage.binary_dilation(e['lash'], iterations=TOP_PX)
    if n == 'neutral':
        iris_img, _ = fill(c, known, [2, 5, 12, 30, 80])
    else:
        # under this cell's lid: the neutral full iris moved / scaled onto this oval
        s = p[2] / PN[2]; sx = PN[0] + (xx - p[0]) / s; sy = PN[1] + (yy - p[1]) / s
        nb = np.stack([ndimage.map_coordinates(NEUTRAL_IRIS[..., k], [sy, sx], order=1, mode='nearest') for k in range(3)], -1)
        # this cell's own colours carried ~40 px past what is drawn, then the neutral iris (relaxed: the drawn
        # colour under the lid is mid-iris, the neutral there is the dark top; a short blend showed a band)
        own, _ = fill(c, known, [2, 5, 12, 30, 60])
        w = np.clip(ndimage.gaussian_filter(known.astype(np.float32), 25) * 3, 0, 1)[..., None]
        iris_img = np.where(known[..., None], c, own * w + nb * (1 - w))
    # white: the drawn white of the opening (not its pale-skin outer gradient) spread outwards
    r_, b_ = c[..., 0], c[..., 2]
    wm = e['white'] & (r_ - b_ < 45) & ndimage.binary_erosion(e['hole0'], iterations=1)
    wc = np.median(c[wm], 0) if wm.sum() > 50 else np.array([240, 228, 220.])
    white, done = fill(c, wm, [3, 8, 20]); white[~done] = wc
    return dict(Ea=Ea, E=E, hl=hl, iris=iris_img, white=white, wc=wc)

B = {}
NEUTRAL_IRIS = None
for n in OPEN:
    B[n] = build(n)
    if n == 'neutral': NEUTRAL_IRIS = B[n]['iris']

def compose(n):
    # white + iris without highlights. Iris coverage = the oval, plus a band just outside the opening where the
    # nearest opening pixel is iris (the drawn iris rim and the oval differ by a few px near the lash)
    b = B[n]; e = ER[n]; h = e['hole0'] | b['hl']
    dist, (iy_, ix_) = ndimage.distance_transform_edt(~h, return_indices=True)
    # kept within 3 px of the oval: further out it copied the lash flicks' notches as bumps on the iris edge
    ext = (dist < 6) & (e['iris'] | b['hl'])[iy_, ix_] & ndimage.binary_dilation(b['E'], iterations=3)
    a = np.maximum(b['Ea'], np.clip(ndimage.gaussian_filter(ext.astype(np.float32), 1.5) * 2 - 0.5, 0, 1))[..., None]
    return b['white'] * (1 - a) + b['iris'] * a

# ---- ball cells and lid holes
# image-right eye: the drawing inside the opening (2 px in from its edge, feathered over 1 px) over the built eye,
# so with the gaze straight ahead the face shows the drawing; the opening's own edge pixels are built, not drawn
# (they mix in the lash / skin colour and showed as a ragged line once the iris moved)
ball_cells = []; holes = {}; info = {}; shade_R = {}
for n in OPEN:
    b = B[n]; e = ER[n]; c = cells[n][..., :3]
    hole_R = e['hole0'] | (b['hl'] & ndimage.binary_erosion(b['E'], iterations=3))     # highlights touching the lash
    hole_R = ndimage.binary_fill_holes(hole_R) & half_R
    hl_full = ndimage.binary_dilation(b['hl'], iterations=2) & b['E']                  # with their soft rim
    base = compose(n)
    # The band right under the lash takes the built iris too: the drawings darken the iris top there (lid shadow,
    # strong in relaxed) and on the ball it moved down with the iris as a dark line. Keeping that band on the lid
    # instead left iris-coloured specks along the lash once the iris moved away.
    inner = ndimage.binary_erosion(hole_R, iterations=2) & ~ndimage.binary_dilation(e['lash'], iterations=TOP_PX)
    top = ndimage.binary_dilation(e['lash'], iterations=TOP_PX + 6) & hole_R                 # wider blend into the band
    f = np.clip(ndimage.gaussian_filter(inner.astype(np.float32), 1.0) * 1.5, 0, 1)
    f_top = np.clip(ndimage.gaussian_filter(inner.astype(np.float32), 4.0) * 1.2, 0, 1)
    f = np.where(top, np.minimum(f, f_top), f)
    f = np.maximum(f, hl_full)[..., None]
    # skin-coloured bits inside the opening that are not highlights (a small gap in the drawn iris rim at its
    # bottom) take the built eye: on the ball they floated under the iris as a pale chip once it moved up
    chip = hole_R & e['skinlike'] & ~ndimage.binary_dilation(b['hl'], iterations=4)
    f = np.where(ndimage.binary_dilation(chip, iterations=2)[..., None], 0, f)
    ballR = base * (1 - f) + c * f
    if n in SHADE_CELLS:
        # a(y) from the iris brightness per row: rows of the opening from its top, darkness relative to the row
        # SHADE_PX below the top; the same a across the row (a lid shadow, not tied to the iris rim)
        ys_h = np.nonzero(hole_R.any(1))[0]; top = ys_h.min(); cxp, _, ap = P[n][:3]
        lum = c.mean(-1); prof = np.zeros(CH)                      # the drawing's own darkening
        for y in range(top, min(top + SHADE_PX + 1, CH)):
            xs_ = np.nonzero(hole_R[y] & (np.abs(xx[y] - cxp) < 0.6 * ap))[0]
            prof[y] = lum[y, xs_].mean() if len(xs_) else 0
        ref = prof[top + SHADE_PX]; a_row = np.zeros(CH)
        a_row[top:top + SHADE_PX] = np.clip(1 - prof[top:top + SHADE_PX] / ref, 0, SHADE_MAX)
        a_row[:top] = a_row[top]                                   # under the lash band: as dark as its first row
        a_row = ndimage.gaussian_filter1d(a_row, 2.0)
        cols = ndimage.binary_dilation(hole_R.any(0), iterations=12)
        A = np.where(cols[None, :] & (yy < top + SHADE_PX + 6), a_row[:, None], 0.0) * half_R
        ballR = np.clip(ballR / (1 - A[..., None]), 0, 255)
        # above the first rows that are drawn in full (under the lash band and the lid), the ball continues the
        # un-darkened iris straight up inside its oval: the band's built iris left a dark seam that came into view
        # below the lid when looking down
        y0 = top + TOP_PX + 6; wv = np.clip((y0 - yy) / 6.0, 0, 1)[..., None] * half_R[..., None]
        ext = np.broadcast_to(ballR[y0][None], ballR.shape)
        up = ext * B[n]['Ea'][..., None] + B[n]['white'] * (1 - B[n]['Ea'][..., None])
        ballR = ballR * (1 - wv) + up * wv
        shade_R[n] = A
        print('SHADE', n, 'top row', int(top), 'ref lum', round(float(ref), 1), 'a at top', round(float(a_row[top]), 3), 'max', round(float(a_row.max()), 3))
    # Just outside the opening the ball repeats the colour at the opening's edge for a few px, then fades into the
    # built eye: texture filtering (mipmaps) reads past the edge, and the built iris there darkened the thin white
    # ring of surprised into a hard dark iris edge in three-vrm.
    dist, (iy_, ix_) = ndimage.distance_transform_edt(~hole_R, return_indices=True)
    wn = np.clip((5 - dist) / 2, 0, 1) * (dist > 0)                                # 3 px, fading out by 5 (longer smeared the edge)
    wn = (wn * (ballR[iy_, ix_].mean(-1) > 150))[..., None]                         # only light edges: a dark iris rim smeared below the iris
    ballR = np.where((dist > 0)[..., None], ballR[iy_, ix_] * wn + ballR * (1 - wn), ballR)
    hl_wide = ndimage.binary_dilation(b['hl'], iterations=6) & b['E']                   # their faint outer ring too
    clean = np.where(hl_wide[..., None], base, ballR)                                   # the eye without highlights
    ball = np.where(half_R[..., None], ballR, mirror(clean))
    # highlights of the image-right eye copied (not mirrored) onto the image-left eye
    # The mirrored oval leans the other way, so a highlight near the iris edge can stick out of it: each one is
    # moved towards the eye centre until it lies inside the image-left oval (surprised: the big one was cut).
    cxR = P[n][0]; dX = int(round(2 * cxR - AX2)); inR = ndimage.binary_erosion(e['irisf'] | (b['E'] & ~hole_R), iterations=3)   # drawn iris; the oval under the lid
    EL = mirror(inR[..., None].astype(np.uint8))[..., 0] > 0
    lab_h, kh = ndimage.label(hl_full); moved = []
    for j in range(1, kh + 1):
        hy, hx = np.nonzero(lab_h == j); sx = int(np.sign(AX2 / 2 - (hx.mean() - dX))) or 1   # towards the L eye centre
        fits = [x_ for x_ in range(0, 31) if EL[hy, hx - dX + sx * x_].mean() > 0.98]
        extra = fits[0] if fits else 0
        ball[hy, hx - dX + sx * extra] = ballR[hy, hx]; moved.append(extra if fits else None)
    hole = hole_R | mirror(hole_R[..., None].astype(np.uint8))[..., 0].astype(bool)
    holes[n] = hole; ball_cells.append(ball)
    info[n] = {'ellipse': [round(float(v), 3) for v in P[n]], 'hole_px': int(hole.sum()), 'highlight_px': int(b['hl'].sum()),
               'highlight_shift_x': -dX, 'highlight_nudge_px': moved, 'white': [round(float(v)) for v in b['wc']]}
for n, side in WINKS.items():
    h = holes['neutral'] & ((xx < W / 2) if side == 'L' else half_R); holes[n] = h
for n in CELLS: holes.setdefault(n, np.zeros((CH, W), bool))

lid = ATL.copy()
for i, n in enumerate(CELLS):
    # alpha 0 in the openings; their RGB takes the nearest lid pixel's colour, so texture filtering at the edge
    # does not mix the drawn iris into the lid (a dark fringe stayed on the lid edge once the iris moved away)
    cl = lid[i * CH:(i + 1) * CH]; h = holes[n]
    if h.any():
        _, (iy_, ix_) = ndimage.distance_transform_edt(h, return_indices=True); cl[..., :3] = cl[iy_, ix_, :3]
    cl[..., 3] = np.where(h, 0, 255)
Image.fromarray(lid.clip(0, 255).astype(np.uint8), 'RGBA').save(os.path.join(O, 'lid_upper.png'))
shade = np.zeros(ATL.shape, np.float32)
for n, A in shade_R.items():
    i = CELLS.index(n); full = np.maximum(A, mirror(A[..., None])[..., 0])
    shade[i * CH:(i + 1) * CH, :, 3] = full * 255
Image.fromarray(shade.clip(0, 255).astype(np.uint8), 'RGBA').save(os.path.join(O, 'shade.png'))
ball_img = np.concatenate(ball_cells, 1)
# stretched copies (SCALED): row 1 of the ball, below the normal cells
scaled = {}
if SCALED:
    NBW = ball_img.shape[1]
    anyh = np.zeros((CH, W), bool)
    for n_ in holes: anyh |= holes[n_]
    big0 = ndimage.binary_dilation(anyh, iterations=60)              # the openings plus any gaze shift
    ysb, xsb = np.nonzero(big0); bx0_, bx1_, by0_, by1_ = xsb.min(), xsb.max() + 1, ysb.min(), ysb.max() + 1
    ox = 4
    H1 = int(np.ceil(max(SCALED.values()) * (by1_ - by0_))) + 8
    row1 = np.zeros((H1, NBW, 3), np.float32) + np.array(B['neutral']['wc'], np.float32)
    for n_, sc_ in SCALED.items():
        src = ball_cells[OPEN.index(n_)]; Ox = ox - sc_ * bx0_; Oy = CH + 4 - sc_ * by0_
        wpx = int(np.ceil(sc_ * (bx1_ - bx0_))); assert ox + wpx <= NBW, 'stretched cell does not fit'
        Y, X = np.mgrid[CH:CH + H1, ox:ox + wpx]
        sy = (Y - Oy) / sc_; sx = (X - Ox) / sc_
        row1[:, ox:ox + wpx] = np.stack([ndimage.map_coordinates(src[..., k], [sy, sx], order=1, mode='nearest') for k in range(3)], -1)
        scaled[n_] = {'scale': sc_, 'offset_px': [float(Ox), float(Oy)]}
        print('SCALED', n_, 'scale', sc_, 'offset px', round(Ox, 1), round(Oy, 1), 'region', ox, ox + wpx, 'rows', CH, CH + H1)
        ox += wpx + 8
    ball_img = np.concatenate([ball_img, row1], 0)
Image.fromarray(ball_img.clip(0, 255).astype(np.uint8), 'RGB').save(os.path.join(O, 'ball.png'))

# ---- gaze range from the neutral image-right eye: at full gaze the iris passes the opening edge by GAZE_H / GAZE_V
cx, cy, a, b_, th = PN; E = B['neutral']['E']; h0 = holes['neutral'] & half_R
row = int(round(cy)); hx = np.nonzero(h0[row])[0]; ix = np.nonzero(E[row])[0]
m_in, m_out = ix.min() - hx.min(), hx.max() - ix.max()
col = int(round(cx)); hyv = np.nonzero(h0[:, col])[0]; iy = np.nonzero(E[:, col])[0]
m_bot = hyv.max() - iy.max(); iw, ih = ix.max() - ix.min(), iy.max() - iy.min()
# GAZE_SIDE=inner: the shift follows the narrower white on the nose side, so an iris moving inwards is not half
# hidden by the inner corner (chara4: 25 px inside vs 80 px outside, the mean let 1/4 of the iris pass the corner)
m_side = m_in if os.environ.get('GAZE_SIDE') == 'inner' else (m_in + m_out) / 2
du = m_side + GAZE_H * iw; dv = max(m_bot, 0) + GAZE_V * ih
print('GAZE margins in/out/bottom px', m_in, m_out, m_bot, 'iris w/h', iw, ih, '-> shift px', round(du, 1), round(dv, 1))

# ---- eye boxes (cell px) that the ball triangles must cover: every opening grown by the gaze shift
anyhole = np.zeros((CH, W), bool)
for n in CELLS: anyhole |= holes[n]
grow = int(np.ceil(max(du, dv))) + 12; big = ndimage.binary_dilation(anyhole, iterations=grow)
lab, k = ndimage.label(big)
boxes = [[int(sl[1].start), int(sl[0].start), int(sl[1].stop), int(sl[0].stop)] for sl in ndimage.find_objects(lab)]   # x0 y0 x1 y1
json.dump({'cells': CELLS, 'ball_cells': OPEN, 'cell_px': [W, CH], 'mirror_ax2': AX2, 'gaze_px': [round(du, 2), round(dv, 2)],
           'gaze_share': [GAZE_H, GAZE_V], 'eye_boxes': boxes, 'info': info, 'ball_h': int(ball_img.shape[0]), 'scaled': scaled,
           'shade_cells': sorted(shade_R),
           'margins': {'inner': int(m_in), 'outer': int(m_out), 'bottom': int(m_bot), 'iris_w': int(iw), 'iris_h': int(ih)}},
          open(os.path.join(O, 'gaze.json'), 'w'), indent=1)
print('EYE boxes', boxes, 'BALL', ball_img.shape, 'cells', OPEN)

# ---- 2D check: lid over the shifted ball, per cell and gaze (texture space, no lighting)
def shifted(img, dx, dy):
    return ndimage.shift(img, (dy, dx, 0), order=1, mode='nearest')
cell_of = {n: (n if n in OPEN else 'neutral') for n in CELLS}
def shade_of(n):
    i = CELLS.index(n); return shade[i * CH:(i + 1) * CH, :, 3:] / 255
rows = []
for n in CELLS:
    ball = ball_cells[OPEN.index(cell_of[n])]; tiles = []; k_ = SCALED.get(cell_of[n], 1.0)
    for gx, gy in ((0, 0), (-du, 0), (du, 0), (0, -dv), (0, dv)):
        bs = shifted(ball, gx / k_, gy / k_) * (1 - shade_of(n)); a = (lid[CELLS.index(n) * CH:(CELLS.index(n) + 1) * CH, :, 3:] / 255)
        comp = cells[n][..., :3] * a + bs * (1 - a)
        tiles.append(Image.fromarray(comp[230:720].clip(0, 255).astype(np.uint8)).resize((W // 3, 490 // 3)))
    rows.append(tiles)
tw, th_ = rows[0][0].size; sheet = Image.new('RGB', (tw * 5, th_ * len(rows)))
for i, r in enumerate(rows):
    for j, t in enumerate(r): sheet.paste(t, (j * tw, i * th_))
sheet.save(os.path.join(O, 'chk', 'paint_gaze.png'))
d0 = [float(np.abs(np.where(holes[n][..., None], ball_cells[OPEN.index(cell_of[n])] * (1 - shade_of(n)), cells[n][..., :3]) - cells[n][..., :3])[holes[n] & half_R].mean()) if (holes[n] & half_R).any() else 0.0 for n in CELLS]
print('GAZE0 mean abs diff to the atlas inside the image-right openings', dict(zip(CELLS, [round(v, 2) for v in d0])))
