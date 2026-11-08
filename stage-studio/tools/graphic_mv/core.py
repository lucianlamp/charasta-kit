"""グラフィックの MV の部品: 拍の時計、色の組、イージング、文字の層、図形、踊る人の切り抜き(ステッカーの縁と影、残像)、置き方、ワイプ、HUD。
絵はすべて 8bit の RGBA(Pillow)で重ね、特殊な重ね方(差の絶対値)だけ numpy で行う。
配置は 1080x1920 の画面で決めてあり、ほかの大きさで書き出すときは重ねたあとに縮める(compose.py の --comp-w、--comp-h)。"""
from __future__ import annotations

import json
import math
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import gaussian_filter

W, H, FPS = 1080, 1920, 30
FONTS = Path(__file__).resolve().parent.parent.parent / 'assets' / 'fonts'
FONT = {  # すべて SIL OFL 1.1(assets/fonts/LICENSES.md)
    'anton': 'anton_Anton-Regular.ttf',  # 縦長の太い英字
    'dela': 'delagothicone_DelaGothicOne-Regular.ttf',  # 太い和文
    'noto': 'NotoSansJP-VF.ttf',  # 本文と HUD。可変の太さ
}


# ---- 拍の時計 ----
class Clock:
    """時刻(秒)と拍の変換。beats(秒の並び)を渡すと曲の拍に合わせ、無ければ一定の BPM"""

    def __init__(self, bpm=120.0, offset=0.0, beats=None):
        self.bpm, self.offset = bpm, offset
        self.beats = np.asarray(beats, float) if beats is not None else None

    def beat(self, t):
        if self.beats is None:
            return (t - self.offset) * self.bpm / 60
        i = np.arange(len(self.beats), dtype=float)
        if t <= self.beats[0]:
            return (t - self.beats[0]) / (self.beats[1] - self.beats[0])
        if t >= self.beats[-1]:
            return i[-1] + (t - self.beats[-1]) / (self.beats[-1] - self.beats[-2])
        return float(np.interp(t, self.beats, i))

    def time(self, b):
        if self.beats is None:
            return self.offset + b * 60 / self.bpm
        i = np.arange(len(self.beats), dtype=float)
        if b <= 0:
            return float(self.beats[0] + b * (self.beats[1] - self.beats[0]))
        if b >= i[-1]:
            return float(self.beats[-1] + (b - i[-1]) * (self.beats[-1] - self.beats[-2]))
        return float(np.interp(b, i, self.beats))


# ---- 色 ----
HEX = re.compile(r'^#[0-9A-Fa-f]{6}$')


def check_color(v, what='色'):
    """#RRGGBB の形でなければ ValueError"""
    if not isinstance(v, str) or not HEX.match(v):
        raise ValueError(f'{what} は #RRGGBB: {v!r}')
    return v.upper()


def mix(a, b, u):
    """2 つの色を u の割合で混ぜた #RRGGBB"""
    ca, cb = hexc(a), hexc(b)
    return '#' + ''.join(f'{round(ca[i] + (cb[i] - ca[i]) * u):02X}' for i in range(3))


POP = {'bg': ['#FFE600', '#19D3FF', '#2337FF'], 'ink': '#0E0E14', 'accent': '#FF2D87', 'light': '#F3F0E8'}  # 試作の色


