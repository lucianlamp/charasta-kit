"""Head ノードから、指定した材質の面を別のノード Head_accessories に分ける(BIN は変えない)。
Tripo Studio の版は頭の飾りが Head と同じメッシュに入っているので、顔の組み立てで Head を外す前に分ける。
python split_head.py <src.vrm> <dst.vrm> <飾りの材質名(例 Material_accessories)>
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb import read_glb, write_glb
if len(sys.argv) < 4: raise SystemExit(__doc__)
src, dst, mat = sys.argv[1], sys.argv[2], sys.argv[3]
js, b = read_glb(src)
hi = next(i for i, n in enumerate(js['nodes']) if n.get('name') == 'Head')
h = js['nodes'][hi]; m = js['meshes'][h['mesh']]
keep = [p for p in m['primitives'] if js['materials'][p['material']]['name'] != mat]
acc = [p for p in m['primitives'] if js['materials'][p['material']]['name'] == mat]
assert acc and keep
m['primitives'] = keep
js['meshes'].append({'name': 'Head_accessories', 'primitives': acc})
node = {'name': 'Head_accessories', 'mesh': len(js['meshes']) - 1}
for k in ('skin', 'translation', 'rotation', 'scale', 'matrix'):
    if k in h: node[k] = h[k]
js['nodes'].append(node); ni = len(js['nodes']) - 1
parent = next((n for n in js['nodes'] if hi in n.get('children', [])), None)
if parent is not None: parent['children'].append(ni)
else: js['scenes'][js.get('scene', 0)]['nodes'].append(ni)
write_glb(dst, js, b)
print('split', len(keep), 'head prims,', len(acc), 'accessory prims; parent', parent and parent.get('name'))
