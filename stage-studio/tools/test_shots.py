"""対話のカメラの幾何の確かめ。bpy が要らないのでふだんの python で動く。  python tools/test_shots.py"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib import shots as Sh  # noqa: E402

KINDS = ['close_who', 'bust_who', 'face_who', 'over_shoulder', 'two_shot', 'pull_back']


def person(pos):
    x, y, z = pos
    return {'hips': (x, y, z + 0.9), 'chest': (x, y, z + 1.2), 'head': (x, y, z + 1.4), 'turn': (0, 1, 0), 'facing': 0}


for mark, facing in (((0, 0, 0), 0), ((-1.15, 0, 0), 0), ((1, 2, 0), 40)):
    spots = Sh.stand(mark, facing, 2)
    a = math.radians(facing)
    front = (math.sin(a), -math.cos(a))
    assert abs(math.dist(spots[0][0], spots[1][0]) - 2 * Sh.STAND) < 1e-9
    assert spots[0][2] == -1 and spots[1][2] == 1
    assert (spots[0][1] - facing) > 0 > (spots[1][1] - facing), '互いの方を向く'
    bodies = [person(s[0]) for s in spots]
    for who in (0, 1):
        me, other = bodies[who], bodies[1 - who]
        p = {**me, 'side': spots[who][2], 'inward': Sh.INWARD, 'front': front, 'facing0': facing, 'other': other}
        for kind in KINDS:
            for u in (0, 0.5, 1):
                loc, look, lens, fstop = Sh.KINDS[kind](u, p, {'a': 0, 'dir': 1, 'seed': 1})
                dx, dy = loc[0] - mark[0], loc[1] - mark[1]
                assert dx * front[0] + dy * front[1] > 0, (kind, '想定線の手前側')
                vx, vy = look[0] - loc[0], look[1] - loc[1]
                right = (vy, -vx)  # 視線の右
                sa = (bodies[0]['head'][0] - loc[0]) * right[0] + (bodies[0]['head'][1] - loc[1]) * right[1]
                sb = (bodies[1]['head'][0] - loc[0]) * right[0] + (bodies[1]['head'][1] - loc[1]) * right[1]
                assert sa < sb, (kind, who, '左の人が画面の左')
                free = Sh.clear_bodies(loc, [x['head'][:2] for x in bodies])
                assert all(math.dist(free[:2], x['head'][:2]) >= 0.399 for x in bodies)
assert math.dist(Sh.clear_bodies((0.1, 0, 1), [(0, 0)]), (0.4, 0, 1)) < 1e-6
solo = {**person((0, 0, 0)), 'side': 0, 'inward': 0, 'front': (0, -1), 'facing0': 0, 'other': None, 'prop': None}
for kind in ('prop_close', 'prop_line'):
    assert Sh.KINDS[kind](0.5, solo, {'a': 0}) == Sh.KINDS['bust_who'](0.5, solo, {'a': 0}), '手紙が無ければ胸から上'
assert Sh.stand((1, 2, 0), 30, 1) == [((1, 2, 0), 30, 0)]
walkers = [[(t / 10, (x, 24 - 0.1 * t, 0.85 + 0.02 * (-1) ** t)) for t in range(100)] for x in (-0.5, 0.5)]
heads = [[(t, (x, y, 1.3)) for t, (x, y, _) in path] for path in walkers]
lane = Sh.fit_lane(walkers, heads)
(cx, cy), face = Sh.lane_at(lane, 5)
assert abs(cx) < 1e-6 and abs(cy - 19) < 1e-6 and abs(face - 1.39) < 1e-6, '腰の上下は道に入らない'
p = {'lane': Sh.lane_at(lane, 5), 'front': (0, -1), 'creature': None}
assert Sh.KINDS['front_walk'](0, p, {})[0][1] < 19 < Sh.KINDS['back_walk'](0, p, {})[0][1], '前と後ろから撮る'
assert Sh.KINDS['side_walk'](0, p, {})[0][0] > 1.95, '芝から撮る'
assert Sh.KINDS['crow_close'](0, p, {}) == Sh.KINDS['front_walk'](0, p, {}), '生き物が居なければ前から'
assert Sh.KINDS['crow_takeoff'](0, p, {}) == Sh.KINDS['front_walk'](0, p, {}), '生き物が居なければ前から'
d = Sh.KINDS['diag_walk'](0, p, {})[0]
assert d[1] < 19 and d[0] > 1, '右の斜め前から'
speaker = {**p, 'head': (0.5, 19.2, 1.3)}
loc, look, _, _ = Sh.KINDS['walk_close'](0, speaker, {})
assert abs(loc[0] - 0.5) < 1e-9 and abs(look[0] - 0.5) < 1e-9 and abs(look[1] - 19) < 1e-9, '横は話す人、前後は lane'
crow = {**p, 'creature': (2.65, 13.5, 7.15)}
loc, look, lens, _ = Sh.KINDS['crow_close'](0, crow, {'a': 0})
assert abs(loc[0] - (2.65 - 2.7)) < 1e-9 and abs(loc[1] - 14.9) < 1e-9, '角度 0 はもとの位置'
for a in (45, 90, -90, 180):
    l2 = Sh.KINDS['crow_close'](0, crow, {'a': a})[0]
    assert abs(math.dist(l2[:2], crow['creature'][:2]) - math.dist(loc[:2], crow['creature'][:2])) < 1e-9 and l2[2] == loc[2], '生き物のまわりを回る'
plan = [{'kind': 'front_walk', 'start': 0, 'end': 2}, {'kind': 'crow_close', 'start': 2, 'end': 3}, {'kind': 'crow_takeoff', 'start': 3, 'end': 5}]
assert [t for t, _ in Sh.lane_samples([(t / 2, (0, 0, 0)) for t in range(10)], plan)] == [0, 0.5, 1, 1.5], '道は lane を追うショットの間だけで決める'
assert len(Sh.lane_samples([(0.0, (0, 0, 0))], [{'kind': 'crow_close', 'start': 0, 'end': 1}])) == 1
two = {**crow, 'hips': (-0.5, 11, 0.9), 'head': (-0.5, 11, 1.4), 'other': {'hips': (0.5, 11, 0.9), 'head': (0.5, 11, 1.3)}}
loc, look, _, _ = Sh.KINDS['crow_takeoff'](0, two, {})
assert abs(loc[0]) < 1e-9 and loc[1] < 11 < look[1] and look[2] > loc[2], '2 人の前の低い所から見上げる'
# face_front: ステージ基準の角度を顔の向きへ移し、±45 度に収める。距離と高さは変えない
look = (0, 0, 1)
for gaze in (0, 90, 180, -135):
    for a in (-80, -30, 0, 30, 80):
        r = math.radians(a)
        loc = Sh.face_front((math.sin(r) * 3, -math.cos(r) * 3, 1.5), look, gaze, 0)
        got = math.degrees(math.atan2(loc[0], -loc[1]))
        want = gaze + max(-45, min(45, a))
        assert abs((got - want + 180) % 360 - 180) < 1e-6 and abs(math.hypot(loc[0], loc[1]) - 3) < 1e-9 and loc[2] == 1.5, (gaze, a, got)
# tighten: 向きは保ち、入れる高さに合う距離へ寄せる。寄りでも頭の上は画面に入る
pp = {'head': (0, 0, 1.4), 'hips': (0, 0, 0.9), 'chest': (0, 0, 1.2)}
for kind in ('orbit', 'close', 'low_feet'):
    loc0, look0, lens0, _ = Sh.KINDS[kind](0.5, {**pp, 'facing': 0}, {'a': 20, 'dir': 1})
    loc, look, lens = Sh.tighten(kind, 0.5, loc0, look0, lens0, pp)
    d0 = [a - b for a, b in zip(loc0, look0)]
    d1 = [a - b for a, b in zip(loc, look)]
    n0, n1 = math.hypot(*d0), math.hypot(*d1)
    assert all(abs(a / n0 - b / n1) < 1e-9 for a, b in zip(d0, d1)), kind
    cover = Sh.FRAME_HEIGHT * n1 / lens
    assert abs(cover - Sh.TIGHT[kind][0]) < 1e-9 and lens >= lens0
    assert Sh.face_z(pp) - 0.09 + Sh.HEAD_TOP - look[2] < cover / 2, '頭の上が入る'
print('ok')
