"""きゃらくるの表情(EA_ のシェイプキー)を、VRoid の Fcl の 57 個の名前と順へ移す。

キットの表情は EA_happy_eye、EA_happy_mouth、EA_brow_happy のように部品ごとのキーで、
プリセットはそれを 3 つ足して呼ぶ。VRoid はプリセットが Fcl_ALL_Joy のようなキーを 1 つ 100% で呼ぶ。
ここでは、各 Fcl のキーを対応する EA_ のキーの和で作り、プリセットをそのキー 1 つに付け替える。
キットに無い動き(Fcl_HA_ の牙、Fcl_MTH_Large など)は動かないキーにする。
1 つの Fcl に当たらない EA_ のキー(EA_happy_eye)は 57 個の後ろに残し、それを呼ぶ独自の表情も残す。

vroid-conform.mjs の前に通す:
python studio/vroid/kit_fcl.py <きゃらくるの VRM> <出力> [--ref studio/vroid/reference.json]
"""
import os
import sys
import json
import argparse
import re

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'face_own'))
import numpy as np
from glbw import W, read_glb, write_glb, accessor

# Fcl のキー → 足す EA_ のキー。書いていない Fcl のキーは動かない。
FCL_FROM_KIT = {
    'Fcl_ALL_Angry': ['EA_angry_eye', 'EA_angry_mouth', 'EA_brow_angry'],
    'Fcl_ALL_Fun': ['EA_relaxed_eye', 'EA_relaxed_mouth', 'EA_brow_relaxed'],
    'Fcl_ALL_Joy': ['EA_happy_eye', 'EA_happy_mouth', 'EA_brow_happy'],
    'Fcl_ALL_Sorrow': ['EA_sad_eye', 'EA_sad_mouth', 'EA_brow_sad'],
    'Fcl_ALL_Surprised': ['EA_surprised_eye', 'EA_surprised_mouth', 'EA_brow_surprised'],
    'Fcl_BRW_Angry': ['EA_brow_angry'], 'Fcl_BRW_Fun': ['EA_brow_relaxed'], 'Fcl_BRW_Joy': ['EA_brow_happy'],
    'Fcl_BRW_Sorrow': ['EA_brow_sad'], 'Fcl_BRW_Surprised': ['EA_brow_surprised'],
    'Fcl_EYE_Angry': ['EA_angry_eye'], 'Fcl_EYE_Close': ['EA_blink'], 'Fcl_EYE_Close_R': ['EA_blink_R'], 'Fcl_EYE_Close_L': ['EA_blink_L'],
    'Fcl_EYE_Fun': ['EA_relaxed_eye'], 'Fcl_EYE_Joy': ['EA_blink_smile'], 'Fcl_EYE_Joy_R': ['EA_blink_smile_R'], 'Fcl_EYE_Joy_L': ['EA_blink_smile_L'],
    'Fcl_EYE_Sorrow': ['EA_sad_eye'], 'Fcl_EYE_Surprised': ['EA_surprised_eye'],
    'Fcl_MTH_Angry': ['EA_angry_mouth'], 'Fcl_MTH_Fun': ['EA_relaxed_mouth'], 'Fcl_MTH_Joy': ['EA_happy_mouth'],
    'Fcl_MTH_Sorrow': ['EA_sad_mouth'], 'Fcl_MTH_Surprised': ['EA_surprised_mouth'],
    'Fcl_MTH_A': ['EA_aa'], 'Fcl_MTH_I': ['EA_ih'], 'Fcl_MTH_U': ['EA_ou'], 'Fcl_MTH_E': ['EA_ee'], 'Fcl_MTH_O': ['EA_oh'],
}


class KitFclError(Exception):
    pass


# 顔の部品の材質(目、口、眉、顔の肌など)は、キーが 0 でも顔のメッシュに残す。conform が Face の役にする材質と同じ範囲
FACE_MATERIAL = re.compile(r'face|eye|iris|mouth|brow|lash|head|skin', re.I)


def split_static(js, b, mi):
    """キーが全部 0 の面(頭と同じメッシュにある飾りなど)を、キーの無い別のメッシュとノードへ移す。
    残すと vroid-conform.mjs が「キーのある面」として Body と別のメッシュにし、メッシュが Body・Body の 2 つになる。"""
    m = js['meshes'][mi]
    face_part = lambda p: FACE_MATERIAL.search(js['materials'][p['material']].get('name', '')) if 'material' in p else True
    static = [p for p in m['primitives'] if not face_part(p) and all(not accessor(js, b, a).any() for t in p.get('targets', []) for a in t.values())]
    if not static or len(static) == len(m['primitives']): return 0
    m['primitives'] = [p for p in m['primitives'] if p not in static]
    for p in static: p.pop('targets', None)
    js['meshes'].append({'name': f'{m.get("name", "mesh")} (static)', 'primitives': static})
    nm = len(js['meshes']) - 1
    parent = {c: i for i, n in enumerate(js['nodes']) for c in n.get('children', [])}
    for ni, n in list(enumerate(js['nodes'])):
        if n.get('mesh') != mi: continue
        new = {k: v for k, v in n.items() if k in ('skin', 'translation', 'rotation', 'scale', 'matrix')}
        new.update(name=f'{n.get("name", "node")}_static', mesh=nm)
        js['nodes'].append(new); k = len(js['nodes']) - 1
        if ni in parent: js['nodes'][parent[ni]].setdefault('children', []).append(k)
        else:
            for s in js.get('scenes', []):
                if ni in s.get('nodes', []): s['nodes'].append(k)
    return len(static)


