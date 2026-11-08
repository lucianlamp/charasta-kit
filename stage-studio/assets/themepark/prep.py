"""image_gen の緑の背景を透明にする。town.png -> town_a.png、farband.png -> farband_a.png。python prep.py"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

d = Path(__file__).parent
for name in ('town', 'farband'):
    a = np.asarray(Image.open(d / f'{name}.png').convert('RGB')).astype(np.float32) / 255
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    key = np.clip((g - np.maximum(r, b) - 0.12) / 0.25, 0, 1)  # 緑の強さ
    alpha = 1 - key
    # 縁の緑かぶりを抜く
    g2 = np.minimum(g, np.maximum(r, b) * 1.02)
    rgb = np.stack([r, g2, b], -1)
    al = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    out = Image.fromarray((rgb * 255).astype(np.uint8))
    if name == 'town':  # 板の左右の端を消す。どの視点でも直線の切れ目が出ないように
        w_ = al.size[0]
        ramp = np.clip(np.minimum(np.arange(w_), w_ - 1 - np.arange(w_)) / (w_ * .1), 0, 1)
        ramp2 = np.clip((.72 - np.arange(w_) / w_) / .1, 0, 1)  # 丘の右端を観覧車の手前で終える
        al = Image.fromarray((np.asarray(al) * (ramp * ramp2)[None, :]).astype(np.uint8))
        # 街の窓の位置。ここに本物の小さな灯りを置く
        lit = (r > .75) & (g > .5) & (b < .62) & (alpha > .9)
        yy, xx = np.nonzero(lit)
        pick = np.random.default_rng(1).choice(len(xx), min(900, len(xx)), replace=False)
        np.savez(d / 'town_dots.npz', u=xx[pick] / r.shape[1], v=1 - yy[pick] / r.shape[0])
    out.putalpha(al)
    out.save(d / f'{name}_a.png')
    print(name, out.size, float(np.mean(alpha)))

# 木馬: 輪郭の内側に、縁からの距離に応じた厚みを付けた両面のメッシュを作り、horse_mesh.npz に保存する
from scipy import ndimage as ndi  # noqa: E402

a = np.asarray(Image.open(d / 'horse.png').convert('RGB')).astype(np.float32) / 255
r, g, b = a[..., 0], a[..., 1], a[..., 2]
mask = (g - np.maximum(r, b)) < 0.18
mask = ndi.binary_opening(mask, iterations=2)
lab, n = ndi.label(mask)
mask = lab == (np.argmax(ndi.sum(mask, lab, range(1, n + 1))) + 1)
mask = ndi.binary_fill_holes(mask) if False else mask
H, W = mask.shape
SIZE = 2.0  # 画像の幅に当たる長さ(m)
GRID = 320
m_px = SIZE / W
dist = ndi.distance_transform_edt(mask) * m_px
cell = SIZE / GRID
t = 0.5 * (np.sqrt(np.minimum(dist, 0.34)) - np.sqrt(cell * 0.75))
t = np.clip(t, 0, None)
t = ndi.gaussian_filter(t, 5) * (dist > cell * 0.75)
ys = (np.arange(GRID + 1) / GRID * (H - 1)).astype(int)
xs = (np.arange(GRID + 1) / GRID * (W - 1)).astype(int)
ins = mask[np.ix_(ys, xs)]
tt = t[np.ix_(ys, xs)]
idx = -np.ones(ins.shape, int)
idx[ins] = np.arange(ins.sum())
jj, ii = np.nonzero(ins)
bottom = jj.max()
X = ii * cell - SIZE / 2
Z = (bottom - jj) * cell + 0.12
T = tt[ins]
V = np.concatenate([np.stack([X, -T, Z], 1), np.stack([X, T, Z], 1)]).astype(np.float32)
UV = np.stack([xs[ii] / (W - 1), 1 - ys[jj] / (H - 1)], 1).astype(np.float32)
UV = np.concatenate([UV, UV])
q = ins[:-1, :-1] & ins[:-1, 1:] & ins[1:, :-1] & ins[1:, 1:]
a0, a1, a2, a3 = idx[:-1, :-1][q], idx[:-1, 1:][q], idx[1:, 1:][q], idx[1:, :-1][q]
nv = len(X)
F = np.concatenate([np.stack([a3, a2, a1, a0], 1), np.stack([a0, a1, a2, a3], 1) + nv])
np.savez(d / 'horse_mesh.npz', v=V, f=F.astype(np.int32), uv=UV)
print('horse', V.shape, F.shape, 'height', float(Z.max()))

# 水たまりの境目をなだらかにする
Image.open(d / 'puddle.png').convert('L').filter(ImageFilter.GaussianBlur(5)).save(d / 'puddle_s.png')

# 床のきらめきの粒: 暗い御影石の明るい粒だけを取り出し、粒ごとに金、薄紫、桃の色を付ける
g = np.asarray(Image.open(d / 'stone_dark.png').convert('L')).astype(np.float32) / 255
sp = g > np.percentile(g, 97.6)
lab, n = ndi.label(sp)
rng = np.random.default_rng(3)
pal = np.array([[1, .66, .26]] * 5 + [[1, .76, .4]] * 3 + [[.62, .55, 1], [1, .5, .7], [.5, .75, 1]], np.float32)
cols = pal[rng.integers(0, len(pal), n + 1)]
cols[0] = 0
out = (cols[lab] * 255).astype(np.uint8)
Image.fromarray(out).filter(ImageFilter.GaussianBlur(.7)).save(d / 'glint.png')
print('glint', n)

# 丸いボケの種: 小さな点をまばらに置く。金を主に、桃、紫、青を混ぜる
rd = np.random.default_rng(5)
S = 1254
dots = np.zeros((S, S, 3), np.float32)
palb = np.array([[1, .6, .16]] * 6 + [[1, .72, .3]] * 3 + [[1, .32, .6], [.6, .35, 1], [.6, .35, 1], [.28, .5, 1], [.28, .5, 1]], np.float32)
yy, xx = np.mgrid[0:S, 0:S]
for _ in range(300):
    cx, cy, rad = rd.integers(8, S - 8), rd.integers(8, S - 8), rd.uniform(2.2, 4.5)
    x0, y0 = cx - 8, cy - 8
    sub = (xx[y0:y0 + 16, x0:x0 + 16] - cx) ** 2 + (yy[y0:y0 + 16, x0:x0 + 16] - cy) ** 2 < rad * rad
    dots[y0:y0 + 16, x0:x0 + 16][sub] = palb[rd.integers(0, len(palb))] * rd.uniform(.5, 1)
Image.fromarray((dots * 255).astype(np.uint8)).save(d / 'bokeh_dots.png')
