"""image_gen の絵を場面用に整える。単色の背景を透明にし、床のテクスチャの継ぎ目を消す。python prep.py"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

d = Path(__file__).parent


def key(name, out, size=None, crop=None):
    im = Image.open(d / f'{name}.png').convert('RGB')
    a = np.asarray(im).astype(np.float32) / 255
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    k = np.clip((np.minimum(r, b) - g - .1) / .2, 0, 1)
    r = np.minimum(r, g * 1.3)
    b = np.minimum(b, g * 1.15)
    rgb = np.stack([r, g, b], -1)
    al = Image.fromarray(((1 - k) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(.7))
    res = Image.fromarray((rgb * 255).astype(np.uint8))
    res.putalpha(al)
    if crop:
        res = res.crop(crop)
    if size:
        res = res.resize(size, Image.LANCZOS)
    res.save(d / out)
    print(out, res.size, float(1 - k.mean()))


def tile(name, out, size=1024, band=.12):
    """上下と左右の端を、半周ずらした絵へなめらかに移す。絵の端の境をなくす"""
    a = np.asarray(Image.open(d / f'{name}.png').convert('RGB').resize((size, size), Image.LANCZOS)).astype(np.float32)
    for axis in (0, 1):
        shifted = np.roll(a, size // 2, axis)
        t = np.linspace(0, 1, size)
        w = np.clip(np.minimum(t, 1 - t) / band, 0, 1)
        w = w * w * (3 - 2 * w)
        w = w[:, None, None] if axis == 0 else w[None, :, None]
        a = a * w + shifted * (1 - w)
    Image.fromarray(a.astype(np.uint8)).save(d / out)
    print(out)


key('keyaki_clump', 'clump_a.png', (1024, 683))
key('keyaki_under', 'under_a.png', (1024, 683))
key('treeline', 'treeline_a.png', crop=(0, 150, 1536, 880))
im = Image.open(d / 'treeline_a.png')  # 板を重ねて並べるので、左右の端を透明へ移す
a = np.asarray(im).astype(np.float32)
t = np.linspace(0, 1, im.width)
a[..., 3] *= np.clip(np.minimum(t, 1 - t) / .08, 0, 1)
Image.fromarray(a.astype(np.uint8)).save(d / 'treeline_a.png')
for n in ('gravel', 'lawn', 'soil', 'bark', 'granite'):
    tile(n, f'{n}_t.png')
