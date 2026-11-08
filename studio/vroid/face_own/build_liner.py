"""後頭部の内張りを VRM(GLB)へ書き足す。既存のノード・メッシュ・材質・アクセサの中身は変えず、末尾に足すだけ。
python build_liner.py <src.vrm> <dst.vrm> [--k 1.0] [--inset 0.006]

形: 頭の中心から見た星形の面(icosphere の半径 r(d))。
  r は 光線が最初に当たる Head / Face / Hair の距離の、周りの方向での最小 から inset を引いた値。
  下は首の周りの円すい(首の Body の上端より下から、外へ行くほど上がる)で切る。長い髪の中まで下りないようにするため。
  Head に当たる方向のうち Head の端から 2 輪より内側の面は捨てる(Head が塞いでいるので要らない)。
骨: 頭の骨に 100%。
"""
import sys, json, argparse
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb import *
from measure import mesh_groups
from PIL import Image
from io import BytesIO
from scipy.spatial import cKDTree


def icosphere(n):
    t = (1 + 5 ** .5) / 2
    v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
    v = [np.array(p, float) / np.linalg.norm(p) for p in v]
    for _ in range(n):
        mid = {}; f2 = []

        def m(a, b):
            k = (min(a, b), max(a, b))
            if k not in mid:
                p = v[a] + v[b]; v.append(p / np.linalg.norm(p)); mid[k] = len(v) - 1
            return mid[k]
        for a, b, c in f:
            ab, bc, ca = m(a, b), m(b, c), m(c, a)
            f2 += [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]
        f = f2
    return np.array(v), np.array(f)


def hits(o, dirs, tris, rb=1500):
    v0 = tris[:, 0]; e1 = tris[:, 1] - v0; e2 = tris[:, 2] - v0
    s = o - v0; q = np.cross(s, e1)
    best = np.full(len(dirs), np.inf)
    for k in range(0, len(tris), 4000):
        E1, E2, S, Q = e1[k:k + 4000], e2[k:k + 4000], s[k:k + 4000], q[k:k + 4000]
        for j in range(0, len(dirs), rb):
            D = dirs[j:j + rb]
            h = np.cross(D[:, None, :], E2[None])
            a = (E1[None] * h).sum(2)
            ok = np.abs(a) > 1e-12
            f = np.where(ok, 1 / np.where(ok, a, 1), 0)
            u = f * (S[None] * h).sum(2)
            v = f * (D[:, None, :] * Q[None]).sum(2)
            t = f * (E2[None] * Q[None]).sum(2)
            t = np.where(ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-5), t, np.inf)
            best[j:j + rb] = np.minimum(best[j:j + rb], t.min(1))
    return best


def srgb2lin(c):
    c = np.asarray(c, float)
    return np.where(c <= .04045, c / 12.92, ((c + .055) / 1.055) ** 2.4)


def lin2srgb(c):
    c = np.asarray(c, float)
    return np.where(c <= .0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - .055)


def hair_material(js):
    """髪の材質。名前はきゃらくるの版で違う(Kimi 版は hair、Tripo Studio 版は Material_hair)ので、Hair ノードの面の材質から取る。"""
    n = next(n for n in js['nodes'] if n.get('name') == 'Hair')
    return js['materials'][js['meshes'][n['mesh']]['primitives'][0]['material']]


def hair_color(js, b):
    """髪のテクスチャを、髪のメッシュの UV で読んだ色の中央値と暗い側の色(sRGB 0..1)。"""
    mat = hair_material(js)
    tex = js['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]
    im = js['images'][tex['source']]
    bv = js['bufferViews'][im['bufferView']]
    a = bv.get('byteOffset', 0)
    img = np.asarray(Image.open(BytesIO(b[a:a + bv['byteLength']])).convert('RGB'), float) / 255
    n = next(n for n in js['nodes'] if n.get('name') == 'Hair')
    uv = accessor(js, b, js['meshes'][n['mesh']]['primitives'][0]['attributes']['TEXCOORD_0'])
    H, W = img.shape[:2]
    x = np.clip((uv[:, 0] % 1 * W).astype(int), 0, W - 1); y = np.clip((uv[:, 1] % 1 * H).astype(int), 0, H - 1)
    c = img[y, x]
    L = c @ [.3, .59, .11]
    return np.median(c, 0), c[L <= np.percentile(L, 15)].mean(0)


def add_view(js, blob, data, target):
    while len(blob) % 4:
        blob.append(0)
    js['bufferViews'].append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data), 'target': target})
    blob.extend(data)
    return len(js['bufferViews']) - 1


