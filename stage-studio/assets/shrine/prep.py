"""image_gen の単色の背景を透明にする。cedar_a.png、bush_a.png、treeline_a.png を作る。python prep.py"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

d = Path(__file__).parent


def key(name, out, kind, size=None):
    im = Image.open(d / f'{name}.png').convert('RGB')
    a = np.asarray(im).astype(np.float32) / 255
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    if kind == 'green':
        k = np.clip((g - np.maximum(r, b) - .14) / .22, 0, 1)
        g = np.minimum(g, np.maximum(r, b) * 1.05)
    else:
        k = np.clip((np.minimum(r, b) - g - .14) / .22, 0, 1)
        r = np.minimum(r, g * 1.3)
        b = np.minimum(b, g * 1.3)
    rgb = np.stack([r, g, b], -1)
    al = Image.fromarray(((1 - k) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(.7))
    res = Image.fromarray((rgb * 255).astype(np.uint8))
    res.putalpha(al)
    if size:
        res = res.resize(size, Image.LANCZOS)
    res.save(d / out)
    print(out, res.size, float(1 - k.mean()))


key('cedar_spray', 'cedar_a.png', 'green', (768, 768))
key('bush', 'bush_a.png', 'magenta', (512, 512))
key('treeline', 'treeline_a.png', 'green')
key('cedar_clump', 'clump_a.png', 'magenta', (1024, 683))
