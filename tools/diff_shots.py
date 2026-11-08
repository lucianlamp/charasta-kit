# 2 つの撮影(tools/studio_checks.mjs の出力)を同じ名前どうしで比べる。表情づくりの作り直しの合格の確かめに使う。
#   python tools/diff_shots.py A_DIR B_DIR OUT_DIR [--threshold 8] [--limit 0.01]
# 1 枚ごとに「差のある画素」(RGB のどれかの差が threshold/255 を超える画素)の割合を出す。limit(既定 1%)を超えた絵は NG。
# OUT_DIR/summary.json(1 枚ごとの割合と最大の差)、OUT_DIR/diff_<名前>.png(差のある絵だけ: A | B | 差の所を赤)、
# OUT_DIR/sheet.png(全部の A | B を縮めて並べたもの)を書く。
import json, os, sys
import numpy as np
from PIL import Image

a_dir, b_dir, out = sys.argv[1:4]
opt = dict(zip(sys.argv[4::2], sys.argv[5::2]))
T = int(opt.get('--threshold', 8)); LIMIT = float(opt.get('--limit', 0.01))
os.makedirs(out, exist_ok=True)
names = [i['name'] for i in json.load(open(os.path.join(a_dir, 'index.json')))]
rows, tiles = [], []
for n in names:
    A = np.asarray(Image.open(os.path.join(a_dir, n + '.png')).convert('RGB')).astype(int)
    pb = os.path.join(b_dir, n + '.png')
    if not os.path.exists(pb): rows.append({'name': n, 'missing': True}); continue
    B = np.asarray(Image.open(pb).convert('RGB')).astype(int)
    d = np.abs(A - B).max(-1); m = d > T; frac = float(m.mean())
    rows.append({'name': n, 'frac': frac, 'pixels': int(m.sum()), 'maxDiff': int(d.max()), 'ok': frac < LIMIT})
    if m.any():
        heat = (A * 0.35).astype(np.uint8); heat[m] = [255, 40, 40]
        Image.fromarray(np.concatenate([A, B, heat], 1).astype(np.uint8)).save(os.path.join(out, f'diff_{n}.png'))
    tiles.append(Image.fromarray(np.concatenate([A, B], 1).astype(np.uint8)).resize((360, 180)))
cols = 4
sheet = Image.new('RGB', (360 * cols, 180 * ((len(tiles) + cols - 1) // cols)), 'white')
for i, t in enumerate(tiles): sheet.paste(t, ((i % cols) * 360, (i // cols) * 180))
sheet.save(os.path.join(out, 'sheet.png'))
worst = max((r for r in rows if 'frac' in r), key=lambda r: r['frac'], default=None)
summary = {'threshold': T, 'limit': LIMIT, 'count': len(rows), 'ng': [r['name'] for r in rows if not r.get('ok')], 'worst': worst, 'rows': rows}
json.dump(summary, open(os.path.join(out, 'summary.json'), 'w'), indent=1)
for r in rows: print(f"{r['name']:28s} " + ('missing' if r.get('missing') else f"{r['frac'] * 100:7.3f}%  px {r['pixels']:6d}  max {r['maxDiff']:3d}  {'ok' if r['ok'] else 'NG'}"))
print('DIFF', len(rows), 'images, NG', len(summary['ng']), 'worst', worst and f"{worst['name']} {worst['frac'] * 100:.3f}%")
