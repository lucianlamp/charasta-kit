# Expressions of a face-atlas VRM from generated videos: one video per expression, starting from the neutral face.
#
#   python expr_video.py prep OPEN.png OUT.png
#       OPEN.png  the neutral lid cell without hair (atlas cell 0 with the border-connected black made white, or a
#                 bald base face)
#       OUT.png   OPEN padded to 16:9 (1280x720) for the video generator. A cell with a white outside is padded
#                 white; otherwise the sides repeat the skin just inside the edge row by row. Without padding the
#                 generator stretched the cell by different x / y scales.
#
#   python expr_video.py prep-closed OPEN.png CELL_OPEN.png CELL_CLOSED.png OUT.png
#       OPEN with the closed eyes of an atlas cell, as a keyframe for a generator that pins frames (Grok Build
#       reference_to_video: first/last frame = open, keyframe at 2 s = closed made the blink close to the cell's own
#       shape). Pad it with prep too.
#
#   python expr_video.py build IN.vrm OUT.vrm OPEN.png WORK_DIR --video NAME=VIDEO.mp4 [--video ...] [--inbetweens 4]
#       NAME is a preset expression of IN.vrm (blink, happy, angry, sad, relaxed, surprised). Each video starts at
#       OPEN; the expression's picture is the video's own (the frames farthest from the first one), pasted on the
#       neutral cell over the area that moves, so the drawn cell is replaced. blink also replaces the closed side
#       of blinkLeft / blinkRight. N in-between frames of each video become custom expressions NAME_1..N.
#       Writes OUT.vrm (the frames as layers moved by each expression's morph, blink_layers.py: an app that ramps
#       the value 0 -> 1 shows the in-betweens) and, in WORK_DIR/NAME/, frames/, cells/, mask.png, scores.csv, plus
#       WORK_DIR/sheet.png and WORK_DIR/atlas.vrm (the cells as texture-transform expressions, binary).
#
# Fixed choices (chara1 and chara3, 2026-10-28/29):
#   area that moves = every blob where frame 0 and the expression frame differ, grown and feathered, with OPEN's
#     lash always inside (it showed through the feather);
#   pasted skin = flat skin colour where the frame is only a shade off it and grey traces above the frame's own
#     lash, then scaled to the cell's slow shading (a lighter patch showed in three-vrm otherwise);
#   the eye opening of every pasted frame is transparent like the neutral cell's (opening_finder), so the eyeball
#     copies of blink_layers.py show through and the gaze moves during an expression;
#   the atlas is re-laid out in as many columns as keep it under 8192 px tall.
import csv, glob, io, json, math, os, struct, subprocess, sys
import numpy as np
from PIL import Image
from scipy import ndimage, optimize
from scipy.cluster.vq import kmeans2
from skimage.morphology import convex_hull_object
from skimage.transform import AffineTransform, warp

MAX_TEX = 8192


def load(p):
    return np.asarray(Image.open(p).convert('RGB'), np.float32) / 255


def save(a, p):
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(p)


def prep(src, dst):
    a = load(src); h, w = a.shape[:2]; W = round(h * 16 / 9); p = (W - w) // 2
    L = a[:, 12:40].mean(1, keepdims=True); R = a[:, w - 40:w - 12].mean(1, keepdims=True)
    # a cell cut out with a white outside (chara3) is padded white; repeating its edge made stripes of hair colour
    if (a[:, :40].min(2) > 0.93).mean() > 0.5: L = np.ones_like(L)
    if (a[:, w - 40:].min(2) > 0.93).mean() > 0.5: R = np.ones_like(R)
    b = np.concatenate([np.repeat(L, p, 1), a, np.repeat(R, W - w - p, 1)], 1)
    b[:, p:p + 12] = L; b[:, p + w - 12:p + w] = R          # the outermost columns are often off-colour
    Image.fromarray((b * 255 + 0.5).astype(np.uint8)).resize((1280, 720), Image.LANCZOS).save(dst)
    print('padded', w, h, '->', W, h, '-> 1280 720')


