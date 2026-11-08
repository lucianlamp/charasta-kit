# image_gen で一部だけ描き直させた絵から、その所だけを元の絵に貼り込む(docs/face_atlas.md「ふだんの口は微笑みにする」)。
#   python paste_area.py BASE.png EDIT.png OUT.png --box X0,Y0,X1,Y1 [--feather 16] [--max-band-diff 24]
# BASE と EDIT は同じキャンバス(image_gen の編集は元の絵と同じ大きさで返る。違えば止める)。
# 四角の中は EDIT、外は BASE。四角の縁から内側へ feather 画素かけて混ぜ、境目を見せない。
# ほかの所の色のずれ(image_gen は編集していない所も少し変える)を持ち込まないためで、線を描き直すものではない。
# 混ぜる帯(0 < 混ぜ率 < 1 の画素)の中で |EDIT - BASE| の最大(0〜255)を出す。max-band-diff(既定 24)を超えたら、帯が描き直した線にかかっている
# ので、出力を書かずに止める(四角を広げて、描き直した線が帯より内側に入るようにする)。
import argparse
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('base'); ap.add_argument('edit'); ap.add_argument('out')
ap.add_argument('--box', required=True); ap.add_argument('--feather', type=int, default=16); ap.add_argument('--max-band-diff', type=float, default=24)
a = ap.parse_args()
B = np.asarray(Image.open(a.base).convert('RGBA')).astype(np.float32)
E = np.asarray(Image.open(a.edit).convert('RGBA')).astype(np.float32)
if B.shape != E.shape: raise SystemExit(f'大きさが違う: {a.base} {B.shape[1]}x{B.shape[0]}、{a.edit} {E.shape[1]}x{E.shape[0]}')
x0, y0, x1, y1 = map(int, a.box.split(','))
H, W = B.shape[:2]
if not (0 <= x0 < x1 <= W and 0 <= y0 < y1 <= H): raise SystemExit(f'四角が絵の外: {a.box}({W}x{H})')
yy, xx = np.mgrid[0:H, 0:W]
d = np.minimum.reduce([xx - x0, x1 - 1 - xx, yy - y0, y1 - 1 - yy]).astype(np.float32)   # 四角の縁からの内向きの距離
m = np.clip((d + 1) / max(a.feather, 1), 0, 1)[..., None]
band = ((m > 0) & (m < 1))[..., 0]
band_diff = float(np.abs(E - B).max(-1)[band].max()) if band.any() else 0.0
if band_diff > a.max_band_diff: raise SystemExit(f'混ぜる帯の中で EDIT と BASE が {band_diff:.0f}/255 違う(上限 {a.max_band_diff:g})。帯が描き直した線にかかっている。--box を広げる。出力は書いていない')
out = B * (1 - m) + E * m
Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8), 'RGBA').save(a.out)
changed = np.abs(out - B).max(-1) > 0.5
print('PASTED', a.out, 'box', a.box, 'feather', a.feather, 'changed px', int(changed.sum()), 'band max diff', f'{band_diff:.0f}')
