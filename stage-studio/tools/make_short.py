"""カット表からショート動画のコマを描く。カットごとに動きを焼き込み、Blender で描く。動画にまとめるのはきゃらすた。
    python tools/make_short.py plan.json --out out/short1 [--pct 100 --samples 128 --base http://127.0.0.1:8870]
plan.json: {"cuts": [{"id": "ハッシュ", "stage": "classroom", "seconds": 4.2, "camera": "talk_bust", "angle": 0, "who": 0, "count": 1, "actors": [{"slot": 0, "char": "...", "ver": "...", "motion": "vrma-02", "expression": "happy", "lips": [{"aa": 0.7}, ...], "once": false}]}]}
actors はそのカットに出る人で、slot は立ち位置の番号、turn は立ち位置の向きに足す度、prop は右手に持つ小道具(letter)、hold は動きの最後の姿勢から始める(どれも省略可)。count は出演者の数。who は追う人の slot。
カットの id ごとに <out>/<id>/ へ書く。できたコマは残すので、直したカットだけ描き直す。
plan に take があると、全カットを 1 つの時間の流れで撮る(歩きながら話す動画)。take: {"id": "ハッシュ", "stage": "parkway", "seconds": 24, "mark": [0, 31, 0], "spread": 0.5, "actors": [...], "creature": {...}}。カットは id、seconds、camera、who だけを持つ。カットごとのコマは <out>/<take の id>/frames のハードリンク。actors[].lips のコマの look と face は tools/bake_motion.mjs を見る。actors[].stop(秒。焼き込みの 0 秒から)があると、その前後で両足が着いたコマに歩きを止める。かかとが着いた時刻は <out>/<take の id>/a<k>.json の steps
"""
import argparse
import json
import math
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib import portable as Pt  # noqa: E402

FPS = 30

a = argparse.ArgumentParser()
a.add_argument('plan')
a.add_argument('--out', required=True)
a.add_argument('--blur', type=float, default=0.4)
a.add_argument('--pct', type=int, default=100)
a.add_argument('--samples', type=int, default=128)
a.add_argument('--base', default='http://127.0.0.1:8870')
a.add_argument('--charasta')  # 省略時は環境変数 CHARASTA_ROOT、無ければキットの親
a.add_argument('--library')  # 省略時は環境変数 CHARASTA_LIBRARY
x = a.parse_args()
BLENDER = Pt.find_blender()
LIB = Pt.library(x.library)
CHARASTA = str(Pt.charasta_root(x.charasta))
plan = json.load(open(x.plan, encoding='utf8'))
root = Path(x.out).resolve()


def actors_of(cut):
    """カットに出る人。actors の無い古い形の plan は、全体の char と ver とカットの動きを 1 人として読む"""
    if 'actors' in cut:
        return cut['actors']
    return [{'slot': 0, 'char': plan['char'], 'ver': plan['ver'], 'motion': cut['motion'], 'expression': cut.get('expression', 'motion'), 'lips': cut.get('lips')}]


def bake_actor(out, k, cut, actor):
    """1 人の動き、表情、口を GLB へ焼き込む。答えはビューアのモデルの向き"""
    bake, glb, lips = out / f'a{k}.json', out / f'a{k}.glb', out / f'a{k}.lips.json'
    if not glb.exists():
        lips.write_text(json.dumps(actor.get('lips') or []), encoding='utf8')
        vrm = LIB / 'characters' / actor['char'] / 'versions' / actor['ver'] / 'model.vrm'
        subprocess.run(['node', str(ROOT / 'tools/bake_motion.mjs'), '--base', x.base, '--charasta', CHARASTA, '--char', actor['char'], '--ver', actor['ver'], '--motion', actor['motion'], '--seconds', str(cut['seconds']),
                        '--expression', actor.get('expression', 'motion'), '--lips', str(lips), '--out', str(bake), *(['--once'] if actor.get('once') else []), *(['--hold'] if actor.get('hold') else []), *(['--grip'] if actor.get('prop') else []), *(['--springs', json.dumps(actor['springs'])] if actor.get('springs') else []), *(['--stop', str(actor['stop'])] if actor.get('stop') else [])], check=True)
        part = out / f'a{k}.part.glb'  # 途中で止まっても、切れたファイルをできたものと見なさない
        subprocess.run([sys.executable, str(ROOT / 'tools/bake_glb.py'), str(vrm), str(bake), str(part)], check=True)
        os.replace(part, glb)
    return json.load(open(bake))['yaw']


