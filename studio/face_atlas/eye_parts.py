# Anime eyes as separate meshes (VRoid style) instead of eyes painted on the face texture.
# Order: prep -> (optional) skin_tone.py uvdump + recolor into OUT_DIR/skin -> build -> render -> compose
#   prep:   python eye_parts.py prep OUT_DIR FACE_DIR DRAW_DIR
#           FACE_DIR: cam.json / skin.png (render_front.py), align.json (align.py), irises.json (iris_concave.py),
#           regions.json + atlas_mouth.png (face_vrm.py select + atlas.py). DRAW_DIR: neutral.png, blink.png, happy.png.
#           Writes OUT_DIR/eyes.json (shapes in render pixels of the front camera), the eye textures and
#           face_upper.png (the face paint of the upper face: brows, nose, blush, with the eyes removed) + prep.png.
#   build:  blender -b --factory-startup --python eye_parts.py -- build KIT character.blend OUT_DIR FACE_DIR ref.vrm out.vrm
#           env EYE_YAW   deg the eye plane turns outward from the front (default 12)
#               EYE_RECESS mm the eye sits behind the rim of the opening (default 3)
#               EYE_PUSH  1 (default): push the face back (never forward) around the opening so the socket is
#                         EYE_RECESS deep all round; 0: leave the face as it is (then EYE_YAW must be near the
#                         face's own ~40 deg, or the inner rim becomes a deep pit)
#               EYE_GAZE  uv (default): the iris is a texture on a sheet behind the opening, scrolled by VRM lookAt
#                         expressions (lookLeft/Right/Up/Down, texture transform offsets); bone: an iris mesh on
#                         eye.L / eye.R moved to its sphere centre (VRM bone lookAt)
#               EYE_RADIUS (iris sphere radius, default 0.15 m), EYE_D1 / EYE_D2 / EYE_DMAX, EYE_SUBDIV
#           Uses OUT_DIR/skin/*.png (skin_tone.py) for the head / body / face paint / mouth textures when present.
#   render: blender -b out.blend --python eye_parts.py -- render OUT_DIR OBLIQUE.py   (OUT/obl yaw 0-65, OUT/expr)
#   compose: python eye_parts.py compose OUT_DIR       (OUT/obl/all.png, OUT/expr.png, OUT/gaze.png)
# Geometry, per eye: a flat eye plane facing EYE_YAW outward, tilted up/down like the face, EYE_RECESS behind the face
# at the deepest point of the opening's rim. The face around the opening is pushed back onto (plane - EYE_RECESS)
# (only depth changes, so the front view is unchanged; the hair in front gets the same shift), and the opening is cut
# out of the face. Inside the socket: eye white (sphere cap, lines the back of the skin past the rim so no hole shows
# from the side), iris (uv: textured sheet 1 mm behind the plane; bone: sphere cap turning on the eye bone), eyelids
# (skin, just behind the face; a thin band under the skin until blink / happy stretch them over the opening at the
# face's own surface). In front of the face (0.5 mm): one lash strip per eye whose texture has a cell per drawing
# (neutral: upper lash and lower line; blink, happy: the drawn closed lash). blink / happy = eyelid shape keys + lash
# cell shift (binary). Every part is laid so that its front projection is exactly the drawing (UV = front projection).
import sys, os, json, math


def cam_proj(cam):
    S = cam['size']; k = S / cam['ortho_scale']; cx, cz = cam['center']
    to_px = lambda x, z: ((x - cx) * k + S / 2, S / 2 - (z - cz) * k)
    to_w = lambda px, py: ((px - S / 2) / k + cx, cz - (py - S / 2) / k)
    return to_px, to_w, k


