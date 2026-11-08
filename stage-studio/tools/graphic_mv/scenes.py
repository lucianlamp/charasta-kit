"""場面ごとの描き方。どの場面も draw(ctx, t, b) で背景、踊る人、文字を 1 枚に描く。
b は場面の中の拍で、場面の頭が NOMINAL[場面](試作の 36 拍の並びでの頭の拍)になるよう ctx がずらす。
決まり: どの拍にも何かが入る(場面ごとの「拍の予定」のコメント)。揺れと点滅は入れない。顔には文字を掛けない
(ctx.front(img, layer) に渡した手前の層は、顔の円にかかる画素を数えて報告する)。
色は ctx.p(core.Palette)、名前、クレジット、言葉は ctx(spec の text)から取る。"""
from __future__ import annotations

import math
import random

from PIL import Image, ImageChops, ImageDraw

from .core import (FPS, H, W, Palette, back_out, band, blank, bounce_out, disc, dot_grid, draw_placed, expo_out, fit, ghost, halftone, hexc,
                   lerp, motion_blur, paste, place_dancer, rays, ring, span, text)

# 置き方: (pass, 縮尺, 画面の横の中心, 絵の下の端の高さ)。場面ごとに大きさを変え、画面の上 3 分の 1 を空けない
BIG = ('full', 0.98, W / 2 + 20, 1925)   # 全身いっぱい。頭は 400 前後
FULL = ('full', 0.90, W / 2, 1900)       # 全身。頭は 520 前後
KNEE = ('mid', 0.9, W / 2, 1935)         # 膝上。頭は 300 前後
FACE = ('face', 0.85, W / 2, 1925)       # 顔の寄り。顔は 700 前後、帽子の上に文字の帯


class Ctx:
    """1 コマを描くときの持ち物。beat と time は場面の中の拍(NOMINAL から数える)と秒の変換"""

    def __init__(self, dancer, palette=None, title='ナース', title_en='NURSE', credit='DANCE', words=(), bpm=120.0, beat=None, time=None):
        self.dancer, self.p = dancer, palette or Palette()
        self.name, self.name_en, self.credit = title, title_en, credit
        self.words, self.bpm = list(words), bpm
        self.beat, self.time = beat, time
        self.fronts, self.me = [], None

    def word(self, i, default):
        return self.words[i] if i < len(self.words) and self.words[i] else default

    def frame(self, t, back=0):
        return int(round(t * FPS)) + 1 - back

    def dancer_at(self, t, place=FULL, back=0, **kw):
        pas, s, cx, by = place
        p = place_dancer(self.dancer, pas, self.frame(t, back), s, cx, by, **kw)
        if back == 0:
            self.me = p
        return p

    def front(self, img, layer):
        self.fronts.append(layer)
        img.alpha_composite(layer)


def letters(word, font, size, fill, **kw):
    return [text(c, font, size, fill, **kw) for c in word if c.strip()] or [text('-', font, size, fill, **kw)]


def row_of(ls, width, track=0.04):
    """文字の層を横に並べ、width に収まる縮尺と、各字の中心の x(縮尺後、並びの中心が 0)を返す"""
    raw = sum(l.width for l in ls) + track * ls[0].height * (len(ls) - 1)
    k = width / raw
    xs, x = [], -width / 2
    for l in ls:
        xs.append(x + l.width * k / 2)
        x += (l.width + track * ls[0].height) * k
    return k, xs


def bump(b, amount=0.04):
    """拍の頭で少し大きくなり、すぐ戻る拡縮(1 + amount から 1 へ)"""
    return 1 + amount * (1 - expo_out((b % 1) / 0.45))


def kick(b, size, every=1.0):
    """拍ごとに size だけ進む動き(拍の頭で速く、すぐ止まる)"""
    n = b / every
    return (math.floor(n) + expo_out((n % 1) / 0.6)) * size