def drift_turn(bake):
    """歩いて横へずれる分を打ち消す度。腰の道のはじめと終わりの向きを見る。2 人の間隔を保つ"""
    d = json.load(open(bake))
    hips = next(i for i, n in enumerate(d['bones']) if n.endswith('Hips'))
    a, b = d['frames'][0]['b'][hips], d['frames'][-1]['b'][hips]
    return -math.degrees(math.atan2(b[0] - a[0], b[2] - a[2]))


def shoot_take(take):
    """1 回の Blender で全カットを撮り、コマをカットごとのフォルダへ分ける"""
    out = root / take['id']
    frames = out / 'frames'
    counts = [round(c['seconds'] * FPS) for c in plan['cuts']]
    if len(list(frames.glob('[0-9]????.png'))) < sum(counts):
        out.mkdir(parents=True, exist_ok=True)
        cast = [{'glb': str(out / f'a{k}.glb'), 'yaw': bake_actor(out, k, take, actor), 'slot': actor['slot'], 'count': len(take['actors']), 'mark': take['mark'], 'spread': take['spread'], 'inward': 0, 'turn': drift_turn(out / f'a{k}.json')} for k, actor in enumerate(take['actors'])]
        (out / 'cast.json').write_text(json.dumps(cast), encoding='utf8')
        shots, at = [], 0
        for i, (c, n) in enumerate(zip(plan['cuts'], counts)):
            shots.append({'kind': c['camera'], 'start': at / FPS, 'end': (at + n) / FPS, 'a': c.get('angle', 0), 'dir': 1, 'seed': i + 1, 'stage': take['stage'], 'who': c.get('who', 0)})
            at += n
        (out / 'shots.json').write_text(json.dumps(shots), encoding='utf8')
        creature = []
        if take.get('creature'):
            (out / 'creature.json').write_text(json.dumps(take['creature']), encoding='utf8')
            creature = ['--creature-json', str(out / 'creature.json')]
        print('take', sum(counts), take['stage'], flush=True)
        subprocess.run([BLENDER, '-b', '--factory-startup', '--python-exit-code', '1', '--python', str(ROOT / 'tools/render.py'), '--', '--stage', take['stage'], '--cast-json', str(out / 'cast.json'), *creature, '--seconds', str(sum(counts) / FPS),
                        '--shots-json', str(out / 'shots.json'), '--frames-dir', str(frames), '--pct', str(x.pct), '--samples', str(x.samples), '--blur', str(x.blur)], check=True)
    at = 0
    for c, n in zip(plan['cuts'], counts):
        cut = root / c['id'] / 'frames'
        cut.mkdir(parents=True, exist_ok=True)
        for f in range(1, n + 1):
            if not (cut / f'{f:05d}.png').exists():
                os.link(frames / f'{at + f:05d}.png', cut / f'{f:05d}.png')
        at += n


if plan.get('take'):
    shoot_take(plan['take'])
    sys.exit(0)

for i, c in enumerate(plan['cuts']):
    out = root / c['id']
    frames = out / 'frames'
    count = round(c['seconds'] * FPS)
    if frames.exists() and len(list(frames.glob('[0-9]????.png'))) >= count:
        print('cut', i + 1, 'skip', flush=True)
        continue
    out.mkdir(parents=True, exist_ok=True)
    cast = [{'glb': str(out / f'a{k}.glb'), 'yaw': bake_actor(out, k, c, actor), 'slot': actor['slot'], 'count': c.get('count', 1), 'turn': actor.get('turn', 0), 'prop': actor.get('prop')} for k, actor in enumerate(actors_of(c))]
    cast_json = out / 'cast.json'
    cast_json.write_text(json.dumps(cast), encoding='utf8')
    shots = out / 'shots.json'
    shots.write_text(json.dumps([{'kind': c['camera'], 'start': 0, 'end': c['seconds'], 'a': c.get('angle', 0), 'dir': 1, 'seed': i + 1, 'stage': c['stage'], 'who': c.get('who', 0)}]), encoding='utf8')
    print('cut', i + 1, '/', len(plan['cuts']), c['stage'], flush=True)
    subprocess.run([BLENDER, '-b', '--factory-startup', '--python-exit-code', '1', '--python', str(ROOT / 'tools/render.py'), '--', '--stage', c['stage'], '--cast-json', str(cast_json), '--seconds', str(c['seconds']),
                    '--shots-json', str(shots), '--frames-dir', str(frames), '--pct', str(x.pct), '--samples', str(x.samples), '--blur', str(x.blur)], check=True)
