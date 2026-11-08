# 目の中の範囲(HOLE_MASK)を、目の中を緑で塗った絵から作る。
#   python hole_mask.py FACE_DIR hole_green.png ALIGN_NAME out.png REF.png
# hole_green.png は、中立の顔の絵を image_gen に「目の中(瞳と白目)を #00FF00 で塗って」と編集させたもの(キャンバスは元の絵と同じ)。
# REF.png は、align.json の ALIGN_NAME の位置合わせに使った絵(atlas.py が置く絵)。大きさが違えば倍率と位置が合わないので止める。
# 緑の画素を、atlas.py が描いた絵を置くのと同じ方法(align.json の ALIGN_NAME の倍率と位置、LANCZOS)で正面の撮影に置き、
# regions.json の upper の bbox(区画の大きさ)で切り出す。白 = 開いた所。paint_gaze.py の HOLE_MASK に渡す。
# 緑の見分け: g が r と b のどちらよりも 100 以上大きく、不透明(alpha > 127)。置いたあとは 127 を境に白黒にする。
import json, os, sys
import numpy as np
from PIL import Image

D, green, name, out, ref = sys.argv[1:6]
al = json.load(open(os.path.join(D, 'align.json')))
reg = json.load(open(os.path.join(D, 'regions.json')))
W = reg.get('size') or json.load(open(os.path.join(D, 'cam.json')))['size']
if name not in al: sys.exit(f'align.json に {name} が無い(ある名前: {", ".join(al)})')
s, tx, ty = al[name]
gs, rs = Image.open(green).size, Image.open(ref).size
if gs != rs: sys.exit(f'緑塗りの絵の大きさ {gs[0]}x{gs[1]} が、位置合わせに使った絵 {ref} の {rs[0]}x{rs[1]} と違う(image_gen が大きさを変えて返した。元の絵と同じ大きさにしてから使う)')
g = np.asarray(Image.open(green).convert('RGBA')).astype(np.int32)
m = (g[..., 1] - np.maximum(g[..., 0], g[..., 2]) > 100) & (g[..., 3] > 127)
if not m.any(): sys.exit('緑(#00FF00)の画素が無い: ' + green)
I = Image.fromarray((m * 255).astype(np.uint8), 'L')
I = I.resize((int(I.size[0] * s), int(I.size[1] * s)), Image.LANCZOS)
c = Image.new('L', (W, W)); c.paste(I, (int(round(tx)), int(round(ty))))
x0, y0, x1, y1 = reg['upper']['bbox']
cell = (np.asarray(c)[y0:y1, x0:x1] > 127).astype(np.uint8) * 255
Image.fromarray(cell, 'L').save(out)
print('HOLE', out, f'{x1 - x0}x{y1 - y0}', 'white', int((cell > 0).sum()), 'green', int(m.sum()))
