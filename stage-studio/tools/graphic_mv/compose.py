"""グラフィックの MV を重ねて連番にする(動画にはまとめない。きゃらすたか呼び出し元がまとめる)。
  python -m graphic_mv.compose --dancer work/dancer --plan plan.json --frames-dir out/frames [--bpm 120 | --beats-json beats.json] [--text text.json] [--palette palette.json] [--comp-w 540 --comp-h 960] [--frames 1-30] [--jobs 8]
plan.json は plan.py の場面の並び([{scene, b0, b1, start, end, wipe, words}])。beats.json は曲の拍の時刻(秒)の並びで、あれば BPM より先に使う。
配置は 1080x1920 で決め、--comp-w と --comp-h が違えば重ねたあとに縮める。答えのコマごとの顔にかかった画素の数を返す(faceHits)。
"""
from __future__ import annotations

import argparse
import json
import time
from multiprocessing import Pool
from pathlib import Path

from PIL import Image, ImageDraw

from .core import FPS, H, W, Clock, Dancer, Palette, blank, difference, expo_in_out, face_hit, grain, paste, text, wipe_mask
from .plan import BY_ID
from .scenes import NOMINAL, SCENES, WIPE, Ctx

G = {}


def setup(cfg):
    """cfg: {dancer, plan, bpm, beats, text, palette, frames_dir, comp_w, comp_h}"""
    G['cfg'] = cfg
    G['clock'] = Clock(cfg['bpm'], 0, cfg.get('beats'))
    G['dancer'] = Dancer(cfg['dancer'])
    G['palette'] = Palette(cfg.get('palette'))
    G['total'] = max(1, round(G['clock'].beat(cfg['plan'][-1]['end'])))


def scene_at(t):
    plan = G['cfg']['plan']
    for k, e in enumerate(plan):
        if t < e['end']:
            return k
    return len(plan) - 1


def ctx_for(e):
    """場面 e の持ち物。場面の中の拍は NOMINAL[scene] から数える"""
    clock, tx = G['clock'], G['cfg'].get('text') or {}
    shift = NOMINAL[e['scene']] - e['b0']
    return Ctx(G['dancer'], G['palette'], title=tx.get('title', 'ナース'), title_en=tx.get('titleEn', 'NURSE'), credit=tx.get('credit', 'DANCE'), words=e.get('words') or [],
               bpm=G['cfg']['bpm'], beat=lambda tt: clock.beat(tt) + shift, time=lambda bb: clock.time(bb - shift))


def hud(img, t, b, total, label, name_en, bpm):
    lay = blank()
    m, L, th = 40, 46, 4
    d = ImageDraw.Draw(lay)
    white = (255, 255, 255, 255)
    for (x, y, sx, sy) in ((m, m, 1, 1), (W - m, m, -1, 1), (m, H - m, 1, -1), (W - m, H - m, -1, -1)):
        d.rectangle((min(x, x + sx * L), min(y, y + sy * th), max(x, x + sx * L), max(y, y + sy * th)), fill=white)
        d.rectangle((min(x, x + sx * th), min(y, y + sy * L), max(x, x + sx * th), max(y, y + sy * L)), fill=white)
    f = round(t * FPS)
    tc = f'TC 00:00:{f // FPS:02d}:{f % FPS:02d}'
    bi = max(1, min(total, int(b) + 1))
    items = [(name_en + ' / DANCE REEL', m + 16, m + 18, (0, 0)), (f'{bpm:g} BPM', W - m - 16, m + 18, (1, 0)),
             (tc, m + 16, H - m - 18, (0, 1)), (f'BEAT {bi:02d}/{total}', W - m - 16, H - m - 18, (1, 1)), (label, W / 2, H - m - 18, (0.5, 1))]
    for s, x, y, a in items:
        paste(lay, text(s, 'noto', 26, '#FFFFFF', weight=800, track=3), x, y, anchor=a)
    for i in range(4):  # 小節の中の拍の点
        on = int(b) % 4 == i
        cx = W / 2 - 45 + i * 30
        d.ellipse((cx - 6, m + 24, cx + 6, m + 36), fill=white if on else None, outline=white, width=2)
    return difference(img, lay)