class Palette:
    """場面が使う色の組。spec の palette {bg: [3 色], ink, accent, light} から、試作の色の名前(YEL、MAG など)と薄い色を求める"""

    def __init__(self, p=None):
        p = p or POP
        if not isinstance(p.get('bg'), list) or len(p['bg']) != 3:
            raise ValueError('palette.bg は 3 色の配列')
        bg = [check_color(c, 'palette.bg') for c in p['bg']]
        self.YEL, self.CYA, self.BLU = bg
        self.INK = check_color(p.get('ink'), 'palette.ink')
        self.MAG = check_color(p.get('accent'), 'palette.accent')
        self.OFF = check_color(p.get('light'), 'palette.light')
        self.WHITE = '#FFFFFF'
        self.NAVY = mix(self.INK, self.BLU, 0.18)
        self.KBLU = self.BLU
        self.BLU_T1, self.BLU_T2 = mix(self.BLU, '#FFFFFF', 0.08), mix(self.BLU, '#FFFFFF', 0.15)
        self.CYA_T = mix(self.CYA, '#FFFFFF', 0.25)
        self.MAG_T = mix(self.MAG, '#FFFFFF', 0.2)
        self.INK_T = mix(self.INK, self.BLU, 0.12)
        self.PAPER = mix(self.OFF, '#FFFFFF', 0.5)
        self.GRAY = mix(self.INK, self.OFF, 0.7)


# ---- イージング(u は 0..1) ----
def clamp(u):
    return 0.0 if u < 0 else 1.0 if u > 1 else u


def expo_out(u):
    u = clamp(u)
    return 1.0 if u >= 1 else 1 - 2 ** (-10 * u)


def expo_in_out(u):
    u = clamp(u)
    if u in (0.0, 1.0):
        return u
    return 2 ** (20 * u - 10) / 2 if u < 0.5 else (2 - 2 ** (-20 * u + 10)) / 2


def back_out(u, s=1.70158):
    u = clamp(u) - 1
    return 1 + u * u * ((s + 1) * u + s)


def bounce_out(u):
    u = clamp(u)
    n, d = 7.5625, 2.75
    if u < 1 / d:
        return n * u * u
    if u < 2 / d:
        u -= 1.5 / d
        return n * u * u + 0.75
    if u < 2.5 / d:
        u -= 2.25 / d
        return n * u * u + 0.9375
    u -= 2.625 / d
    return n * u * u + 0.984375


def span(b, start, length):
    """拍 b が start から length 拍の間のどこか(0..1)"""
    return clamp((b - start) / length)


def lerp(a, b, u):
    return a + (b - a) * u


def hexc(s, a=255):
    s = s.lstrip('#')
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), a)


# ---- 文字 ----
@lru_cache(maxsize=16)
def font(name, size, weight=None):
    f = ImageFont.truetype(str(FONTS / FONT[name]), size)
    if weight is not None:
        f.set_variation_by_axes([weight])
    return f


# 縦書きの組み方。Pillow に libraqm が無く、フォントの縦書き用の字形(vert)を呼べないので、字ごとに置き方を決める
V_ROTATE = set('ー－―‐-～〜~…‥=＝（）()「」『』【】〈〉《》[]→←')  # 90 度右へ回して字の枠の真ん中に置く
V_SMALL = set('ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ')  # 字の枠の右上寄り
V_PUNCT = set('、。，．')  # 字の枠の右上
V_CENTER = {'rotate': (0.5, 0.5), 'small': (0.57, 0.43), 'punct': (0.74, 0.26), 'normal': (0.5, 0.5)}


def _glyph(c, f, col, outline, oc):
    bx = f.getbbox(c, stroke_width=outline)
    g = Image.new('RGBA', (bx[2] - bx[0] + 2, bx[3] - bx[1] + 2), (0, 0, 0, 0))
    ImageDraw.Draw(g).text((1 - bx[0], 1 - bx[1]), c, font=f, fill=col, stroke_width=outline, stroke_fill=oc)
    return g


def vertical_text(s, f, size, col, outline, oc, track):
    """縦書き: 1 字ずつ size 四方の枠に置いて縦に積む。長音や波線は 90 度回し、小さい仮名は右上寄り、句読点は右上"""
    pad = outline + 4
    step = size + track
    im = Image.new('RGBA', (size + 2 * pad, step * len(s) + 2 * pad), (0, 0, 0, 0))
    for i, c in enumerate(s):
        g = _glyph(c, f, col, outline, oc)
        kind = 'rotate' if c in V_ROTATE else 'small' if c in V_SMALL else 'punct' if c in V_PUNCT else 'normal'
        if kind == 'rotate':
            g = g.rotate(-90, Image.BICUBIC, expand=True)
        u, v = V_CENTER[kind]
        im.alpha_composite(g, (round(pad + u * size - g.width / 2), round(pad + i * step + v * size - g.height / 2)))
    return im


