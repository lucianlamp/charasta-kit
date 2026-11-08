"""Body と Hair の中身、画像、揺れものが元と同じかを確かめ、VRM の項目を数える。python verify.py out.vrm source.vrm"""
import sys, hashlib, json, os
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from glbw import *
ja, ba = read_glb(sys.argv[2]); jb, bb = read_glb(sys.argv[1])
def acc_hash(js, b, i): return hashlib.sha1(accessor(js, b, i).tobytes()).hexdigest()
def prim_hashes(js, b, name):
    n = next(n for n in js['nodes'] if n.get('name') == name)
    return [{k: acc_hash(js, b, v) for k, v in {**p['attributes'], 'INDICES': p['indices']}.items()} for p in js['meshes'][n['mesh']]['primitives']]
for nm in ('Body', 'Hair'):
    print(nm, 'same accessors:', prim_hashes(ja, ba, nm) == prim_hashes(jb, bb, nm))
def img_hash(js, b):
    o = {}
    for im in js['images']:
        v = js['bufferViews'][im['bufferView']]; a = v.get('byteOffset', 0); o[im['name']] = hashlib.sha1(b[a:a + v['byteLength']]).hexdigest()
    return o
ia, ib = img_hash(ja, ba), img_hash(jb, bb)
print('kept images same:', {k: ia[k] == ib[k] for k in ib if k in ia}, 'new:', [k for k in ib if k not in ia], 'dropped:', [k for k in ia if k not in ib])
print('springBone same:', json.dumps(ja['extensions']['VRMC_springBone'], sort_keys=True) == json.dumps(jb['extensions']['VRMC_springBone'], sort_keys=True))
wa, _ = node_world(ja); wb, _ = node_world(jb)
print('old nodes same:', all(np.allclose(wa[i], wb[i]) and ja['nodes'][i].get('name') == jb['nodes'][i].get('name') for i in range(len(ja['nodes']))))
sk = jb['skins'][0]; print('joints', len(ja['skins'][0]['joints']), '->', len(sk['joints']))
ibm = accessor(jb, bb, sk['inverseBindMatrices']).reshape(-1, 4, 4); ibo = accessor(ja, ba, ja['skins'][0]['inverseBindMatrices']).reshape(-1, 4, 4)
print('old ibm same', np.allclose(ibm[:len(ibo)], ibo))
v = jb['extensions']['VRMC_vrm']
print('specVersion', v.get('specVersion'), 'lookAt', v['lookAt']['type'], 'L/R eye', jb['nodes'][v['humanoid']['humanBones']['leftEye']['node']]['name'], jb['nodes'][v['humanoid']['humanBones']['rightEye']['node']]['name'])
f = next(n for n in jb['nodes'] if n.get('name') == 'Face'); m = jb['meshes'][f['mesh']]
tn = m['extras']['targetNames']; tn0 = json.load(open(os.path.join(HERE, 'fcl_names.json')))
print('target names equal official:', tn == tn0, len(tn), 'prims', [(jb['materials'][p['material']]['name'], jb['accessors'][p['attributes']['POSITION']]['count'], len(p['targets'])) for p in m['primitives']])
print({k: [tn[b_['index']] for b_ in e.get('morphTargetBinds', [])] for k, e in v['expressions']['preset'].items()})
print('total nodes', len(jb['nodes']), 'size MB', round(len(bb) / 1e6, 1))
