"""image_gen の画像から、床の高さ、水の量の図、遠景の透明な板を作る。python prep.py"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

d = Path(__file__).parent
NX, NY = 1100, 1160
EX, EY = 19.0, 20.0     # 床のメッシュの大きさ(m)。stages/rooftop.py の X0-.5..X1+.5、Y0-.5..Y1+.5
X0, Y0 = -9.5, -10.5
PATCH = (-1.6, 1.6, -4.7, -1.5)  # 手前の床の細かい図の範囲
BASIN = 8.5             # 水たまりの画像 1 枚の大きさ(m)
H, F = 825.0, 1050.0


def G(px, py):
    """target の画素に写る床の点"""
    z = .5 * F / (py - H)
    return (px - 470.5) / F * z, -5 + z


def gray(name):
    return np.asarray(Image.open(d / name).convert('L')).astype(np.float32) / 255


def tile(a, x, y, size):
    h, w = a.shape
    return ndi.map_coordinates(a, [(y / size % 1) * h, (x / size % 1) * w], order=1, mode='wrap')


def tri(x):
    return np.abs((x % 2) - 1)


b = ndi.gaussian_filter(gray('floor_basin.png'), 6)
b = (b - b.min()) / (b.max() - b.min())
gy, gx = np.meshgrid(np.linspace(Y0, Y0 + EY, NY), np.linspace(X0, X0 + EX, NX), indexing='ij')
basin = ndi.map_coordinates(b, [tri(gy / BASIN + .3) * (b.shape[0] - 1), tri(gx / BASIN + .1) * (b.shape[1] - 1)], order=1)

# 手前の細かい図: 赤 = 水の量、緑 = この図を使う重み、青 = 亀裂
S = 1254
near = 1 - gray('near_cracks.png')
near = np.maximum(ndi.grey_erosion(ndi.gaussian_filter(near, .7), 11), ndi.gaussian_filter(1 - gray('near_sketch.png'), .7) * 1.05)  # 主な亀裂の幅を約 1.5cm にし、下絵の線は必ず残す
near = np.clip(near, 0, 1)
near = np.flipud(near)  # 行 0 を y の小さい側にする


def to_patch(px, py):
    x, y = G(px, py)
    return (x - PATCH[0]) / (PATCH[1] - PATCH[0]) * S, (y - PATCH[2]) / (PATCH[3] - PATCH[2]) * S


def poly(pts, v, im):
    ImageDraw.Draw(im).polygon([to_patch(*p) for p in pts], fill=v)


lv = Image.new('L', (S, S), 0)
poly([(150, 1228), (280, 1205), (520, 1222), (700, 1215), (860, 1240), (905, 1268), (840, 1300), (800, 1400), (650, 1462), (470, 1450), (300, 1400), (230, 1300)], 255, lv)
poly([(720, 1175), (800, 1160), (860, 1190), (850, 1215), (740, 1215)], 235, lv)
poly([(450, 1150), (560, 1128), (690, 1145), (680, 1180), (520, 1185)], 235, lv)
poly([(-60, 1040), (70, 1020), (170, 1060), (150, 1125), (40, 1130), (-60, 1110)], 235, lv)
lv = np.asarray(lv).astype(np.float32) / 255
yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
dx = ndi.gaussian_filter(ndi.map_coordinates(b, [yy % b.shape[0], (xx * 3) % b.shape[1]], order=1), 3)  # 輪郭を画像の起伏で揺らす
lv = ndi.map_coordinates(ndi.gaussian_filter(lv, 12), [yy + (dx - .5) * 60, xx + (dx[::-1] - .5) * 60], order=1, mode='nearest')
lv = np.clip(np.maximum(lv, .22 + .4 * np.clip(yy / S * 1.5 - .25, 0, 1) + (tile(b, xx / S * 3.2, yy / S * 3.2, 4.1) - .4) * .2), 0, 1)  # 手前ほど水膜が薄い
wy = np.clip(np.minimum(yy, S - 1 - yy) / 90, 0, 1) * np.clip(np.minimum(xx, S - 1 - xx) / 90, 0, 1)
wy = wy * wy * (3 - 2 * wy)
Image.fromarray((np.dstack([np.flipud(lv), np.flipud(wy), np.flipud(near)]) * 255).astype(np.uint8), 'RGB').save(d / 'near_map.png')

# 全体の水の量: 薄い水膜が基本で、target の床の奥に写らない所にだけ輪郭のある水たまりを置く
zone = (gy < -5.5) | (gy > 5.5) | (np.abs(gx) > 3.6)
lvl = float(np.percentile(basin, 20))
pud = np.clip((lvl - basin) / .04, 0, 1) * zone
film = .66 + (basin - .4) * .2
wet = np.clip(np.maximum(film, pud), 0, 1)
Image.fromarray((np.flipud(wet) * 255).astype(np.uint8)).save(d / 'floor_wet.png')

# 床の高さ: 平らな面に亀裂の溝を掘る
crack = 1 - ndi.gaussian_filter(tile(gray('floor_cracks.png'), gx, gy, 3.4), .6)
u = (gx - PATCH[0]) / (PATCH[1] - PATCH[0]) * (S - 1)
v = (gy - PATCH[2]) / (PATCH[3] - PATCH[2]) * (S - 1)
inp = (u > 0) & (u < S - 1) & (v > 0) & (v < S - 1)
w = np.where(inp, ndi.map_coordinates(wy, [v, u], order=1, mode='nearest'), 0)
nc = np.where(inp, ndi.map_coordinates(near, [v, u], order=1, mode='nearest'), 0)
crack = crack * (1 - w) + nc * w
# 亀裂で区切った板: 板ごとに少し高さを変える
rng = np.random.default_rng(3)
ct = gray('floor_cracks.png') > .5
lab, n = ndi.label(ndi.binary_erosion(ct, iterations=1))
val = rng.random(n + 1)[lab]
val = ndi.grey_dilation(val, 5)
sl = val[((gy / 3.4 % 1) * (ct.shape[0] - 1)).astype(int), ((gx / 3.4 % 1) * (ct.shape[1] - 1)).astype(int)]
nb = ndi.binary_dilation(near > .35, iterations=2)
lab2, n2 = ndi.label(~nb)
v2 = rng.random(n2 + 1)[lab2]
sl2 = np.where(inp, v2[np.clip(v, 0, S - 1).astype(int), np.clip(u, 0, S - 1).astype(int)], 0)
sl = sl * (1 - (w > .5)) + sl2 * (w > .5)
Image.fromarray((np.flipud(sl) * 255).astype(np.uint8)).save(d / 'floor_slab.png')
h = (-crack * .005 + (sl - .5) * .004) * np.clip((.9 - np.where(inp, ndi.map_coordinates(np.clip(lv, 0, 1), [v, u], order=1, mode='nearest'), 0) * w) / .2, 0, 1)  # 水たまりの中は平ら
np.save(d / 'floor_h.npy', h.astype(np.float32))
print('h', float(h.min()), float(h.max()), 'pud share', float((pud > .5).mean()))

# 骨材の法線: 高さの画像の傾きから作る。繰り返しの端も続く
hg = ndi.gaussian_filter(gray('concrete_height.png'), 1.0, mode='wrap')
nx_, ny_ = ndi.sobel(hg, 1, mode='wrap'), ndi.sobel(hg, 0, mode='wrap')
Image.fromarray((np.dstack([np.clip(.5 + nx_ * 2, 0, 1), np.clip(.5 - ny_ * 2, 0, 1), np.ones_like(hg)]) * 255).astype(np.uint8), 'RGB').save(d / 'floor_n.png')

# 雲: 塊の輪郭をぼかす
c = Image.open(d / 'clouds_a.png').convert('RGB')
a = np.asarray(c).astype(np.float32) / 255
a = ndi.gaussian_filter(a, (5, 5, 0))
Image.fromarray((a * 255).astype(np.uint8)).save(d / 'clouds_soft.png')