# ----------------------------------------------------------------------------------------------------------- prep
def prep(OUT, FACE, DRAW):
    import numpy as np
    from PIL import Image, ImageDraw
    from scipy import ndimage
    os.makedirs(OUT, exist_ok=True)
    cam = json.load(open(os.path.join(FACE, 'cam.json'))); S = cam['size']
    al = json.load(open(os.path.join(FACE, 'align.json'))); reg = json.load(open(os.path.join(FACE, 'regions.json')))
    irs = sorted(json.load(open(os.path.join(FACE, 'irises.json')))['irises'], key=lambda e: e['center'][0])
    skin = np.asarray(Image.open(os.path.join(FACE, 'skin.png')).convert('RGBA')).astype(np.float32)

    def warp(name):
        s, tx, ty = al['neutral']                    # the drawings are edits of neutral on the same canvas
        I = Image.open(os.path.join(DRAW, name + '.png')).convert('RGBA'); I = I.resize((int(I.size[0] * s), int(I.size[1] * s)), Image.LANCZOS)
        c = Image.new('RGBA', (S, S)); c.paste(I, (int(round(tx)), int(round(ty)))); return np.asarray(c).astype(np.float32)
    D = {n: warp(n) for n in ('neutral', 'blink', 'happy')}

    def chans(a):
        r, g, b, al_ = a[..., 0], a[..., 1], a[..., 2], a[..., 3]; return r, g, b, al_, (r + g + b) / 3

    def lash_mask(a, e):
        # the lash: dark and brown (the iris rim is dark too but blue-grey; the drawn hair outline is cut off by an
        # opening of 7 px, then the lash grows back through dark pixels for 10 px to recover the thin flicks)
        r, g, b, al_, lum = chans(a); L = (lum < 150) & (r - b > 8) & (al_ > 128)
        cx, cy = e['center']; rx, ry = e['rx'], e['ry']
        box = np.zeros_like(L); box[int(cy - 1.6 * ry):int(cy + 1.5 * ry), int(cx - 2.6 * rx):int(cx + 2.6 * rx)] = True
        op = ndimage.binary_opening(L & box, structure=np.ones((7, 7)))
        lab, n = ndimage.label(op); sz = ndimage.sum(np.ones_like(lum), lab, range(1, n + 1))
        main = lab == 1 + int(np.argmax(sz))
        for _ in range(10): main = ndimage.binary_dilation(main) & L
        return ndimage.binary_closing(main, structure=np.ones((9, 9))) | main

    def lower_edge(main, ylim):
        T = {}
        for x in np.nonzero(main.any(0))[0]:
            col = np.nonzero(main[:ylim, x])[0]
            if len(col): T[int(x)] = int(col.max())
        return T

    def smooth(xs, ys, med=21, sig=3.0):
        ys = ndimage.median_filter(np.asarray(ys, float), size=min(med, len(ys) | 1), mode='nearest')
        return ndimage.gaussian_filter1d(ys, sig, mode='nearest')

    def fit_ellipse(px, py):
        # Halir & Flusser direct least squares ellipse fit; returns centre, semi axes, angle (rad, of the first axis)
        x, y = px.astype(float), py.astype(float); mx, my = x.mean(), y.mean(); sc = max(x.std(), y.std()); x, y = (x - mx) / sc, (y - my) / sc
        D1 = np.stack([x * x, x * y, y * y], 1); D2 = np.stack([x, y, np.ones_like(x)], 1)
        S1, S2, S3 = D1.T @ D1, D1.T @ D2, D2.T @ D2; T = -np.linalg.solve(S3, S2.T); M = S1 + S2 @ T
        M = np.array([M[2] / 2, -M[1], M[0] / 2]); w, v = np.linalg.eig(M); v = np.real(v)
        cond = 4 * v[0] * v[2] - v[1] ** 2; a1 = v[:, np.nonzero(cond > 0)[0][0]]; A, B, C, Dd, E, F = np.concatenate([a1, T @ a1])
        den = B * B - 4 * A * C; x0 = (2 * C * Dd - B * E) / den; y0 = (2 * A * E - B * Dd) / den
        num = 2 * (A * E * E + C * Dd * Dd - B * Dd * E + den * F)
        s_ = math.sqrt((A - C) ** 2 + B * B); ax1 = -math.sqrt(num * (A + C + s_)) / den; ax2 = -math.sqrt(num * (A + C - s_)) / den
        th = 0.5 * math.atan2(-B, C - A)
        return [x0 * sc + mx, y0 * sc + my], float(ax1 * sc), float(ax2 * sc), float(th)

    n_ = D['neutral']; r, g, b, al_, lum = chans(n_)
    eyes = []; dbg = Image.fromarray(n_[..., :3].astype(np.uint8)); dr = ImageDraw.Draw(dbg)
    U_all = np.zeros(lum.shape, bool); excl = np.zeros(lum.shape, bool)
    CELLS = ('neutral', 'blink', 'happy'); A = {n: np.zeros(lum.shape, np.float32) for n in CELLS}
    iris_known = np.zeros(lum.shape, bool); white_known = np.zeros(lum.shape, bool); iris_alpha = np.zeros(lum.shape, np.float32)
    for idx, e in enumerate(irs):
        side = 'R' if e['center'][0] < S / 2 else 'L'            # image left = the character's right eye
        outer = -1 if side == 'R' else 1                           # image direction of the outer corner
        cx, cy = e['center']; rx, ry = e['rx'], e['ry']
        main = lash_mask(n_, e); T = lower_edge(main, int(cy + ry))
        xs = np.array(sorted(T)); ts = np.array([T[x] for x in xs], float)
        oside = (xs - cx) * outer > 0.3 * rx
        xo = int(xs[oside][np.argmax(ts[oside])]); yo = T[xo]
        xi = int(xs.max() if outer < 0 else xs.min()); yi = T[xi]
        # lower lid: the faint red lower lashes, fitted by a cubic through the corners and under the iris
        Lo = (r - g > 45) & (r - b > 45) & (lum < 230) & (al_ > 128)
        lo = []
        for x in range(min(xo, xi), max(xo, xi)):
            start = int(max(T.get(x, cy) + 5, cy + 0.3 * ry)); col = np.nonzero(Lo[start:int(cy + 1.5 * ry), x] & ~main[start:int(cy + 1.5 * ry), x])[0]
            if len(col): lo.append((x, start + col[0]))
        lo = np.array(lo, float); keep = np.ones(len(lo), bool)
        for _ in range(4):
            X = np.concatenate([lo[keep, 0], [xo] * 50, [xi] * 50, [cx] * 20]); Y = np.concatenate([lo[keep, 1], [yo] * 50, [yi] * 50, [cy + ry] * 20])
            c3 = np.polyfit(X, Y, 3); res = np.abs(np.polyval(c3, lo[:, 0]) - lo[:, 1]); keep = res < max(8, np.percentile(res, 70))
        # iris: the drawn iris colours inside the opening, holes (highlights) filled; ellipse fitted to its outline
        # where it is not under the lash
        ell0 = ((np.mgrid[0:S, 0:S][1] - cx) / (rx * 1.15)) ** 2 + ((np.mgrid[0:S, 0:S][0] - cy) / (ry * 1.15)) ** 2 < 1
        sat = n_[..., :3].max(-1) - n_[..., :3].min(-1)
        irisc = ((lum < 140) & (r - g < 15)) | ((g >= r) & (lum < 225) & (g - b > 15)) | ((g >= r - 5) & (sat > 25) & (lum < 240))
        I = ndimage.binary_fill_holes(ndimage.binary_opening(irisc & ell0 & ~main, iterations=2) | (ell0 & main & (lum < 150)))
        lab, nn = ndimage.label(I); I = lab == 1 + int(np.argmax(ndimage.sum(I, lab, range(1, nn + 1))))
        edge = I & ~ndimage.binary_erosion(I) & ~ndimage.binary_dilation(main, iterations=4)
        ey, ex = np.nonzero(edge); ec, ea, eb, eth = fit_ellipse(ex, ey)
        yy, xx = np.mgrid[0:S, 0:S]
        def ell_q(xx, yy, grow=1.0):
            dx, dy = xx - ec[0], yy - ec[1]; u = dx * math.cos(eth) + dy * math.sin(eth); v = -dx * math.sin(eth) + dy * math.cos(eth)
            return (u / (ea * grow)) ** 2 + (v / (eb * grow)) ** 2
        Ein = ell_q(xx, yy) <= 1
        # opening = between the lash's lower edge and the lower lid, plus the iris below the lash
        x_a, x_b = min(xo, xi), max(xo, xi)
        cols = np.arange(x_a, x_b + 1); top = smooth(cols, np.interp(cols, xs, ts))
        bot = np.polyval(c3, cols)
        poly = np.zeros(lum.shape, bool)
        for x, t_, b_ in zip(cols, top, bot):
            if b_ > t_: poly[int(round(t_)):int(round(b_)) + 1, x] = True
        top_full = np.interp(xx, cols, top, left=1e9, right=1e9)
        U = poly | (Ein & (yy > top_full))
        U = ndimage.binary_opening(U, iterations=2)
        lab, nn = ndimage.label(U); U = lab == 1 + int(np.argmax(ndimage.sum(U, lab, range(1, nn + 1))))
        ux = np.nonzero(U.any(0))[0]; cols = np.arange(ux.min(), ux.max() + 1)
        tops, bots = [], []
        for x in cols:
            ys_ = np.nonzero(U[:, x])[0]; tops.append(ys_.min()); bots.append(ys_.max() + 1)
        tops = ndimage.gaussian_filter1d(np.array(tops, float), 2, mode='nearest'); bots = ndimage.gaussian_filter1d(np.array(bots, float), 2, mode='nearest')
        U_all |= U
        # lash textures, one cell per drawing: the upper lash = darkness inside the lash mask (+4 px); neutral also gets
        # the lower line (the red lower lashes along the lower lid). blink / happy show their own (closed) lash cell.
        reg_up = ndimage.binary_dilation(main, iterations=4)
        # (holes inside the lash = drawn highlights on it: opaque, drawn colour)
        a_up = np.maximum(np.clip((225 - lum) / 105, 0, 1) * (b <= r + 8) * reg_up, ndimage.binary_fill_holes(main) & ~main)
        bot_full = np.interp(xx, cols, bots, left=np.nan, right=np.nan)
        a_lo = np.clip(((r - g) - 28) / 45, 0, 1) * np.clip((245 - lum) / 20, 0, 1) * (np.abs(yy - bot_full) < 16) * ~reg_up
        A['neutral'] = np.maximum(A['neutral'], np.maximum(a_up, a_lo))
        closed = {}
        for name in ('blink', 'happy'):
            # closed line = lower edge of the drawn closed lash: the eyelids close up to it
            mc = lash_mask(D[name], e); C = lower_edge(mc, int(cy + 1.5 * ry)); cx_ = np.array(sorted(C))
            closed[name] = {'x': cx_.tolist(), 'y': smooth(cx_, [C[x] for x in cx_], 15, 3).tolist()}
            rc, gc, bc, alc, lc = chans(D[name]); regc = ndimage.binary_dilation(mc, iterations=4)
            A[name] = np.maximum(A[name], np.maximum(np.clip((225 - lc) / 105, 0, 1) * (bc <= rc + 8) * regc, ndimage.binary_fill_holes(mc) & ~mc))
            excl |= ndimage.binary_dilation(regc, iterations=10)
        excl |= ndimage.binary_dilation(U | reg_up | (a_lo > 0.05), iterations=10)
        iris_known |= Ein & (ell_q(xx, yy) <= 0.97) & ~ndimage.binary_dilation(main, iterations=2)
        # iris layer for the UV-scroll gaze: the iris on a transparent background (1.5 px soft edge)
        iris_alpha = np.maximum(iris_alpha, np.clip((1 - np.sqrt(ell_q(xx, yy))) * min(ea, eb) / 1.5 + 0.5, 0, 1))
        # the white: light pixels only (the antialiased edge of the lash wing would be smeared outwards as dark streaks)
        white_known |= U & (ell_q(xx, yy) > 1.06) & ~ndimage.binary_dilation(main, iterations=3) & (a_lo < 0.2) & (lum > 170)
        eyes.append({'side': side, 'bone': 'eye.' + side, 'outer': outer,
                     'iris': {'center': [float(ec[0]), float(ec[1])], 'a': ea, 'b': eb, 'angle': eth},
                     'cols': cols.tolist(), 'top': tops.tolist(), 'bottom': bots.tolist(), 'closed': closed})
        print('EYE', side, 'corners outer', (xo, yo), 'inner', (xi, yi), 'columns', cols.min(), cols.max(),
              'iris', [round(v, 1) for v in ec], round(ea, 1), round(eb, 1), round(math.degrees(eth), 1), 'irises.json', e)
        pts = [(x, t) for x, t in zip(cols, tops)] + [(x, b_) for x, b_ in zip(cols[::-1], bots[::-1])]
        dr.line(pts + [pts[0]], fill=(0, 0, 255), width=2)
        th = np.linspace(0, 2 * math.pi, 100)
        dr.line([(ec[0] + ea * math.cos(t) * math.cos(eth) - eb * math.sin(t) * math.sin(eth), ec[1] + ea * math.cos(t) * math.sin(eth) + eb * math.sin(t) * math.cos(eth)) for t in th], fill=(255, 0, 0), width=2)
        for name, col_ in (('blink', (255, 0, 255)), ('happy', (255, 160, 0))):
            dr.line(list(zip(closed[name]['x'], closed[name]['y'])), fill=col_, width=2)
    # one crop rectangle for all eye textures (UV = front projection into it)
    ys_, xs_ = np.nonzero(excl); X0, Y0, X1, Y1 = int(xs_.min()) - 8, int(ys_.min()) - 8, int(xs_.max()) + 8, int(ys_.max()) + 8
    def fill(known, img, iters=60):
        # normalised convolution: unknown pixels take the blurred colour of the known ones, growing outwards
        out = img.copy(); k = known.astype(np.float32)
        for s in (2, 4, 8, 16, 32, 64):
            w = ndimage.gaussian_filter(k, s); m = (w > 1e-3) & ~known & (out[..., 3] < 0)
            for c in range(3): out[..., c] = np.where(m, ndimage.gaussian_filter(img[..., c] * k, s) / np.maximum(w, 1e-6), out[..., c])
            out[..., 3] = np.where(m, 1, out[..., 3])
        return out
    def crop(a): return a[Y0:Y1, X0:X1]
    nc = crop(n_).copy()
    def filled(known):
        img = nc.copy(); img[..., 3] = np.where(crop(known), 1, -1); out = fill(crop(known), img)
        out[..., 3] = 255; return Image.fromarray(out.clip(0, 255).astype(np.uint8), 'RGBA')
    filled(iris_known).save(os.path.join(OUT, 'eye_iris.png')); filled(white_known).save(os.path.join(OUT, 'eye_white.png'))
    lay = np.asarray(filled(iris_known)).copy(); lay[..., 3] = (crop(iris_alpha) * 255).astype(np.uint8)
    lay[:2] = lay[-2:] = 0; lay[:, :2] = lay[:, -2:] = 0                 # transparent border: clamped scrolling shows nothing
    Image.fromarray(lay, 'RGBA').save(os.path.join(OUT, 'eye_iris_layer.png'))
    k_skin = np.array([252, 230, 221], np.float32)
    tiles = []
    for name in CELLS:                                  # colours un-mixed from the skin under the strokes
        a = crop(A[name])[..., None]; col = (crop(D[name])[..., :3] - (1 - a) * k_skin) / np.maximum(a, 0.35)
        tiles.append(np.concatenate([col.clip(0, 255), a * 255], -1))
    Image.fromarray(np.concatenate(tiles, 0).astype(np.uint8), 'RGBA').save(os.path.join(OUT, 'eye_lash.png'))
    # face paint for the upper face: the model's skin with the drawing's strokes (brows, nose, blush); eyes removed
    x0, y0, x1, y1 = reg['upper']['bbox']
    m = (al_ > 128) & (r > 170) & (r >= g) & (g >= b - 5) & (r - b > 20) & (r - g < 90) & ~ndimage.binary_dilation(U_all, iterations=8)   # the eye white is not skin
    mf = m.astype(np.float32); wsum = ndimage.gaussian_filter(mf, 24) + 1e-4
    loc = np.stack([ndimage.gaussian_filter(n_[..., c] * mf, 24) / wsum for c in range(3)], -1)
    d = np.sqrt(((n_[..., :3] - loc) ** 2).sum(-1)); alpha = np.clip((d - 14) / 40, 0, 1) * (al_ / 255)
    mint = (g > r + 8) & ((r + g + b) / 3 > 140); lab, nn = ndimage.label(mint); sizes = ndimage.sum(np.ones_like(r), lab, range(1, nn + 1))
    alpha[ndimage.binary_dilation(np.isin(lab, 1 + np.nonzero(sizes > mint.size * 0.02)[0]), iterations=2)] = 0
    alpha *= 1 - ndimage.gaussian_filter(ndimage.binary_dilation(excl, iterations=4).astype(np.float32), 6)
    rx0, ry0, rx1, ry1 = reg['upper']['rect']; ramp = 0.03 * max(rx1 - rx0, ry1 - ry0)
    a = alpha[y0:y1, x0:x1] * np.clip(np.minimum.reduce([xx[y0:y1, x0:x1] - rx0, rx1 - xx[y0:y1, x0:x1], yy[y0:y1, x0:x1] - ry0, ry1 - yy[y0:y1, x0:x1]]) / ramp, 0, 1)
    out = skin[y0:y1, x0:x1].copy(); out[..., :3] = out[..., :3] * (1 - a[..., None]) + n_[y0:y1, x0:x1, :3] * a[..., None]; out[..., 3] = 255
    Image.fromarray(out.clip(0, 255).astype(np.uint8), 'RGBA').save(os.path.join(OUT, 'face_upper.png'))
    json.dump({'size': S, 'crop': [X0, Y0, X1, Y1], 'lash_cells': list(CELLS), 'upper_bbox': [x0, y0, x1, y1], 'eyes': eyes}, open(os.path.join(OUT, 'eyes.json'), 'w'), indent=1)
    dbg.crop((X0, Y0, X1, Y1)).save(os.path.join(OUT, 'prep.png'))
    print('PREP crop', [X0, Y0, X1, Y1])