def pop(b, at, length=0.5):
    """at 拍で 0 から 1 へ跳ねて出る縮尺(0 は描かない)"""
    return back_out(span(b, at, length))


# ---- INTRO(0-4 拍) 全身いっぱい ----
# 拍の予定: 0 アクセントの円 / 1 黒い輪が描かれ、右上に小さな文字 / 2 縦書きの名前が下りる / 3 黄色の札が貼られる。円は毎拍わずかに拡縮
def s_intro(c, t, b):
    P = c.p
    img = blank(hexc(P.OFF))
    cy = 1000
    disc(img, W / 2 + 20, cy, 470 * pop(b, 0, 1.0) * (bump(b, 0.03) if b > 1 else 1), P.MAG)
    a0 = -90 + b * 25
    ring(img, W / 2 + 20, cy, 545, 5, P.INK, a0, a0 + 340 * expo_out(span(b, 1, 1.2)))
    if b >= 1:
        u = expo_out(span(b, 1, 0.6))
        for i, s in enumerate(('3D CHARACTER', c.credit, f'{c.bpm:g} BPM')):
            lay = text(s, 'noto', 30, P.INK, weight=900, track=4)
            paste(img, lay, lerp(W + 300, 1035, u), 430 + i * 46, anchor=(1, 0), scale=fit(lay, 620))
    v = text(c.name, 'dela', 240, P.INK, vertical=True)
    kv = fit(v, 280, 880)

    def name(lay, tt):
        u = expo_out(span(c.beat(tt), 2, 0.8))
        paste(lay, v, 140, lerp(-v.height * kv, 100, u), anchor=(0.5, 0), scale=kv)

    motion_blur(img, name, t, 2 < b < 2.9)
    tag = text('DANCE REEL 01', 'anton', 92, P.INK)
    s = pop(b, 3, 0.5)
    if s > 0:
        pad = Image.new('RGBA', (tag.width + 60, tag.height + 40), hexc(P.YEL))
        pad.alpha_composite(tag, (30, 20))
        paste(img, pad, 770, 290, rot=-8, scale=s)
    by = BIG[3] + 700 * (1 - expo_out(span(b, 0, 1.0)))
    p = c.dancer_at(t, place=(BIG[0], BIG[1], BIG[2], by), shadow=P.INK)
    draw_placed(img, p)
    return img


# ---- NAME(4-8 拍) 膝上。偶数番目でない字(2 字目、4 字目、...)は脚の手前 ----
# 拍の予定: 4 文字が下から入る / 5 線だけの名前が左右から並ぶ / 6 色が入れ替わる(アクセント→黒) / 7 縦書きの名前と番号
def s_name(c, t, b):
    P = c.p
    img = blank(hexc(P.YEL))
    swap = b >= 6
    fill, shade = (P.INK, P.MAG) if swap else (P.MAG, P.INK)
    word = c.name_en.replace(' ', '') or 'DANCE'
    ls = letters(word, 'anton', 600, fill)
    k, xs = row_of(ls, 1020)
    cy, rot = 1460, 4
    outl = text(word, 'anton', 600, None, outline=5, ocolor=P.INK)
    ko = 1020 / outl.width
    for j, sgn in ((-1, -1), (1, 1)):
        u = expo_out(span(b, 5 + (0.2 if j > 0 else 0), 0.8))
        if u > 0:
            paste(img, outl, W / 2 + sgn * (1 - u) * 1300, cy + j * ls[0].height * k * 1.05, scale=ko, rot=rot)
    if b >= 7:
        u = expo_out(span(b, 7, 0.6))
        v = text(c.name, 'dela', 110, P.INK, vertical=True)
        paste(img, v, lerp(W + 100, 1000, u), 160, anchor=(0.5, 0), scale=fit(v, 140, 760))
        paste(img, text('01', 'anton', 120, P.MAG), lerp(-100, 70, u), 150, anchor=(0.5, 0))
    behind, front = blank(), blank()
    ca, sa = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    for i, (l, x) in enumerate(zip(ls, xs)):
        u = expo_out(span(b, 4 + 0.1 * i, 0.7))
        dst = front if i % 2 == 1 else behind
        y = cy - x * sa + (1 - u) * 900
        paste(dst, text(word[i], 'anton', 600, shade), W / 2 + x * ca + 14, y + 14, scale=k, rot=rot)
        paste(dst, l, W / 2 + x * ca, y, scale=k, rot=rot)
    img.alpha_composite(behind)
    p = c.dancer_at(t, place=KNEE, shadow=P.INK, sticker=12, shadow_off=(16, 16))
    draw_placed(img, p)
    c.front(img, front)
    return img


