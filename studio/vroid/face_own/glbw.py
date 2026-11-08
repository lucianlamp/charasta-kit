"""GLB の読み書き(同じフォルダの glb.py)と、書き足しの道具。"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb import *

class W:
    """GLB の書き足し。"""
    def __init__(s, js, bin_):
        s.js = js; s.bin = bytearray(bin_)

    def view(s, data, target=None):
        s.bin += b'\0' * (-len(s.bin) % 4)
        v = {'buffer': 0, 'byteOffset': len(s.bin), 'byteLength': len(data)}
        if target: v['target'] = target
        s.bin += data
        s.js['bufferViews'].append(v); return len(s.js['bufferViews']) - 1

    def acc(s, arr, type_, ct, target=None, bounds=False):
        arr = np.asarray(arr); bv = s.view(arr.astype(np.dtype(CT[ct]).newbyteorder('<')).tobytes(), target)
        a = {'bufferView': bv, 'componentType': ct, 'count': len(arr), 'type': type_}
        if bounds: a['min'] = [float(x) for x in arr.min(0)]; a['max'] = [float(x) for x in arr.max(0)]
        s.js['accessors'].append(a); return len(s.js['accessors']) - 1

def remap_tex(o, tmap):
    if isinstance(o, dict):
        for k, v in o.items():
            if k.endswith('Texture') and isinstance(v, dict) and 'index' in v: v['index'] = tmap(v['index'])
            remap_tex(v, tmap)
    elif isinstance(o, list):
        for v in o: remap_tex(v, tmap)


def image_bytes(js, b, i):
    bv = js['bufferViews'][js['images'][i]['bufferView']]; a = bv.get('byteOffset', 0)
    return b[a:a + bv['byteLength']]


def compact(js, bin_):
    """使われているアクセサ・材質・テクスチャ・画像だけを残して詰め直す。"""
    used_m = sorted({p['material'] for m in js['meshes'] for p in m['primitives'] if 'material' in p})
    used_mesh = sorted({n['mesh'] for n in js['nodes'] if 'mesh' in n})
    nm = {o: n for n, o in enumerate(used_mesh)}
    js['meshes'] = [js['meshes'][i] for i in used_mesh]
    for n in js['nodes']:
        if 'mesh' in n: n['mesh'] = nm[n['mesh']]
    used_m = sorted({p['material'] for m in js['meshes'] for p in m['primitives']})
    mm = {o: n for n, o in enumerate(used_m)}
    js['materials'] = [js['materials'][i] for i in used_m]
    for m in js['meshes']:
        for p in m['primitives']: p['material'] = mm[p['material']]
    ut = set()
    remap_tex(js['materials'], lambda i: (ut.add(i), i)[1])
    ut = sorted(ut); tm = {o: n for n, o in enumerate(ut)}
    remap_tex(js['materials'], lambda i: tm[i])
    js['textures'] = [js['textures'][i] for i in ut]
    ui = sorted({t['source'] for t in js['textures']}); im = {o: n for n, o in enumerate(ui)}
    for t in js['textures']: t['source'] = im[t['source']]
    js['images'] = [js['images'][i] for i in ui]
    usedacc = set(s['inverseBindMatrices'] for s in js['skins'])
    for m in js['meshes']:
        for p in m['primitives']:
            usedacc.add(p['indices']); usedacc.update(p['attributes'].values())
            for t in p.get('targets', []): usedacc.update(t.values())
    ua = sorted(usedacc); am = {o: n for n, o in enumerate(ua)}
    views = {}; out = bytearray(); nv = []

    def keep(i):
        if i not in views:
            v = dict(js['bufferViews'][i]); a = v.get('byteOffset', 0); d = bin_[a:a + v['byteLength']]
            out.extend(b'\0' * (-len(out) % 4)); v['byteOffset'] = len(out); out.extend(d)
            views[i] = len(nv); nv.append(v)
        return views[i]
    acc = []
    for i in ua:
        a = dict(js['accessors'][i]); a['bufferView'] = keep(a['bufferView']); acc.append(a)
    for im_ in js['images']: im_['bufferView'] = keep(im_['bufferView'])
    js['accessors'] = acc; js['bufferViews'] = nv
    for m in js['meshes']:
        for p in m['primitives']:
            p['indices'] = am[p['indices']]; p['attributes'] = {k: am[v] for k, v in p['attributes'].items()}
            if 'targets' in p: p['targets'] = [{k: am[v] for k, v in t.items()} for t in p['targets']]
    for s in js['skins']: s['inverseBindMatrices'] = am[s['inverseBindMatrices']]
    return out

def quat(R):
    t = np.trace(R)
    if t > 0:
        s = np.sqrt(t + 1) * 2; q = [(R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s, s / 4]
    else:
        i = int(np.argmax(np.diag(R))); j, k = (i + 1) % 3, (i + 2) % 3
        s = np.sqrt(R[i, i] - R[j, j] - R[k, k] + 1) * 2; q = [0, 0, 0, 0]
        q[i] = s / 4; q[j] = (R[j, i] + R[i, j]) / s; q[k] = (R[k, i] + R[i, k]) / s; q[3] = (R[k, j] - R[j, k]) / s
    return [float(x) for x in q]

