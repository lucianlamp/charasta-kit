"""image_gen の濡れ、亀裂、高さの画像から床全体の図を作る。python prep_floor.py
floor_map.png: 赤 = 水の量(0.5 が濡れと乾きの境目)、緑 = 鏡の水たまり、青 = 亀裂の深さ
floor_h.npy: メッシュの高さ。floor_n.png: 骨材の法線。線は引かない。亀裂は画像の線を細くして深さの図にするだけ。"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

d = Path(__file__).parent
NX, NY = 6144, 6468     # 1 画素 3.1mm
EX, EY = 19.0, 20.0
X0, Y0 = -9.5, -10.5
H, F = 825.0, 1050.0
WET_BIAS = .03


def G(px, py):
    """target の画素に写る床の点(m)"""
    z = .5 * F / (py - H)
    return (px - 470.5) / F * z, -5 + z


def gray(name):
    return np.asarray(Image.open(d / name).convert('L')).astype(np.float32) / 255


def tile(a, x, y, size, rot=0.0):
    """画像 a を size(m)の繰り返しで、z 軸に rot 回して床の点 x, y で読む"""
    c, s = np.cos(rot), np.sin(rot)
    u, v = (x * c - y * s) / size, (x * s + y * c) / size
    h, w = a.shape
    return ndi.map_coordinates(a, [(v % 1) * h, (u % 1) * w], order=1, mode='wrap').astype(np.float32)


gy, gx = np.meshgrid(np.linspace(Y0, Y0 + EY, NY, dtype=np.float32), np.linspace(X0, X0 + EX, NX, dtype=np.float32), indexing='ij')

wc = gray('wc_wet.png')
wc = np.clip(wc - np.median(wc) + .5, 0, 1)  # 濡れと乾きを半々にする
ch = gray('wc_height.png')
ca = 1 - gray('wc_crack_a.png')
cb = 1 - gray('wc_crack_b.png')
basin = ndi.gaussian_filter(gray('floor_basin.png'), 6, mode='wrap')
basin = (basin - basin.min()) / (basin.max() - basin.min())

# ---- 亀裂 ----
C_SIZE = 8.7
lo = np.maximum(tile(ca, gx, gy, C_SIZE, .21), tile(ca, gx[:, ::-1], gy, C_SIZE * 1.17, 1.33) * .9)  # 2 回の読みを重ねて繰り返しを隠す
fine = np.maximum.reduce([tile(cb, gx, gy, 2.9, .7), tile(cb, gx / 2.3, gy, 2.1, .03) * .9, tile(ca, gx / 3.1, gy, 3.3, .02) * 1.2])  # 2 回目は横へ伸ばして読む。横へ走る細い亀裂になる
wid = tile(wc, gx, gy, 3.7, 2.1)  # 亀裂の幅と深さの揺れ
lo = lo * (.55 + .9 * wid)  # 濡れの画像で場所ごとに切れて細る
near_ = .15 + .85 * np.clip((gy + 4.2) / 2.7, 0, 1)  # カメラの近くほど小さい
crack = np.clip((lo - (.36 + .3 * (1 - near_))) / .3, 0, 1)
crack = ndi.gaussian_filter(crack, .6)
fine = np.clip((fine - .4) / .4, 0, 1) * np.clip(.2 + 1.2 * (wid - .3), 0, 1) * .85
print('crack share', float((crack > .5).mean()))

# 亀裂で区切った板。隙間は太らせて閉じる
s_ = 4
closed = ndi.binary_dilation(crack[::s_, ::s_] > .25, iterations=5)
lab, n = ndi.label(~closed)
rng = np.random.default_rng(7)
val = rng.random(n + 1).astype(np.float32)
val[0] = .5
sl = val[lab]
idx = ndi.distance_transform_edt(lab == 0, return_distances=False, return_indices=True)
sl = sl[tuple(idx)]
sl = np.asarray(Image.fromarray(sl).resize((NX, NY), Image.NEAREST))
sl = ndi.gaussian_filter(sl, 2)
print('slabs', n)

# ---- 水たまり: 目標の位置の区画(値は水の深さ)。残りは屋上の全体に不規則に散らす ----
PX, PY = NX // 4, NY // 4


def to_map(p):
    x, y = G(*p)
    return (x - X0) / EX * PX, (y - Y0) / EY * PY


# 水位の図。区画ごとの値が高いほど水が床の高さを越える。低いと骨材の高い所が島になって残る
SECTIONS = [
    (1.0, [(150, 1226), (262, 1208), (400, 1262), (430, 1286), (402, 1322), (300, 1314), (172, 1304)]),
    (1.0, [(396, 1290), (480, 1262), (560, 1250), (700, 1270), (830, 1326), (882, 1400), (806, 1478), (640, 1466), (486, 1462), (424, 1380)]),
    (.8, [(-80, 1036), (70, 1016), (176, 1046), (186, 1126), (60, 1142), (-80, 1126)]),
    (.8, [(446, 1136), (560, 1122), (696, 1136), (696, 1182), (540, 1196), (456, 1186)]),
    (.8, [(716, 1172), (800, 1146), (950, 1146), (970, 1220), (820, 1222), (730, 1216)]),
    (.6, [(170, 1044), (300, 1020), (440, 1036), (600, 1016), (720, 1038), (716, 1128), (560, 1118), (440, 1146), (300, 1122), (176, 1136)]),
]
masks = []
for val_, sec in SECTIONS:
    im = Image.new('L', (PX, PY), 0)
    ImageDraw.Draw(im).polygon([to_map(p) for p in sec], fill=255)
    masks.append(val_ * np.asarray(im).astype(np.float32) / 255)
level_ = np.max(masks[2:], axis=0)
main = np.max(masks[:2], axis=0)  # 手前の 2 区画は小さいので、水位をあまりぼかさない
# 踊る場所の外にも、低い所を読んだ区画を散らす。水位は低く、輪郭を持たない
sub = (gy[::4, ::4], gx[::4, ::4])
b2 = tile(basin, sub[1], sub[0], 7.3, .4)[:PY, :PX]
wm = (np.abs(sub[1]) > 1.6) | (sub[0] < -4.6) | (sub[0] > 1.0)
level_ = np.maximum(level_, ((b2 < np.percentile(b2, 10)) & wm)[:PY, :PX].astype(np.float32) * .66)
level_ = np.maximum(ndi.gaussian_filter(level_, 13), ndi.gaussian_filter(main, 4.5))
level_ = np.asarray(Image.fromarray(level_).resize((NX, NY), Image.BILINEAR))
# 床の高さ: 高さの画像を 3 つの大きさでぼかして重ねる
fh = (tile(ndi.gaussian_filter(ch, 9, mode='wrap'), gx, gy, 2.7, 1.5) - ch.mean()) * 1.6 + (tile(ndi.gaussian_filter(ch, 3, mode='wrap'), gx, gy, 1.1, .4) - ch.mean()) * .4
fh = fh + (tile(ndi.gaussian_filter(wc, 12, mode='wrap'), gx, gy, 1.9, 1.0) - .5) * .25 + ndi.gaussian_filter(np.maximum(crack, fine), 2) * .5
fh = (fh - fh.mean()) / fh.std()
pool = np.clip((level_ - .5) * 7 - fh, -.5, .5) + .5  # 水位が床の高さを越えた所だけ水
pool = np.clip((pool - .35) / .3, 0, 1)
bin_ = pool > .5
for inv in (False, True):  # 水の小片と乾いた小さな島を消す
    lab_, n_ = ndi.label(~bin_ if inv else bin_)
    size = ndi.sum(np.ones_like(lab_), lab_, np.arange(n_ + 1))
    small = (size < 1600)[lab_] & (lab_ > 0)
    bin_ = (bin_ | small) if inv else (bin_ & ~small)
pool = ndi.gaussian_filter(bin_.astype(np.float32), 1.0)
hard = pool.copy()  # 亀裂を埋める範囲
print('pool share', float((pool > .5).mean()))

# ---- 水の量 ----
w1 = tile(wc, gx, gy, 1.43, .5)
w2 = tile(wc, gx, gy, .47, 1.9)
big = tile(basin, gx, gy, 5.3, 1.2)
amp = .12 + .88 * np.clip((gy + 4.2) / 2.7, 0, 1)  # カメラの近くの床は濡れの斑を弱くする
wet = .5 + (ndi.gaussian_filter(w1 - .5, 3) * .55 + ndi.gaussian_filter(w2 - .5, 1.5) * .45) * amp + (sl - .5) * .4 * amp + (.5 - big) * .2 + np.clip((gy + 3.5) / 6, 0, 1) * .07
# 水たまりの周りは濡れ、離れると乾く
near_pool = ndi.gaussian_filter(pool[::4, ::4], 22)
near_pool = np.asarray(Image.fromarray(near_pool).resize((NX, NY), Image.BILINEAR))
wet = wet - np.median(wet[::7, ::7]) + .5 + WET_BIAS + near_pool * .08
wet = np.clip(wet, 0, 1)
print('wet share', float((wet > .5).mean()))

crack_all = np.clip(np.maximum(crack, fine), 0, 1) * (1 - hard)  # 水は亀裂を埋める
Image.fromarray((np.dstack([wet, pool, crack_all])[::-1] * 255).astype(np.uint8), 'RGB').save(d / 'floor_map.png', compress_level=3)

# ---- メッシュの高さ: 板ごとのわずかな段だけ。亀裂はメッシュに掘らない ----
h = ndi.gaussian_filter((sl - .5) * .004, 3)[::5, ::5]
h = np.asarray(Image.fromarray(h).resize((1100, 1160), Image.BILINEAR))
pl = np.asarray(Image.fromarray(ndi.gaussian_filter(pool[::4, ::4], 8)).resize((1100, 1160), Image.BILINEAR))
np.save(d / 'floor_h.npy', (h * (1 - pl)).astype(np.float32))

# ---- 骨材の法線 ----
hg = ndi.gaussian_filter(ch, .8, mode='wrap')
nx_, ny_ = ndi.sobel(hg, 1, mode='wrap'), ndi.sobel(hg, 0, mode='wrap')
Image.fromarray((np.dstack([np.clip(.5 + nx_ * 1.6, 0, 1), np.clip(.5 - ny_ * 1.6, 0, 1), np.ones_like(hg)]) * 255).astype(np.uint8), 'RGB').save(d / 'floor_n.png')
# 光の図: 床に映る光を、反射の向き(u = 横 / 奥、v = 上 / 奥)ごとに持つ。材質が骨材の粒にだけ掛ける
ru = (np.arange(1100) + .5) / 1100 * 1.1 - .5
rv = (np.arange(800) + .5) / 800 * .85
ug, vg = np.meshgrid(ru, rv)
qx, qy = ug * F + 470.5, vg * F + H  # target の画素に直した値
env = np.zeros((800, 1100, 3), np.float32)
GOLD, MAG, BLUE = np.array([1, .5, .13]), np.array([1, .07, .6]), np.array([.1, .4, 1])


def gs(x, c, w):
    return np.exp(-.5 * ((x - c) / w) ** 2)


def st(x, a_, b_):
    t_ = np.clip((x - a_) / (b_ - a_), 0, 1)
    return t_ * t_ * (3 - 2 * t_)


band = st(qy, 870, 890) * (1 - st(qy, 1180, 1300))
for px_, k_ in ((89, .9), (105, .9), (185, 1.1), (410, .9), (688, .9), (860, 1.0), (877, 1.0)):
    env += (gs(qx, px_, 5) * band * k_)[..., None] * GOLD
for px_ in (314, 327):
    env += (gs(qx, px_, 5) * band * .75)[..., None] * MAG
for px_ in (457, 480, 559, 754):
    env += (gs(qx, px_, 6) * band * .55)[..., None] * BLUE
env += (st(qx, 620, 700) * st(qy, 960, 1000) * (1 - st(qy, 1270, 1340)) * .4)[..., None] * GOLD  # 右の中景の暖色の面
low = st(qy, 1290, 1420)
env += (st(qx, 660, 800) * low * .44)[..., None] * GOLD  # 手前の金は x=720 より右
env += ((gs(qx, 270, 45) + gs(qx, 90, 40) * .5) * low * .27)[..., None] * MAG
env += (gs(qx, 520, 120) * low * .12)[..., None] * BLUE
env += .018 * np.array([.8, .75, 1])  # どこでも粒が少し光る
env *= ((1 - st(qx, 960, 1090)) * st(qx, -40, 30) * (1 - st(qy, 1640, 1700)) * st(qy, 830, 860))[..., None]  # 図の端で必ず 0
Image.fromarray((np.clip(env[::-1], 0, 1) * 255).astype(np.uint8), 'RGB').save(d / 'floor_refl.png')

# 夜空: r18 の積雲の写真を、枠の中にだけ置く。殻の 1 枚は方位 90 度、仰角 -4 から 50 度
SW, SH = 2400, 1440
fx, fy = np.meshgrid((np.arange(SW) + .5) / SW, (np.arange(SH) + .5) / SH)
az = (.5 - fx) * np.pi / 2  # 右が正
el = np.radians((1 - fy) * 54 - 4)
sx = 470.5 + F * np.tan(az)
sy = H - F * np.tan(el) / np.cos(az)
FR = Image.new('L', (2200, 1400), 0)  # 目標の画素に -600, -500 を足した座標の枠
ImageDraw.Draw(FR).polygon([(x_ + 600, y_ + 500) for x_, y_ in [(-430, -30), (0, -20), (180, 20), (300, 70), (580, 190), (640, 300), (600, 400), (520, 430), (300, 420), (170, 400), (0, 330), (-430, 310)]], fill=255)
ImageDraw.Draw(FR).polygon([(x_ + 600, y_ + 500) for x_, y_ in [(700, 300), (760, 250), (860, 240), (960, 250), (1060, 270), (1060, 410), (900, 430), (720, 420)]], fill=255)
fr = ndi.gaussian_filter(np.asarray(FR).astype(np.float32) / 255, 55)
mask = ndi.map_coordinates(fr, [sy + 500, sx + 600], order=1, mode='constant')
src = np.asarray(Image.open(d / 'sky_night.png').convert('RGB')).astype(np.float32) / 255
src = ndi.gaussian_filter(src, (1.8, 1.8, 0)) ** .86
sh_, sw_ = src.shape[:2]
fade_ = np.clip(np.minimum(np.arange(sw_), sw_ - 1 - np.arange(sw_)) / (sw_ * .12), 0, 1)[None, :, None]
src = src * fade_ + np.roll(src, sw_ // 2, axis=1) * (1 - fade_)
srow = (1 - (np.degrees(el) - 6) / 64) * (sh_ - 1)  # 積雲の明るい段を使う
scol = ((fx + .16) % 1) * (sw_ - 1)
cl = np.dstack([ndi.map_coordinates(src[..., i], [srow, scol], order=1, mode='grid-wrap') for i in range(3)])
lum = cl.mean(2)
alpha = np.clip((mask * 1.5 + (lum - .32) * 3.2 - .62) / .55, 0, 1) * np.clip(mask * 2.2, 0, 1)
alpha = ndi.gaussian_filter(alpha, 1.5)[..., None]
navy = np.array([14, 29, 58], np.float32) / 255
hz = np.clip((14 - np.degrees(el)) / 18, 0, 1)[..., None] ** 1.5
base_ = navy * (1 - hz) + np.array([.26, .22, .33]) * hz  # 地平の霞
out_ = base_ * (1 - alpha) + np.clip(cl * np.array([.84, .87, .79]), 0, 1) * alpha
Image.fromarray((np.clip(out_, 0, 1) * 255).astype(np.uint8)).save(d / 'sky_soft.png')
print('ok')