# ---- MOVE(8-12 拍) 全身。斜めに流れる言葉(言葉の枠 3) ----
# 拍の予定: 毎拍、段が一歩ずつ進む / 10 塗りと線の段が入れ替わる / 色ずれの影は毎拍広がって戻る
def s_diag(c, t, b):
    P = c.p
    img = blank(hexc(P.NAVY))
    swap = b >= 10
    row = ' ' + ' / '.join(c.word(i, d) for i, d in enumerate(('MOVE', 'STEP', 'TURN'))) + ' /'
    fill = text(row * 3, 'noto', 150, P.MAG, weight=900)
    hol = text(row * 3, 'noto', 150, None, outline=3, ocolor=P.WHITE, weight=900)
    big = Image.new('RGBA', (2600, 3000), (0, 0, 0, 0))
    period = fill.width / 3
    for r in range(16):
        lay = fill if (r % 2 == 0) != swap else hol
        d = 1 if r % 2 == 0 else -1
        x = (d * kick(b, 140) + r * 230) % period
        paste(big, lay, -x, r * 190, anchor=(0, 0))
    paste(img, big, W / 2, H / 2, rot=14)
    o = 14 * bump(b, 0.8)
    p = c.dancer_at(t, place=FULL, chroma=((P.CYA, -o, 0), (P.MAG, o, o * 0.6)))
    draw_placed(img, p)
    return img


# ---- FEEL(12-16 拍) 全身、色の残像(言葉の枠 2: 左上の言葉と手前の大きな言葉) ----
# 拍の予定: 12 FEEL / 13 THE / 14 BEAT が手前に跳ねる / 15 BEAT が白に替わる。集中線は毎拍ひとこま回る
def s_feel(c, t, b):
    P = c.p
    img = blank(hexc(P.BLU))
    rays(img, W / 2, 1100, 22, kick(b, 360 / 44), P.BLU_T1, 7)
    halftone(img, P.BLU_T2, 24, 0.5, 1.0)
    for col, back in ((P.YEL, 9), (P.MAG, 6), (P.CYA, 3)):
        draw_placed(img, ghost(c.dancer, 'full', c.frame(t, back), FULL[1], FULL[2], FULL[3], col))
    feel = text(c.word(0, 'FEEL'), 'noto', 250, P.WHITE, weight=900, skew=0.2)
    kf = fit(feel, 640)
    the = text('THE', 'noto', 210, P.YEL, weight=900, skew=0.2)

    def words(lay, tt):
        bb = c.beat(tt)
        paste(lay, feel, lerp(-500, 350, expo_out(span(bb, 12, 0.6))), 190, rot=4, scale=kf)
        paste(lay, the, lerp(W + 400, 780, expo_out(span(bb, 13, 0.6))), 400, rot=4)

    motion_blur(img, words, t, 12 < b < 12.7 or 13 < b < 13.7)
    p = c.dancer_at(t, place=FULL)
    draw_placed(img, p)
    s = pop(b, 14, 0.5)
    if s > 0:
        col = P.WHITE if b >= 15 else P.YEL
        word = c.word(1, 'BEAT')
        shade = text(word, 'noto', 340, P.INK, weight=900, skew=0.2)
        k = fit(shade, 1000) * s * (bump(b, 0.05) if b >= 15 else 1)
        front = blank()
        paste(front, shade, W / 2 + 14, 1600 + 14, scale=k, rot=4)
        paste(front, text(word, 'noto', 340, col, weight=900, skew=0.2), W / 2, 1600, scale=k, rot=4)
        c.front(img, front)
    return img