def add_acc(js, blob, arr, ctype, typ, target, minmax=False):
    a = {'bufferView': add_view(js, blob, arr.tobytes(), target), 'byteOffset': 0, 'componentType': ctype, 'count': len(arr), 'type': typ}
    if minmax:
        a['min'] = [float(x) for x in arr.min(0)]; a['max'] = [float(x) for x in arr.max(0)]
    js['accessors'].append(a)
    return len(js['accessors']) - 1


def build(js, b, k, inset, dark):
    hb = js['extensions']['VRMC_vrm']['humanoid']['humanBones']
    W, _ = node_world(js)
    head_node = hb['head']['node']; hy = W[head_node][1, 3]
    g = mesh_groups(js, b)
    S, H, BODY = g['shell'][0], g['hair'][0], g['body'][0]
    # 中心: 高さは Head の上半分の中央、奥行きは顔の前と固定の髪の後ろの中央
    t = S.reshape(-1, 3); ty = t[t[:, 1] > hy]
    cy = (ty[:, 1].min() + ty[:, 1].max()) / 2
    hv = H[g['hair'][1] >= .9].reshape(-1, 3)
    band = hv[np.abs(hv[:, 0]) < .12]
    cz = (t[:, 2].max() + band[:, 2].min()) / 2
    c = np.array([0, cy, cz])
    # 首: 頭の骨の近くの Body の一番上
    bv = BODY.reshape(-1, 3)
    near = bv[(np.abs(bv[:, 0]) < .07) & (np.abs(bv[:, 2] - W[hb['neck']['node']][2, 3]) < .07)]
    top = near[:, 1].max()
    ring = near[(near[:, 1] < top - .01) & (near[:, 1] > top - .05)]
    z_neck = ring[:, 2].mean()
    r_neck = np.percentile(np.hypot(ring[:, 0], ring[:, 2] - z_neck), 90)
    y0 = min(hy, top - .02)
    # 方向ごとの最初の当たり
    fd, _ = icosphere(5)
    rS, rH = hits(c, fd, S), hits(c, fd, H)
    fine = np.minimum(rS, rH)
    tree = cKDTree(fd)
    finite = np.isfinite(fine)
    near_f = cKDTree(fd[finite])
    d_low, f_low = icosphere(4)

    def cap_min(q, ang):
        out = np.empty(len(q))
        for i, nb in enumerate(near_f.query_ball_point(q, 2 * np.sin(np.radians(ang) / 2))):
            out[i] = fine[finite][nb].min() if nb else np.inf
        return out
    r = cap_min(d_low, 7)
    miss = ~np.isfinite(r)
    if miss.any():
        r[miss] = cap_min(d_low[miss], 20)
    head_hit = np.isfinite(hits(c, d_low, S))
    # 下の円すいで切る
    rays = np.linspace(.01, 1, 400)[None]            # V,S
    P = c[None, None] + rays[..., None] * d_low[:, None]
    rho = np.hypot(P[..., 0], P[..., 2] - z_neck)
    below = P[..., 1] < y0 + k * np.maximum(0, rho - r_neck)
    first = np.where(below.any(1), below.argmax(1), 399)
    r = np.minimum(r, rays[0, first])
    limit = r - inset
    # なめらかにする(limit を超えない)
    edges = np.concatenate([f_low[:, [0, 1]], f_low[:, [1, 2]], f_low[:, [2, 0]]])
    nb = [[] for _ in d_low]
    for a, bb in edges:
        nb[a].append(bb)
    r = limit.copy()
    for _ in range(4):
        avg = np.array([r[n].mean() for n in nb])
        r = np.minimum(limit, .5 * r + .5 * avg)
    V = c + r[:, None] * d_low
    # Head に塞がれた面を捨てる: Head の端から 2 輪より内側
    dist = np.where(head_hit, 99, 0)
    for _ in range(3):
        dist = np.array([min(dist[i], min(dist[n] for n in nb[i]) + 1) for i in range(len(dist))])
    keep = ~(dist[f_low] >= 3).all(1)
    F = f_low[keep]
    used = np.unique(F); remap = -np.ones(len(V), int); remap[used] = np.arange(len(used))
    V2, F2 = V[used], remap[F]
    # 法線
    N = np.zeros_like(V2)
    fn = np.cross(V2[F2[:, 1]] - V2[F2[:, 0]], V2[F2[:, 2]] - V2[F2[:, 0]])
    for i in range(3):
        np.add.at(N, F2[:, i], fn)
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
    return dict(V=V2, F=F2, N=N, center=c, y0=y0, top=top, z_neck=z_neck, r_neck=r_neck, head_node=head_node, n_head_hit=int(head_hit.sum()))


