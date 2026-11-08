"""VRM のテクスチャの UV の島の外側(余白)を、島の縁の色で埋め直す(glTF を直接書き換え、画像のバイトだけ差し替える)。

  python tools/vrm/uv_pad.py in.vrm out.vrm --mesh Face [--pad 16] [--ymin 1.18 --ymax 1.36] [--debug dir]
  python tools/vrm/uv_pad.py in.vrm --mesh Face --probe [--ymin .. --ymax ..]   # 書かずに、変わる画素の数と色の差だけ出す

テクスチャを塗り直す道具(あごの下の色を直す chin_fix_glb.py など)が島の中だけを塗り、余白に元の色を残すと、
双一次の補間とミップマップで余白の色が島の縁ににじみ、UV の継ぎ目が細い線として見える。
この道具は、どの三角形にも覆われない画素のうち島から --pad 画素以内のものを、いちばん近い覆われた画素の色にする。
--ymin/--ymax(m、VRM の座標の高さ)を渡すと、その高さの三角形が覆う画素に近い余白だけを直す(ほかの所の画素は変えない)。
対象は --mesh の節点のメッシュが使う基本色のテクスチャ。同じ画像を使うほかのメッシュの三角形も覆いに数える。
JPEG の画像は PNG で書き出して mimeType を image/png に変える(JPEG で書き直すと余白以外の画素まで変わるため)。PNG は PNG のまま。
次は読み込みの段階で止める: --mesh が無い、primitive が無い、texCoord != 0、KHR_texture_transform、16 ビットの PNG。
パレット PNG の透明(tRNS)は RGBA にして残す。

例: 首の中央(前と後ろ)の縦の継ぎ目。島の中の色は左右で 3 以内で一致していたが、
余白は後ろで (230,139,136)、前で (251,204,200) と、島の中の (238,180,178) から離れていた。
"""
from __future__ import annotations

import argparse
import io
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glb  # noqa: E402


def raster(p0, p1, p2, W, H):
    """UV の画素座標の三角形が中心を覆う画素。(覆う画素の印, 行, 列) を返す"""
    x0, y0 = np.floor(np.minimum(np.minimum(p0, p1), p2)).astype(int)
    x1, y1 = np.ceil(np.maximum(np.maximum(p0, p1), p2)).astype(int)
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W - 1), min(y1, H - 1)
    if x1 < x0 or y1 < y0:
        return None, None, None
    den = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1])
    if abs(den) < 1e-12:
        return None, None, None
    xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
    l0 = ((p1[1] - p2[1]) * (xs - p2[0]) + (p2[0] - p1[0]) * (ys - p2[1])) / den
    l1 = ((p2[1] - p0[1]) * (xs - p2[0]) + (p0[0] - p2[0]) * (ys - p2[1])) / den
    m = (l0 >= -1e-4) & (l1 >= -1e-4) & (1 - l0 - l1 >= -1e-4)
    return m, ys, xs


def pad_gutter(T0, tri_uv, tri_in, pad):
    """T0(H, W, C)の画像で、三角形(tri_uv: (N, 3, 2)、glTF の UV)が覆わない画素のうち、覆う画素から pad 以内で、
    いちばん近い覆う画素が tri_in の三角形のものを、その画素の色にする。返すのは (新しい画像, 埋めた画素の印, 覆う画素の印)。
    覆い = 画素の中心が三角形の中にある画素(塗り直しの道具と同じ決め方)。縁の画素で中心が外にあるものは余白に数える。"""
    H, W = T0.shape[:2]
    cov = np.zeros((H, W), bool)
    reg = np.zeros((H, W), bool)
    for uv, inside in zip(np.asarray(tri_uv) * [W, H] - 0.5, tri_in):
        m, yy, xx = raster(uv[0], uv[1], uv[2], W, H)
        if m is None:
            continue
        cov[yy[m], xx[m]] = True
        if inside:
            reg[yy[m], xx[m]] = True
    dist, (iy, ix) = ndimage.distance_transform_edt(~cov, return_indices=True)
    gap = (~cov) & (dist <= pad) & reg[iy, ix]
    T1 = T0.copy()
    T1[gap] = T0[iy[gap], ix[gap]]
    return T1, gap, cov


