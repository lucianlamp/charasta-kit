# スマホ用の軽い VRM を作る: 画像を縮めて glb を組み直す（形・骨・表情・UV はそのまま）。
#   python tools/make_lite.py IN.vrm OUT.vrm [--body 2048] [--atlas 4096]
# 一辺が --atlas を超える画像（顔テクスチャ方式の表情の絵など、もともと 4096 より大きいもの）は --atlas まで、
# それ以外は --body まで縮める。PNG は PNG、JPEG は JPEG のまま。
# 2026-10-30: 版をそのまま iPhone の Safari で開くと、画像だけで GPU に 400〜730MB 載り、ページが落ちた。
import argparse, io, json, struct, sys
from PIL import Image

ap = argparse.ArgumentParser(); ap.add_argument('src'); ap.add_argument('dst')
ap.add_argument('--body', type=int, default=2048); ap.add_argument('--atlas', type=int, default=4096)
a = ap.parse_args()

b = open(a.src, 'rb').read()
magic, ver, total = struct.unpack('<4sII', b[:12]); assert magic == b'glTF', 'not a glb'
jl, jt = struct.unpack('<I4s', b[12:20]); J = json.loads(b[20:20 + jl])
bl, bt = struct.unpack('<I4s', b[20 + jl:28 + jl]); BIN = b[28 + jl:28 + jl + bl]

img_views = {}
for im in J.get('images', []):
    if 'bufferView' in im: img_views[im['bufferView']] = im
before = after = 0
out = bytearray(); views = J['bufferViews']
for i, bv in enumerate(views):
    off = bv.get('byteOffset', 0); data = BIN[off:off + bv['byteLength']]
    if i in img_views:
        im = img_views[i]; pic = Image.open(io.BytesIO(data)); w, h = pic.size
        cap = a.atlas if max(w, h) > 4096 else a.body
        before += w * h * 4
        if max(w, h) > cap:
            s = cap / max(w, h); pic = pic.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
            buf = io.BytesIO()
            if im.get('mimeType') == 'image/jpeg': pic.convert('RGB').save(buf, 'JPEG', quality=90)
            else: pic.save(buf, 'PNG', optimize=False)
            data = buf.getvalue()
        after += pic.size[0] * pic.size[1] * 4
    while len(out) % 4: out.append(0)
    bv['byteOffset'] = len(out); bv['byteLength'] = len(data); out += data
while len(out) % 4: out.append(0)
J['buffers'][0]['byteLength'] = len(out)
js = json.dumps(J, separators=(',', ':')).encode()
while len(js) % 4: js += b' '
glb = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(out)) + struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(out), b'BIN\0') + bytes(out)
open(a.dst, 'wb').write(glb)
print(f'LITE {a.src} -> {a.dst}: file {len(b) / 1e6:.0f} -> {len(glb) / 1e6:.0f} MB, textures {before / 1e6:.0f} -> {after / 1e6:.0f} MB (RGBA, without mipmaps)')