# ---------------------------------------------------------------------------------------------------------- build
D1 = float(os.environ.get('EYE_D1', 0.004))   # the face lies on the eye plane up to D1 from the opening ...
D2 = float(os.environ.get('EYE_D2', 0.018))   # ... and is back to its own shape at D1 + D2
RECESS = float(os.environ.get('EYE_RECESS', 3)) / 1000   # socket: the eye sits this far behind the rim of the opening
PUSH = os.environ.get('EYE_PUSH', '1') == '1'   # push the face back (never forward) so the socket is RECESS deep all round;
                                                # 0: leave the face as it is (the eye plane then needs EYE_YAW near the face's own ~40 deg)
GAZE = os.environ.get('EYE_GAZE', 'uv')        # uv: iris texture scrolled by lookAt expressions; bone: iris mesh on eye bones
GAZE_H, GAZE_V = 0.006, 0.0035                  # largest iris shift (m) for the uv gaze
FIT = os.environ.get('EYE_FIT', 'plane'); FLAT = float(os.environ.get('EYE_FLAT', 1.0))   # socket: plane or sphere
WHITE_MARGIN = 0.012           # the white goes this far under the face around the opening (seen from the side)
H_LASH, H_LID, H_IRIS, H_WHITE = 0.0005, -0.0004, -0.0010, -0.0022   # along the plane normal
R_EYE = float(os.environ.get('EYE_RADIUS', 0.15))   # iris sphere radius = distance from eye bone to the iris
DMAX = float(os.environ.get('EYE_DMAX', 0.015))   # largest depth shift of the face (soft limit)
RAISE_PX = 5                   # the opening's top edge goes this far up into the lash (no skin sliver under the lash)


def smoothstep(t):
    import numpy as np
    t = np.clip(t, 0, 1); return t * t * (3 - 2 * t)


def poly_dist(P, poly):
    # distance (same units) from points P (N,2) to the closed polygon (M,2); 0 inside
    import numpy as np
    A = poly; B = np.roll(poly, -1, 0); AB = B - A; L2 = (AB ** 2).sum(1) + 1e-12
    t = np.clip(((P[:, None, :] - A[None]) * AB[None]).sum(-1) / L2[None], 0, 1)
    d = np.sqrt((((A[None] + t[..., None] * AB[None]) - P[:, None, :]) ** 2).sum(-1)).min(1)
    x, y = P[:, 0:1], P[:, 1:2]; ya, yb, xa, xb = A[None, :, 1], B[None, :, 1], A[None, :, 0], B[None, :, 0]
    cross = ((ya > y) != (yb > y)) & (x < xa + (y - ya) * (xb - xa) / (yb - ya + 1e-12))
    inside = cross.sum(1) % 2 == 1
    return np.where(inside, 0.0, d)