@lru_cache(maxsize=256)
def text(s, name, size, fill='#000000', outline=0, ocolor=None, weight=None, track=0, vertical=False, skew=0.0):
    """文字の層(余白の無い RGBA)。outline>0 で fill=None なら線だけの文字。track は字間(px)、vertical は縦書き(vertical_text)。skew は斜体の傾き(横へずらす割合)"""
    f = font(name, size, weight)
    col = hexc(fill) if fill else (0, 0, 0, 0)
    oc = hexc(ocolor or fill or '#000000')
    if vertical:
        im = vertical_text(s, f, size, col, outline, oc, track)
        return im.crop(im.getbbox() or (0, 0, 1, 1))
    pad = outline + 4
    w = int(sum(f.getlength(c) for c in s) + track * (len(s) - 1)) + 2 * pad
    h = f.getbbox(s)[3] + 2 * pad
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    x = pad
    for c in s:
        d.text((x, pad), c, font=f, fill=col, stroke_width=outline, stroke_fill=oc)
        x += f.getlength(c) + track
    im = im.crop(im.getbbox() or (0, 0, 1, 1))
    if skew:
        w2 = im.width + int(abs(skew) * im.height)
        im = im.transform((w2, im.height), Image.AFFINE, (1, skew, -skew * im.height if skew > 0 else 0, 0, 1, 0), Image.BICUBIC)
    return im


def fit(layer, max_w=None, max_h=None):
    """layer が max_w x max_h に収まる縮尺(1 より大きくしない)。長い名前は字を小さくして画面の幅に収める"""
    k = 1.0
    if max_w:
        k = min(k, max_w / max(1, layer.width))
    if max_h:
        k = min(k, max_h / max(1, layer.height))
    return k


# ---- 置き方 ----
def transformed(layer, scale=1.0, rot=0.0):
    if scale == 1 and rot == 0:
        return layer
    im = layer.convert('RGBa')  # 縁の色が黒く濁らないよう、乗算済みで変形する
    if scale != 1:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.BICUBIC)
    if rot:
        im = im.rotate(rot, Image.BICUBIC, expand=True)
    return im.convert('RGBA')


def paste(dst, layer, x, y, anchor=(0.5, 0.5), scale=1.0, rot=0.0, alpha=1.0):
    """layer の anchor の点を dst の (x, y) へ置く。画面の外へはみ出す分は切る"""
    im = transformed(layer, scale, rot)
    if alpha < 1:
        a = im.getchannel('A').point(lambda v: int(v * alpha))
        im = im.copy()
        im.putalpha(a)
    x0, y0 = round(x - anchor[0] * im.width), round(y - anchor[1] * im.height)
    cx0, cy0 = max(0, x0), max(0, y0)
    cx1, cy1 = min(dst.width, x0 + im.width), min(dst.height, y0 + im.height)
    if cx1 <= cx0 or cy1 <= cy0:
        return (x0, y0, im.width, im.height)
    dst.alpha_composite(im, (cx0, cy0), (cx0 - x0, cy0 - y0, cx1 - x0, cy1 - y0))
    return (x0, y0, im.width, im.height)


def blank(color=(0, 0, 0, 0)):
    return Image.new('RGBA', (W, H), color)


def motion_blur(dst, draw, t, moving, n=6, shutter=0.5):
    """draw(layer, t) を n 個の時刻で描いて平均する(動く間だけ)。shutter はコマの割合"""
    if not moving:
        lay = blank()
        draw(lay, t)
        dst.alpha_composite(lay)
        return
    acc = None
    for k in range(n):
        lay = blank()
        draw(lay, t - shutter / FPS * (k / (n - 1)))
        a = np.asarray(lay.convert('RGBa'), np.float32)
        acc = a if acc is None else acc + a
    dst.alpha_composite(Image.fromarray((acc / n + 0.5).astype(np.uint8), 'RGBa').convert('RGBA'))


