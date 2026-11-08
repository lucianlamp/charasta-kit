"""studio/vroid/kit_fcl.py の確かめ。小さな GLB を作って変換し、キーと表情を見る。Blender は呼ばない。

python test/kit_fcl_check.py
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "studio" / "vroid"))
sys.path.insert(0, str(ROOT / "studio" / "vroid" / "face_own"))
import kit_fcl as K  # noqa: E402
from glbw import W, accessor  # noqa: E402

REF = json.loads((ROOT / "studio" / "vroid" / "reference.json").read_text(encoding="utf8"))
EA = ['EA_aa', 'EA_blink', 'EA_happy_eye', 'EA_angry_eye', 'EA_sad_eye', 'EA_relaxed_eye', 'EA_surprised_eye', 'EA_blink_L', 'EA_blink_R',
      'EA_blink_smile', 'EA_blink_smile_L', 'EA_blink_smile_R', 'EA_brow_happy', 'EA_brow_angry', 'EA_brow_sad', 'EA_brow_relaxed', 'EA_brow_surprised',
      'EA_happy_mouth', 'EA_angry_mouth', 'EA_sad_mouth', 'EA_relaxed_mouth', 'EA_surprised_mouth', 'EA_ih', 'EA_ou', 'EA_ee', 'EA_oh']
NV = 4


def build():
    """顔の面(キーごとに頂点 0 を i+1 mm 動かす)と、キーが全部 0 の飾りの面を 1 つのメッシュに持つキット形の VRM。"""
    js = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': 0}], 'bufferViews': [], 'accessors': [], 'materials': [{'name': 'face'}, {'name': 'acc'}],
          'nodes': [{'name': 'Root', 'children': [1]}, {'name': 'Head', 'mesh': 0, 'skin': 0}], 'scenes': [{'nodes': [0]}], 'meshes': [], 'extensions': {'VRMC_vrm': {'expressions': {'preset': {}, 'custom': {}}}}}
    w = W(js, b'')
    pos = w.acc(np.zeros((NV, 3), np.float32), 'VEC3', 5126, bounds=True)
    idx = w.acc(np.array([0, 1, 2], np.uint32), 'SCALAR', 5125)
    zero = w.acc(np.zeros((NV, 3), np.float32), 'VEC3', 5126, bounds=True)
    face_t = []
    for i in range(len(EA)):
        d = np.zeros((NV, 3), np.float32); d[0, 1] = (i + 1) / 1000
        face_t.append({'POSITION': w.acc(d, 'VEC3', 5126, bounds=True)})
    js['meshes'].append({'name': 'head', 'weights': [0] * len(EA), 'extras': {'targetNames': EA}, 'primitives': [
        {'attributes': {'POSITION': pos}, 'indices': idx, 'material': 0, 'targets': face_t},
        {'attributes': {'POSITION': pos}, 'indices': idx, 'material': 1, 'targets': [{'POSITION': zero} for _ in EA]}]})
    ex = js['extensions']['VRMC_vrm']['expressions']
    bind = lambda *ks: {'morphTargetBinds': [{'node': 1, 'index': EA.index(k), 'weight': 1.0} for k in ks], 'overrideBlink': 'block', 'isBinary': False}
    ex['preset'].update(blink=bind('EA_blink'), blinkLeft=bind('EA_blink_L'), blinkRight=bind('EA_blink_R'), happy=bind('EA_happy_eye', 'EA_happy_mouth', 'EA_brow_happy'),
                        aa=bind('EA_aa'), neutral={'isBinary': False})
    ex['custom'].update(happy_eye=bind('EA_happy_eye'), brow_angry=bind('EA_brow_angry'))
    return js, bytes(w.bin)


def dy(js, b, prim, key):
    names = js['meshes'][0]['extras']['targetNames']
    return float(accessor(js, b, prim['targets'][names.index(key)]['POSITION'])[0, 1]) * 1000


def main():
    js, b = build()
    js, b, rep = K.convert(js, b, REF['morphs'], REF['presets'])
    m = js['meshes'][0]; names = m['extras']['targetNames']
    assert names[:57] == REF['morphs'], 'Fcl の 57 個が手本の順で先頭にある'
    assert names[57:] == ['EA_happy_eye'], f'Fcl に 1 つで当たらないキーだけ後ろに残る: {names[57:]}'
    assert len(m['weights']) == len(names)
    assert len(m['primitives']) == 1, 'キーが全部 0 の面は顔のメッシュから外す'
    face = m['primitives'][0]
    assert len(face['targets']) == len(names)
    st = [i for i, nd in enumerate(js['nodes']) if nd.get('mesh') == 1]
    assert len(st) == 1, 'キーの無い面は別のメッシュとノードになる'
    accp = js['meshes'][1]['primitives'][0]
    assert 'targets' not in accp and 'extras' not in js['meshes'][1] and 'weights' not in js['meshes'][1] and accp['material'] == 1
    assert js['nodes'][st[0]]['skin'] == 0 and st[0] in js['nodes'][0]['children'], '同じスキンで、同じ親の下'
    v = lambda k: round(dy(js, b, face, k), 3)
    n = lambda k: EA.index(k) + 1
    assert v('Fcl_MTH_A') == n('EA_aa') and v('Fcl_EYE_Close_L') == n('EA_blink_L') and v('Fcl_EYE_Joy_R') == n('EA_blink_smile_R')
    assert v('Fcl_ALL_Joy') == n('EA_happy_eye') + n('EA_happy_mouth') + n('EA_brow_happy'), 'ALL はそろった部品の和'
    assert v('Fcl_ALL_Neutral') == 0 and v('Fcl_HA_Hide') == 0 and v('Fcl_EYE_Natural') == 0
    assert v('EA_happy_eye') == n('EA_happy_eye')
    acc = js['accessors'][face['targets'][names.index('Fcl_ALL_Joy')]['POSITION']]
    assert 'min' in acc and 'max' in acc, 'POSITION のキーには min と max'
    ex = js['extensions']['VRMC_vrm']['expressions']
    for k, want in REF['presets'].items():
        got = ex['preset'][k]['morphTargetBinds']
        assert [(g['node'], names[g['index']], g['weight']) for g in got] == [(1, want[0], 1.0)], f'{k}: {got}'
    assert ex['preset']['happy']['overrideBlink'] == 'block', 'プリセットの上書きの設定は残す'
    assert [names[g['index']] for g in ex['custom']['happy_eye']['morphTargetBinds']] == ['EA_happy_eye']
    assert [names[g['index']] for g in ex['custom']['brow_angry']['morphTargetBinds']] == ['Fcl_BRW_Angry']
    assert len(b) % 4 == 0 and js['buffers'][0]['byteLength'] == len(b)
    for a in js['accessors']:
        bv = js['bufferViews'][a['bufferView']]
        assert bv['byteOffset'] + bv['byteLength'] <= len(b)
    # NORMAL のキーも同じ和で作る
    js2, b2 = build()
    w2 = W(js2, b2)
    for i, t in enumerate(js2['meshes'][0]['primitives'][0]['targets']):
        nrm = np.zeros((NV, 3), np.float32); nrm[1, 0] = (i + 1) / 100
        t['NORMAL'] = w2.acc(nrm, 'VEC3', 5126)
    for t in js2['meshes'][0]['primitives'][1]['targets']: t['NORMAL'] = t['POSITION']
    js2, b2, _ = K.convert(js2, bytes(w2.bin), REF['morphs'], REF['presets'])
    names2 = js2['meshes'][0]['extras']['targetNames']; f2 = js2['meshes'][0]['primitives'][0]
    nj = accessor(js2, b2, f2['targets'][names2.index('Fcl_ALL_Joy')]['NORMAL'])[1, 0] * 100
    assert round(float(nj), 3) == n('EA_happy_eye') + n('EA_happy_mouth') + n('EA_brow_happy'), 'NORMAL も和'
    # 顔のメッシュが 2 つ以上なら止める
    js3, b3 = build()
    js3['meshes'].append(json.loads(json.dumps(js3['meshes'][0]))); js3['nodes'].append({'name': 'Lash', 'mesh': 1}); js3['nodes'][0]['children'].append(2)
    # キーが 0 でも顔の部品(瞳のハイライトなど)は顔のメッシュに残す
    js4, b4 = build(); js4['materials'][1]['name'] = 'EyeHighlight'
    js4, b4, _ = K.convert(js4, b4, REF['morphs'], REF['presets'])
    assert len(js4['meshes'][0]['primitives']) == 2 and len(js4['meshes']) == 1, '顔の部品は分けない'
    try:
        K.convert(js3, b3, REF['morphs'], REF['presets']); raise AssertionError('顔のメッシュが 2 つなら止める')
    except K.KitFclError:
        pass
    # 2 回目は止める(もう Fcl のキーがある)
    try:
        K.convert(js, b, REF['morphs'], REF['presets']); raise AssertionError('2 回目は止める')
    except K.KitFclError:
        pass
    print('kit_fcl_check: ok', rep)


main()
