# Rebuild the eyeball layer (paint_gaze.py's ball.png) from irises drawn whole by image_gen (chara4): the drawing's
# own iris was cut by the lids, and the parts paint_gaze.py filled in showed as a chipped iris and a white seam once
# the gaze moved. image_gen edits a crop of each eye of the face drawing into the iris alone (hidden parts continued,
# everything else transparent, same canvas); this puts both irises back where they were drawn, over the white of the
# eye, in every first-row ball cell.
# Usage: python ball_from_iris.py FACE_DIR DRAWING_NAME IRIS.png:X0,Y0,X1,Y1 [IRIS.png:X0,Y0,X1,Y1 ...]
#   DRAWING_NAME  the align.json entry of the face drawing the crops were cut from (e.g. neutral_bald)
#   X0..Y1        the crop box in that drawing's pixels (the iris image covers it, at any resolution)
# White of the eye: gaze.json's neutral 'white' (env BALL_WHITE="r,g,b" overrides). The ball.png before is kept as
# ball_orig.png; run build_gaze.py again afterwards.
import json, os, sys
import numpy as np
from PIL import Image

D, name = sys.argv[1], sys.argv[2]
G = os.path.join(D, 'gaze'); gz = json.load(open(os.path.join(G, 'gaze.json')))
s, tx, ty = json.load(open(os.path.join(D, 'align.json')))[name]
bx0, by0, bx1, by1 = json.load(open(os.path.join(D, 'regions.json')))['upper']['bbox']
cw, ch = gz['cell_px']; cells = gz['ball_cells']
white = [int(v) for v in os.environ['BALL_WHITE'].split(',')] if os.environ.get('BALL_WHITE') else \
    (gz['info'] if isinstance(gz['info'], dict) else eval(gz['info']))['neutral']['white']
src = os.path.join(G, 'ball.png'); orig = os.path.join(G, 'ball_orig.png')
if not os.path.exists(orig): os.replace(src, orig)
ball = Image.open(orig).convert('RGB')
# IRIS_MATCH_HEIGHT=1: every later iris is stretched vertically, about its bottom edge, to the first iris's height
# (chara4: image_gen drew the left iris 15 px taller than the right one, its top 22 px higher; the bottoms matched)
MATCH = os.environ.get('IRIS_MATCH_HEIGHT') == '1'
cell = Image.new('RGBA', (cw, ch), tuple(white) + (255,)); h_first = None
for arg in sys.argv[3:]:
    path, box = arg.rsplit(':', 1); x0, y0, x1, y1 = [float(v) for v in box.split(',')]
    iris = Image.open(path).convert('RGBA')
    w, h = round((x1 - x0) * s), round((y1 - y0) * s)
    iris = iris.resize((w, h), Image.LANCZOS); px, py = round(x0 * s + tx - bx0), round(y0 * s + ty - by0)
    ys = np.where((np.asarray(iris)[..., 3] > 128).any(1))[0]; top, bot = int(ys.min()), int(ys.max())
    if h_first is None: h_first = bot - top
    elif MATCH and bot - top != h_first:
        k = h_first / (bot - top); h2 = round(h * k)
        iris = iris.resize((w, h2), Image.LANCZOS); py += round(bot - bot * k)
        print('IRIS_MATCH', os.path.basename(path), 'height', bot - top, '->', h_first)
    cell.alpha_composite(iris, (px, py))
    a = np.asarray(iris)[..., 3]; print('IRIS', os.path.basename(path), 'cell px', px, py, w, iris.height, 'opaque px', int((a > 128).sum()))
cell = cell.convert('RGB')
for k in range(len(cells)): ball.paste(cell, (k * cw, 0))
ball.save(src); print('BALL', ball.size, 'cells', cells, 'white', white)
