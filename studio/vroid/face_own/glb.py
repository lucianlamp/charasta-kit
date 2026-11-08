"""GLB の読み書きと、アクセサを numpy で読む最小の道具。"""
import json, struct
import numpy as np

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    raw = open(path, 'rb').read()
    magic, ver, length = struct.unpack('<4sII', raw[:12])
    assert magic == b'glTF' and ver == 2
    p, js, bin_ = 12, None, b''
    while p < length:
        n, t = struct.unpack('<I4s', raw[p:p + 8])
        d = raw[p + 8:p + 8 + n]
        if t == b'JSON':
            js = json.loads(d.decode('utf8'))
        elif t == b'BIN\0':
            bin_ = d
        p += 8 + n
    return js, bin_


def write_glb(path, js, bin_):
    j = json.dumps(js, ensure_ascii=False, separators=(',', ':')).encode('utf8')
    j += b' ' * (-len(j) % 4)
    b = bytes(bin_) + b'\0' * (-len(bin_) % 4)
    total = 12 + 8 + len(j) + 8 + len(b)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total))
        f.write(struct.pack('<I4s', len(j), b'JSON')); f.write(j)
        f.write(struct.pack('<I4s', len(b), b'BIN\0')); f.write(b)


def accessor(js, bin_, i):
    a = js['accessors'][i]
    dt = np.dtype(CT[a['componentType']]).newbyteorder('<')
    nc = NC[a['type']]
    v = js['bufferViews'][a['bufferView']]
    off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = v.get('byteStride', 0) or dt.itemsize * nc
    n = a['count']
    if stride == dt.itemsize * nc:
        arr = np.frombuffer(bin_, dt, n * nc, off).reshape(n, nc)
    else:
        arr = np.stack([np.frombuffer(bin_, dt, nc, off + k * stride) for k in range(n)])
    return arr.squeeze(-1) if nc == 1 else arr


def node_world(js):
    """ノードごとの世界行列(レスト)と親。"""
    nodes = js['nodes']
    parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}

    def local(n):
        if 'matrix' in n:
            return np.array(n['matrix'], float).reshape(4, 4).T
        t = np.array(n.get('translation', [0, 0, 0]), float)
        x, y, z, w = n.get('rotation', [0, 0, 0, 1])
        s = np.array(n.get('scale', [1, 1, 1]), float)
        R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        M = np.eye(4); M[:3, :3] = R * s; M[:3, 3] = t
        return M
    world = {}

    def w(i):
        if i not in world:
            world[i] = (w(parent[i]) if i in parent else np.eye(4)) @ local(nodes[i])
        return world[i]
    return [w(i) for i in range(len(nodes))], parent