def convert(js, b, fcl_names, presets):
    """js と BIN を書き換えて返す。fcl_names は手本の 57 個の順、presets は {プリセット: [Fcl のキー]}。"""
    for k, srcs in FCL_FROM_KIT.items():
        if k not in fcl_names: raise KitFclError(f'手本に {k} が無い')
    meshes = [i for i, m in enumerate(js['meshes']) if any(n.startswith('EA_') for n in m.get('extras', {}).get('targetNames', []))]
    if not meshes: raise KitFclError('EA_ のキーを持つメッシュが無い(きゃらくるの表情付き VRM ではない)')
    if len(meshes) > 1: raise KitFclError('EA_ のキーを持つメッシュが 2 つ以上ある(目やまつ毛が別のメッシュ)。顔が 1 つのメッシュの頭だけを扱う')
    if any(n.startswith('Fcl_') for mi in meshes for n in js['meshes'][mi]['extras']['targetNames']): raise KitFclError('もう Fcl のキーがある(変換済み)')
    split_static(js, b, meshes[0])
    single = {srcs[0]: k for k, srcs in FCL_FROM_KIT.items() if len(srcs) == 1}
    w = W(js, b); zeros = {}
    remap = {}   # (メッシュ, 元の番号) -> 新しい番号
    report = {}
    for mi in meshes:
        m = js['meshes'][mi]; old = m['extras']['targetNames']
        missing = sorted({s for srcs in FCL_FROM_KIT.values() for s in srcs} - set(old))
        if missing: raise KitFclError(f'{m.get("name")}: キットのキーが足りない: {", ".join(missing)}')
        extra = [n for n in old if n not in single and not n.startswith('Fcl_')]
        names = list(fcl_names) + extra
        for p in m['primitives']:
            if len(p.get('targets', [])) != len(old): raise KitFclError(f'{m.get("name")}: 面ごとのキーの数がそろっていない')
            attrs = sorted({k for t in p['targets'] for k in t})
            src = {a: {n: accessor(js, b, t[a]).astype(np.float32) for n, t in zip(old, p['targets']) if a in t} for a in attrs}
            nv = len(accessor(js, b, p['attributes']['POSITION']))
            out = []
            for n in names:
                t = {}
                for a in attrs:
                    d = sum((src[a][s] for s in FCL_FROM_KIT.get(n, [n] if n in src[a] else []) if s in src[a]), np.zeros((nv, 3), np.float32))
                    if not d.any():
                        if nv not in zeros: zeros[nv] = w.acc(np.zeros((nv, 3), np.float32), 'VEC3', 5126, bounds=True)
                        t[a] = zeros[nv]
                    else:
                        t[a] = w.acc(d, 'VEC3', 5126, bounds=(a == 'POSITION'))
                out.append(t)
            p['targets'] = out
        m['extras']['targetNames'] = names
        if 'weights' in m: m['weights'] = [0.0] * len(names)
        for i, n in enumerate(old):
            if n in names: remap[(mi, i)] = names.index(n)
            elif n in single: remap[(mi, i)] = names.index(single[n])
        report[m.get('name', mi)] = {'fcl': len(fcl_names), 'extra': extra}
    node_mesh = {ni: n['mesh'] for ni, n in enumerate(js['nodes']) if 'mesh' in n}
    face_nodes = [ni for ni, mi in node_mesh.items() if mi in meshes]
    ex = js['extensions']['VRMC_vrm']['expressions']
    # プリセット: 手本どおり Fcl のキー 1 つ 100%。顔のノードが 2 つ以上あれば(面ごとに分かれた頭)すべてに付ける
    for k, keys in presets.items():
        e = ex['preset'].setdefault(k, {'isBinary': False})
        e['morphTargetBinds'] = [{'node': ni, 'index': js['meshes'][node_mesh[ni]]['extras']['targetNames'].index(key), 'weight': 1.0} for key in keys for ni in face_nodes]
    # 独自の表情は、元のキーの新しい番号へ
    for k, e in ex.get('custom', {}).items():
        binds = []
        for bd in e.get('morphTargetBinds', []):
            key = (node_mesh.get(bd['node']), bd['index'])
            if key in remap: binds.append({**bd, 'index': remap[key]})
            elif node_mesh.get(bd['node']) not in meshes: binds.append(bd)
        e['morphTargetBinds'] = binds
    js['buffers'][0]['byteLength'] = len(w.bin)
    return js, bytes(w.bin), report


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('src'); ap.add_argument('dst')
    ap.add_argument('--ref', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'reference.json'))
    a = ap.parse_args()
    ref = json.load(open(a.ref, encoding='utf8'))
    js, b = read_glb(a.src)
    try:
        js, b, rep = convert(js, b, ref['morphs'], ref['presets'])
    except KitFclError as e:
        raise SystemExit(str(e))
    write_glb(a.dst, js, b)
    print(f'{a.dst}: ' + '、'.join(f'{k} Fcl {v["fcl"]} 個 + 残したキー {v["extra"]}' for k, v in rep.items()))


if __name__ == '__main__':
    main()
