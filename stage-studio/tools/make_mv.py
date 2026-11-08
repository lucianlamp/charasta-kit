"""1 本の MV を作る: 動きの焼き込み -> カット割りの予定 -> シーンごとに Blender で描く -> 動画にまとめる。
    python tools/make_mv.py --stage concert,classroom --char avatar-sample-b --ver v2-official --motion illit-itsme-b --seconds 15 --bpm 120 --out out/mv1 [--audio song.m4a --audio-start 0] [--seed 1 --pct 100 --samples 128]
--stage にシーンを並べると、カットの変わり目で順に切り替える(--beats-per-shot、--shots-per-scene)。
できたコマは残すので、止まっても同じ命令で続きから描く。--frames-only は動画にまとめない(きゃらすたが自分でまとめる)。
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib import portable as Pt  # noqa: E402
from lib import shots as Sh  # noqa: E402

a = argparse.ArgumentParser()
for k in ('--stage', '--char', '--ver', '--motion', '--out'):
    a.add_argument(k, required=True)
a.add_argument('--seconds', type=float, default=15)
a.add_argument('--bpm', type=float, default=120)
a.add_argument('--beat-offset', type=float, default=0)
a.add_argument('--beats-per-shot', type=int, default=8)
a.add_argument('--shots-per-scene', type=int, default=1)
a.add_argument('--audio')
a.add_argument('--audio-start', type=float, default=0)
a.add_argument('--blur', type=float, default=0.4)
a.add_argument('--seed', type=int, default=0)
a.add_argument('--variant', default='')
a.add_argument('--pct', type=int, default=100)
a.add_argument('--samples', type=int, default=128)
a.add_argument('--base', default='http://127.0.0.1:8870')
a.add_argument('--charasta')  # 省略時は環境変数 CHARASTA_ROOT、無ければキットの親
a.add_argument('--library')  # 省略時は環境変数 CHARASTA_LIBRARY
a.add_argument('--frames-only', action='store_true')
a.add_argument('--look', choices=['anime', 'cel'])  # render.py の --look。無ければ前と同じ絵
a.add_argument('--face-front', action='store_true')
x = a.parse_args()
BLENDER = Pt.find_blender()
LIB = Pt.library(x.library)
CHARASTA = str(Pt.charasta_root(x.charasta))
out = Path(x.out).resolve()  # Blender はカレントの外で動くので、相対のままだと別の場所へ書く
out.mkdir(parents=True, exist_ok=True)
stages = x.stage.split(',')
bake, glb, frames, shots_json = out / 'bake.json', out / 'bake.glb', out / 'frames', out / 'shots.json'
if not glb.exists():
    subprocess.run(['node', str(ROOT / 'tools/bake_motion.mjs'), '--base', x.base, '--charasta', CHARASTA, '--char', x.char, '--ver', x.ver, '--motion', x.motion, '--seconds', str(x.seconds), '--out', str(bake)], check=True)
    part = out / 'bake.part.glb'  # 途中で止まっても、切れたファイルをできたものと見なさない
    subprocess.run([sys.executable, str(ROOT / 'tools/bake_glb.py'), str(LIB / 'characters' / x.char / 'versions' / x.ver / 'model.vrm'), str(bake), str(part)], check=True)
    os.replace(part, glb)
yaw = json.load(open(bake))['yaw']
beats_args = []
if x.audio:  # 音楽があれば拍は音楽から求める
    subprocess.run([sys.executable, str(ROOT / 'tools/beats.py'), x.audio, str(out / 'beats.json'), '--start', str(x.audio_start), '--seconds', str(x.seconds + 5)], check=True)
    beats_args = ['--beats-json', str(out / 'beats.json')]
    beats = json.load(open(out / 'beats.json'))
else:
    beats = Sh.beats_of(x.bpm, max(x.seconds, 30), x.beat_offset)
plan = Sh.assign_stages(Sh.plan(beats, x.seconds, x.seed, x.beats_per_shot, x.beats_per_shot), stages, x.shots_per_scene)
shots_json.write_text(json.dumps(plan), encoding='utf8')
used = list(dict.fromkeys(p['stage'] for p in plan))  # 短い動画では後ろのシーンまで回らない
print('scenes', used, flush=True)
for stage in used:
    subprocess.run([BLENDER, '-b', '--factory-startup', '--python-exit-code', '1', '--python', str(ROOT / 'tools/render.py'), '--', '--stage', stage, '--glb', str(glb), '--seconds', str(x.seconds), '--bpm', str(x.bpm), '--beat-offset', str(x.beat_offset),
                    '--shots-json', str(shots_json), '--frames-dir', str(frames), '--seed', str(x.seed), '--variant', x.variant, '--yaw', str(yaw), '--pct', str(x.pct), '--samples', str(x.samples), '--blur', str(x.blur), *beats_args, *(['--look', x.look, '--vrm', str(LIB / 'characters' / x.char / 'versions' / x.ver / 'model.vrm')] if x.look else []), *(['--face-front'] if x.face_front else [])], check=True)
if x.frames_only:
    sys.exit(0)
cmd = [Pt.find_ffmpeg(), '-y', '-v', 'error', '-framerate', '30', '-start_number', '1', '-i', str(frames / '%05d.png')]
if x.audio:
    cmd += ['-ss', str(x.audio_start), '-i', x.audio, '-map', '0:v', '-map', '1:a', '-af', f'apad=whole_dur={x.seconds}', '-t', str(x.seconds), '-c:a', 'aac', '-b:a', '192k']
cmd += ['-c:v', 'h264_nvenc', '-preset', 'p6', '-cq', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(out / 'mv.mp4')]
subprocess.run(cmd, check=True)
print('done', out / 'mv.mp4')