def prep_closed(op, cell_open, cell_closed, dst):
    # only the closed lash and the lines next to it are taken; the rest of the eye area becomes OPEN's skin colour,
    # so hair and the open eye's outline in the cells do not come along
    B = load(op); Oc = load(cell_open); Cc = load(cell_closed)
    d = np.abs(Oc - Cc).max(2) > 0.12
    lab, n = ndimage.label(ndimage.binary_dilation(d, iterations=4))
    s = ndimage.sum(np.ones_like(d), lab, range(1, n + 1)); keep = np.isin(lab, np.argsort(s)[-2:] + 1)
    reg = ndimage.binary_fill_holes(ndimage.binary_dilation(keep, iterations=30))
    m = ndimage.gaussian_filter(reg.astype(float), 6)[..., None]
    out_skin = ~ndimage.binary_dilation(reg, iterations=20)
    skin = np.median(B[out_skin], 0)
    cskin = np.median(Cc[out_skin & (Cc.min(2) < 0.93)], 0)
    C = np.clip(Cc * skin / np.maximum(cskin, 1e-3), 0, 1)
    # the whole eye area: where the open and closed lash overlap, the cells do not differ
    near = ndimage.gaussian_filter(ndimage.binary_dilation((Cc.mean(2) < 0.67) & reg, iterations=3).astype(float), 1.5)
    k = np.maximum(np.clip(1 - np.abs(C - skin).max(2) / 0.14, 0, 1), 1 - near)[..., None]
    save(B * (1 - m) + (C * (1 - k) + skin * k) * m, dst)


def warp_to(F, p, shape, sc=1):
    # output pixel (x, y) reads the frame at (sx*x + tx, sy*y + ty); returns the image and where it lies inside the frame
    sx, sy, tx, ty = p
    t = AffineTransform(matrix=np.array([[sx * sc, 0, tx], [0, sy * sc, ty], [0, 0, 1]]))
    inside = warp(np.ones(F.shape[:2]), t, output_shape=shape, order=0, mode='constant', cval=0) > 0.5
    return warp(F, t, output_shape=shape, mode='edge').astype(np.float32), inside


def register(F0, O, use):
    # frame 0 is OPEN itself, so everything that is not white outside the face is used. x and y scales are fitted
    # separately; Powell from a few starts (Nelder-Mead and phase correlation got stuck on the white cut-outs).
    H, W = O.shape[:2]; q = 2; Os, ms = O[::q, ::q], use[::q, ::q]
    def cost(p):
        Fw, ins = warp_to(F0, p, Os.shape[:2], q); m = ms & ins
        return ((Fw - Os) ** 2).sum(2)[m].mean() if m.sum() > 0.5 * ms.sum() else 1.0
    fw, fh = F0.shape[1] / W, F0.shape[0] / H; best = None
    for s0 in sorted({fw, fh, min(fw, fh), max(fw, fh)}):
        for sy0 in (s0, fh):
            p0 = [s0, sy0, (F0.shape[1] - s0 * W) / 2, (F0.shape[0] - sy0 * H) / 2]
            r = optimize.minimize(cost, p0, method='Powell', options={'xtol': 1e-3, 'ftol': 1e-9, 'maxiter': 4000})
            if best is None or r.fun < best.fun: best = r
    return best.x, float(np.sqrt(best.fun))


