"""VRM に bake_motion.mjs の動きを足した GLB を作る。VRM の拡張を外すので Blender の glTF の読み込みでそのまま開ける。
    python tools/bake_glb.py model.vrm bake.json out.glb
"""
import json
import re
import struct
import sys

import numpy as np

vrm, bake, out = sys.argv[1:4]
b = open(vrm, 'rb').read()
n = struct.unpack('<I', b[12:16])[0]
js = json.loads(b[20:20 + n])
binary = bytearray(b[28 + n:])
d = json.load(open(bake))
sanitize = lambda s: re.sub(r'[\[\].:/]', '', s.replace(' ', '_'))
by_name = {}
for i, node in enumerate(js['nodes']):
    by_name.setdefault(sanitize(node.get('name', f'node{i}')), i)
times = np.arange(len(d['frames']), dtype=np.float32) / d['fps']


def add(arr, typ, minmax=False):
    while len(binary) % 4:
        binary.append(0)
    raw = np.asarray(arr, np.float32).tobytes()
    js['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(raw)})
    binary.extend(raw)
    acc = {'bufferView': len(js['bufferViews']) - 1, 'componentType': 5126, 'count': int(len(arr) if typ != 'SCALAR' or np.ndim(arr) == 1 else np.size(arr)), 'type': typ}
    if minmax:
        acc['min'], acc['max'] = [float(np.min(arr))], [float(np.max(arr))]
    js['accessors'].append(acc)
    return len(js['accessors']) - 1


t_acc = add(times, 'SCALAR', True)
channels, samplers = [], []
B = np.array([f['b'] for f in d['frames']], np.float32)  # F, bones, 7
missing = []
for k, name in enumerate(d['bones']):
    node = by_name.get(sanitize(name))
    if node is None:
        missing.append(name)
        continue
    for path, typ, arr in (('translation', 'VEC3', B[:, k, :3]), ('rotation', 'VEC4', B[:, k, 3:])):
        samplers.append({'input': t_acc, 'output': add(arr, typ), 'interpolation': 'LINEAR'})
        channels.append({'sampler': len(samplers) - 1, 'target': {'node': node, 'path': path}})
for k, name in enumerate(d['meshes']):
    node = by_name.get(sanitize(name))
    w = np.array([f['m'][k] for f in d['frames']], np.float32)
    if node is None or 'mesh' not in js['nodes'][node]:
        missing.append(name)
        continue
    if w.max() < 1e-4:
        continue
    samplers.append({'input': t_acc, 'output': add(w.reshape(-1), 'SCALAR'), 'interpolation': 'LINEAR'})
    channels.append({'sampler': len(samplers) - 1, 'target': {'node': node, 'path': 'weights'}})
if missing:
    print('not found', missing[:8], len(missing))
js['animations'] = [{'name': 'bake', 'channels': channels, 'samplers': samplers}]
for k in ('extensions', 'extensionsUsed', 'extensionsRequired'):
    js.pop(k, None)
for m in js.get('materials', []):
    m.pop('extensions', None)
js['buffers'][0]['byteLength'] = len(binary)
while len(binary) % 4:
    binary.append(0)
js['buffers'][0]['byteLength'] = len(binary)
text = json.dumps(js, separators=(',', ':'), ensure_ascii=False).encode('utf8')
text += b' ' * (-len(text) % 4)
total = 12 + 8 + len(text) + 8 + len(binary)
with open(out, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, total))
    f.write(struct.pack('<II', len(text), 0x4E4F534A) + text)
    f.write(struct.pack('<II', len(binary), 0x004E4942) + binary)
print(out, 'channels', len(channels), 'frames', len(times), 'yaw', d['yaw'])