class UvPadError(Exception):
    pass


def check_tex_info(ti):
    if ti.get('texCoord', 0) != 0:
        raise UvPadError(f'texCoord={ti["texCoord"]} は扱えない(TEXCOORD_0 だけ)')
    if 'KHR_texture_transform' in ti.get('extensions', {}):
        raise UvPadError('KHR_texture_transform を使う基本色テクスチャは扱えない')


def load_texture(J, B, im):
    """画像を (配列 H x W x C(uint8), 元の mode) で返す。16 ビットは止め、パレットの透明は RGBA にする"""
    if 'bufferView' not in im:
        raise UvPadError('bufferView でない画像(uri)は扱えない')
    v = J['bufferViews'][im['bufferView']]
    o = v.get('byteOffset', 0)
    raw = bytes(B[o:o + v['byteLength']])
    if raw[:8] == b'\x89PNG\r\n\x1a\n' and len(raw) > 24 and raw[24] == 16:
        raise UvPadError('16 ビットの PNG は扱えない(8 ビットに変換してから渡す)')
    src = Image.open(io.BytesIO(raw))
    mode = src.mode
    if mode in ('I', 'I;16', 'I;16B', 'I;16L', 'F'):
        raise UvPadError(f'16 ビット以上の画像({mode})は扱えない')
    if mode in ('PA', 'LA', 'RGBA', 'La', 'RGBa') or (mode in ('P', 'L', '1', 'RGB') and 'transparency' in src.info):
        want = 'RGBA'
    else:
        want = 'RGB'
    return np.asarray(src.convert(want)).copy(), mode


def encode(T1):
    """書き出すバイト列(PNG)。JPEG の入力も PNG で書く(JPEG に戻すと余白以外の画素まで変わるため)"""
    buf = io.BytesIO()
    Image.fromarray(T1).save(buf, 'PNG', compress_level=6)
    return buf.getvalue()