def green_mask(path, F):
    # an image_gen copy of the cell F (padded to a square on white) with the eye openings painted pure green: the
    # green area in cell pixels, moved by the shift that lays the copy's other pixels on F (phase correlation)
    if not os.path.exists(path): return None
    H, W = F.shape[:2]
    g = np.asarray(Image.open(path).convert('RGB').resize((W, W), Image.LANCZOS), np.float32)[(W - H) // 2:(W - H) // 2 + H] / 255
    gm = (g[..., 1] > 0.75) & (g[..., 0] < 0.4) & (g[..., 2] < 0.4)
    a = np.where(gm[..., None], F, g).mean(2); b = F.mean(2)
    R = np.fft.fft2(a - a.mean()) * np.conj(np.fft.fft2(b - b.mean())); r = np.fft.ifft2(R / (np.abs(R) + 1e-9)).real
    dy, dx = np.unravel_index(np.argmax(r), r.shape); dy = dy - H if dy > H // 2 else dy; dx = dx - W if dx > W // 2 else dx
    if abs(dy) > 20 or abs(dx) > 20: print('green mask', os.path.basename(path), 'shift too large', dy, dx); dy = dx = 0
    gm = ndimage.shift(gm.astype(float), (-dy, -dx), order=0) > 0.5
    print('green mask', os.path.basename(path), 'shift', dy, dx, 'px', int(gm.sum()))
    return ndimage.binary_opening(gm, iterations=2)


def lash_opening(hole, dark_t=0.5, look_up=60, smooth=31, min_area=0.4, min_iris=0.3):
    # OPENING=lash: per column of the hole, the opening starts below the first dark run from the top (the upper
    # lash; dark = mean < dark_t, searched from look_up px above the hole); the start rows are median-smoothed
    # over smooth columns (single lash strands reached down). The frame is cut only if the opening covers min_area
    # of the hole and min_iris of it is iris-red (R - G > 0.2): chara4's half-closed and closed frames and happy's
    # arcs fell below (opening 0.54-0.73 of the hole, red 0.00-0.18), the open ones were 0.68-0.99 and 0.34-0.44.
    cols = np.where(hole.any(0))[0]
    t0 = np.array([np.where(hole[:, x])[0].min() for x in cols]); t1 = np.array([np.where(hole[:, x])[0].max() for x in cols])
    def find(F):
        dark = F.mean(2) < dark_t; start = t0.copy()
        for i, x in enumerate(cols):
            a = max(0, t0[i] - look_up); r = np.where(dark[a:t1[i] + 1, x])[0] + a
            if len(r):
                br = np.where(np.diff(r) > 1)[0]; start[i] = (r[br[0]] if len(br) else r[-1]) + 1
        start = ndimage.median_filter(start, smooth, mode='nearest')
        m = np.zeros_like(hole)
        for i, x in enumerate(cols): m[start[i]:t1[i] + 1, x] = True
        m = ndimage.binary_opening(m & hole, iterations=3)
        if not m.any() or m.sum() < min_area * hole.sum() or ((F[..., 0] - F[..., 1]) > 0.2)[m].mean() < min_iris:
            return np.zeros_like(hole)
        return m
    return find


def opening_finder(O, hole):
    # the eye opening (iris and the white next to it) of a pasted frame, made transparent so the eyeball layer and
    # its gaze show there. Colours are learnt from OPEN: inside = where the neutral cell is transparent, outside = the
    # rest of the eye area (nearest of 12 k-means centres each). Each eye's blob becomes its convex hull, so the
    # highlights on the iris rim stay inside.
    zone = ndimage.binary_dilation(hole, iterations=60)
    ci = kmeans2(O[hole], 12, minit='++', seed=1)[0]; co = kmeans2(O[zone & ~hole], 12, minit='++', seed=1)[0]
    def find(F):
        x = F.reshape(-1, 3)
        near = lambda c: ((x[:, None] - c[None]) ** 2).sum(2).min(1)
        m = ndimage.binary_opening((near(ci) < near(co)).reshape(F.shape[:2]) & zone, iterations=2)
        lab, n = ndimage.label(m)
        if n == 0: return m
        s = ndimage.sum(m, lab, range(1, n + 1))
        m = np.isin(lab, np.where(s >= max(400, 0.15 * s.max()))[0] + 1)
        return convex_hull_object(ndimage.binary_closing(m, iterations=4)) if m.any() else m
    f0 = find(O); print('opening on OPEN vs the neutral hole: IoU', round(float((f0 & hole).sum() / (f0 | hole).sum()), 3))
    return find


def low(a, w, s=40):
    # slow shading of the skin: normalized gaussian over the skin pixels only
    return np.dstack([ndimage.gaussian_filter(a[..., k] * w, s) for k in range(3)]) / (ndimage.gaussian_filter(w, s)[..., None] + 1e-6)


def skin_weight(a, alpha=None):
    ok = np.ones(a.shape[:2], bool) if alpha is None else alpha > 0.98
    ref = np.median(a[ok], 0)
    return ((np.abs(a - ref).max(2) < 0.07) & ok).astype(float)


def analyse(name, video, O, work, nib):
    """Frames of one expression video in cell space: the expression frame, the picked in-betweens, the area."""
    wd = os.path.join(work, name); fdir = os.path.join(wd, 'frames'); os.makedirs(fdir, exist_ok=True)
    # the result is kept next to the frames (a rebuild with the same video, OPEN and nib reads it back)
    cache = os.path.join(wd, 'analysis.npz'); key = f'{os.path.getmtime(video)}|{O.shape}|{float(O.mean()):.6f}|{nib}'
    if os.path.exists(cache):
        z = np.load(cache)
        if str(z['key']) == key:
            print(name, 'analysis read from', cache)
            return {'C': z['C'], 'between': list(z['between']), 'M': z['M'], 'area': z['area'], 'mid': float(z['mid']), 'F0': z['F0']}
    if not glob.glob(os.path.join(fdir, '*.png')):
        subprocess.run(['ffmpeg', '-v', 'error', '-i', video, os.path.join(fdir, '%04d.png')], check=True)
    frames = sorted(glob.glob(os.path.join(fdir, '*.png')))
    H, W = O.shape[:2]; white = O.min(2) > 0.93

    F0raw = load(frames[0])
    P, rms = register(F0raw, O, ~white)
    F0w, ins0 = warp_to(F0raw, P, (H, W)); use = ~white & ins0
    gain = [np.polyfit(F0w[..., c][use], O[..., c][use], 1) for c in range(3)]
    colour = lambda F: np.clip(np.stack([F[..., c] * gain[c][0] + gain[c][1] for c in range(3)], 2), 0, 1).astype(np.float32)
    V = [colour(warp_to(load(p), P, (H, W))[0]) for p in frames]
    print(name, 'frame', F0raw.shape[1], F0raw.shape[0], '-> cell', W, H, 'transform', np.round(P, 4), 'rms', round(rms, 4))

    # the expression frame: every video changes into the expression and holds it to the end (the blink too: it closes
    # and stays closed; opening plays the same frames backwards). It is the middle of the final run of frames close
    # to the last one; surprised opened wider for a moment and then settled, so the peak is not used.
    d = np.array([np.abs(F - V[-1]).max(2)[use].mean() for F in V])     # distance to the last frame
    k = len(V) - 1
    while k > 1 and d[k - 1] <= 0.15 * d[0]: k -= 1
    run = np.arange(k, len(V)); ci = int(run[len(run) // 2]); C = V[ci]

    # the area that moves: every blob where frame 0 and the expression frame differ, grown and feathered
    diff = np.abs(C - V[0]).max(2) > 0.12
    lab, n = ndimage.label(ndimage.binary_dilation(diff & ~white, iterations=4))
    sizes = ndimage.sum(np.ones_like(diff), lab, range(1, n + 1))
    keep = np.isin(lab, np.where(sizes >= 0.05 * sizes.max())[0] + 1)
    dark = (O.mean(2) < 0.45) | (C.mean(2) < 0.45)
    area = ndimage.binary_fill_holes(ndimage.binary_dilation(keep | (dark & ndimage.binary_dilation(keep, iterations=30)), iterations=22))
    eyes = np.isin(lab, np.argsort(sizes)[-2:] + 1)          # the two largest blobs are the eyes
    lash = (O.mean(2) < 0.3) & ndimage.binary_dilation(eyes, iterations=10)
    M = np.maximum(ndimage.gaussian_filter(area.astype(float), 10),
                   ndimage.gaussian_filter(ndimage.binary_dilation(lash, iterations=8).astype(float), 2))
    skin = np.median(O[~white & ~ndimage.binary_dilation(area, iterations=20)], 0)

    def clean(F):
        # shade-off-skin pixels and grey traces above the frame's own upper lash become skin; lid crease lines are
        # more orange than the skin, so they stay
        k = np.clip(1 - np.abs(F - skin).max(2) / 0.05, 0, 1)
        lf = (F.mean(2) < 0.3) & area; ft = np.full(W, H)
        for x in np.where(lf.any(0))[0]: ft[x] = np.where(lf[:, x])[0].min()
        above = np.arange(H)[:, None] < ft[None, :] - 2
        k = np.maximum(k, np.clip((F[..., 2] - (skin[2] - 0.06)) / 0.04, 0, 1) * above)[..., None]
        return F * (1 - k) + skin * k

    # the in-betweens: distinct pictures on the way, nearest to evenly spaced progress
    # progress = how far a frame has moved from frame 0 towards the expression frame (projection of its change on the
    # change of the expression frame). A ratio of distances d0 / (d0 + dC) bunched the frames around 0.5: the
    # in-betweens picked by it barely differed from the open eye, and the eye then closed in one step at 0.6.
    D = (C - V[0])[area]; DD = float((D * D).sum()) + 1e-9
    cl = np.array([float(((F - V[0])[area] * D).sum()) / DD for F in V])
    # the generator repeats a picture for a few frames: a new picture starts where the progress changes
    # (a frame barely off the neutral one is no use as an in-between)
    # only the last rise into the expression: back from the held run while the progress keeps falling (chara3's
    # surprised video first did something else for 15 frames at a progress of 0.4, came back to 0.18 and then rose)
    k0 = run[0] - 1
    while k0 > 1 and cl[k0 - 1] <= cl[k0] + 0.02 * cl[ci]: k0 -= 1
    going = [i for i in range(max(1, k0), run[0]) if 0.1 < cl[i] / cl[ci] < 0.97 and abs(cl[i] - cl[i - 1]) > 0.01]
    # frames off the way: the part of a frame's change that is not along the expression's change (chara3's surprised
    # video blinked once on the way; its closed-eye frames had a progress of 0.2 to 0.6 and were picked)
    off = np.array([float(np.sqrt((((F - V[0])[area] - cl[i] * D) ** 2).sum() / DD)) for i, F in enumerate(V)])
    if going:
        lim = max(0.3, 2 * float(np.median(off[going])))
        dropped = [i for i in going if off[i] > lim]; going = [i for i in going if off[i] <= lim]
        if dropped: print(name, 'off the way (dropped):', dropped, np.round(off[dropped], 2).tolist(), 'limit', round(lim, 2))
    picks = []
    for t in np.arange(1, nib + 1) / (nib + 1):
        cand = [i for i in going if i not in picks]
        if cand: picks.append(min(cand, key=lambda i: abs(cl[i] / cl[ci] - t)))
    picks.sort(key=lambda i: cl[i])     # in order of progress (chara3 surprised jumped to 0.4 at frame 4, then fell back)
    with open(os.path.join(wd, 'scores.csv'), 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['frame', 'progress', 'off', 'distinct', 'picked'])
        w.writerows([(i, round(float(cl[i]), 4), round(float(off[i]), 3), i in going, 'expression' if i == ci else i in picks) for i in range(len(V))])
    print(name, 'expression frame', ci, 'in-betweens', picks, [round(float(cl[i] / cl[ci]), 3) for i in picks])
    save(np.dstack([M] * 3), os.path.join(wd, 'mask.png'))
    xs = np.where(area.any(0))[0]; mid = (xs.min() + xs.max()) / 2
    out = {'C': clean(C), 'between': [clean(V[i]) for i in picks], 'M': M, 'area': area, 'mid': mid, 'F0': clean(V[0])}
    np.savez(cache, key=key, C=out['C'], between=np.array(out['between'], np.float32).reshape(-1, H, W, 3), M=M, area=area, mid=mid, F0=out['F0'])
    return out


def face_open(face_dir, dst):
    # OPEN for a face with a mouth region: the head's bare skin (render_front.py skin.png) over the box around the
    # upper and mouth regions, with the neutral cell of each atlas (atlas.py, full drawing) laid in at its bbox
    reg = json.load(open(os.path.join(face_dir, 'regions.json')))
    skin = Image.open(os.path.join(face_dir, 'skin.png')).convert('RGBA')
    x0, y0, x1, y1 = face_box(reg)
    for r in ('upper', 'mouth'):
        a = Image.open(os.path.join(face_dir, f'atlas_{r}.png')).convert('RGBA'); n = len(reg[r]['cells'])
        bx0, by0, bx1, by1 = reg[r]['bbox']; cell = a.crop((0, 0, a.width, a.height // n))
        # outside the head the cell holds black (no texture there): keep the skin render's own coverage
        cell.putalpha(Image.fromarray(np.minimum(np.asarray(cell)[..., 3], np.asarray(skin)[by0:by1, bx0:bx1, 3])))
        skin.alpha_composite(cell, (bx0, by0))
    out = Image.new('RGBA', (x1 - x0, y1 - y0), (255, 255, 255, 255)); out.alpha_composite(skin.crop((x0, y0, x1, y1)))
    out.convert('RGB').save(dst); print('OPEN', dst, out.size, 'box', [x0, y0, x1, y1])


def face_box(reg):
    b = [reg[r]['bbox'] for r in ('upper', 'mouth') if r in reg]
    return min(v[0] for v in b), min(v[1] for v in b), max(v[2] for v in b), max(v[3] for v in b)


def build(src, dst, op, work, videos, nib, face_dir=None):
    O = load(op); H, W = O.shape[:2]
    os.makedirs(work, exist_ok=True)
    res = {}
    for name, video in videos:
        res[name] = analyse(name, video, O, work, nib)

    # the VRM: atlas cells of each face region material
    b = open(src, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + n]); bin0 = 20 + n + 8
    blob = b[bin0:bin0 + struct.unpack('<I', b[20 + n:24 + n])[0]]
    def view(i):
        v = j['bufferViews'][i]; o = v.get('byteOffset', 0); return blob[o:o + v['byteLength']]
    mats = {m['name']: i for i, m in enumerate(j['materials'])}
    SHADE = mats.get('EyeShade')
    # regions: (material, slice of OPEN). Without FACE_DIR the OPEN is the Face_upper cell itself (chara1, chara3);
    # with it (a face with a mouth, chara4) the OPEN covers both regions and each takes its bbox out of it
    if face_dir:
        reg = json.load(open(os.path.join(face_dir, 'regions.json'))); fx0, fy0, _, _ = face_box(reg)
        regions = []
        for r, mname in (('upper', 'Face_upper'), ('mouth', 'Face_mouth')):
            if r in reg and mname in mats:
                bx0, by0, bx1, by1 = reg[r]['bbox']; regions.append((mname, (slice(by0 - fy0, by1 - fy0), slice(bx0 - fx0, bx1 - fx0))))
    else:
        regions = [('Face_upper', (slice(0, H), slice(0, W)))]
    tex_img = lambda mi: j['textures'][j['materials'][mi]['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    img_rgba = lambda ii: np.asarray(Image.open(io.BytesIO(view(j['images'][ii]['bufferView']))).convert('RGBA'), np.float32) / 255
    ex = j['extensions']['VRMC_vrm']['expressions']
    for name in res: assert name in ex.get('preset', {}), f'{name} is not a preset expression of {src}'
    # the EyeShade cell of a drawn expression (chara3 relaxed: the dark band under the lid) belongs to the old picture;
    # the video's frame has its own shading, so that bind goes and the expression can blend in blink_layers.py
    if SHADE is not None:
        for name in list(res) + (['blinkLeft', 'blinkRight'] if 'blink' in res else []):   # the winks show the blink's frames
            if name not in ex['preset']: continue
            e = ex['preset'][name]; e['textureTransformBinds'] = [t for t in e['textureTransformBinds'] if t['material'] != SHADE]

    def paste(base, F, m):
        # F scaled to the base cell's slow skin shading, then pasted with m; opaque where pasted
        sb = skin_weight(base[..., :3], base[..., 3]); sf = skin_weight(F)
        F = np.clip(F * low(base[..., :3], sb) / np.maximum(low(F, sf), 1e-3), 0, 1)
        rgb = base[..., :3] * (1 - m[..., None]) + F * m[..., None]
        return np.dstack([rgb, np.where(m > 0.01, 1.0, base[..., 3])]).astype(np.float32)
    def png(a):
        f = io.BytesIO(); Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(f, 'PNG', optimize=True); return f.getvalue()

    replace, uv_moves, custom_binds, sheet_rows = {}, {}, {}, []
    for mname, (sy, sx) in regions:
        LID = mats[mname]; MATS = [LID] + ([SHADE] if SHADE is not None and mname == 'Face_upper' else [])
        lid_i = tex_img(LID); lid = img_rgba(lid_i).copy()
        vs = [t['offset'][1] for g in ('preset', 'custom') for e in ex.get(g, {}).values() for t in e.get('textureTransformBinds', [])
              if t['material'] == LID and t['offset'][1] > 1e-6]
        old = round(1 / min(vs))
        assert lid.shape[0] % old == 0 and round(max(vs) * old) < old, f'{mname} atlas is not one column of equal cells'
        ch = lid.shape[0] // old; cw = lid.shape[1]
        Hs, Ws = sy.stop - sy.start, sx.stop - sx.start
        assert (ch, cw) == (Hs, Ws), f'{mname}: the OPEN part is {Ws}x{Hs} but the atlas cells are {cw}x{ch}'
        def cellof(name):
            t = [t['offset'][1] for t in ex['preset'][name].get('textureTransformBinds', []) if t['material'] == LID]
            return round(t[0] * old) if t else None
        lid0 = lid[:ch].copy()
        cell = lambda k: lid[k * ch:(k + 1) * ch]
        # the eye openings of the pasted frames become transparent like the neutral cell's, so the gaze moves during an
        # expression (blink_layers.py puts an eyeball copy behind every layer)
        hole = lid0[..., 3] < 0.5
        # OPENING=lash (chara4): the colour split of opening_finder took chara4's cream eye white for skin and cut the
        # closed lids of blink and happy open (the eyeball showed through them), and a difference from the video's
        # first frame could not tell the closed lash from the pupil either. Here the opening is the neutral hole
        # below the frame's upper lash, and a frame is cut only when that is most of the hole and shows the iris;
        # nearly closed and closed frames stay opaque (the gaze does not move behind them).
        LASH = os.environ.get('OPENING') == 'lash'
        # OPENING_MASKS=DIR: the eye opening of each frame painted green by image_gen (preferred; the user: masks are
        # image_gen's job). DIR/out_NAME_between_K.png and out_NAME_expression.png, made from the saved cells padded
        # to a square (see references/face_atlas.md); a frame without its file stays opaque.
        MDIR = os.environ.get('OPENING_MASKS') if mname == 'Face_upper' else None
        find = None if MDIR or not hole.any() else lash_opening(hole) if LASH else opening_finder(O[sy, sx], hole)
        def cut(c, F, m, key=None):
            if MDIR:
                g = green_mask(os.path.join(MDIR, f'out_{key}.png'), F)
                # OPENING_GROW=N: the green may go N px beyond the neutral hole (chara4's drawn surprised opens wider; inside
                # the hole only, the drawing's own iris top stayed above the moving iris)
                lim = ndimage.binary_dilation(hole, iterations=int(os.environ.get('OPENING_GROW', 0))) if os.environ.get('OPENING_GROW') else hole
                if g is not None: c[..., 3] = np.where(g & lim & (m > 0.01), 0, c[..., 3])
                return c
            # (OPENING=lash: down to m > 0.01, where paste made the cell opaque; at 0.5 bits of the neutral iris under
            # the feather of m stayed drawn inside the opening)
            if find is not None: c[..., 3] = np.where(find(F) & (m > (0.01 if LASH else 0.5)), 0, c[..., 3])
            return c
        sheet = [('neutral', lid0[..., :3])]; new, customs = [], []
        for name, r in res.items():
            k = cellof(name)
            if k is None: continue                                  # this expression does not show this region
            C, M = r['C'][sy, sx], r['M'][sy, sx]; ckey = f'{name}_expression'; tone = lambda F: F
            # EXPR_DRAWN=DIR (chara4): the expression cell is the image_gen drawing itself (DIR/NAME.png, made like
            # OPEN by face-open from the drawing's atlas), and the in-betweens get the drawing's line darkness: per
            # channel, the video's expression frame is mapped onto the drawing by quantiles over the moving area. The
            # Grok frames (720p, enlarged about 2x) had soft, light lashes that looked see-through next to the drawn
            # neutral. The image_gen eye-opening mask of the drawing is out_NAME_drawn.png.
            dp = os.path.join(os.environ['EXPR_DRAWN'], f'{name}.png') if os.environ.get('EXPR_DRAWN') else ''
            if os.path.exists(dp):
                Cd = load(dp)[sy, sx]; ar = r['area'][sy, sx]
                if ar.sum() > 500:
                    q = np.linspace(0, 1, 65)
                    qs = [(np.quantile(C[..., c][ar], q), np.quantile(Cd[..., c][ar], q)) for c in range(3)]
                    # only on the lines (mean below 0.75, fully below 0.55): mapped skin came out blotchy around the brows
                    def tone(F, qs=qs):
                        T = np.stack([np.interp(F[..., c], *qs[c]) for c in range(3)], 2)
                        w = np.clip((0.75 - F.mean(2)) / 0.2, 0, 1)[..., None]
                        return (F * (1 - w) + T * w).astype(np.float32)
                C, ckey = Cd, f'{name}_drawn'
                M = np.maximum(M, ((lid0[..., 3] > 0.5) | hole).astype(np.float32))   # the whole drawn cell
            lid[k * ch:(k + 1) * ch] = cut(paste(lid0, C, M), C, M, ckey)   # the drawn cell is replaced
            save(cell(k)[..., :3], os.path.join(work, name, f'expression_{mname}.png'))
            Mb = r['M'][sy, sx]
            for i, F in enumerate(r['between']):
                F = tone(F[sy, sx]); c = cut(paste(lid0, F, Mb), F, Mb, f'{name}_between_{i + 1}'); new.append(c); customs.append(f'{name}_{i + 1}')
                save(c[..., :3], os.path.join(work, name, f'between_{i + 1}_{mname}.png'))
                sheet.append((f'{name}_{i + 1}', c[..., :3]))
            sheet.append((name, cell(k)[..., :3]))
            if name == 'blink':
                for wn in ('blinkLeft', 'blinkRight'):
                    kw = cellof(wn) if wn in ex['preset'] else None
                    if kw is None: continue
                    half = (np.arange(Ws)[None, :] < r['mid'] - sx.start).repeat(Hs, 0)
                    # the closed side of the drawn wink: the half that differs more from the neutral cell
                    s = half if np.abs(cell(kw)[..., :3] - lid0[..., :3]).max(2)[half].mean() >= \
                        np.abs(cell(kw)[..., :3] - lid0[..., :3]).max(2)[~half].mean() else ~half
                    mw = M * ndimage.gaussian_filter(s.astype(float), 4)
                    lid[kw * ch:(kw + 1) * ch] = cut(paste(lid0, C, mw), C, mw, ckey)
                    sheet.append((wn, cell(kw)[..., :3]))
        sheet_rows.append((mname, sheet))

        # re-layout: as many columns as keep the atlas under MAX_TEX px tall
        total = old + len(new); cols = math.ceil(total / (MAX_TEX // ch)); rows = math.ceil(total / cols)
        slot = lambda k, rows=rows: (k // rows, k % rows)
        def relayout(a, extra):
            out = np.zeros((rows * ch, cols * cw, 4), np.float32)
            for k in range(cols * rows):
                c = a[k * ch:(k + 1) * ch] if k < old else extra[k - old] if k < total else a[:ch]
                col, row = slot(k); out[row * ch:(row + 1) * ch, col * cw:(col + 1) * cw] = c
            return out
        replace[j['images'][lid_i]['bufferView']] = png(relayout(lid, new))
        if LID != MATS[-1]:
            sh_i = tex_img(SHADE); shade = img_rgba(sh_i); clear = np.zeros((ch, cw, 4), np.float32)
            replace[j['images'][sh_i]['bufferView']] = png(relayout(shade, [clear] * len(new)))
        uv_acc = {p['attributes']['TEXCOORD_0'] for m in j['meshes'] for p in m['primitives'] if p['material'] in MATS}
        for m in j['meshes']:
            for p in m['primitives']:
                if p['material'] not in MATS: assert p['attributes'].get('TEXCOORD_0') not in uv_acc, 'shared UV accessor'
        for a in uv_acc:
            ac = j['accessors'][a]; bv = j['bufferViews'][ac['bufferView']]
            assert ac['componentType'] == 5126 and 'byteStride' not in bv
            uv = np.frombuffer(view(ac['bufferView']), np.float32, ac['count'] * 2, ac.get('byteOffset', 0)).reshape(-1, 2).copy()
            assert uv[:, 1].max() <= 1 / old + 1e-3, 'UVs outside cell 0'
            uv[:, 0] /= cols; uv[:, 1] *= old / rows
            raw = bytearray(view(ac['bufferView'])); o = ac.get('byteOffset', 0)
            raw[o:o + uv.nbytes] = uv.tobytes(); replace[ac['bufferView']] = bytes(raw)
            ac['min'] = uv.min(0).tolist(); ac['max'] = uv.max(0).tolist()
        for grp in ('preset', 'custom'):
            for e in ex.get(grp, {}).values():
                for t in e.get('textureTransformBinds', []):
                    if t['material'] in MATS:
                        i = round(t['offset'][1] * old); assert abs(t['offset'][0]) < 1e-6 and abs(t['offset'][1] * old - i) < 1e-3
                        col, row = slot(i); t['offset'] = [col / cols, row / rows]
        for k, cname in enumerate(customs):
            col, row = slot(old + k)
            custom_binds.setdefault(cname, []).extend({'material': mi, 'offset': [col / cols, row / rows], 'scale': [1, 1]} for mi in MATS)
        print(mname, 'cells', total, 'layout', cols, 'x', rows, 'atlas', cols * cw, rows * ch)
    custom = ex.setdefault('custom', {})
    for cname, binds in custom_binds.items():
        custom[cname] = {'isBinary': True, 'overrideBlink': 'none', 'overrideLookAt': 'none', 'overrideMouth': 'none', 'textureTransformBinds': binds}
    out = bytearray()
    for i, v in enumerate(j['bufferViews']):
        data = replace.get(i, view(i))
        while len(out) % 4: out += b'\0'
        v['byteOffset'] = len(out); v['byteLength'] = len(data); out += data
    while len(out) % 4: out += b'\0'
    j['buffers'][0]['byteLength'] = len(out)
    js = json.dumps(j, separators=(',', ':')).encode()
    while len(js) % 4: js += b' '
    glb = (struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(out)) + struct.pack('<I4s', len(js), b'JSON') + js
           + struct.pack('<I4s', len(out), b'BIN\0') + out)
    atlas_vrm = os.path.join(work, 'atlas.vrm')
    open(atlas_vrm, 'wb').write(glb)
    print('custom', sorted(custom_binds), 'size', len(glb))

    # standard output: the frames as layers moved by each expression's morph
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import blink_layers
    blink_layers.apply(atlas_vrm, dst)

    # sheet: per region, the rows of every cell made here that differ
    imgs = []
    for mname, sheet in sheet_rows:
        diff = np.zeros(sheet[0][1].shape[:2], bool)
        for _, t in sheet: diff |= np.abs(t - sheet[0][1]).max(2) > 0.05
        if not diff.any(): continue
        ys = np.where(diff.any(1))[0]; Hs = diff.shape[0]; y0, y1 = max(ys.min() - 40, 0), min(ys.max() + 20, Hs)
        tiles = [Image.fromarray((t[y0:y1] * 255).astype(np.uint8)).resize((t.shape[1] // 3, max((y1 - y0) // 3, 1))) for _, t in sheet]
        tw, th = tiles[0].size; per = nib + 2
        img = Image.new('RGB', (tw * per, th * math.ceil(len(tiles) / per)), 'white')
        for i, t in enumerate(tiles): img.paste(t, ((i % per) * tw, (i // per) * th))
        imgs.append(img)
    if imgs:
        Wm = max(i.width for i in imgs); sheet_img = Image.new('RGB', (Wm, sum(i.height for i in imgs)), 'white'); y = 0
        for i in imgs: sheet_img.paste(i, (0, y)); y += i.height
        sheet_img.save(os.path.join(work, 'sheet.png'))


if __name__ == '__main__':
    a = sys.argv[1:]
    nib = 4; videos = []; face_dir = None
    if '--inbetweens' in a:
        i = a.index('--inbetweens'); nib = int(a[i + 1]); del a[i:i + 2]
    if '--face-dir' in a:
        i = a.index('--face-dir'); face_dir = a[i + 1]; del a[i:i + 2]
    while '--video' in a:
        i = a.index('--video'); nm, vp = a[i + 1].split('=', 1); videos.append((nm, vp)); del a[i:i + 2]
    if a[0] == 'prep': prep(*a[1:3])
    elif a[0] == 'prep-closed': prep_closed(*a[1:5])
    elif a[0] == 'face-open': face_open(*a[1:3])
    elif a[0] == 'build':
        if not videos: sys.exit('give at least one --video NAME=VIDEO.mp4')
        build(*a[1:5], videos, nib, face_dir)
    else: sys.exit('usage: see the top of this file')
