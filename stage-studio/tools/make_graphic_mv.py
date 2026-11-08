"""グラフィックの MV のコマを作る: 動きの焼き込み -> スカートの確かめ -> 踊る人を 3 つの描き方で透明な背景に描く -> 文字と図形と重ねる。
きゃらすたが動画にまとめる前提で、mp4 は作らない(make_mv.py の --frames-only と同じ)。
    python tools/make_graphic_mv.py --catalog
    python tools/make_graphic_mv.py --plan-only --spec spec.json
    python tools/make_graphic_mv.py --spec spec.json --out <作業> --quality preview|final [--dancer-dir <踊る人の作業>] [--base http://127.0.0.1:8870 --charasta <きゃらすたの場所> --library <保管場所>]
spec.json: {char, ver, motion, seconds, bpm, beats?, audio?, audioStart, seed?, springs, skirtDamp, cues[], text{title, titleEn, credit, words[]},
            palette{bg[3], ink, accent, light}, plan?[{scene, start, end, wipe, word?}], pct?, samples?, compW?, compH?}
plan が無ければ seed から場面の並びを作る。beats が無く audio があれば tools/beats.py で拍を求める。
--out に frames/%05d.png、shots.json(場面の並びと秒)、report.json(顔にかかった文字、時間、描いたコマの範囲)、progress.json(今の工程)を書く。
踊る人は --dancer-dir(既定 <out>/dancer)に置き、描いてあるコマは描き直さない。文字と色だけ直したときは重ねるだけをやり直す。
股の前が見えるコマが 1 つでもあれば描かずに止まり、report.json の exposed に秒を書いて終わりのコード 3 を返す。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))

from graphic_mv import plan as Pl  # noqa: E402
from graphic_mv.core import FPS, Palette, check_color  # noqa: E402

sys.path.insert(0, str(ROOT))

from lib import portable as Pt  # noqa: E402

BLENDER = LIB = CHARASTA = None  # main() で環境から決める(--catalog や --plan-only は Blender が無くても動く)
QUALITIES = {'preview': {'pct': 50, 'samples': 16, 'compW': 540, 'compH': 960}, 'final': {'pct': 100, 'samples': 64, 'compW': 1080, 'compH': 1920}}
MAX_TEXT = {'title': 24, 'titleEn': 24, 'credit': 60, 'word': 16}
EXIT_EXPOSED = 3


def check_spec(spec):
    """spec の値を確かめる。おかしければ ValueError"""
    if not (isinstance(spec.get('seconds'), (int, float)) and 1 <= spec['seconds'] <= 180):
        raise ValueError('seconds は 1 から 180')
    tx = spec.get('text') or {}
    for k in ('title', 'titleEn', 'credit'):
        if k in tx and (not isinstance(tx[k], str) or len(tx[k]) > MAX_TEXT[k]):
            raise ValueError(f'text.{k} は {MAX_TEXT[k]} 文字までの文字列')
    if 'titleEn' in tx and not all(32 <= ord(ch) < 127 for ch in tx['titleEn']):
        raise ValueError('text.titleEn は英数字と記号だけ')
    for w in tx.get('words') or []:
        if not isinstance(w, str) or len(w) > MAX_TEXT['word']:
            raise ValueError(f'text.words は {MAX_TEXT["word"]} 文字までの文字列')
    if spec.get('palette'):
        Palette(spec['palette'])
    for c in spec.get('cues') or []:
        if not (c.get('to', 0) > c.get('from', 0) >= 0) or not isinstance(c.get('expr'), dict) or not all(0 <= v <= 1 for v in c['expr'].values()):
            raise ValueError(f'cues の行が不正: {c!r}')
        if c['from'] > spec['seconds']:
            raise ValueError(f'cues の from が動画の長さより後: {c!r}')
    return spec


def clock_args(spec, work):
    """(bpm, beats)。beats は曲の拍の時刻(秒、開始位置が 0)か None"""
    if spec.get('beats'):
        return float(spec.get('bpm') or 120), list(spec['beats'])
    if spec.get('audio'):
        out = Path(work) / 'beats.json'
        r = subprocess.run([sys.executable, str(ROOT / 'tools/beats.py'), spec['audio'], str(out), '--start', str(spec.get('audioStart', 0)), '--seconds', str(spec['seconds'] + 5)], check=True, capture_output=True, text=True)
        beats = json.loads(out.read_text())
        bpm = float(r.stdout.split()[1]) if r.stdout.startswith('bpm') else float(spec.get('bpm') or 120)
        return bpm, beats
    return float(spec.get('bpm') or 120), None


def plan_of(spec, bpm, beats):
    words = (spec.get('text') or {}).get('words')
    if spec.get('plan'):
        return Pl.from_cuts(spec['plan'], spec['seconds'], bpm, beats, words)
    return Pl.make_plan(spec['seconds'], bpm, beats, int(spec.get('seed', 0)), words)


def plan_only(spec):
    with tempfile.TemporaryDirectory() as tmp:
        bpm, beats = clock_args(spec, tmp)
    entries = plan_of(spec, bpm, beats)
    need = Pl.needed_frames(entries, spec['seconds'], bpm, beats)
    return {'bpm': round(bpm, 3), 'source': 'audio' if beats else 'bpm', 'frames': Pl.frame_count(spec['seconds']), 'plan': entries,
            'passes': {p: Pl.ranges(f) for p, f in need.items() if f}}


def write_json(path, obj):
    tmp = Path(str(path) + '.part')
    tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding='utf8')
    os.replace(tmp, path)


def main():
    for f in (sys.stdout, sys.stderr):
        f.reconfigure(encoding='utf-8')
    a = argparse.ArgumentParser()
    a.add_argument('--catalog', action='store_true')
    a.add_argument('--plan-only', action='store_true')
    a.add_argument('--spec')
    a.add_argument('--out')
    a.add_argument('--dancer-dir')
    a.add_argument('--quality', choices=QUALITIES, default='preview')
    a.add_argument('--base', default='http://127.0.0.1:8870')
    a.add_argument('--charasta')  # 省略時は環境変数 CHARASTA_ROOT、無ければキットの親
    a.add_argument('--library')  # 省略時は環境変数 CHARASTA_LIBRARY
    a.add_argument('--jobs', type=int, default=8)
    x = a.parse_args()
    if x.catalog:
        print(json.dumps(Pl.CATALOG, ensure_ascii=False))
        return 0
    if not x.spec:
        a.error('--spec が要る')
    try:
        spec = check_spec(json.loads(Path(x.spec).read_text(encoding='utf8')))
    except ValueError as e:
        print('spec が正しくない:', e, file=sys.stderr)
        return 2
    if x.plan_only:
        print(json.dumps(plan_only(spec), ensure_ascii=False))
        return 0
    if not x.out:
        a.error('--out が要る')
    global BLENDER, LIB, CHARASTA
    BLENDER, LIB, CHARASTA = Pt.find_blender(), Pt.library(x.library), str(Pt.charasta_root(x.charasta))
    q = {**QUALITIES[x.quality], **{k: spec[k] for k in ('pct', 'samples', 'compW', 'compH') if spec.get(k)}}
    out = Path(x.out).resolve()
    dancer = Path(x.dancer_dir).resolve() if x.dancer_dir else out / 'dancer'
    out.mkdir(parents=True, exist_ok=True)
    dancer.mkdir(parents=True, exist_ok=True)
    report = {'quality': x.quality, **q, 'timings': {}}
    progress = lambda **kw: write_json(out / 'progress.json', kw)  # noqa: E731

    bpm, beats = clock_args(spec, out)
    entries = plan_of(spec, bpm, beats)
    need = Pl.needed_frames(entries, spec['seconds'], bpm, beats)
    n = Pl.frame_count(spec['seconds'])
    write_json(out / 'shots.json', entries)
    report['passes'] = {p: Pl.ranges(f) for p, f in need.items() if f}
    report['bpm'] = round(bpm, 3)

    vrm = LIB / 'characters' / spec['char'] / 'versions' / spec['ver'] / 'model.vrm'
    glb = dancer / 'bake.glb'
    if not glb.exists():
        progress(phase='bake')
        t0 = time.time()
        cues = dancer / 'cues.json'
        write_json(cues, spec.get('cues') or [])
        springs = json.dumps({'skirt': spec['springs']['skirt']} if (spec.get('springs') or {}).get('skirt') else (spec.get('springs') or {}))
        cmd = ['node', str(ROOT / 'tools/bake_motion.mjs'), '--base', x.base, '--charasta', CHARASTA, '--char', spec['char'], '--ver', spec['ver'], '--motion', spec['motion'], '--seconds', str(spec['seconds']), '--cues', str(cues), '--out', str(dancer / 'bake.json')]
        if springs != '{}':
            cmd += ['--springs', springs]
        subprocess.run(cmd, check=True)
        part = dancer / 'bake.part.glb'  # 途中で止まっても、切れたファイルをできたものと見なさない
        subprocess.run([sys.executable, str(ROOT / 'tools/bake_glb.py'), str(vrm), str(dancer / 'bake.json'), str(part)], check=True)
        os.replace(part, glb)
        report['timings']['bake'] = round(time.time() - t0, 1)

    def blender(pas, frames, extra):
        return subprocess.run([BLENDER, '-b', '--factory-startup', '--python-exit-code', '1', '--python', str(ROOT / 'tools/render_dancer.py'), '--', '--glb', str(glb), '--vrm', str(vrm), '--out-dir', str(dancer),
                               '--pass', pas, '--frames', Pl.ranges(frames), '--pct', str(q['pct']), '--samples', str(q['samples']), '--skirt-damp', str(spec.get('skirtDamp', 0.6)), '--skip-existing', *extra],
                              env={**os.environ, 'STAGE_STUDIO': str(ROOT)})

    missing = {p: sorted(f for f in fs if not (dancer / p / f'{f:05d}.png').exists()) for p, fs in need.items() if fs}
    missing = {p: fs for p, fs in missing.items() if fs}
    # スカートの確かめ: 描く前に、描いていないコマで股の前が見えるかを数える(描かない)
    exposed = []
    t0 = time.time()
    for pas, fs in missing.items():
        progress(phase='check', pass_=pas)
        r = blender(pas, fs, ['--skip-render'])
        if r.returncode != 0:
            raise SystemExit(f'スカートの確かめが失敗した({pas})')
        bad = json.loads((dancer / f'{pas}.json').read_text()).get('crotch_frames', [])
        if bad:
            exposed.append({'pass': pas, 'frames': bad, 'seconds': sorted({round((f - 1) / FPS, 1) for f in bad})})
    if missing:
        report['timings']['check'] = round(time.time() - t0, 1)
    if exposed:
        report['exposed'] = exposed
        write_json(out / 'report.json', report)
        print('EXPOSED', json.dumps(exposed), flush=True)
        return EXIT_EXPOSED
    for pas, fs in missing.items():
        progress(phase='render', pass_=pas, total=len(need[pas]))
        t0 = time.time()
        r = blender(pas, fs, [])
        if r.returncode != 0:
            raise SystemExit(f'踊る人を描けなかった({pas}、終わりのコード {r.returncode})')
        report['timings'][pas] = round(time.time() - t0, 1)
        report['timings'][pas + 'PerFrame'] = round((time.time() - t0) / len(fs), 3)

    progress(phase='compose', total=n)
    from graphic_mv.compose import compose
    tx = spec.get('text') or {}
    cfg = {'dancer': str(dancer), 'plan': entries, 'bpm': round(bpm, 1), 'beats': beats, 'text': tx, 'palette': spec.get('palette'),
           'frames_dir': str(out / 'frames'), 'comp_w': q['compW'], 'comp_h': q['compH']}
    r = compose(cfg, list(range(1, n + 1)), x.jobs)
    report['timings']['compose'] = r['seconds']
    report['faceHits'] = r['faceHits']
    report['frames'] = n
    write_json(out / 'report.json', report)
    progress(phase='done', total=n)
    print('composed', n, 'frames in', r['seconds'], 's; face hits', len(r['faceHits']), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
