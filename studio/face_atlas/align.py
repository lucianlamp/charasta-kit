# Line drawn face images up with the flat front render: the visible skin of both is matched (scale + shift).
# Usage: python align.py FACE_DIR IMG [IMG ...] [--same]
#   FACE_DIR holds with_hair.png from render_front.py; writes FACE_DIR/align.json {name: [scale, tx, ty]}
#   (render pixel = image pixel * scale + (tx, ty)) and FACE_DIR/align_<name>.png overlays to check by eye.
# Drawn faces of one character are generated one by one, so each is aligned on its own.
import sys, os, json
import numpy as np
from PIL import Image
D = sys.argv[1]; imgs = [a for a in sys.argv[2:] if not a.startswith('--')]
# --same: the images are edits of the first one on the same canvas (Codex edits keep the canvas), so they all take
# the first image's alignment; aligning each on its own gave 'sad' and 'aa' a 12% smaller scale and a wrong shift
SAME = '--same' in sys.argv
def skin(rgba):
    a = np.asarray(rgba.convert('RGBA')).astype(int); r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    return (al > 128) & (r > 170) & (r >= g) & (g >= b - 5) & (r - b > 20) & (r - g < 90)
R = Image.open(os.path.join(D, 'with_hair.png')); W = R.size[0]; N = 256; k = N / W
rs = np.asarray(Image.fromarray(skin(R).astype(np.uint8) * 255).resize((N, N), Image.BILINEAR)) > 127
res = json.load(open(os.path.join(D, 'align.json'))) if os.path.exists(os.path.join(D, 'align.json')) else {}
for k_, path in enumerate(imgs):
    if SAME and k_ > 0:
        res[os.path.splitext(os.path.basename(path))[0]] = res[os.path.splitext(os.path.basename(imgs[0]))[0]]; continue
    I = Image.open(path); name = os.path.splitext(os.path.basename(path))[0]; iw, ih = I.size
    im = skin(I); ys, xs = np.nonzero(im); ry, rx = np.nonzero(rs)
    # start: match the skin bounding boxes, then search scale and shift around it
    s0 = (np.ptp(rx) / k) / np.ptp(xs); best = None
    for s in s0 * np.linspace(0.8, 1.25, 46):
        small = np.asarray(Image.fromarray(im.astype(np.uint8) * 255).resize((max(1, int(iw * s * k)), max(1, int(ih * s * k))), Image.BILINEAR)) > 127
        sy, sx = np.nonzero(small)
        if not len(sx): continue
        cx0, cy0 = rx.mean() - sx.mean(), ry.mean() - sy.mean()
        for dx in range(-8, 9, 2):
            for dy in range(-8, 9, 2):
                ox, oy = int(round(cx0 + dx)), int(round(cy0 + dy))
                canvas = np.zeros((N, N), bool)
                y0, x0 = max(0, oy), max(0, ox); y1, x1 = min(N, oy + small.shape[0]), min(N, ox + small.shape[1])
                if y1 <= y0 or x1 <= x0: continue
                canvas[y0:y1, x0:x1] = small[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
                iou = (canvas & rs).sum() / max((canvas | rs).sum(), 1)
                if best is None or iou > best[0]: best = (iou, s, ox / k, oy / k)
    iou, s, tx, ty = best; res[name] = [float(s), float(tx), float(ty)]
    print('ALIGN', name, 'iou', round(float(iou), 3), 'scale', round(float(s), 4), 'shift', round(tx), round(ty))
    warped = I.convert('RGBA').resize((int(iw * s), int(ih * s)), Image.LANCZOS)
    over = Image.new('RGBA', R.size); over.paste(warped, (int(round(tx)), int(round(ty))))
    mix = Image.blend(R.convert('RGBA'), over, 0.5).convert('RGB').resize((1024, 1024)); mix.save(os.path.join(D, f'align_{name}.png'))
json.dump(res, open(os.path.join(D, 'align.json'), 'w'), indent=1)
