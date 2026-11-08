"""中立の絵(neutral)の画素とモデルの正面の (x,y) の対応と、目の開口の輪郭を求める。出力は work/feat.json。
align.mode:
  atlas  材料の VRM に顔テクスチャ方式のアトラスがあるとき。アトラスの中立の区画を正面へ戻し、穴(透明)を目の開口にして、絵を重ねて合わせる。
  direct 絵の画素と正面の対応が分かっているとき(x0, y0, dxdpx)。目の開口は緑で塗った絵(eye_mask)から読む。
"""
import io, json
import numpy as np
from PIL import Image
from scipy import ndimage as ni
from scipy.signal import fftconvolve
from glbw import read_glb, accessor
Image.MAX_IMAGE_PIXELS = None


def contour(m, x_of, y_of):
    """開口のマスク(星形)を重心からの極座標で読み、(x,y) の 720 点にする。"""
    m = ni.binary_fill_holes(m)
    c0 = np.array([np.mean(np.where(m)[1]), np.mean(np.where(m)[0])])
    th = np.radians(np.arange(0, 360, .5)); R = []
    for t in th:
        rs = np.arange(0, 400, .5)
        xx = np.clip((c0[0] + rs * np.cos(t)).astype(int), 0, m.shape[1] - 1); yy = np.clip((c0[1] + rs * np.sin(t)).astype(int), 0, m.shape[0] - 1)
        R.append(rs[np.where(m[yy, xx])[0].max()])
    R = ni.gaussian_filter1d(np.array(R), 3, mode='wrap')
    return np.c_[x_of(c0[0] + R * np.cos(th)), y_of(c0[1] + R * np.sin(th))].tolist()


def ink(a):
    a = a[..., :3].astype(float)
    return ((a[..., 0] - a[..., 2]) > 90) & (a.sum(2) < 480)


def vrm_image(js, b, i):
    v = js['bufferViews'][js['images'][i]['bufferView']]; a = v.get('byteOffset', 0)
    return Image.open(io.BytesIO(b[a:a + v['byteLength']]))