def build(KIT, blend, OUT, FACE, ref_vrm, out_vrm):
    import bpy, bmesh, struct, importlib.util
    import numpy as np
    from pathlib import Path
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    from mathutils.geometry import barycentric_transform
    YAW = math.radians(float(os.environ.get('EYE_YAW', 12)))
    spec = importlib.util.spec_from_file_location('mt', Path(KIT) / 'scripts/mtoon-export.py')
    mt = importlib.util.module_from_spec(spec); spec.loader.exec_module(mt); mt.enable_vrm()
    bpy.ops.wm.open_mainfile(filepath=blend)
    out_vrm = Path(out_vrm).resolve(); out_blend = out_vrm.with_suffix('.blend')
    assert out_blend != Path(blend).resolve(), 'the output .blend must not be the input'
    cam = json.load(open(os.path.join(FACE, 'cam.json'))); to_px, to_w, K = cam_proj(cam)
    E = json.load(open(os.path.join(OUT, 'eyes.json'))); reg = json.load(open(os.path.join(FACE, 'regions.json')))
    X0, Y0, X1, Y1 = E['crop']; CW, CH = X1 - X0, Y1 - Y0
    head = bpy.data.objects['Head']; hair = bpy.data.objects['Hair']; me = head.data
    rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    MH = head.matrix_world.copy(); MHi = MH.inverted()
    assert not me.shape_keys and len(me.materials) == 1

    # ---- the face as it is: positions, triangles, corner normals (for the normals of everything made here)
    V0 = [MH @ v.co for v in me.vertices]; me.calc_loop_triangles()
    T0 = [(tuple(t.vertices), tuple(t.loops)) for t in me.loop_triangles]; N0 = [Vector(n.vector) for n in me.corner_normals]
    bvh0 = BVHTree.FromPolygons(V0, [t[0] for t in T0])
    def front_hit(bvh, x, z):
        loc, nrm, i, _ = bvh.ray_cast(Vector((x, -2.0, z)), Vector((0, 1, 0))); return loc, nrm, i
    def normal_at(p_orig, ti=None):
        if ti is None: ti = bvh0.find_nearest(p_orig)[2]
        (a, b, c), (la, lb, lc) = T0[ti]
        w = barycentric_transform(p_orig, V0[a], V0[b], V0[c], Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
        return (N0[la] * w.x + N0[lb] * w.y + N0[lc] * w.z).normalized()
    def face_normal_front(x, z):              # the original face normal seen from the front at (x, z)
        loc, _, ti = front_hit(bvh0, x, z)
        if loc is None: misses.append((x, z)); return Vector((0, -1, 0))
        return normal_at(loc, ti)
    misses = []

    # ---- face paint regions on the face as it is (before it is subdivided, so the UVs are interpolated with it)
    def pick(rect):
        out = []
        for poly in me.polygons:
            if (MH.to_3x3() @ poly.normal).normalized().y > -0.15: continue
            x, y = to_px(*(lambda p: (p.x, p.z))(MH @ poly.center))
            if rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]: out.append(poly.index)
        return out
    def bbox(polys):
        pts = [to_px(*(lambda p: (p.x, p.z))(MH @ me.vertices[v].co)) for p in polys for v in me.polygons[p].vertices]
        return [int(min(p[0] for p in pts)) - 2, int(min(p[1] for p in pts)) - 2, int(max(p[0] for p in pts)) + 3, int(max(p[1] for p in pts)) + 3]
    base = me.materials[0]
    def mtoon_copy(name, img_path, alpha_mode='OPAQUE'):
        if isinstance(img_path, str): img = bpy.data.images.load(img_path); img.name = name; img.pack()
        else: img = img_path
        m = base.copy(); m.name = name; g = m.vrm_addon_extension.mtoon1; gb = base.vrm_addon_extension.mtoon1
        g.pbr_metallic_roughness.base_color_texture.index.source = img
        if gb.extensions.vrmc_materials_mtoon.shade_multiply_texture.index.source:
            g.extensions.vrmc_materials_mtoon.shade_multiply_texture.index.source = img
        for info in (g.pbr_metallic_roughness.base_color_texture, g.extensions.vrmc_materials_mtoon.shade_multiply_texture):
            info.index.sampler.wrap_s = info.index.sampler.wrap_t = 'CLAMP_TO_EDGE'
        if alpha_mode != 'OPAQUE': g.alpha_mode = alpha_mode
        return m, img
    uvl = me.uv_layers.active.data; regions = {}
    mouth = reg['mouth']; sel = pick(mouth['rect']); b_ = bbox(sel)
    assert b_ == mouth['bbox'], f'mouth bbox {b_} != {mouth["bbox"]} (atlas_mouth.png would not fit)'
    upper_rect = reg['upper']['rect']; sel_u = [p for p in pick(upper_rect) if p not in set(sel)]; bu = bbox(sel_u)
    # face_upper.png covers the bbox face_vrm.py select wrote (the irises were subdivided there): it must contain ours
    fu = E['upper_bbox']; assert fu[0] <= bu[0] and fu[1] <= bu[1] and bu[2] <= fu[2] and bu[3] <= fu[3], f'upper bbox {bu} outside {fu}'
    bu = fu
    # skin_tone.py output (OUT/skin): the recoloured head / body textures and face paint replace the originals
    SK = os.path.join(OUT, 'skin'); skin_on = os.path.isfile(os.path.join(SK, 'head.png'))
    def skinned(path, name): return os.path.join(SK, name) if skin_on and os.path.isfile(os.path.join(SK, name)) else path
    if skin_on:
        for mname in ('head', 'upper_body', 'lower_body'):
            im = bpy.data.images.load(os.path.join(SK, mname + '.png')); im.name = 'skin_' + mname; im.pack()
            g = bpy.data.materials[mname].vrm_addon_extension.mtoon1
            g.pbr_metallic_roughness.base_color_texture.index.source = im
            if g.extensions.vrmc_materials_mtoon.shade_multiply_texture.index.source: g.extensions.vrmc_materials_mtoon.shade_multiply_texture.index.source = im
        print('SKIN textures from', SK)
    for key, polys, bb, img_path, ncell in (('mouth', sel, mouth['bbox'], skinned(os.path.join(FACE, 'atlas_mouth.png'), 'atlas_mouth.png'), len(mouth['cells'])),
                                             ('upper', sel_u, bu, skinned(os.path.join(OUT, 'face_upper.png'), 'face_upper.png'), 1)):
        m, img = mtoon_copy('Face_' + key, img_path); me.materials.append(m); slot = len(me.materials) - 1
        x0, y0, x1, y1 = bb; w, h = x1 - x0, (y1 - y0) * ncell
        assert tuple(img.size) == (w, h), f'{key}: image {tuple(img.size)} != {w}x{h}'
        for p in polys:
            poly = me.polygons[p]; poly.material_index = slot
            for li in poly.loop_indices:
                px, py = to_px(*(lambda q: (q.x, q.z))(MH @ me.vertices[me.loops[li].vertex_index].co))
                uvl[li].uv = ((px - x0) / w, 1 - (py - y0) / h)
        regions[key] = (m, bb)
        print('REGION', key, len(polys), 'triangles bbox', bb)
    face_upper_mat, upper_bb = regions['upper']

    # ---- eye planes
    eyes = []
    for e in E['eyes']:
        cols = np.array(e['cols'], float); top = np.array(e['top']); bot = np.array(e['bottom'])
        top_h = np.minimum(top - RAISE_PX, bot)                      # the opening as cut out of the face
        poly_px = np.concatenate([np.stack([cols, top_h], 1), np.stack([cols[::-1], bot[::-1]], 1)])
        poly_px = poly_px[::max(1, len(poly_px) // 80)]           # ~80 edges per eye (1.5 mm each)
        # the plane: turned EYE_YAW outward, tilted up/down like the face, and placed at or behind the face over the
        # whole opening (it only ever pushes the face back: where it was in front of the face, the eye stood out of
        # the outline in profile and from below). Its deepest contact is the outer corner, so the inner side is a socket.
        ic = e['iris']; o_ = e['outer']; gx = o_ * math.tan(YAW)
        xs_, ys_ = np.meshgrid(np.arange(cols.min(), cols.max() + 1, 6.0), np.arange(top_h.min(), bot.max() + 1, 6.0))
        in_open = (ys_ >= np.interp(xs_, cols, top_h)) & (ys_ <= np.interp(xs_, cols, bot))
        smp = []
        # socket mode: the face is not reshaped; the plane goes RECESS behind the face at the deepest point of the
        # opening's rim, so the eye sits in a shallow socket cut into the round face
        pts_ = poly_px if RECESS is not None else np.stack([xs_[in_open], ys_[in_open]], 1)
        for px, py in pts_:
            x, z = to_w(px, py); loc, _, _ = front_hit(bvh0, x, z)
            if loc is not None: smp.append((x, z, loc.y))
        smp = np.array(smp); r_ = smp[:, 2] - gx * smp[:, 0]
        gz = float(np.polyfit(smp[:, 1], r_, 1)[0]); c0 = float((r_ - gz * smp[:, 1]).max()) + (RECESS or 0.0)
        n = Vector((gx, -1.0, gz)).normalized()
        def plane_y(x, z, c0=c0, gx=gx, gz=gz): return c0 + gx * x + gz * z
        A = Vector((float(smp[:, 0].mean()), 0.0, float(smp[:, 1].mean()))); A.y = plane_y(A.x, A.z)
        dent = plane_y(smp[:, 0], smp[:, 1]) - smp[:, 2]
        if PUSH: print('PLANE', e['side'], 'pitch deg', round(math.degrees(math.atan(gz)), 1), 'socket %.1f mm all round; face pushed back at the rim: max %.1f mean %.1f mm'
                       % (RECESS * 1000, float(dent.max() - RECESS) * 1000, float(dent.mean() - RECESS) * 1000))
        else: print('PLANE', e['side'], 'pitch deg', round(math.degrees(math.atan(gz)), 1), 'socket depth at the rim (face unchanged): min %.1f max %.1f mean %.1f mm'
                    % (float(dent.min()) * 1000, float(dent.max()) * 1000, float(dent.mean()) * 1000))
        poly_w = np.array([to_w(*p) for p in poly_px])
        icx, icz = to_w(*ic['center']); R_e = R_EYE
        Q = Vector((icx, plane_y(icx, icz), icz)) + H_IRIS * n; C = Q - R_e * n
        if RECESS is not None and FIT == 'sphere':
            # eyeball: a sphere fitted to the rim of the opening (the round face there), made FLAT times larger, set
            # RECESS behind the rim at its shallowest point. The eye bone sits at its centre, so the iris turns on it.
            p3 = smp[:, [0, 2, 1]]                      # x, y, z
            M_ = np.c_[2 * p3, np.ones(len(p3))]; sol = np.linalg.lstsq(M_, (p3 ** 2).sum(1), rcond=None)[0]
            c_fit = sol[:3]; r_fit = float(math.sqrt(sol[3] + (c_fit ** 2).sum())); rim_c = p3.mean(0)
            u = (rim_c - c_fit) / np.linalg.norm(rim_c - c_fit); Rk = r_fit * FLAT; ctr = rim_c - Rk * u
            def sph_y(x, z, ctr=ctr, Rk=Rk): return ctr[1] - np.sqrt(np.maximum(Rk * Rk - (x - ctr[0]) ** 2 - (z - ctr[2]) ** 2, 0))
            ctr = ctr + np.array([0, float((smp[:, 2] - sph_y(smp[:, 0], smp[:, 1])).max()) + RECESS, 0])
            def plane_y(x, z, ctr=ctr, Rk=Rk): return ctr[1] - np.sqrt(np.maximum(Rk * Rk - (x - ctr[0]) ** 2 - (z - ctr[2]) ** 2, 0))
            R_e = Rk + H_IRIS; C = Vector(ctr.tolist()); Q = Vector((icx, float(plane_y(icx, icz)), icz)); Q = C + (Q - C).normalized() * R_e
            n = (Q - C).normalized(); dent = plane_y(smp[:, 0], smp[:, 1]) - smp[:, 2]
            print('SPHERE', e['side'], 'fitted radius mm', round(r_fit * 1000), 'used', round(Rk * 1000), 'socket depth at the rim: min %.1f max %.1f mean %.1f mm' % (float(dent.min()) * 1000, float(dent.max()) * 1000, float(dent.mean()) * 1000), 'axis yaw deg', round(math.degrees(math.atan2(abs(u[0]), -u[1])), 1))
        eyes.append(dict(e=e, cols=cols, top=top, top_h=top_h, bot=bot, poly_px=poly_px, poly_w=poly_w, A=A, n=n, plane_y=plane_y, C=C, Q=Q, R=R_e))
        print('EYE', e['side'], 'anchor', [round(v, 4) for v in A], 'normal', [round(v, 3) for v in n], 'pivot', [round(v, 4) for v in C])

    def zdist(P): return np.stack([poly_dist(P, ey['poly_w']) for ey in eyes], 1)
    def zone(P):
        # P (N,2) world x,z -> per eye weight (N, eyes)
        return 1 - smoothstep((zdist(P) - D1) / D2)
    def falloff(t):
        # t = depth behind the eye plane: the face, and the hair in front of it, move; things far behind (the ear, the
        # back hair) do not. A smooth function of position (a cut-off behind the first surface hit made flaps where the
        # ear is behind the cheek); 40 mm wide so that the depth order never flips (1 + shift * slope > 0)
        return 1.0 if t <= 0.03 else float(1 - smoothstep((t - 0.03) / 0.04))

    # ---- subdivide the face around the eyes (12.9 mm edges -> ~3 mm) so it can be flattened and cut cleanly
    bm = bmesh.new(); bm.from_mesh(me)
    for it in range(int(os.environ.get('EYE_SUBDIV', 2))):
        bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table(); bm.normal_update()
        # first pass: the whole reshaped area; second pass: the flat part and 6 mm around it (the cut)
        W = [MH @ v.co for v in bm.verts]; dz = zdist(np.array([[p.x, p.z] for p in W])).min(1)
        reach = D1 + D2 if it == 0 else D1 + 0.006
        edges = set()
        for f in bm.faces:
            if (MH.to_3x3() @ f.normal).y > -0.1 or not any(dz[v.index] < reach for v in f.verts): continue
            c = MH @ f.calc_center_median(); loc, _, _ = front_hit(bvh0, c.x, c.z)
            if loc is None or abs(loc.y - c.y) > 0.003: continue    # only the front surface (not the back of the head)
            edges.update(f.edges)
        bmesh.ops.subdivide_edges(bm, edges=list(edges), cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
        print('SUBDIV', it, len(edges), 'edges ->', len(bm.faces), 'faces')
    orig = bm.verts.layers.float_vector.new('orig')
    for v in bm.verts: v[orig] = MH @ v.co

    # ---- reshape: depth only, the same shift for the face and the hair (front view unchanged)
    def warp_points(W):
        if RECESS is not None and not PUSH: return list(W), 0, [0.0, 0.0]          # socket mode: the face keeps its shape
        rim = RECESS if RECESS is not None else 0.0     # push mode: the face around the opening goes to RECESS in front of the eye plane
        P = np.array([[p.x, p.z] for p in W]); wz = zone(P); moved = 0; dmax = [0.0, 0.0]
        out = []
        for p, w in zip(W, wz):
            if w.sum() <= 0: out.append(p); continue
            loc, _, _ = front_hit(bvh0, p.x, p.z)
            if loc is None: out.append(p); continue
            d = float(sum(wi * max(0.0, ey['plane_y'](p.x, p.z) - rim - loc.y) for wi, ey in zip(w, eyes)) / max(1.0, w.sum()))   # back only
            # soft limit in the falloff only (exact where the face must lie on the plane): far from the eye the plane
            # runs away from the round face, and following it there would make ridges
            dm = DMAX / max(1e-6, 1 - float(w.max())); d = dm * math.tanh(d / dm)
            pm = float(sum(wi * ey['plane_y'](p.x, p.z) for wi, ey in zip(w, eyes)) / w.sum())
            f = falloff(p.y - pm); q = p.copy(); q.y += d * f; out.append(q)
            if f > 0 and abs(d) > 1e-6: moved += 1; dmax = [min(dmax[0], d * f), max(dmax[1], d * f)]
        return out, moved, dmax
    W = [MH @ v.co for v in bm.verts]; W2, mv, dm = warp_points(W)
    for v, q in zip(bm.verts, W2): v.co = MHi @ q
    print('WARP Head', mv, 'vertices, depth shift mm', [round(x * 1000, 1) for x in dm])
    for o in (hair,):
        Mo = o.matrix_world; Moi = Mo.inverted(); Wo = [Mo @ v.co for v in o.data.vertices]; W2o, mv, dm = warp_points(Wo)
        for v, q in zip(o.data.vertices, W2o): v.co = Moi @ q
        print('WARP', o.name, mv, 'vertices, depth shift mm', [round(x * 1000, 1) for x in dm])
    bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
    bvh1 = BVHTree.FromPolygons([MH @ v.co for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces])   # reshaped face, not cut

    # ---- cut the openings: bisect along every polygon edge (planes containing the view axis), delete inside
    for ey in eyes:
        pw = ey['poly_w']
        for i in range(len(pw)):
            a, b = pw[i], pw[(i + 1) % len(pw)]
            lo, hi = np.minimum(a, b) - 0.004, np.maximum(a, b) + 0.004
            faces = []
            for f in bm.faces:
                c = MH @ f.calc_center_median()
                if not (lo[0] <= c.x <= hi[0] and lo[1] <= c.z <= hi[1]): continue
                loc, _, _ = front_hit(bvh1, c.x, c.z)
                if loc is None or abs(c.y - loc.y) > 0.002: continue          # the front surface only
                faces.append(f)
            if not faces: continue
            pa = Vector((a[0], 0.0, a[1])); dirv = Vector((b[0] - a[0], 0.0, b[1] - a[1])); pn = dirv.cross(Vector((0, 1, 0))).normalized()
            geom = list({v for f in faces for v in f.verts}) + list({e_ for f in faces for e_ in f.edges}) + faces
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=MHi @ pa, plane_no=(MHi.to_3x3() @ pn).normalized())
            bm.faces.ensure_lookup_table()
        dead = []
        for f in bm.faces:
            c = MH @ f.calc_center_median()
            loc, _, _ = front_hit(bvh1, c.x, c.z)
            if loc is None or abs(c.y - loc.y) > 0.002: continue
            if poly_dist(np.array([[c.x, c.z]]), pw)[0] == 0: dead.append(f)
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
        bm.faces.ensure_lookup_table()
        print('CUT', ey['e']['side'], len(pw), 'edges,', len(dead), 'faces removed')
    bm.to_mesh(me); bm.free(); me.update()
    # normals: every corner takes the normal of the face as it was at the same place (the toon shading stays as before)
    oa = me.attributes['orig']; cn = [None] * len(me.loops)
    for poly in me.polygons:
        c = sum((Vector(oa.data[v].vector) for v in poly.vertices), Vector()) / len(poly.vertices); ti = bvh0.find_nearest(c)[2]
        for li in poly.loop_indices: cn[li] = normal_at(Vector(oa.data[me.loops[li].vertex_index].vector), ti)
    me.normals_split_custom_set(cn); me.attributes.remove(me.attributes['orig']); me.update()
    print('HEAD', len(me.vertices), 'vertices', len(me.polygons), 'triangles')

    # ---- eye parts (one mesh): white, iris, eyelids, upper lash strip, lower line strip
    mats = {}
    for key, fn in (('white', 'eye_white.png'), ('iris', 'eye_iris_layer.png' if GAZE == 'uv' else 'eye_iris.png')):
        mats[key] = mtoon_copy('Eye_' + key, os.path.join(OUT, fn), 'MASK' if (key == 'iris' and GAZE == 'uv') else 'OPAQUE')[0]
    # one lash material per eye (a texture transform shifts a whole material: winks need them apart), one atlas
    mats['lash_R'], lash_img = mtoon_copy('Eye_lash_R', os.path.join(OUT, 'eye_lash.png'), 'BLEND'); lash_img.name = 'Eye_lash'
    mats['lash_L'] = mtoon_copy('Eye_lash_L', lash_img, 'BLEND')[0]
    ncell = len(E['lash_cells']); assert tuple(lash_img.size) == (CW, CH * ncell), f'eye_lash.png {tuple(lash_img.size)}'
    lash_alpha = np.array(lash_img.pixels[:], np.float32).reshape(lash_img.size[1], lash_img.size[0], 4)[::-1, :, 3]   # rows from the top
    mats['lid'] = face_upper_mat
    order = ['white', 'iris', 'lid', 'lash_R', 'lash_L']
    verts, faces, fmat, fuv, vgroup, keys, vorig = [], [], [], [], [], {}, []
    key_names = [f'{k}_{ey["e"]["side"]}' for k in ('blink', 'happy') for ey in eyes]
    def px_w(px, py): return to_w(px, py)
    def crop_uv(px, py): return ((px - X0) / CW, 1 - (py - Y0) / CH)
    def lash_uv(px, py): return ((px - X0) / CW, 1 - (py - Y0) / (CH * ncell))      # cell 0 (neutral) at the top
    def upper_uv(px, py):
        x0, y0, x1, y1 = upper_bb; return ((px - x0) / (x1 - x0), 1 - (py - y0) / (y1 - y0))
    def add_grid(pos_fn, uv_fn, nx, ny, part, group, key_fn=None, keep=None):
        # (nx+1) x (ny+1) vertices from pos_fn(i, j) -> (world point, px point); quads split in two
        base_i = len(verts); idx = {}
        for j in range(ny + 1):
            for i in range(nx + 1):
                if keep is not None and not any(keep(i - di, j - dj) for di in (0, 1) for dj in (0, 1)): continue
                p, pp = pos_fn(i, j); idx[i, j] = len(verts); verts.append(p); vgroup.append(group); vorig.append(pp)
                for kn in key_names: keys.setdefault(kn, []).append(key_fn(kn, i, j) if key_fn else p)
        for j in range(ny):
            for i in range(nx):
                if keep is not None and not keep(i, j): continue
                q = [idx[i, j], idx[i + 1, j], idx[i + 1, j + 1], idx[i, j + 1]]
                for tri in ((q[0], q[1], q[2]), (q[0], q[2], q[3])):
                    faces.append(tri); fmat.append(order.index(part)); fuv.append([uv_fn(*vorig[t]) for t in tri])
    def on_sphere(C, r, x, z):
        d2 = r * r - (x - C.x) ** 2 - (z - C.z) ** 2; return Vector((x, C.y - math.sqrt(max(d2, 0.0)), z))
    def on_face(x, z, h):                        # on the reshaped face (before the cut), h in front of it
        loc, nrm, _ = front_hit(bvh1, x, z)
        if loc is None: return None
        return Vector((x, loc.y - h / max(0.3, abs(nrm.y)), z))
    for ey in eyes:
        e = ey['e']; side = e['side']; n = ey['n']; cols, top, top_h, bot = ey['cols'], ey['top'], ey['top_h'], ey['bot']
        def closed_y(name, x):
            cl = e['closed'][name]; c = np.interp(x, cl['x'], cl['y']); t = np.interp(x, cols, top); b = np.interp(x, cols, bot)
            return float(np.clip(c, t + 2, b - 2))
        # white: cells over the opening + margin, on the white sphere
        cell = 32; mpx = WHITE_MARGIN * K
        gx0, gy0 = cols.min() - mpx - cell, top_h.min() - mpx - cell; nx = int((cols.max() - cols.min() + 2 * mpx) / cell) + 3; ny = int((bot.max() - top_h.min() + 2 * mpx) / cell) + 3
        cpts = np.array([[gx0 + (i + 0.5) * cell, gy0 + (j + 0.5) * cell] for j in range(ny) for i in range(nx)])
        inside = (poly_dist(cpts, ey['poly_px']) <= mpx + cell * 0.71).reshape(ny, nx)
        Cw = ey['C']; rw = ey['R'] - (H_IRIS - H_WHITE)
        def wpos(i, j, gx0=gx0, gy0=gy0, Cw=Cw, rw=rw):
            # on the white sphere, but never in front of the face: past the rim it lines the back of the skin, so
            # looking into the opening from the side shows white, never a hole or a dark wall
            px, py = gx0 + i * cell, gy0 + j * cell; x, z = px_w(px, py); p = on_sphere(Cw, rw, x, z)
            loc, nrm, _ = front_hit(bvh1, x, z)
            if loc is not None: p.y = max(p.y, loc.y + 0.0006 / max(abs(nrm.y), 0.3))   # 0.6 mm under the skin
            return p, (px, py)
        # outside the opening, no lining where the face turns sideways (seen from the side it would show through)
        def steep(i, j):                 # cell (i, j) by its centre: well outside the opening and on a sideways face
            px, py = gx0 + (i + 0.5) * cell, gy0 + (j + 0.5) * cell; x, z = px_w(px, py); loc, nrm, _ = front_hit(bvh1, x, z)
            return poly_dist(np.array([[px, py]]), ey['poly_px'])[0] > cell and (loc is None or abs(nrm.y) < 0.5)
        inside &= ~np.array([[steep(i, j) for i in range(nx)] for j in range(ny)])
        add_grid(wpos, crop_uv, nx, ny, 'white', 'head', keep=lambda i, j, inside=inside: 0 <= i < nx and 0 <= j < ny and inside[j, i])
        if GAZE == 'uv':
            # iris layer: a sheet over the opening (+8 px) just in front of the white; the iris is its texture and
            # the gaze scrolls it (VRM lookAt expressions with texture transforms)
            cell_i = 24; ix0, iy0 = cols.min() - 8, top_h.min() - 8
            nxi, nyi = int((cols.max() - cols.min() + 16) / cell_i) + 1, int((bot.max() - top_h.min() + 16) / cell_i) + 1
            cp = np.array([[ix0 + (i + 0.5) * cell_i, iy0 + (j + 0.5) * cell_i] for j in range(nyi) for i in range(nxi)])
            ins = (poly_dist(cp, ey['poly_px']) <= 8 + cell_i * 0.71).reshape(nyi, nxi)
            def lpos_i(i, j, ix0=ix0, iy0=iy0, Cw=Cw, ey=ey):
                px, py = ix0 + i * cell_i, iy0 + j * cell_i; x, z = px_w(px, py); return on_sphere(Cw, ey['R'], x, z), (px, py)
            add_grid(lpos_i, crop_uv, nxi, nyi, 'iris', 'head', keep=lambda i, j, ins=ins: 0 <= i < nxi and 0 <= j < nyi and ins[j, i])
            continue_iris = False
        else:
            continue_iris = True
        # iris: elliptic rings on the iris sphere, weighted to the eye bone
        ic = e['iris']; segs, rings = 40, 3
        def ipos(i, j, ic=ic, Cw=Cw):
            t = 2 * math.pi * i / segs; s = j / rings
            u, v = ic['a'] * s * math.cos(t), ic['b'] * s * math.sin(t); th = ic['angle']
            px, py = ic['center'][0] + u * math.cos(th) - v * math.sin(th), ic['center'][1] + u * math.sin(th) + v * math.cos(th)
            x, z = px_w(px, py); return on_sphere(Cw, ey['R'], x, z), (px, py)
        if continue_iris: add_grid(ipos, crop_uv, segs, rings, 'iris', e['bone'])
        # eyelids: columns across the opening. At rest each is a thin band (14 -> 6 px outside the opening edge, so
        # under the face); blink / happy stretch it over the opening up to the closed line. The band is not collapsed
        # to a line: the corner normals are stored relative to the faces, which must not be degenerate.
        ncol, nrow = 30, 4; xs = np.linspace(cols.min() - 12, cols.max() + 12, ncol + 1)
        for which in ('upper', 'lower'):
            sgn = -1 if which == 'upper' else 1
            def fixed_y(x, which=which, sgn=sgn): return float(np.interp(x, cols, top_h if which == 'upper' else bot)) + 18 * sgn
            def lid_px(x, j, name, which=which, sgn=sgn):
                f = fixed_y(x)
                if name == 'rest': return f - 10 * sgn * j / nrow
                c = closed_y(name, x); tgt = c + 4 if which == 'upper' else c - 4
                return f + (tgt - f) * j / nrow
            def lid_w(x, py, ey=ey):
                # just behind the (uncut) face: under the skin at rest, at the face's own surface when closed
                wx, wz = px_w(x, py); loc, _, _ = front_hit(bvh1, wx, wz)
                d = loc.y if loc is not None else ey['plane_y'](wx, wz); return Vector((wx, d - H_LID, wz))
            def lpos(i, j, lid_px=lid_px, lid_w=lid_w):
                # uv of the closed position (blink): that is where the eyelid is seen
                x = xs[i]; return lid_w(x, lid_px(x, j, 'rest')), (x, lid_px(x, j, 'blink'))
            def lkey(kn, i, j, side=side, lid_px=lid_px, lid_w=lid_w, lpos=lpos):
                if not kn.endswith('_' + side): return lpos(i, j)[0]
                x = xs[i]; return lid_w(x, lid_px(x, j, kn.split('_')[0]))
            add_grid(lpos, upper_uv, ncol, nrow, 'lid', 'head', key_fn=lkey)
        # lash strip: 10 px cells wherever any lash cell (open / closed) has strokes, on the reshaped face. It does not
        # move: blink / happy show their own lash cell (texture transform), the eyelids close the opening behind it.
        a = lash_alpha; cell = 14; nx, ny = CW // cell, CH // cell
        occ = np.zeros((ny, nx), bool)
        for k in range(ncell): occ |= a[k * CH:k * CH + ny * cell, :nx * cell].reshape(ny, cell, nx, cell).max((1, 3)) > 0.02
        occ = occ | np.roll(occ, 1, 0) | np.roll(occ, -1, 0) | np.roll(occ, 1, 1) | np.roll(occ, -1, 1)
        half = int((E['size'] / 2 - X0) // cell)
        if side == 'R': occ[:, half:] = False
        else: occ[:, :half] = False
        def spos(i, j, ey=ey):
            px, py = X0 + i * cell, Y0 + j * cell; x, z = px_w(px, py); p = on_face(x, z, H_LASH)
            return (p if p is not None else Vector((x, ey['plane_y'](x, z) - H_LASH / ey['n'].y, z))), (px, py)
        add_grid(spos, lash_uv, nx, ny, 'lash_' + side, 'head', keep=lambda i, j, occ=occ: 0 <= i < occ.shape[1] and 0 <= j < occ.shape[0] and occ[j, i])
    print('EYEPARTS', len(verts), 'vertices', len(faces), 'triangles', {k: fmat.count(order.index(k)) for k in order})
    # orientation: every part faces the front camera
    for fi, f in enumerate(faces):
        a, b, c = (verts[t] for t in f); nn = (b - a).cross(c - a)
        if nn.length > 1e-12 and nn.y > 0: faces[fi] = (f[0], f[2], f[1]); fuv[fi] = [fuv[fi][0], fuv[fi][2], fuv[fi][1]]
    em = bpy.data.meshes.new('EyeParts'); em.from_pydata([MHi @ p for p in verts], [], faces); em.update()
    for k in order: em.materials.append(mats[k])
    for poly, mi in zip(em.polygons, fmat): poly.material_index = mi
    uvs = em.uv_layers.new(name='UVMap').data
    for poly, uv3 in zip(em.polygons, fuv):
        for li, uv in zip(poly.loop_indices, uv3): uvs[li].uv = uv
    eo = bpy.data.objects.new('EyeParts', em); head.users_collection[0].objects.link(eo)
    eo.parent = head.parent; eo.parent_type = head.parent_type; eo.matrix_world = MH
    for g in ('head', 'eye.L', 'eye.R'): eo.vertex_groups.new(name=g)
    for vi, g in enumerate(vgroup): eo.vertex_groups[g].add([vi], 1.0, 'REPLACE')
    mod = eo.modifiers.new('Armature', 'ARMATURE'); mod.object = rig
    # normals of the face as it was at the same place seen from the front (closed position for the eyelids)
    nrm_v = [face_normal_front(*px_w(*pp)) for pp in vorig]
    em.normals_split_custom_set([nrm_v[em.loops[li].vertex_index] for poly in em.polygons for li in poly.loop_indices])
    assert len(misses) < 0.01 * len(vorig), f'{len(misses)} eye part vertices are not in front of the face: {misses[:5]}'
    eo.shape_key_add(name='Basis', from_mix=False)
    for kn in key_names:
        kb = eo.shape_key_add(name=kn, from_mix=False)
        for vi, p in enumerate(keys[kn]): kb.data[vi].co = MHi @ p
    print('EYEPARTS keys', key_names)
    # eye bones: head at the iris sphere centre (the iris turns on its sphere), pointing forward (bone gaze only)
    bpy.context.view_layer.objects.active = rig; bpy.ops.object.mode_set(mode='EDIT'); MR = rig.matrix_world; MRi = MR.inverted()
    for ey in (eyes if GAZE == 'bone' else []):
        eb = rig.data.edit_bones[ey['e']['bone']]; eb.use_connect = False
        eb.head = MRi @ ey['C']; eb.tail = MRi @ (ey['C'] + 0.03 * ey['n']); eb.roll = 0
    bpy.ops.object.mode_set(mode='OBJECT')
    # ---- VRM: expressions and lookAt
    v1 = rig.data.vrm_addon_extension.vrm1; p = v1.expressions.preset
    m_mouth = regions['mouth'][0]; mcells = reg['mouth']['cells']
    json.dump(mcells, open(os.path.join(OUT, 'mouth_cells.json'), 'w'))
    lcells = E['lash_cells']
    def bind(expr, morphs=(), mouth=None, binary=False, lash=None, sides=('R', 'L')):
        expr.morph_target_binds.clear(); expr.texture_transform_binds.clear()
        for kn in morphs:
            b = expr.morph_target_binds.add(); b.node.mesh_object_name = eo.name; b.index = kn; b.weight = 1.0
        if mouth and mcells.index(mouth) > 0:
            b = expr.texture_transform_binds.add(); b.material = m_mouth; b.scale = (1.0, 1.0); b.offset = (0.0, mcells.index(mouth) / len(mcells))
        for sd in (sides if lash else ()):          # glTF UV space: v grows downwards, cell i is i cell heights lower
            b = expr.texture_transform_binds.add(); b.material = mats['lash_' + sd]; b.scale = (1.0, 1.0); b.offset = (0.0, lcells.index(lash) / len(lcells))
        expr.is_binary = binary
    # every expression that shifts a texture is binary (an atlas shift cannot blend two cells): blink snaps shut
    bind(p.blink, ['blink_R', 'blink_L'], lash='blink', binary=True)
    bind(p.blink_left, ['blink_L'], lash='blink', binary=True, sides=('L',)); bind(p.blink_right, ['blink_R'], lash='blink', binary=True, sides=('R',))
    bind(p.happy, ['happy_R', 'happy_L'], 'happy', True, lash='happy'); p.happy.override_blink = 'block'; p.happy.override_mouth = 'block'
    for emo in ('angry', 'sad', 'relaxed', 'surprised'):        # mouth only (the eyes stay neutral in this prototype)
        if emo in mcells: bind(getattr(p, emo), [], emo, True); getattr(p, emo).override_mouth = 'block'
    for vis in ('aa', 'ih', 'ou', 'ee', 'oh'):
        if vis in mcells: bind(getattr(p, vis), [], vis, True)
    la = v1.look_at
    if GAZE == 'uv':
        # lookLeft/Right/Up/Down shift the iris texture (offset only). Weight 1 = the largest shift, reached when the
        # target is 30 deg off (horizontal) / 20 deg (vertical); the shift keeps the iris inside the opening.
        la.type = 'expression'
        for rm, inp in ((la.range_map_horizontal_inner, 30.0), (la.range_map_horizontal_outer, 30.0), (la.range_map_vertical_up, 20.0), (la.range_map_vertical_down, 20.0)):
            rm.input_max_value = inp; rm.output_scale = 1.0
        du, dv = GAZE_H * K / CW, GAZE_V * K / CH       # texture fraction; content moves by -offset (glTF v grows down)
        for expr, off in ((p.look_left, (-du, 0.0)), (p.look_right, (du, 0.0)), (p.look_up, (0.0, dv)), (p.look_down, (0.0, -dv))):
            expr.morph_target_binds.clear(); expr.texture_transform_binds.clear()
            b = expr.texture_transform_binds.add(); b.material = mats['iris']; b.scale = (1.0, 1.0); b.offset = off; expr.is_binary = False
        print('LOOKAT expression: iris shift mm h', GAZE_H * 1000, 'v', GAZE_V * 1000, 'uv offset', round(du, 4), round(dv, 4))
    else:
        la.type = 'bone'
        for rm, deg in ((la.range_map_horizontal_inner, 5.0), (la.range_map_horizontal_outer, 5.0), (la.range_map_vertical_up, 3.0), (la.range_map_vertical_down, 3.0)):
            rm.input_max_value = 90.0; rm.output_scale = deg
    hb = MR @ rig.data.bones['head'].head_local; mid = (eyes[0]['Q'] + eyes[1]['Q']) / 2
    la.offset_from_head_bone = (mid.x - hb.x, mid.z - hb.z, -(mid.y - hb.y))      # glTF axes: +Y up, +Z forward
    if GAZE == 'bone': print('LOOKAT bone, iris shift per degree mm', [round(ey['R'] * math.radians(1) * 1000, 2) for ey in eyes], 'offset', [round(v, 4) for v in la.offset_from_head_bone])
    # ---- export
    raw = Path(ref_vrm).read_bytes(); nj = struct.unpack_from('<I', raw, 12)[0]
    keep = {node['name'] for node in json.loads(raw[20:20 + nj])['nodes'] if 'mesh' in node} | {eo.name}
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
    print('EXPRESSIONS', {k: (len(v.get('morphTargetBinds', [])), len(v.get('textureTransformBinds', []))) for k, v in ex.items() if v.get('morphTargetBinds') or v.get('textureTransformBinds')})
    print('LOOKAT', vrm['lookAt'])
    print('MESHES', [(m_['name'], [len(pr.get('targets', [])) for pr in m_['primitives']]) for m_ in doc['meshes']])
    bpy.ops.wm.save_as_mainfile(filepath=str(out_blend))
    print('EXPORT', out_vrm, 'BLEND', out_blend, 'INSPECT', mt.inspect_vrm(out_vrm))


# --------------------------------------------------------------------------------------------------------- render
def render(OUT, oblique):
    # neutral at 4 angles with the shared camera script (OUT/obl), then neutral / blink / happy / gaze from the front
    # with the same camera at yaw 0 (OUT/expr); happy's mouth cell is shown by shifting the mouth UVs as the VRM
    # texture transform does, the gaze by turning the eye bones as VRM bone lookAt does
    import bpy, runpy
    from mathutils import Vector, Euler
    sys.argv = [sys.argv[0], '--', os.path.join(OUT, 'obl')]; runpy.run_path(oblique, run_name='__main__')
    sc = bpy.context.scene; cam = sc.camera
    h = bpy.data.objects['Head']; P = [h.matrix_world @ v.co for v in h.data.vertices]
    c = Vector((0, min(p.y for p in P), (min(p.z for p in P) + max(p.z for p in P)) / 2 + 0.01)); d = Vector((0, -1, 0.05)).normalized()
    cam.location = c + d * 0.75; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    eo = bpy.data.objects['EyeParts']; kb = eo.data.shape_keys.key_blocks
    rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE'); v1 = rig.data.vrm_addon_extension.vrm1; pre = v1.expressions.preset
    def uv_shift(mat, off, sign):                # what a VRM texture transform with offset (u, v) shows (Blender v is up)
        for obj in (h, eo):
            me_ = obj.data; uv = me_.uv_layers.active.data; slots = {i for i, m in enumerate(me_.materials) if m == mat}
            for poly in me_.polygons:
                if poly.material_index in slots:
                    for li in poly.loop_indices: uv[li].uv = (uv[li].uv[0] + sign * off[0], uv[li].uv[1] - sign * off[1])
    def express(name, sign):                     # apply (+1) / undo (-1) a preset expression at weight 1
        ex = getattr(pre, name)
        for b in ex.morph_target_binds: kb[b.index].value = 1.0 if sign > 0 else 0.0
        for b in ex.texture_transform_binds: uv_shift(b.material, tuple(b.offset), sign)
    def eyes_turn(yaw, pitch):                   # bone gaze: world-space turn applied in each bone's own space
        R = Euler((math.radians(pitch), 0, math.radians(yaw)), 'XYZ').to_matrix()
        for b in ('eye.L', 'eye.R'):
            pb = rig.pose.bones[b]; pb.rotation_mode = 'QUATERNION'; M = pb.bone.matrix_local.to_3x3()
            pb.rotation_quaternion = (M.inverted() @ R @ M).to_quaternion()
    bone = v1.look_at.type == 'bone'
    for name, expr, gaze in (('neutral', None, (0, 0)), ('blink', 'blink', (0, 0)), ('happy', 'happy', (0, 0)),
                             ('look_left', None if bone else 'look_left', (5, 0)), ('look_up', None if bone else 'look_up', (0, 3)),
                             ('look_right', None if bone else 'look_right', (-5, 0)), ('look_down', None if bone else 'look_down', (0, -3))):
        if expr: express(expr, 1)
        if bone: eyes_turn(*gaze)
        bpy.context.view_layer.update()
        sc.render.filepath = os.path.join(OUT, 'expr', name + '.png'); bpy.ops.render.render(write_still=True)
        if expr: express(expr, -1)
    eyes_turn(0, 0)


def compose(OUT):
    # OUT/obl/all.png (yaw 0/25/45/65, 400 px each, like face5/obl/all.png) and OUT/expr.png (neutral, blink, happy)
    from PIL import Image
    def row(paths, out):
        ims = [Image.open(p).convert('RGB').resize((400, 400), Image.LANCZOS) for p in paths]
        o = Image.new('RGB', (400 * len(ims), 400)); [o.paste(im, (400 * i, 0)) for i, im in enumerate(ims)]; o.save(out)
    row([os.path.join(OUT, 'obl', f'yaw{y}.png') for y in (0, 25, 45, 65)], os.path.join(OUT, 'obl', 'all.png'))
    row([os.path.join(OUT, 'expr', f'{n}.png') for n in ('neutral', 'blink', 'happy')], os.path.join(OUT, 'expr.png'))
    row([os.path.join(OUT, 'expr', f'{n}.png') for n in ('look_left', 'look_right', 'look_up', 'look_down')], os.path.join(OUT, 'gaze.png'))


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    if argv and argv[0] == 'prep': prep(*argv[1:4])
    elif argv and argv[0] == 'build': build(*argv[1:7])
    elif argv and argv[0] == 'render': render(*argv[1:3])
    elif argv and argv[0] == 'compose': compose(argv[1])