def append_liner(js, b, shape, base_srgb):
    blob = bytearray(b)
    V, F, N = shape['V'], shape['F'], shape['N']
    joints = js['skins'][0]['joints']; j = joints.index(shape['head_node'])
    pos = add_acc(js, blob, V.astype('<f4'), 5126, 'VEC3', 34962, True)
    nor = add_acc(js, blob, N.astype('<f4'), 5126, 'VEC3', 34962)
    jnt = add_acc(js, blob, np.tile(np.array([j, 0, 0, 0], '<u2'), (len(V), 1)), 5123, 'VEC4', 34962)
    wgt = add_acc(js, blob, np.tile(np.array([1, 0, 0, 0], '<f4'), (len(V), 1)), 5126, 'VEC4', 34962)
    idx = add_acc(js, blob, F.astype('<u4').reshape(-1), 5125, 'SCALAR', 34963, False)
    ia = js['accessors'][idx]; ia['min'] = [int(F.min())]; ia['max'] = [int(F.max())]
    lin = [float(x) for x in srgb2lin(base_srgb)]
    src = hair_material(js)
    mt = json.loads(json.dumps(src))
    mt['name'] = 'head_liner'
    mt.pop('normalTexture', None)
    mt['pbrMetallicRoughness'] = {'baseColorFactor': lin + [1.0]}
    ext = mt['extensions']['VRMC_materials_mtoon']
    ext.pop('shadeMultiplyTexture', None)
    ext['shadeColorFactor'] = lin
    js['materials'].append(mt)
    js['meshes'].append({'name': 'Head_liner', 'primitives': [{'attributes': {'POSITION': pos, 'NORMAL': nor, 'JOINTS_0': jnt, 'WEIGHTS_0': wgt}, 'indices': idx, 'material': len(js['materials']) - 1, 'mode': 4}]})
    js['nodes'].append({'name': 'Head_liner', 'mesh': len(js['meshes']) - 1, 'skin': 0})
    js['scenes'][js.get('scene', 0)]['nodes'].append(len(js['nodes']) - 1)
    js['buffers'][0]['byteLength'] = len(blob) + (-len(blob) % 4)
    return bytes(blob)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('dst')
    ap.add_argument('--k', type=float, default=1.0); ap.add_argument('--inset', type=float, default=.006)
    ap.add_argument('--color', help='sRGB r,g,b 0..1 を直接指定'); ap.add_argument('--dark', type=float, default=1.0)
    a = ap.parse_args()
    js, b = read_glb(a.src)
    med, dark = hair_color(js, b)
    col = np.array([float(x) for x in a.color.split(',')]) if a.color else dark * a.dark
    s = build(js, b, a.k, a.inset, a.dark)
    print('center', s['center'].round(4), 'neck top', round(float(s['top']), 4), 'z', round(float(s['z_neck']), 4), 'r', round(float(s['r_neck']), 4), 'y0', round(float(s['y0']), 4))
    print('verts', len(s['V']), 'tris', len(s['F']), 'hair median', med.round(3), 'dark15', dark.round(3), 'liner', np.round(col, 3))
    new = append_liner(js, b, s, col)
    write_glb(a.dst, js, new)
    json.dump({'center': [float(x) for x in s['center']], 'tris': len(s['F']), 'verts': len(s['V']), 'color_srgb': [float(x) for x in col]}, open(a.dst + '.json', 'w'))