# ---- TRIPLE(16-20 拍) 三面。0、1、2 拍前のコマ ----
# 拍の予定: 16 柱が入る / 毎拍、上の番号が 3 つずつ進む / 18 色が一つずれる
def barcode(seed, ink, h=70):
    rnd = random.Random(seed)
    lay = Image.new('RGBA', (150, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    x = 0
    while x < 150:
        w = rnd.choice((2, 2, 3, 5, 7))
        if rnd.random() < 0.6:
            d.rectangle((x, 0, x + w - 1, h), fill=hexc(ink))
        x += w + rnd.choice((2, 3, 4))
    return lay


def s_tri(c, t, b):
    P = c.p
    img = blank()
    pal = [P.MAG, P.YEL, P.CYA]
    shift = 1 if b >= 18 else 0
    cw = W / 3
    step = max(0, math.floor(b) - 16)
    u = expo_out((b % 1) / 0.5)
    for i in range(3):
        x0, x1 = round(i * cw), round((i + 1) * cw)
        col = ImageDraw.Draw(img)
        col.rectangle((x0, 0, x1, H), fill=hexc(pal[(i + shift) % 3]))
        lay = blank()
        for n, dy in ((step * 3 + i + 1, 0), (max(1, (step - 1) * 3 + i + 1), -1)):  # 番号が上へ抜け、次の番号が下から入る
            if step == 0 and dy:
                continue
            y = 70 + (dy * 300 * u if dy else (1 - u) * 300 if step else 0)
            paste(lay, text(f'{n:02d}', 'anton', 300, P.WHITE), (x0 + x1) / 2, y, anchor=(0.5, 0))
        m = Image.new('L', (W, H), 0)
        ImageDraw.Draw(m).rectangle((x0, 60, x1, 420), fill=255)

        lay.putalpha(ImageChops.multiply(lay.getchannel('A'), m))
        img.alpha_composite(lay)
        paste(img, barcode(i + 7 + step, P.INK), x0 + 26, 450, anchor=(0, 0))
        lab = text(f'{c.name_en} / BEAT -{i}', 'noto', 24, P.INK, weight=800)
        paste(img, lab, x0 + 26, 530, anchor=(0, 0), scale=fit(lab, cw - 52))
        p = c.dancer_at(t, place=('full', 0.82, (x0 + x1) / 2, 1960), back=15 * i, sticker=8, shadow=P.INK, shadow_off=(10, 10))
        if i == 0:
            c.me = p
        draw_placed(img, p, clip=(x0, 0, x1, H))
    d = ImageDraw.Draw(img)
    for i in (1, 2):
        d.rectangle((round(i * cw) - 4, 0, round(i * cw) + 4, H), fill=hexc(P.INK))
    return img


# ---- FACE(20-24 拍) 顔の寄り(言葉の枠 1)。言葉は胸の手前 ----
# 拍の予定: 20 輪と言葉 / 21、22、23 帽子の上の帯に 1 拍 1 字 / 23 「に、のって。」(言葉が RHYTHM のとき)。輪は毎拍ひとこま回る
def s_face(c, t, b):
    P = c.p
    img = blank(hexc(P.CYA))
    halftone(img, P.CYA_T, 22, 0.0, 0.7)
    p = c.dancer_at(t, place=FACE, sticker=12, shadow=P.MAG, shadow_off=(18, 18))
    fx, fy = p.face
    word = c.word(0, 'RHYTHM')
    rhythm = word.upper() == 'RHYTHM'
    band_chars = 'リズム' if rhythm else [ch for ch in word if ch.strip()][:3]
    for k, ch in enumerate(band_chars):  # 帽子の上の帯に 1 拍 1 字
        u = expo_out(span(b, 21 + k, 0.6))
        if u > 0:
            g = text(ch, 'dela', 250, None, outline=6, ocolor=P.INK)
            paste(img, g, 230 + k * 310, lerp(-200, 190, u), scale=fit(g, 290, 300))
    rr = 470 * pop(b, 20, 0.6)
    a0 = kick(b, 45)
    ring(img, fx, fy, rr, 6, P.INK, a0, a0 + 300)
    ring(img, fx, fy, rr + 40, 14, P.MAG, -a0 + 90, -a0 + 200)
    draw_placed(img, p)
    front = blank()
    u = expo_out(span(b, 20, 0.7))
    rh = text(word, 'anton', 330, P.YEL)
    k = min(1000 / rh.width, 330 / rh.height * 1.2)
    paste(front, text(word, 'anton', 330, P.INK), lerp(-800, W / 2, u) + 14, 1660 + 14, scale=k)
    paste(front, rh, lerp(-800, W / 2, u), 1660, scale=k)
    s = pop(b, 23, 0.5)
    if s > 0 and rhythm:
        paste(front, text('に、のって。', 'dela', 76, P.INK, vertical=True), 1020, 760, anchor=(0.5, 0), scale=s)
    c.front(img, front)
    return img


# ---- KICK(24-28 拍) 全身、残像(言葉の枠 1。26 拍でもう一度落ちる) ----
# 拍の予定: 24 言葉が落ちる / 25 黄色の細い帯が逆から走る / 26 言葉がもう一度落ちる / 27 残像の色が入れ替わる。青い帯は毎拍一歩進む
def s_kick(c, t, b):
    P = c.p
    img = blank(hexc(P.PAPER))
    band(img, -28, lerp(-1600, 160, expo_out(span(b, 24, 0.8))) + kick(b - 24, 40), 170, P.KBLU)
    if b >= 25:
        band(img, 24, lerp(1700, -380, expo_out(span(b, 25, 0.7))) - kick(b - 25, 30), 46, P.YEL)
    word, b0 = (c.word(0, 'KICK'), 24 if b < 26 else 26)
    ls = letters(word, 'anton', 700, P.INK)
    k, xs = row_of(ls, 960, 0.03)
    cols = (P.KBLU, P.GRAY) if b < 27 else (P.GRAY, P.KBLU)
    for col, back, dx, by in ((cols[0], 8, -270, 1650), (cols[1], 16, 270, 1770)):
        draw_placed(img, ghost(c.dancer, 'full', c.frame(t, back), 0.64, W / 2 + dx, by, col))
    lay = blank()
    for i, (l, x) in enumerate(zip(ls, xs)):
        u = bounce_out(span(b, b0 + 0.08 * i, 0.9))
        paste(lay, l, W / 2 + x, lerp(-700, 760, u), scale=k)
    img.alpha_composite(lay)
    p = c.dancer_at(t, place=FULL, shadow=P.INK)
    draw_placed(img, p)
    return img


# ---- DANCE(28-32 拍) 全身と輪(言葉の枠 1。言葉が DANCE なら 30 拍でダンスに替わる) ----
# 拍の予定: 28 言葉が上に入る / 29 輪が広がる / 30 言葉が替わる / 31 輪の色が入れ替わる。輪は回り続ける
def s_dance(c, t, b):
    P = c.p
    img = blank(hexc(P.MAG))
    dot_grid(img, P.MAG_T)
    r1 = 440 * pop(b, 28, 0.8) + 70 * pop(b, 29, 0.6)
    c1, c2 = (P.YEL, P.CYA) if b < 31 else (P.CYA, P.YEL)
    ring(img, W / 2, 1150, r1, 18, c1, -90 + b * 30, -90 + b * 30 + 300)
    ring(img, W / 2, 1150, max(0, r1 - 80), 10, c2, 90 - b * 40, 90 - b * 40 + 230)
    w0 = c.word(0, 'DANCE')
    if b < 30:
        word, font_, b0 = w0, 'anton', 28
    else:
        word, font_, b0 = ('ダンス', 'dela', 30) if w0.upper() == 'DANCE' else (w0, 'anton', 30)
    ls = letters(word, font_, 600, None, outline=7, ocolor=P.WHITE)
    k0, xs = row_of(ls, 1000, 0.02)
    k = min(k0, 420 / ls[0].height)  # 字の少ない言葉が縦に大きくなりすぎないよう、高さでも抑える
    for i, (l, x) in enumerate(zip(ls, xs)):
        u = expo_out(span(b, b0 + 0.1 * i, 0.6))
        paste(img, l, W / 2 + x * k / k0, lerp(-100, 330, u), scale=k)
    p = c.dancer_at(t, place=FULL, chroma=((P.CYA, -14, 0), (P.INK, 14, 8)))
    draw_placed(img, p)
    return img


# ---- END(32-36 拍) 膝上を丸の中に。名前とクレジット(文字だけ) ----
# 拍の予定: 32 丸が開き、英字の名前が入る / 32.5 名前 / 32.6 線とクレジット / 33 から黄色の輪がひとこまずつ回る
def s_end(c, t, b):
    P = c.p
    img = blank(hexc(P.INK))
    dot_grid(img, P.INK_T)
    s = pop(b, 32, 0.7)
    cx, cy, r = W / 2, 1180, 380 * s
    disc(img, cx, cy, r, P.MAG)
    if r > 4:
        k = 0.56
        f0 = c.frame(c.time(32))
        im = c.dancer.image('mid', f0)
        fx, fy = c.dancer.face('mid', f0)
        by = (cy - 0.02 * 380) + (1 - fy) * im.height * k
        p = c.dancer_at(t, place=('mid', k, cx + (0.5 - fx) * im.width * k, by), sticker=8, shadow=None)
        draw_placed(img, p, circle=(cx, cy, r))
    a0 = -90 + (kick(b - 33.2, 45) if b > 33.2 else 0)  # 描き終えた後は毎拍ひとこま回る
    ring(img, cx, cy, r + 26, 12, P.YEL, a0, a0 + 330 * expo_out(span(b, 32.2, 1.0)))
    en = text(c.name_en, 'anton', 400, P.YEL)
    paste(img, en, lerp(-600, W / 2, expo_out(span(b, 32, 0.6))), 250, scale=min(900 / en.width, 300 / en.height))
    nm = text(c.name, 'dela', 140, P.MAG)
    paste(img, nm, W / 2, 520, scale=(pop(b, 32.5, 0.5) * 0.999 + 0.001) * fit(nm, 1000))
    w = 300 * expo_out(span(b, 32.6, 0.6))
    ImageDraw.Draw(img).rectangle((W / 2 - w, 620, W / 2 + w, 626), fill=hexc(P.WHITE))
    cr = text(c.credit, 'noto', 32, P.WHITE, weight=800, track=4)
    paste(img, cr, W / 2, 670, alpha=expo_out(span(b, 32.6, 0.6)), scale=fit(cr, 1000))
    return img


# 場面の ID と描き方。NOMINAL は試作の 36 拍の並びでの頭の拍(場面の中の拍はここから数える)
SCENES = {'intro': s_intro, 'name': s_name, 'move': s_diag, 'feel': s_feel, 'triple': s_tri, 'face': s_face, 'kick': s_kick, 'dance': s_dance, 'end': s_end}
NOMINAL = {'intro': 0, 'name': 4, 'move': 8, 'feel': 12, 'triple': 16, 'face': 20, 'kick': 24, 'dance': 28, 'end': 32}
WIPE = 0.5  # ワイプの長さ(拍)。場面の頭の拍で覆い終わる