def atlas_mode(P, A):
    """アトラスの中立の区画を正面の格子へ戻し、絵のまつ毛・眉・口の線を重ねて尺度と位置を探す。"""
    js, b = read_glb(P['source_vrm'])
    n = next(n for n in js['nodes'] if n.get('name') == P['head_mesh'])
    p = next(p for p in js['meshes'][n['mesh']]['primitives'] if js['materials'][p['material']]['name'] == A['material'])
    Q = accessor(js, b, p['attributes']['POSITION']).astype(float); uv = accessor(js, b, p['attributes']['TEXCOORD_0']).astype(float)
    S = np.linalg.lstsq(np.c_[Q[:, :2], np.ones(len(Q))], uv, rcond=None)[0]
    mt = next(m for m in js['materials'] if m['name'] == A['material'])
    tex = js['textures'][mt['pbrMetallicRoughness']['baseColorTexture']['index']]
    a = np.asarray(vrm_image(js, b, tex['source']).convert('RGBA')); H, W = a.shape[:2]
    N = A['size']; x0, x1, y1 = A['rect']; PX = N / (x1 - x0)
    xs = x0 + (np.arange(N) + .5) / PX; ys = y1 - (np.arange(N) + .5) / PX
    X, Y = np.meshgrid(xs, ys)
    ix = np.clip(((S[0, 0] * X + S[1, 0] * Y + S[2, 0]) * W).astype(int), 0, W - 1)
    iy = np.clip(((S[0, 1] * X + S[1, 1] * Y + S[2, 1]) * H).astype(int), 0, H - 1)
    rect = a[iy, ix].astype(float)
    x_of = lambda c: x0 + (c + .5) / PX
    y_of = lambda r: y1 - (r + .5) / PX
    hole = rect[..., 3] < 128
    lab, nl = ni.label(hole); sizes = ni.sum(hole, lab, range(1, nl + 1))
    E = A['eye_box']; feat = {}
    for i in range(1, nl + 1):
        ys_, xs_ = np.where(lab == i); cx, cy = x_of(xs_.mean()), y_of(ys_.mean())
        if E['y'][0] < cy < E['y'][1] and E['x'][0] < abs(cx) < E['x'][1] and E['px'][0] < sizes[i - 1] < E['px'][1]:
            feat['L' if cx > 0 else 'R'] = contour(lab == i, x_of, y_of)
    assert 'L' in feat and 'R' in feat, '目の穴が 2 つ見つからない。align.eye_box を見直す'
    src = np.asarray(Image.open(P['neutral']).convert('RGB'))
    M = ink(rect) & (rect[..., 3] > 200)
    w = A['ink_window']; M[:w[1]] = 0; M[w[3]:] = 0; M[:, :w[0]] = 0; M[:, w[2]:] = 0
    ds = 3
    A2 = ni.zoom(M.astype(float), 1 / ds, order=1); best = None
    for s in np.arange(A['scale'][0], A['scale'][1], .01):
        B2 = ni.zoom(ink(src).astype(float), s / ds, order=1)
        c = fftconvolve(A2, B2[::-1, ::-1], mode='full'); i = np.unravel_index(c.argmax(), c.shape)
        if best is None or c[i] > best[0]: best = (c[i], s, i[0] - (B2.shape[0] - 1), i[1] - (B2.shape[1] - 1))
    _, s, r0, c0 = best; r0, c0 = r0 * ds, c0 * ds
    A3 = M.astype(float); best2 = None
    for s2 in np.arange(s - .012, s + .012, .002):
        B = ni.zoom(ink(src).astype(float), s2, order=1); pad = 30; H2, W2 = B.shape
        win = A3[max(r0 - pad, 0):r0 + H2 + pad, max(c0 - pad, 0):c0 + W2 + pad]
        c = fftconvolve(win, B[::-1, ::-1], mode='full'); i = np.unravel_index(c.argmax(), c.shape)
        if best2 is None or c[i] > best2[0]: best2 = (c[i], s2, i[0] - (H2 - 1) + max(r0 - pad, 0), i[1] - (W2 - 1) + max(c0 - pad, 0))
    _, s, r0, c0 = best2
    feat['src'] = {'x0': float(x_of(c0)), 'y0': float(y_of(r0)), 'dxdpx': float(s / PX), 'w': int(src.shape[1]), 'h': int(src.shape[0])}
    return feat


def direct_mode(P, A):
    src = np.asarray(Image.open(P['neutral']).convert('RGB'))
    d = A['dxdpx']; x_of = lambda c: A['x0'] + c * d; y_of = lambda r: A['y0'] - r * d
    g = np.asarray(Image.open(A['eye_mask']).convert('RGB').resize((src.shape[1], src.shape[0])), float)
    m = (g[..., 1] - g[..., 0] > 80) & (g[..., 1] - g[..., 2] > 80)
    lab, nl = ni.label(m); sizes = ni.sum(m, lab, range(1, nl + 1))
    big = 1 + np.argsort(sizes)[-2:]
    assert len(big) == 2 and sizes[big - 1].min() > 200, '緑の塗りが 2 つ見つからない'
    feat = {}
    for i in big:
        side = 'L' if x_of(np.where(lab == i)[1].mean()) > A.get('cx', 0) else 'R'
        feat[side] = contour(lab == i, x_of, y_of)
    assert 'L' in feat and 'R' in feat, '緑の塗りが左右に分かれていない'
    feat['src'] = {'x0': A['x0'], 'y0': A['y0'], 'dxdpx': d, 'w': int(src.shape[1]), 'h': int(src.shape[0])}
    return feat


def main(P):
    A = P['align']
    feat = (atlas_mode if A['mode'] == 'atlas' else direct_mode)(P, A)
    json.dump(feat, open(P['work'] + '/feat.json', 'w'))
    print('src', feat['src'])