# ---- 図形 ----
def disc(dst, cx, cy, r, color):
    if r > 0:
        ImageDraw.Draw(dst).ellipse((cx - r, cy - r, cx + r, cy + r), fill=hexc(color) if isinstance(color, str) else color)


def ring(dst, cx, cy, r, width, color, a0=0, a1=360):
    if r <= 0:
        return
    lay = blank()
    ImageDraw.Draw(lay).arc((cx - r, cy - r, cx + r, cy + r), a0, a1, fill=hexc(color), width=int(width))
    dst.alpha_composite(lay)


def rays(dst, cx, cy, n, angle, color, width_deg=6):
    """中心から広がる集中線(扇形を n 本)"""
    lay = blank()
    d = ImageDraw.Draw(lay)
    R = 2400
    for k in range(n):
        a = math.radians(angle + k * 360 / n)
        w = math.radians(width_deg) * (0.6 + 0.4 * ((k * 7) % 5) / 4)
        d.polygon([(cx, cy), (cx + R * math.cos(a - w / 2), cy + R * math.sin(a - w / 2)), (cx + R * math.cos(a + w / 2), cy + R * math.sin(a + w / 2))], fill=hexc(color))
    dst.alpha_composite(lay)


@lru_cache(maxsize=8)
def _halftone(color, step, fade_from, fade_to, horizontal):
    """網点。fade_from から fade_to(画面の割合)へ点が大きくなる"""
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    c = hexc(color)
    for j, y in enumerate(range(0, H + step, step)):
        for x in range(-step, W + step, step):
            xx = x + (step / 2 if j % 2 else 0)
            u = clamp(((xx / W) if horizontal else (y / H) - fade_from) / max(1e-3, fade_to - fade_from))
            r = step * 0.42 * u
            if r > 0.6:
                d.ellipse((xx - r, y - r, xx + r, y + r), fill=c)
    return lay


def halftone(dst, color, step=26, fade_from=0.45, fade_to=1.0, horizontal=False):
    dst.alpha_composite(_halftone(color, step, fade_from, fade_to, horizontal))


