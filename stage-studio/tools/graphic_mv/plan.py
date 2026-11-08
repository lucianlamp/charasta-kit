"""場面の並び。4 拍を 1 場面とし、頭を INTRO、最後を END にして、間を seed で並べ替えた場面で埋める。
場面ごとに使う描き方(全身、膝上、顔の寄り)、入りのワイプ、ワイプの重なり、残像のずらしを足して、描き方ごとに要るコマを求める。
seed 0 は catalog.json の順(試作 v12 と同じ並び)。"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

from .core import FPS, Clock
from .scenes import WIPE

CATALOG = json.loads((Path(__file__).resolve().parent / 'catalog.json').read_text(encoding='utf8'))
BY_ID = {s['id']: s for s in CATALOG}
WIPES = ['iris', 'diag', 'bars', 'slab', 'columns']
BEATS_PER_SCENE = 4
DEFAULT_WORDS = ['MOVE', 'STEP', 'TURN', 'FEEL', 'BEAT', 'RHYTHM', 'KICK', 'DANCE']
MARGIN = 8  # 描き方ごとのコマの範囲の前後に足すゆとり(コマ)
PASSES = ['full', 'mid', 'face']


def middles():
    return [s['id'] for s in CATALOG if not s.get('role')]


def scene_order(n, seed=0):
    """n 個の場面の並び(n >= 2)。頭は intro、最後は end。間は seed で並べ替え、足りなければもう一巡する(同じ場面を続けない)"""
    if n < 2:
        raise ValueError('場面は 2 つ以上')
    mids, out, rnd = middles(), [], random.Random(seed)
    while len(out) < n - 2:
        batch = list(mids)
        if seed:
            rnd.shuffle(batch)
        if out and batch[0] == out[-1]:
            batch.append(batch.pop(0))
        out += batch
    return ['intro'] + out[:n - 2] + ['end']


def split_word(w):
    """カットの word(複数の枠は / で区切る)を言葉の並びにする"""
    if w is None:
        return None
    return [x.strip() for x in str(w).split('/') if x.strip()]


def assign_words(entries, words):
    """言葉の枠を持つ場面へ、words を順に配る(足りなければ頭へ戻る)。entries に words が既にあればそのまま"""
    words = [w for w in (words or DEFAULT_WORDS) if w] or DEFAULT_WORDS
    k = 0
    for e in entries:
        n = BY_ID[e['scene']]['words']
        if e.get('words') is None:
            e['words'] = [words[(k + i) % len(words)] for i in range(n)]
        k += n
    return entries


def make_plan(seconds, bpm=120.0, beats=None, seed=0, words=None, order=None):
    """秒と拍(BPM か拍の時刻の列)から場面の並びを作る。答えは [{scene, b0, b1, start, end, wipe, words}]"""
    clock = Clock(bpm, 0, beats)
    total = clock.beat(seconds)
    n = len(order) if order else max(2, round(total / BEATS_PER_SCENE))
    ids = order or scene_order(n, seed)
    out = []
    for i, sid in enumerate(ids):
        if sid not in BY_ID:
            raise ValueError(f'知らない場面: {sid!r}')
        last = i == n - 1
        b0, b1 = BEATS_PER_SCENE * i, (total if last else BEATS_PER_SCENE * (i + 1))
        start = 0.0 if i == 0 else clock.time(b0)
        end = float(seconds) if last else clock.time(b1)
        out.append({'scene': sid, 'b0': b0, 'b1': round(b1, 6), 'start': round(start, 6), 'end': round(end, 6), 'wipe': None if i == 0 else BY_ID[sid]['wipe']})
    if out[-1]['end'] - out[-1]['start'] <= 0:
        raise ValueError('最後の場面の長さが 0')
    return assign_words(out, words)


def from_cuts(cuts, seconds, bpm=120.0, beats=None, words=None):
    """きゃらすたのカット([{scene, wipe?, word?, start, end}] か seconds の並び)を場面の並びにする。b0 は頭の秒に一番近い拍"""
    clock = Clock(bpm, 0, beats)
    out, t = [], 0.0
    for i, c in enumerate(cuts):
        if c.get('scene') not in BY_ID:
            raise ValueError(f'知らない場面: {c.get("scene")!r}')
        start = float(c['start']) if 'start' in c else t
        end = float(c['end']) if 'end' in c else start + float(c['seconds'])
        t = end
        wipe = c.get('wipe', BY_ID[c['scene']]['wipe'])
        if wipe in ('', 'none'):
            wipe = None
        if wipe is not None and wipe not in WIPES:
            raise ValueError(f'知らないワイプ: {wipe!r}')
        b0 = round(clock.beat(start))
        out.append({'scene': c['scene'], 'b0': b0, 'b1': round(clock.beat(end), 6), 'start': round(start, 6), 'end': round(end, 6), 'wipe': None if i == 0 else wipe, 'words': split_word(c.get('word'))})
    if not out:
        raise ValueError('カットが無い')
    if abs(out[-1]['end'] - seconds) > 0.02:
        raise ValueError(f'カットの合計 {out[-1]["end"]} 秒が動画の長さ {seconds} 秒と違う')
    return assign_words(out, words)


def frame_count(seconds):
    return round(seconds * FPS)  # Python の round は偶数丸め(きゃらすたの roundHalfEven と同じ)


def needed_frames(entries, seconds, bpm=120.0, beats=None):
    """描き方ごとに要るコマの集合 {pass: set(コマ番号)}。ワイプで前の場面に重なる分と、残像で戻る分を足す"""
    clock = Clock(bpm, 0, beats)
    n = frame_count(seconds)
    need = {p: set() for p in PASSES}
    for i, e in enumerate(entries):
        meta = BY_ID[e['scene']]
        lead = 0.0
        if i > 0 and e['wipe']:
            lead = max(0.0, e['start'] - clock.time(e['b0'] - WIPE))
        lo = math.floor((e['start'] - lead) * FPS) + 1 - meta['back'] - MARGIN
        hi = math.ceil(e['end'] * FPS) + MARGIN
        for p in meta['passes']:
            need[p].update(range(max(1, lo), min(n, hi) + 1))
    return need


def ranges(frames):
    """コマの集合を '1-10,20-30' の形にする"""
    fs = sorted(frames)
    out = []
    for f in fs:
        if out and f == out[-1][1] + 1:
            out[-1][1] = f
        else:
            out.append([f, f])
    return ','.join(f'{a}-{b}' if a != b else str(a) for a, b in out)


def parse_ranges(s):
    out = set()
    for part in filter(None, s.split(',')):
        lo, _, hi = part.partition('-')
        out.update(range(int(lo), int(hi or lo) + 1))
    return out