def process(inp, out=None, mesh='Face', pad=16, ymin=None, ymax=None, probe=False, debug=None):
    J, B = glb.load(inp)
    node = next((n for n in J['nodes'] if n.get('name') == mesh and 'mesh' in n), None)
    if node is None:
        names = sorted(n.get('name', '') for n in J['nodes'] if 'mesh' in n)
        raise UvPadError(f'--mesh {mesh!r} の節点が無い(メッシュを持つ節点: {", ".join(names)})')
    mprims = J['meshes'][node['mesh']].get('primitives', [])
    if not mprims:
        raise UvPadError(f'--mesh {mesh!r} に primitive が無い')
    prim0 = next((p for p in mprims if p.get('material') is not None
                  and 'baseColorTexture' in J['materials'][p['material']].get('pbrMetallicRoughness', {})), None)
    if prim0 is None:
        raise UvPadError(f'--mesh {mesh!r} のどの primitive にも基本色テクスチャが無い')
    ti0 = J['materials'][prim0['material']]['pbrMetallicRoughness']['baseColorTexture']
    check_tex_info(ti0)
    img_i = J['textures'][ti0['index']]['source']
    im = J['images'][img_i]
    T0, mode = load_texture(J, B, im)
    H, W = T0.shape[:2]
    is_jpeg = im.get('mimeType') == 'image/jpeg'
    print('image', img_i, im.get('name'), im.get('mimeType'), mode, (W, H))

    # 同じ画像を基本色に使う primitive をすべて集める
    tex_of_img = {k for k, t in enumerate(J['textures']) if t['source'] == img_i}
    prims = []
    for m in J['meshes']:
        for p in m['primitives']:
            if p.get('material') is None:
                continue
            ti = J['materials'][p['material']].get('pbrMetallicRoughness', {}).get('baseColorTexture')
            if ti is not None and ti.get('index') in tex_of_img:
                check_tex_info(ti)
                prims.append(p)
    tris = []
    for p in prims:
        P = glb.acc(J, B, p['attributes']['POSITION'])
        UV = glb.acc(J, B, p['attributes']['TEXCOORD_0'])
        I = glb.acc(J, B, p['indices']).reshape(-1, 3)
        inr = np.ones(len(P), bool)
        if ymin is not None:
            inr &= P[:, 1] >= ymin
        if ymax is not None:
            inr &= P[:, 1] <= ymax
        tris.append((UV[I], inr[I].any(1)))
    T1, gap, cov = pad_gutter(T0, np.concatenate([t[0] for t in tris]), np.concatenate([t[1] for t in tris]), pad)
    # 書き出す形に符号化し、読み戻した画素で差を測る(報告は書かれる結果と一致する)
    nb = encode(T1)
    back = np.asarray(Image.open(io.BytesIO(nb)).convert('RGBA' if T0.shape[2] == 4 else 'RGB'))
    diff = np.abs(back.astype(int) - T0.astype(int)).max(-1)
    print('encode', 'JPEG -> PNG (image/png)' if is_jpeg else 'PNG', len(nb), 'bytes')
    print('gutter px', int(gap.sum()), 'changed px', int((diff > 0).sum()), 'changed outside gutter', int(((diff > 0) & ~gap).sum()),
          'max diff', int(diff.max()), 'mean diff of changed', round(float(diff[diff > 0].mean()) if (diff > 0).any() else 0, 1))
    if debug:
        os.makedirs(debug, exist_ok=True)
        ys, xs = np.where(gap)
        if len(ys):
            y0, y1, x0, x1 = max(ys.min() - 24, 0), min(ys.max() + 24, H), max(xs.min() - 24, 0), min(xs.max() + 24, W)
            A = Image.fromarray(T0[y0:y1, x0:x1, :3])
            Bi = Image.fromarray(back[y0:y1, x0:x1, :3])
            M = Image.fromarray((np.stack([gap[y0:y1, x0:x1], cov[y0:y1, x0:x1], np.zeros_like(gap[y0:y1, x0:x1])], -1) * 255).astype(np.uint8))
            S = Image.new('RGB', (A.width * 3, A.height))
            for k, x in enumerate((A, Bi, M)):
                S.paste(x, (k * A.width, 0))
            S.save(os.path.join(debug, 'uv_pad_before_after_mask.png'))
            print('debug', os.path.join(debug, 'uv_pad_before_after_mask.png'), 'crop', (x0, y0, x1, y1))
    if probe:
        return None

    if is_jpeg:
        im['mimeType'] = 'image/png'
    chunks, off = [], 0
    for k, bv in enumerate(J['bufferViews']):
        bo = bv.get('byteOffset', 0)
        data = nb if k == im['bufferView'] else bytes(B[bo:bo + bv['byteLength']])
        padb = (-off) % 4
        if padb:
            chunks.append(b'\0' * padb)
            off += padb
        bv['byteOffset'] = off
        bv['byteLength'] = len(data)
        chunks.append(data)
        off += len(data)
    J['buffers'][0]['byteLength'] = off
    glb.save(out, J, bytearray(b''.join(chunks)))
    print('wrote', out, os.path.getsize(out))
    return img_i


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inp')
    ap.add_argument('out', nargs='?')
    ap.add_argument('--mesh', default='Face')
    ap.add_argument('--pad', type=int, default=16)
    ap.add_argument('--ymin', type=float)
    ap.add_argument('--ymax', type=float)
    ap.add_argument('--probe', action='store_true')
    ap.add_argument('--debug')
    a = ap.parse_args()
    if not a.probe and not a.out:
        ap.error('out が要る(--probe のときは要らない)')
    try:
        process(a.inp, a.out, a.mesh, a.pad, a.ymin, a.ymax, a.probe, a.debug)
    except UvPadError as e:
        sys.exit(f'uv_pad: {e}')


if __name__ == '__main__':
    main()