@lru_cache(maxsize=4)
def _dots(color, step, r):
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for y in range(step // 2, H, step):
        for x in range(step // 2, W, step):
            d.ellipse((x - r, y - r, x + r, y + r), fill=hexc(color))
    return lay


def dot_grid(dst, color, step=54, r=2):
    dst.alpha_composite(_dots(color, step, r))


def band(dst, angle, offset, width, color):
    """画面の中心を通る、angle 度の向きの帯。offset は帯の中心の法線方向のずれ(px)"""
    a = math.radians(angle)
    ux, uy = math.cos(a), math.sin(a)
    nx, ny = -uy, ux
    cx, cy = W / 2 + nx * offset, H / 2 + ny * offset
    L = 3000
    pts = [(cx - ux * L + nx * width / 2, cy - uy * L + ny * width / 2), (cx + ux * L + nx * width / 2, cy + uy * L + ny * width / 2),
           (cx + ux * L - nx * width / 2, cy + uy * L - ny * width / 2), (cx - ux * L - nx * width / 2, cy - uy * L - ny * width / 2)]
    ImageDraw.Draw(dst).polygon(pts, fill=hexc(color))


# ---- ワイプ(次の場面を見せる形の白黒の型。u は 0..1) ----
_YY, _XX = np.mgrid[0:H, 0:W].astype(np.float32)


def wipe_mask(kind, u):
    if kind == 'iris':  # 円が広がる
        r = u * math.hypot(W, H) * 0.56
        m = (_XX - W / 2) ** 2 + (_YY - H * 0.5) ** 2 < r * r
    elif kind == 'diag':  # 斜めの辺が右下から左上へ進む
        p = (_XX * 0.5 + _YY * 0.87) / (W * 0.5 + H * 0.87)
        m = p > 1 - u * 1.02
    elif kind == 'bars':  # 縦の帯が少しずつ遅れて下から伸びる
        i = np.floor(_XX / (W / 5))
        v = np.clip(u * 1.6 - i * 0.15, 0, 1)
        m = _YY > H * (1 - (1 - (1 - v) ** 3))
    elif kind == 'slab':  # 板が上から下りる
        m = _YY < u * H
    elif kind == 'columns':  # 3 本の柱が上と下から交互に入る(三面の場面)
        i = np.floor(_XX / (W / 3))
        v = np.array([expo_out(clamp(u * 1.5 - k * 0.25)) for k in range(3)], np.float32)[np.clip(i, 0, 2).astype(int)]
        m = np.where(i % 2 == 0, _YY < v * H, _YY > H * (1 - v))
    else:
        m = np.full((H, W), u >= 0.5)
    return Image.fromarray(m.astype(np.uint8) * 255, 'L')


# ---- 踊る人 ----
class Dancer:
    """stage-studio から描いた透明な背景の連番(<dir>/<pass>/00001.png)と、コマごとの顔と腰の位置(<pass>.json)"""

    def __init__(self, root):
        self.root = Path(root)
        self.meta = {p: json.loads((self.root / f'{p}.json').read_text()) for p in ('full', 'mid', 'face') if (self.root / f'{p}.json').exists()}

    @lru_cache(maxsize=48)
    def image(self, pas, f):
        f = max(min(int(k) for k in self.meta[pas]['frames']), min(max(int(k) for k in self.meta[pas]['frames']), f))
        im = Image.open(self.root / pas / f'{f:05d}.png').convert('RGBA')
        res = tuple(self.meta[pas].get('res') or im.size)
        if im.size != res:  # 試しは小さく描く(pct)。置き方は決めた大きさで計るので広げる
            im = im.resize(res, Image.BICUBIC)
        return im

    def face(self, pas, f):
        fr = self.meta[pas]['frames']
        k = str(max(min(int(x) for x in fr), min(max(int(x) for x in fr), f)))
        return fr[k]['face']


def silhouette(alpha, color):
    """alpha(L)の形を 1 色で塗った層"""
    lay = Image.new('RGBA', alpha.size, hexc(color) if isinstance(color, str) else color)
    lay.putalpha(alpha)
    return lay


def grow(alpha, r):
    """形を r px 太らせる(ぼかしてから低い所で切る。角が丸くなり、ステッカーの縁らしくなる)"""
    a = np.asarray(alpha, np.float32) / 255
    pad = int(r * 2 + 4)
    a = np.pad(a, pad)
    g = gaussian_filter(a, r * 0.6)
    m = np.clip((g - 0.06) / 0.08, 0, 1)
    return Image.fromarray((m * 255).astype(np.uint8), 'L'), pad


class Placed:
    """画面に置いた踊る人。face は画面の顔の中心(px)と半径"""

    def __init__(self, layer, x0, y0, face, face_r):
        self.layer, self.x0, self.y0, self.face, self.face_r = layer, x0, y0, face, face_r


def place_dancer(dancer, pas, f, scale, cx, by, sticker=10, shadow=None, shadow_off=(14, 14), chroma=None):
    """踊る人の絵の下の真ん中(0.5, 1.0)を画面の (cx, by) へ置き、縁と影を付けた 1 枚の層にする。
    sticker は白い縁の太さ(px)、shadow は縁の形をずらした影の色、chroma は ((色, dx, dy), ...) のずらした色の影"""
    im = transformed(dancer.image(pas, f), scale)
    a = im.getchannel('A')
    if sticker:
        edge, pad = grow(a, sticker)
    else:
        edge, pad = a, 0
    w, h = edge.size
    lay = Image.new('RGBA', (w + 60, h + 60), (0, 0, 0, 0))
    o = 30
    for col, dx, dy in (chroma or ()):
        lay.alpha_composite(silhouette(edge, col), (o + round(dx), o + round(dy)))
    if shadow:
        lay.alpha_composite(silhouette(edge, shadow), (o + shadow_off[0], o + shadow_off[1]))
    if sticker:
        lay.alpha_composite(silhouette(edge, '#FFFFFF'), (o, o))
    lay.alpha_composite(im, (o + pad, o + pad))
    x0 = round(cx - im.width * 0.5) - pad - o
    y0 = round(by - im.height) - pad - o
    fx, fy = dancer.face(pas, f)
    face = (x0 + o + pad + fx * im.width, y0 + o + pad + fy * im.height)
    face_r = {'full': 0.075, 'mid': 0.13, 'face': 0.21}[pas] * im.height
    return Placed(lay, x0, y0, face, face_r)


def draw_placed(dst, p, alpha=1.0, clip=None, circle=None):
    """clip は (x0, y0, x1, y1) の窓、circle は (cx, cy, r) の丸い窓。窓の外は描かない"""
    if clip is None and circle is None:
        paste(dst, p.layer, p.x0, p.y0, anchor=(0, 0), alpha=alpha)
        return
    lay = blank()
    paste(lay, p.layer, p.x0, p.y0, anchor=(0, 0), alpha=alpha)
    m = Image.new('L', (W, H), 0)
    if clip is not None:
        ImageDraw.Draw(m).rectangle(clip, fill=255)
    else:
        cx, cy, r = circle
        ImageDraw.Draw(m).ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    lay.putalpha(Image.fromarray(np.minimum(np.asarray(lay.getchannel('A')), np.asarray(m)), 'L'))
    dst.alpha_composite(lay)


def ghost(dancer, pas, f, scale, cx, by, color, sticker=0):
    """残像: 形を 1 色で塗った踊る人"""
    im = transformed(dancer.image(pas, f), scale)
    a = im.getchannel('A')
    if sticker:
        a, pad = grow(a, sticker)
    else:
        pad = 0
    return Placed(silhouette(a, color), round(cx - im.width * 0.5) - pad, round(by - im.height) - pad, None, 0)


def face_hit(layer, placed, margin=1.15):
    """layer の不透明な所が顔の円にかかる画素の数"""
    if placed is None or placed.face is None:
        return 0
    x, y = placed.face
    r = placed.face_r * margin
    box = tuple(int(v) for v in (max(0, x - r), max(0, y - r), min(W, x + r), min(H, y + r)))
    if box[2] <= box[0] or box[3] <= box[1]:
        return 0
    a = np.asarray(layer.getchannel('A').crop(box))
    yy, xx = np.mgrid[box[1]:box[3], box[0]:box[2]]
    inside = (xx - x) ** 2 + (yy - y) ** 2 < r * r
    return int(((a > 40) & inside).sum())


# ---- HUD ----
def difference(dst, layer):
    """layer(白い文字)を差の絶対値で重ねる。どの背景でも読める"""
    d = np.asarray(dst, np.int16)
    l = np.asarray(layer, np.int16)
    a = l[..., 3:4] / 255
    out = d.copy()
    out[..., :3] = (d[..., :3] * (1 - a) + np.abs(d[..., :3] - l[..., :3]) * a).astype(np.int16)
    return Image.fromarray(out.astype(np.uint8), 'RGBA')


def grain(dst, seed, amount=5):
    rng = np.random.default_rng(seed)
    n = rng.normal(0, amount, (H // 2, W // 2)).astype(np.float32)
    n = np.repeat(np.repeat(n, 2, 0), 2, 1)
    d = np.asarray(dst, np.float32)
    d[..., :3] += n[..., None]
    return Image.fromarray(np.clip(d, 0, 255).astype(np.uint8), 'RGBA')
