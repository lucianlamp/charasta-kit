"""床の継ぎ目の配置図(溝の深さ)を描く。床の材質が暗い線と段差の法線に使う。
範囲は x -15..15 m、y -6..6.5 m で、1 画素 5 mm。線の位置は target の視点の画素から逆算する。"""
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

CAM_Y, CAM_Z, F = -9.3, 3.0, 16 / 36 * 1672
TILT = math.atan(49 / F)
S = 200  # 1 m の画素数


def world(u, v):
    a, b = (u - 470.5) / F, (836 - v) / F
    c, s = math.cos(TILT), math.sin(TILT)
    ray = (a, c - b * s, s + b * c)
    t = CAM_Z / -ray[2]
    return ray[0] * t, CAM_Y + ray[1] * t


def px(x, y):
    return (x + 15) * S, (6.5 - y) * S


img = Image.new('L', (30 * S, int(12.5 * S)), 0)
d = ImageDraw.Draw(img)


def line(a, b, width=3):
    d.line([px(*a), px(*b)], fill=255, width=width)


apex = world(470, 1330)
near = world(90, 1440)
row = world(470, 1248)[1]
for v in (1048, 1053, 1059, 1066, 1074, 1084, 1096, 1112, 1134, 1165, 1248):
    y = world(470, v)[1]
    line((-15, y), (15, y), 2)
for sx in (-1, 1):
    corner = (sx * abs(near[0]), near[1])
    line(apex, corner)
    line(corner, (sx * abs(near[0]) * 1.5, -6.5))
    a, b = world(722, 1127), world(941, 1178)
    line((sx * abs(a[0]), a[1]), (sx * abs(b[0]), b[1]), 2)
    line((sx * abs(b[0]), b[1]), (sx * 14.5, -1.5), 2)
    for k in range(1, 18):  # 奥の細かい格子
        x = sx * k * 0.8
        line((x, world(470, 1127)[1]), (x, 6.5), 2)
    line((sx * 6.0, row), (sx * 6.0, 6.5), 2)
for v in (1130, 1245):  # 中央の縦線は引かず、小さな印だけ
    y = world(470, v)[1]
    line((0, y - 0.08), (0, y + 0.08), 2)
    line((-0.08, y), (0.08, y), 2)
img.filter(ImageFilter.GaussianBlur(0.8)).save(Path(__file__).parent / 'floor_seams.png', optimize=True)
