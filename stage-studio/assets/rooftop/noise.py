"""コマのボケた背景の粒を測る。5px の中央値との差の標準偏差。python noise.py 画像..."""
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

for f in sys.argv[1:]:
    a = np.asarray(Image.open(f).convert('L')).astype(np.float32)
    d = a - ndi.median_filter(a, 5)
    print(f, [round(float(d[y0:y1, x0:x1].std()), 2) for x0, x1, y0, y1 in ((300, 520, 340, 480), (40, 200, 1000, 1150), (100, 1000, 0, 500))])
