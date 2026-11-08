"""動画をまとめて作る。予定は JSON の配列で、1 件は make_mv.py の引数と同じ名前。できた動画はそのまま残し、止まっても続きから描く。
    python tools/make_batch.py batch.json --out out/batch
    [{"stage": "concert", "char": "avatar-sample-b", "ver": "v2-official", "motion": "illit-itsme-b", "seconds": 15, "bpm": 120, "seed": 1, "audio": "song.m4a", "audio_start": 12}]
"""
import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
a = argparse.ArgumentParser()
a.add_argument('plan')
a.add_argument('--out', default=str(ROOT / 'out/batch'))
x = a.parse_args()
for job in json.load(open(x.plan, encoding='utf8')):
    name = '_'.join(str(job.get(k, '')) for k in ('stage', 'char', 'motion', 'seed'))
    out = Path(x.out) / name
    if (out / 'mv.mp4').exists():
        print('skip', name)
        continue
    args = ['python', str(ROOT / 'tools/make_mv.py'), '--out', str(out)]
    for k, v in job.items():
        args += ['--' + k.replace('_', '-'), str(v)]
    print('make', name, flush=True)
    subprocess.run(args, check=True)