def render(i):
    cfg, clock = G['cfg'], G['clock']
    plan = cfg['plan']
    t = (i - 1) / FPS
    gb = clock.beat(t)
    k = scene_at(t)
    e = plan[k]
    ctx = ctx_for(e)
    img = SCENES[e['scene']](ctx, t, ctx.beat(t))
    hits = sum(face_hit(l, ctx.me) for l in ctx.fronts)
    # 次の場面のワイプ: 次の場面の頭の WIPE 拍前から覆い始め、頭の拍で覆い終わる
    if k + 1 < len(plan) and plan[k + 1]['wipe'] and gb > plan[k + 1]['b0'] - WIPE:
        nx = plan[k + 1]
        u = expo_in_out((gb - (nx['b0'] - WIPE)) / WIPE)
        nctx = ctx_for(nx)
        img = Image.composite(SCENES[nx['scene']](nctx, t, nctx.beat(t)), img, wipe_mask(nx['wipe'], u))
    tx = cfg.get('text') or {}
    img = hud(img, t, gb, G['total'], f'{k + 1:02d} {BY_ID[e["scene"]]["label"]}', tx.get('titleEn', 'NURSE'), cfg['bpm'])
    img = grain(img, i, 4).convert('RGB')
    if (cfg.get('comp_w') or W, cfg.get('comp_h') or H) != (W, H):
        img = img.resize((cfg['comp_w'], cfg['comp_h']), Image.LANCZOS)
    img.save(Path(cfg['frames_dir']) / f'{i:05d}.png', compress_level=1)
    return i, hits


def compose(cfg, frames, jobs=8):
    """frames のコマを重ねて cfg['frames_dir'] へ書く。答えは {faceHits: [[コマ, 画素の数], ...], seconds}"""
    Path(cfg['frames_dir']).mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    if jobs <= 1:
        setup(cfg)
        res = [render(i) for i in frames]
    else:
        with Pool(jobs, initializer=setup, initargs=(cfg,)) as pool:
            res = pool.map(render, frames, chunksize=4)
    return {'faceHits': [[i, h] for i, h in res if h], 'seconds': round(time.time() - t0, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dancer', required=True)
    ap.add_argument('--plan', required=True)
    ap.add_argument('--frames-dir', required=True)
    ap.add_argument('--bpm', type=float, default=120)
    ap.add_argument('--beats-json')
    ap.add_argument('--text')
    ap.add_argument('--palette')
    ap.add_argument('--comp-w', type=int, default=W)
    ap.add_argument('--comp-h', type=int, default=H)
    ap.add_argument('--frames')
    ap.add_argument('--jobs', type=int, default=8)
    a = ap.parse_args()
    plan = json.loads(Path(a.plan).read_text(encoding='utf8'))
    cfg = {'dancer': a.dancer, 'plan': plan, 'bpm': a.bpm, 'beats': json.load(open(a.beats_json)) if a.beats_json else None,
           'text': json.load(open(a.text, encoding='utf8')) if a.text else None, 'palette': json.load(open(a.palette)) if a.palette else None,
           'frames_dir': a.frames_dir, 'comp_w': a.comp_w, 'comp_h': a.comp_h}
    from .plan import frame_count, parse_ranges
    frames = sorted(parse_ranges(a.frames)) if a.frames else list(range(1, frame_count(plan[-1]['end']) + 1))
    r = compose(cfg, frames, a.jobs)
    print(f'composed {len(frames)} frames in {r["seconds"]}s')
    print('front layers over the face:', r['faceHits'][:20] or 'none')


if __name__ == '__main__':
    main()
