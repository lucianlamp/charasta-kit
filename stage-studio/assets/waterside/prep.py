"""image_gen の絵を舞台で使う形にする。python assets/waterside/prep.py
sky_env.png: 4 枚の空を方位で並べた環境テクスチャ。island_*.png、jungle_a.png: マゼンタの背景を抜いた遠景"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = Path(__file__).parent
W, H = 8192, 4096
# (絵, 中心の方位, 方位の幅, 上端の仰角, 端を薄める幅)。方位は +Y が 0 で +X の側が正
SHEETS = [('sky_front3', -2, 64, 43, 10), ('sky_side_a', 80, 122, 60, 20), ('sky_back', 180, 110, 60, 20), ('sky_side_b', -80, 122, 60, 20)]
GRADE = (.0, .02, .07)  # 絵の赤と橙を、桃と藤色へ寄せる量(スクリーン)


def rgb(name):
    return np.asarray(Image.open(HERE / f'{name}.png').convert('RGB'), np.float32) / 255


def ss(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def sample(a, u, v, mode='nearest'):
    h, w = a.shape[:2]
    c = [(1 - v) * (h - 1), u * (w - 1)]
    return np.stack([ndi.map_coordinates(a[..., k], c, order=3, mode=mode) for k in range(3)], -1)


def sky():
    az = (np.linspace(0, 1, W, endpoint=False) + .5 / W - .25)[None, :] * 360
    el = 90 - (np.arange(H // 2) + .5)[:, None] * 180 / H  # 上半分だけ。下は折り返す
    az = np.broadcast_to(az, (H // 2, W))
    el = np.broadcast_to(el, (H // 2, W))
    total, weight = np.zeros((H // 2, W, 3), np.float32), np.zeros((H // 2, W, 1), np.float32)
    for name, c, span, top, fade in SHEETS:
        d = (az - c + 180) % 360 - 180
        w = (ss(-span / 2, -span / 2 + fade, d) * (1 - ss(span / 2 - fade, span / 2, d)))
        w = (w * (1 - ss(top - 7, top, el)))[..., None]
        if name == 'sky_front3':
            part = sample(rgb(name), d / span + .5, np.minimum(el / top, 1))
            part = (1 - (1 - part) * (1 - np.array((.0, .09, .18), np.float32))) * np.array((.93, .97, .97), np.float32)  # 赤の空を桃と藤色へ
        else:
            part = sample(rgb(name), d / span + .5, np.minimum(el / top, 1))
            part = (1 - (1 - part) * (1 - np.array((.22, .17, .26), np.float32))) * np.array((.84, .9, 1.0), np.float32)  # 横と裏の絵は赤が強い
        total += part * w
        weight += w
    # 境目は重みで割り、高い空だけ別の層が見える
    # 高い空: 裏の絵を方位 2 周ぶん折り返して使う
    back = rgb('sky_back')
    u = np.abs(((az + 180) / 180) % 2 - 1)
    z = sample(back, u, np.clip((el - 25) / 65, 0, 1))
    w = np.clip(1 - weight, 0, 1) * ss(30, 44, el)[..., None] + 1e-4
    img = (total + z * w) / (weight + w)
    img = 1 - (1 - img) * (1 - np.array(GRADE, np.float32))
    grey = img.mean(-1, keepdims=True)
    img = np.clip(grey + (img - grey) * 1.12, 0, 1)  # 彩度
    img = img ** 1.1  # コントラスト
    full = np.concatenate([img, img[::-1]], 0)
    Image.fromarray((np.clip(full, 0, 1) * 255 + .5).astype(np.uint8)).save(HERE / 'sky_env.png')


def key(a):
    """マゼンタを抜く。返すのは RGBA"""
    m = np.minimum(a[..., 0], a[..., 2]) - a[..., 1]
    alpha = 1 - np.clip((m - .12) / .3, 0, 1)
    alpha = ndi.gaussian_filter(alpha, 1.4)
    out = a.copy()
    spill = np.minimum(out[..., 0], out[..., 2]) > out[..., 1]
    lim = out[..., 1] + (np.minimum(out[..., 0], out[..., 2]) - out[..., 1]) * .35
    out[..., 0] = np.where(spill, np.minimum(out[..., 0], lim), out[..., 0])
    out[..., 2] = np.where(spill, np.minimum(out[..., 2], lim), out[..., 2])
    return np.concatenate([out, alpha[..., None]], -1)


def save_rgba(a, name):
    Image.fromarray((np.clip(a, 0, 1) * 255 + .5).astype(np.uint8), 'RGBA').save(HERE / name)


def islands():
    a = key(rgb('islands'))
    mask = a[..., 3] > .5
    lab, n = ndi.label(ndi.binary_dilation(mask, iterations=4))
    boxes = sorted((s for s in ndi.find_objects(lab) if (s[1].stop - s[1].start) > 30), key=lambda s: s[1].start)
    print([(s[1].start, s[1].stop, s[0].start, s[0].stop) for s in boxes])
    for b, name in zip(boxes, 'abcd'):
        y0 = b[0].start
        y1 = b[0].stop - 6
        cut = a[y0:y1, b[1].start:b[1].stop].copy()
        cut[..., 3] = ss(.42, .58, ndi.gaussian_filter(cut[..., 3], 5))  # 遠い島の輪郭はなだらか
        save_rgba(cut, f'island_{name}.png')


def hill():
    a = key(rgb('hill'))
    ys, xs = np.nonzero(a[..., 3] > .5)
    cut = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    save_rgba(cut, 'hill_a.png')


def jungle():
    a = key(rgb('jungle'))
    save_rgba(np.concatenate([a, a[:, ::-1]], 1), 'jungle_a.png')  # 左右に折り返して、つなぎ目を無くす


def wet():
    a = np.asarray(Image.open(HERE / 'wood_wet.png').convert('L'), np.float32)
    Image.fromarray(ndi.gaussian_filter(a, 16, mode='mirror').astype(np.uint8)).save(HERE / 'wood_wet_soft.png')


def tile(name, out):
    """上下左右がつながる絵にする。半分ずらした絵を、元の絵の端の所にだけ重ねる"""
    a = np.asarray(Image.open(HERE / f'{name}.png').convert('L'), np.float32)
    h, w = a.shape
    ramp = lambda n: np.minimum(ss(0, .22, np.linspace(0, 1, n)), ss(0, .22, np.linspace(1, 0, n)))
    m = np.outer(ramp(h), ramp(w))
    b = np.roll(a, (h // 2, w // 2), (0, 1))
    Image.fromarray((a * m + b * (1 - m)).astype(np.uint8)).save(HERE / out)


wet()
sky()
islands()
jungle()
hill()
tile('water_height', 'water_tile.png')
tile('caustics_thin', 'caustics_tile.png')
k = rgb('knot')  # 節の絵は丸く抜いて甲板へ置く
h, w = k.shape[:2]
yy, xx = np.mgrid[0:h, 0:w]
rad = np.hypot((xx - w / 2) / (w / 2), (yy - h / 2) / (h / 2))
save_rgba(np.concatenate([k, (1 - ss(.55, .98, rad))[..., None]], -1), 'knot_a.png')
