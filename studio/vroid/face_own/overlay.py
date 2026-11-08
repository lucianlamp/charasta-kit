"""目と口の位置の確認の絵。中立の絵の上に、読んだ目の開口(緑)、広げたあとの開口(黄)、虹彩(水色)、口の線(青)を描く。work/place.png"""
import numpy as np
from PIL import Image, ImageDraw
import parts as pt


def main(P):
    im = Image.open(P['neutral']).convert('RGB'); d = ImageDraw.Draw(im)
    k = im.width / pt.S['w']

    def px(xy):
        xy = np.asarray(xy, float)
        c, r = pt.m2px(xy[:, 0], xy[:, 1])
        return [(float(a * k), float(b * k)) for a, b in zip(c, r)]
    for side in 'LR':
        e = pt.Eye(side, P['eye_xf'])
        d.line(px(pt.FEAT[side]), fill=(0, 200, 0), width=2)
        d.line(px(np.vstack([e.U, e.L[::-1], e.U[:1]])), fill=(255, 220, 0), width=2)
        ir = P['iris']; t = np.linspace(0, 2 * np.pi, 64)
        d.line(px(np.c_[ir['cx'][side] + ir['rx'] * pt.MM * np.cos(t), ir['cy'] + ir['ry'] * pt.MM * np.sin(t)]), fill=(0, 200, 255), width=2)
    m = P['mouth']
    d.line(px([(m['xm'] - m['W0'], m['ym']), (m['xm'] + m['W0'], m['ym'])]), fill=(0, 80, 255), width=3)
    im.save(P['work'] + '/place.png')
    print('place', P['work'] + '/place.png')
