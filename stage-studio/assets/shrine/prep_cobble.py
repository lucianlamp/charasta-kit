"""image_gen の高さの絵から濡れた石の法線を作る。絵の端はつながる。python prep_cobble.py [強さ]"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ni

d = Path(__file__).parent
k = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
a = np.asarray(Image.open(d / 'cobble_height.png').convert('L').resize((1024, 1024), Image.LANCZOS)).astype(np.float32) / 255
a = a - ni.gaussian_filter(a, 60, mode='wrap')  # 大きな明暗は使わない
a = ni.gaussian_filter(a, 4.5, mode='wrap')  # 細かい揺れは粒に出るので落とし、滑らかな丸い面だけ残す
lo, hi = np.percentile(a, (1, 99))
Image.fromarray((np.clip((a - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)).save(d / 'cobble_soft.png')  # 光る頂を選ぶ滑らかな高さ
gx = (np.roll(a, -1, 1) - np.roll(a, 1, 1)) / 2
gy = (np.roll(a, 1, 0) - np.roll(a, -1, 0)) / 2  # 画像の上が +V
n = np.stack([-gx * k * 40, -gy * k * 40, np.ones_like(a)], -1)
n /= np.linalg.norm(n, axis=2, keepdims=True)
print('rms slope xy', float(np.sqrt((n[..., :2] ** 2).mean())))
Image.fromarray(((n * .5 + .5) * 255).astype(np.uint8)).save(d / 'cobble_n.png')
