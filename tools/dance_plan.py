"""ダンス MV のカット割りを求める: python tools/dance_plan.py <stage-studio のフォルダ> <条件.json> <答え.json>
stage-studio の tools/make_mv.py と同じ割り方(lib/shots.py の plan と assign_stages)で、拍からショットの予定を作る。
条件: {"beats": [秒...] か null, "bpm", "seconds", "seed", "beatsPerShot", "shotsPerScene", "stages": [シーン...]}
beats が null なら bpm から求める(make_mv の音声なしの経路)。答えはショットの配列 [{kind, start, end, a, dir, seed, stage}]。
乱数は Python の random なので、JS へ移さずに stage-studio の関数をそのまま呼ぶ。stage-studio のファイルは読むだけで変えない。
"""
import json
import sys

stage_dir, src, dst = sys.argv[1:4]
sys.path.insert(0, stage_dir)
from lib import shots as Sh  # noqa: E402

c = json.load(open(src, encoding='utf8'))
bps = int(c['beatsPerShot'])
beats = c.get('beats') or Sh.beats_of(float(c['bpm']), max(float(c['seconds']), 30), 0)
plan = Sh.assign_stages(Sh.plan(beats, float(c['seconds']), int(c['seed']), bps, bps), c['stages'], int(c['shotsPerScene']))
json.dump(plan, open(dst, 'w', encoding='utf8'))
