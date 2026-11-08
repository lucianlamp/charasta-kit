"""顔の材質に、輪郭線の太さを場所ごとに変えるテクスチャ(MToon の outlineWidthMultiplyTexture、G を読む)を付ける。
目、鼻、口のまわりは 0(線なし)、あごと頬の輪郭と首は 1。VRoid の顔も同じ仕組みで、輪郭だけに線を出している。
きゃらくるの頭は顔が 1 つの材質なので、太さの値だけでは目や鼻の凹凸にも線が出る(2026-11-04 ナースの子、ユーザーの指摘)。

範囲は虹彩の中心から決める(--eyes で渡す。無ければ Humanoid の目の骨。きゃらくるの目の骨は回転の中心で、虹彩より内側にあるので --eyes を渡す)。左右の目の間隔を d として、
  目: それぞれの目を中心に 半径 x 0.45d、y 0.35d の楕円
  鼻と口: 目の高さから 0.55d 下を中心に 半径 x 0.35d、y 0.45d の楕円
の中を 0 にする(前を向いた面だけ。縁は d の 0.08 倍でなだらかに)。

python outline_mask.py <in.vrm> <out.vrm> [--eyes xL,xR,y(m)] [--material N00_000_00_Face_00_SKIN] [--size 1024] [--png <確認用.png>]
"""
import sys, os, io, json, argparse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'face_own'))
import numpy as np
from PIL import Image
from scipy import ndimage as ni
from glbw import W, read_glb, write_glb, accessor, node_world

EYE_R = (0.45, 0.35)
MOUTH = (0.55, 0.35, 0.45)
EDGE = 0.08


def ellipse_inside(x, y, cx, cy, rx, ry, edge):
    """楕円の中で 1、外で 0。縁は edge の幅でなだらか。"""
    r = np.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2)
    k = edge / min(rx, ry)
    return np.clip((1 + k - r) / (2 * k), 0, 1)


def weights(P, eyes, d, front_z):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    (lx, ly, _), (rx_, ry_, _) = eyes
    ye = (ly + ry_) / 2
    inner = np.maximum.reduce([
        ellipse_inside(x, y, lx, ly, EYE_R[0] * d, EYE_R[1] * d, EDGE * d),
        ellipse_inside(x, y, rx_, ry_, EYE_R[0] * d, EYE_R[1] * d, EDGE * d),
        ellipse_inside(x, y, (lx + rx_) / 2, ye - MOUTH[0] * d, MOUTH[1] * d, MOUTH[2] * d, EDGE * d)])
    front = np.clip((z - front_z) / (0.1 * d), 0, 1)   # 頭の中心より前の面だけ
    return 1 - inner * front


def raster(uv, F, w, size):
    """三角形ごとに UV の上で重みを補間して塗る。塗れなかった画素は近くの値で埋める。"""
    img = np.zeros((size, size), np.float32); hit = np.zeros((size, size), bool)
    U = uv[:, 0] % 1 * size - .5; V = uv[:, 1] % 1 * size - .5
    for a, b, c in F:
        xs = np.array([U[a], U[b], U[c]]); ys = np.array([V[a], V[b], V[c]])
        x0, x1 = int(np.floor(xs.min())), int(np.ceil(xs.max())); y0, y1 = int(np.floor(ys.min())), int(np.ceil(ys.max()))
        if x1 - x0 > size / 2 or y1 - y0 > size / 2: continue   # UV の継ぎ目をまたぐ三角形
        gx, gy = np.meshgrid(np.arange(max(x0, 0), min(x1, size - 1) + 1), np.arange(max(y0, 0), min(y1, size - 1) + 1))
        den = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
        if abs(den) < 1e-12: continue
        l0 = ((ys[1] - ys[2]) * (gx - xs[2]) + (xs[2] - xs[1]) * (gy - ys[2])) / den
        l1 = ((ys[2] - ys[0]) * (gx - xs[2]) + (xs[0] - xs[2]) * (gy - ys[2])) / den
        l2 = 1 - l0 - l1
        m = (l0 >= -.02) & (l1 >= -.02) & (l2 >= -.02)
        img[gy[m], gx[m]] = (l0 * w[a] + l1 * w[b] + l2 * w[c])[m]; hit[gy[m], gx[m]] = True
    if hit.any() and not hit.all():
        idx = ni.distance_transform_edt(~hit, return_distances=False, return_indices=True)
        img = img[idx[0], idx[1]]
    return np.clip(img, 0, 1)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('src'); ap.add_argument('dst')
    ap.add_argument('--material', default='N00_000_00_Face_00_SKIN'); ap.add_argument('--size', type=int, default=1024); ap.add_argument('--png'); ap.add_argument('--eyes')
    a = ap.parse_args()
    js, b = read_glb(a.src)
    mi = [i for i, m in enumerate(js['materials']) if m.get('name', '').startswith(a.material)]
    if not mi: raise SystemExit(f'材質 {a.material} が無い')
    mt = js['materials'][mi[0]].setdefault('extensions', {}).get('VRMC_materials_mtoon')
    if not mt or mt.get('outlineWidthMode', 'none') == 'none': raise SystemExit('その材質に輪郭線が無い(vroid-conform.mjs --outline を先に)')
    hb = js['extensions']['VRMC_vrm']['humanoid']['humanBones']
    world = node_world(js)[0]
    eyes = [np.asarray(world[hb[k]['node']])[:3, 3] for k in ('leftEye', 'rightEye')]
    if a.eyes:
        xl, xr, ye = (float(v) for v in a.eyes.split(','))
        eyes = [np.array([xl, ye, eyes[0][2]]), np.array([xr, ye, eyes[1][2]])]
    d = float(np.linalg.norm(eyes[0][:2] - eyes[1][:2]))
    head = np.asarray(world[hb['head']['node']])[:3, 3]
    prims = [(n, p) for n in js['nodes'] if 'mesh' in n for p in js['meshes'][n['mesh']]['primitives'] if p.get('material') in mi]
    if not prims: raise SystemExit('その材質を使う面が無い')
    uvs = [p['attributes'].get('TEXCOORD_0') for _, p in prims]
    if any(u is None for u in uvs): raise SystemExit('UV の無い面がある')
    img = None
    for n, p in prims:
        P = accessor(js, b, p['attributes']['POSITION']).astype(float)
        uv = accessor(js, b, p['attributes']['TEXCOORD_0']).astype(float)
        F = accessor(js, b, p['indices']).astype(int).reshape(-1, 3)
        part = raster(uv, F, weights(P, eyes, d, head[2]), a.size)
        img = part if img is None else np.minimum(img, part)   # 同じ UV を共有するなら線を出さない側を取る
    g = (img * 255).astype(np.uint8)
    im = Image.fromarray(np.stack([g, g, g], -1))
    if a.png: im.save(a.png)
    buf = io.BytesIO(); im.save(buf, 'PNG')
    G = W(js, b); bv = G.view(buf.getvalue())
    js['images'].append({'name': 'FaceOutlineWidth', 'mimeType': 'image/png', 'bufferView': bv})
    js['textures'].append({'source': len(js['images']) - 1})
    t = len(js['textures']) - 1
    for i in mi: js['materials'][i]['extensions']['VRMC_materials_mtoon']['outlineWidthMultiplyTexture'] = {'index': t}
    js['buffers'][0]['byteLength'] = len(G.bin)
    write_glb(a.dst, js, bytes(G.bin))
    print(f'{a.dst}: 目の間隔 {d * 1000:.1f} mm、線ありの画素 {np.mean(img > .5) * 100:.1f}%、材質 {len(mi)}、面 {len(prims)}')


main()
