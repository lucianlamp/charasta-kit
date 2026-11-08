"""MV のカメラワーク。拍に合わせて切り替え、キャラの腰と頭を追う。bpy に依存しない計算だけを置く。

座標は Blender(+Z が上)。キャラの正面は -Y を向く(glTF の +Z 正面を読み込むとこうなる)。カメラの角度 a は、キャラの正面から見て右回りの度数で、0 が真正面。
1 つのショット: {kind, start, end}。kind ごとに shot_* が (カメラの位置, 見る点, 焦点距離, f 値) を返す。
"""
import math
import random


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def around(c, angle_deg, r, h):
    a = math.radians(angle_deg)
    return (c[0] + math.sin(a) * r, c[1] - math.cos(a) * r, h)


def lerp3(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


DRIFT_HZ = 0.12  # 引きのカメラのごくゆっくりした漂い。速い揺れは手ブレに見えるので入れない


def noise(t, seed, hz=DRIFT_HZ):
    # 周期の長い正弦の滑らかな値(-1..1)
    a = random.Random(seed).uniform(0, 6.28)
    return math.sin(t * hz * 6.28 + a)


# 各ショット: u は 0..1 の進み、p は {hips, head, chest, feet}、r は乱数の値(ショットごとに固定)。身長 1.6m を基準にした寸法
def shot_wide_push(u, p, r):
    a = r['a']
    return around(p['hips'], a, 5.2 - 1.6 * ease(u), 0.55), (p['hips'][0], p['hips'][1], 0.95), 30, 2.8


def shot_orbit(u, p, r):
    a = r['a'] + r['dir'] * 40 * u
    return around(p['hips'], a, 3.3, 0.8 + 0.25 * math.sin(u * 3.14)), (p['chest'][0], p['chest'][1], p['chest'][2] - 0.1), 35, 2.2


def shot_crane_up(u, p, r):
    a = r['a'] + r['dir'] * 18 * u
    return around(p['hips'], a, 4.0, 0.25 + 2.6 * ease(u)), (p['hips'][0], p['hips'][1], 0.9), 28, 2.8


def shot_crane_down(u, p, r):
    a = r['a'] - r['dir'] * 18 * u
    return around(p['hips'], a, 3.6, 3.2 - 2.7 * ease(u)), (p['hips'][0], p['hips'][1], 0.85), 28, 2.8


def shot_close(u, p, r):
    a = p['facing'] + r['a'] * 0.35 + r['dir'] * 10 * u  # 寄りは顔の向きを追う
    return around(p['head'], a, 1.7 - 0.25 * u, p['head'][2] - 0.08), p['head'], 70, 1.8


def shot_low_feet(u, p, r):
    a = r['a'] + r['dir'] * 25 * u
    return around(p['hips'], a, 2.4, 0.14), (p['hips'][0], p['hips'][1], 0.75 + 0.35 * u), 22, 2.5


def shot_side_track(u, p, r):
    a = r['a'] + 90 * r['dir']
    c = (p['hips'][0] + (u - 0.5) * 0.9 * r['dir'], p['hips'][1], 0)
    return around(c, a, 3.0, 0.9), p['chest'], 40, 2.0


def shot_high_top(u, p, r):
    a = r['a'] + r['dir'] * 30 * u
    return around(p['hips'], a, 2.4, 4.3 - 0.4 * u), (p['hips'][0], p['hips'][1], 0.3), 26, 4.0


# 話す動画のカメラ。拍によらず、ゆっくり寄るだけ。顔の向きを追う
def shot_talk_wide(u, p, r):
    return around(p['hips'], p['facing'] * 0.5 + r['a'], 3.4 - 0.35 * ease(u), 1.05), (p['chest'][0], p['chest'][1], p['chest'][2] - 0.25), 42, 2.8


# 頭の骨は首の付け根にあるので、カメラは顔の高さまで上げる。下から撮ると見上げた顔になる
def shot_talk_bust(u, p, r):
    return around(p['head'], p['facing'] * 0.7 + r['a'], 2.1 - 0.15 * ease(u), p['head'][2] + 0.04), (p['head'][0], p['head'][1], p['head'][2] - 0.12), 70, 2.2


def shot_talk_close(u, p, r):
    return around(p['head'], p['facing'] * 0.8 + r['a'], 1.9 - 0.12 * ease(u), p['head'][2] + 0.06), (p['head'][0], p['head'][1], p['head'][2] + 0.03), 100, 2.2


# 対話のカメラ。2 人の間の線(想定線)の手前側だけから撮るので、話す人の左右は切り返しても入れ替わらない。カメラの向きは立ち位置から決める
# p は話す人の道筋に side(画面の左 -1、右 +1)、inward(内向きの度)、front(手前を指す水平の単位ベクトル)、other(相手の道筋。居なければ None)、facing0(場面の向き)を足したもの
FRAME_HEIGHT = 36.0  # 縦長の画面の縦の大きさ(mm)。カメラの sensor_fit AUTO の長い辺
FACE_ABOVE_HEAD = 0.09  # 頭の骨は首の付け根にある。そこから顔の中心までの高さ
TILT = 0.6  # 片方の寄りで、体の内向きの何割まで正面へ回り込むか


def face_z(p):
    return p['head'][2] + FACE_ABOVE_HEAD


def third_z(p, dist, lens):
    """顔を画面の上 3 分の 1 に置く見る点の高さ。下の 3 分の 1 が字幕になる"""
    return face_z(p) - FRAME_HEIGHT * dist / lens / 6


def to_other(p):
    """話す人から相手へ向かう水平の単位ベクトル。相手が居なければ立ち位置の内側"""
    if p.get('other'):
        dx, dy = p['other']['head'][0] - p['head'][0], p['other']['head'][1] - p['head'][1]
        n = max(math.hypot(dx, dy), 1e-3)
        return dx / n, dy / n
    fx, fy = p['front']
    return (fy, -fx) if p['side'] > 0 else (-fy, fx)


def camera_side(p):
    """想定線に直角で、手前を指す単位ベクトル"""
    ux, uy = to_other(p)
    nx, ny = -uy, ux
    return (nx, ny) if nx * p['front'][0] + ny * p['front'][1] >= 0 else (-nx, -ny)


def mid_point(p):
    o = p.get('other') or p
    return tuple((a + b) / 2 for a, b in zip(p['hips'], o['hips']))


def bust(u, p, r, dist, lens, fstop):
    a = p['facing0'] - p['side'] * p['inward'] * TILT + p.get('turn0', 0) * 0.8 + r['a']
    head = p['head']
    d = dist - 0.1 * ease(u)
    loc = around(head, a, d, face_z(p) + 0.02)
    ux, uy = to_other(p)
    room = d / lens  # 見ている方に空きを残す。画面の幅の約 5 %
    return loc, (head[0] + ux * room, head[1] + uy * room, third_z(p, d, lens)), lens, fstop


def shot_close_who(u, p, r):
    return bust(u, p, r, 1.55, 90, 2.2)


def shot_bust_who(u, p, r):
    return bust(u, p, r, 1.8, 62, 2.2)


def shot_face_who(u, p, r):
    """顔だけの大写し"""
    return bust(u, p, r, 1.2, 100, 2.0)


PAPER_W, PAPER_H = 0.148, 0.21  # 手紙の大きさ(m)
PAPER_FRONT = 0.055  # 指から紙までの距離(m)
LAST_LINE = (0.166, 0.84, 0.57)  # 最後の行の横の位置 u と、なぞり始めと終わりの高さ v(0 が紙の下)。tools/make_letter.py と合わせる


def shot_prop_close(u, p, r):
    """手紙の寄り。頭で素早く寄って、突きつけられたように見せる。手紙が無ければ胸から上"""
    if not p.get('prop'):
        return shot_bust_who(u, p, r)
    c, n, side = p['prop']['rest'], p['prop']['rest_normal'], p['prop']['rest_side']
    c = (c[0] + side[0] * 0.018, c[1] + side[1] * 0.018, c[2] - 0.02)  # 折った紙の見える部分の中心。少し下に手を入れる
    d, lens = 0.56 + 0.5 * (1 - ease(min(1, u * 5))), 60
    return (c[0] + n[0] * d, c[1] + n[1] * d, c[2] + 0.03), c, lens, 4.0


def shot_prop_line(u, p, r):
    """手紙の最後の行を上からなぞる。文の途中で切る。手紙が無ければ胸から上"""
    if not p.get('prop'):
        return shot_bust_who(u, p, r)
    c, n, side = p['prop']['rest'], p['prop']['rest_normal'], p['prop']['rest_side']
    d, lens = 0.17, 70
    across = (LAST_LINE[0] - 0.5) * PAPER_W
    z = c[2] + (LAST_LINE[1] + (LAST_LINE[2] - LAST_LINE[1]) * u - 0.5) * PAPER_H
    at = (c[0] + side[0] * across, c[1] + side[1] * across, z)
    return (at[0] + n[0] * d, at[1] + n[1] * d, at[2] + 0.01), at, lens, 5.6


def shot_over_shoulder(u, p, r):
    """手前の相手の肩と髪の向こうに話す人。相手が居なければ胸から上"""
    f = p.get('other')
    if not f:
        return shot_bust_who(u, p, r)
    ux, uy = to_other(p)
    nx, ny = camera_side(p)
    back, off, lens = 0.72 - 0.05 * ease(u), 0.42, 58
    fh, sh = f['head'], p['head']
    loc = (fh[0] + ux * back + nx * off, fh[1] + uy * back + ny * off, face_z(f))
    d = math.dist(loc, sh)
    return loc, (sh[0] - nx * 0.07, sh[1] - ny * 0.07, third_z(p, d, lens)), lens, 1.8


def shot_two_shot(u, p, r):
    """2 人の全身が入る引き。ゆっくり寄る"""
    c = mid_point(p)
    d, lens = 3.9 - 0.2 * ease(u), 35
    fx, fy = p['front']
    face = max(p, p.get('other') or p, key=face_z)
    return (c[0] + fx * d, c[1] + fy * d, 1.2), (c[0], c[1], third_z(face, d, lens)), lens, 3.2


def shot_pull_back(u, p, r):
    """話す人の寄りから、部屋の中の 2 人が小さく見えるまで下がる。終わりの引き"""
    e = ease(u)
    c = mid_point(p)
    fx, fy = p['front']
    d, lens = 2.0 + 3.4 * e, 62 - 30 * e
    near = around(p['head'], p['facing0'] - p['side'] * p['inward'] * TILT, d, face_z(p) + 0.02)
    far = (c[0] + fx * d, c[1] + fy * d, 1.5)
    at = lerp3(p['head'], c, e)
    return lerp3(near, far, e), (at[0], at[1], third_z(p, d, lens)), lens, 2.8 + 2 * e


# 歩きながら話す動画のカメラ。lane は 2 人の腰を直線に当てはめた地面の点で、歩く足の周期が入らない。高さも固定するので、背景は一定の速さで流れるだけ
WALK_LENS = 35
WALK_FSTOP = 4.0


def walk_shot(p, ahead, right, z):
    """lane から front の向きへ ahead、front を見て右へ right だけ離れた所から撮る。顔は画面の上 3 分の 1"""
    (cx, cy), face = p['lane']
    fx, fy = p['front']
    d = math.hypot(ahead, right)
    return (cx + fx * ahead - fy * right, cy + fy * ahead + fx * right, z), (cx, cy, face - FRAME_HEIGHT * d / WALK_LENS / 6), WALK_LENS, WALK_FSTOP


def shot_front_walk(u, p, r):
    """2 人の前を下がりながら撮る"""
    return walk_shot(p, 3.4, 0, 1.3)


def shot_side_walk(u, p, r):
    """芝から並走する。真横だと奥の人が隠れるので、少し前へ出る"""
    return walk_shot(p, 1.95, 2.9, 1.3)


def shot_back_walk(u, p, r):
    """後ろから追う"""
    return walk_shot(p, -3.4, 0, 1.5)


def shot_diag_walk(u, p, r):
    """右の斜め前から 2 人を撮る。2 人の顔が見え、前からの絵と角度が変わる"""
    return walk_shot(p, 3.0, 1.75, 1.3)


WALK_CLOSE = (1.9, 50)  # 話す人の寄りの距離(m)と焦点距離


def shot_walk_close(u, p, r):
    """話す人の胸から上を前から撮る。前後は lane に従い、横だけ話す人の頭(ならした道筋)に合わせるので、歩く足の周期が入らない"""
    (cx, cy), _ = p['lane']
    fx, fy = p['front']
    nx, ny = -fy, fx
    side = (p['head'][0] - cx) * nx + (p['head'][1] - cy) * ny
    bx, by = cx + nx * side, cy + ny * side
    d, lens = WALK_CLOSE
    z = face_z(p)
    return (bx + fx * d, by + fy * d, z + 0.03), (bx, by, third_z(p, d, lens)), lens, 2.8


def shot_crow_close(u, p, r):
    """枝の上の生き物の寄り。道の上から見上げる三脚の絵で、2 人の位置に従わない。a(度)は生き物のまわりに上から見て左回りに回す角度。生き物が居なければ前から"""
    if not p.get('creature'):
        return shot_front_walk(u, p, r)
    x, y, z = p['creature']
    d, lens = 3.1, 85
    ox, oy = (-2.7 if x > 0 else 2.7), 1.4
    a = math.radians(r.get('a', 0))
    ox, oy = ox * math.cos(a) - oy * math.sin(a), ox * math.sin(a) + oy * math.cos(a)
    return (x + ox, y + oy, z - 0.6), (x, y, z + 0.2 - FRAME_HEIGHT * d / lens / 6), lens, 2.0  # 生き物の高さで撮り、字幕の上に置く


TAKEOFF = (3.6, 0.55, 24, 0.5, 2.6)  # 2 人の前の距離(m)、カメラの高さ、焦点距離、見る点の顔の高さからの上げ(m)、見る点の奥行き(m)


def shot_crow_takeoff(u, p, r):
    """立ち止まった 2 人の前に据えた低い三脚から、2 人と頭の上の空を見上げる。飛び立った生き物が 2 人の上を横切る終わりのカット。
    2 人の腰のならした道筋の中点に据えるので、立ち止まっている間は動かない。生き物が居なければ前から"""
    if not p.get('creature'):
        return shot_front_walk(u, p, r)
    c = mid_point(p)
    fx, fy = p['front']
    ahead, z, lens, rise, deep = TAKEOFF
    return (c[0] + fx * ahead, c[1] + fy * ahead, z), (c[0] - fx * deep, c[1] - fy * deep, face_z(p) + rise), lens, 5.6


KINDS = {k[5:]: v for k, v in globals().items() if k.startswith('shot_')}
WALK_KINDS = {'front_walk', 'side_walk', 'back_walk', 'diag_walk', 'walk_close', 'crow_close', 'crow_takeoff'}
LANE_KINDS = {'front_walk', 'side_walk', 'back_walk', 'diag_walk', 'walk_close'}  # 2 人の歩く道(lane)を追うショット。lane はこの間の腰の道から決める
ABOVE_KINDS = {'crow_close'}  # ステージの bounds より高い所から撮る
FACE_KINDS = {'talk_wide', 'talk_bust', 'talk_close', 'close_who', 'bust_who', 'face_who', 'over_shoulder', 'two_shot', 'pull_back', 'prop_close', 'prop_line', 'front_walk', 'side_walk', 'back_walk', 'diag_walk', 'walk_close', 'crow_takeoff'}  # カメラに付けた光で肌を起こすショット
DRAMA_KINDS = FACE_KINDS - {'talk_wide', 'talk_bust', 'talk_close'}
DRAMA_FILL = 0.2  # 対話のカメラは人に近く、明るい服が白く飛ぶので光を弱める
DRAMA_EMISSION = 0.45  # 同じ理由で、キャラの自己発光も弱める
FACE_TARGET = 0.42  # 話す人の顔の領域の輝度(画面の値の中央値)。カットごとに試し撮りしてカメラの光を合わせる
SKIN_REF = 0.6  # 顔のテクスチャの明るさ(リニア)の基準。これより明るい肌は光を弱め、暗い肌は強めて、2 人の顔をそろえる


def skin_gain(level):
    """顔の明るさをそろえる倍率"""
    return max(0.55, min(1.9, SKIN_REF / max(level, 0.05)))
# 流れ: 引きで始め、寄りと動きを交互に。同じ種類を続けない
FLOW = ['wide_push', 'orbit', 'close', 'low_feet', 'crane_up', 'side_track', 'close', 'orbit', 'high_top', 'crane_down', 'low_feet', 'close']


def plan(beats, seconds, seed=0, beats_per_shot=8, first_beats=8):
    """拍の時刻から切り替えの予定を作る。beats_per_shot 拍ごとに切り替える。"""
    r = random.Random(seed)
    cuts = [0.0]
    i = first_beats
    while i < len(beats) and beats[i] < seconds - 0.6:
        cuts.append(beats[i])
        i += beats_per_shot
    cuts.append(seconds)
    out, angle = [], r.choice([-20, 20])
    for k, (a, b) in enumerate(zip(cuts[:-1], cuts[1:])):
        kind = FLOW[(k + seed) % len(FLOW)] if k else 'wide_push'
        angle = r.choice([-1, 1]) * 12 if k == 0 else max(-42, min(42, angle + r.choice([-50, -30, 30, 50])))  # ステージの見せ場は正面。大きく回るのは orbit だけ
        out.append({'kind': kind, 'start': a, 'end': b, 'a': angle, 'dir': r.choice([-1, 1]), 'seed': r.randint(0, 99999)})
    return out


def assign_stages(shots, stages, shots_per_scene=1):
    """ショットにシーンを順に割り当てる。shots_per_scene ショットごとに次のシーンへ移り、最後まで行ったら最初に戻る"""
    return [{**s, 'stage': stages[(k // shots_per_scene) % len(stages)]} for k, s in enumerate(shots)]


def camera_at(t, shots, track, smooth=None):
    """時刻 t のカメラ。track(t, 話す人) が {hips, head, chest}。引きのカメラだけごくゆっくり漂わせる。答えは (位置, 見る点, 焦点距離, f 値, ショットの番号)"""
    k = next((i for i, s in enumerate(shots) if s['start'] <= t < s['end']), len(shots) - 1)
    s = shots[k]
    u = (t - s['start']) / max(s['end'] - s['start'], 1e-3)
    loc, look, lens, fstop = KINDS[s['kind']](u, track(t, s.get('who')), s)
    # 寄りは少しの揺れでも大きく写るので揺らさない。話す動画は三脚で撮った絵にする
    amp = 0 if lens >= 45 or s['kind'] not in FLOW else 0.012
    loc = tuple(x + amp * noise(t, s['seed'] + j) for j, x in enumerate(loc))
    look = tuple(x + amp * 0.6 * noise(t, s['seed'] + 7 + j) for j, x in enumerate(look))
    return loc, look, lens, fstop, k


FACE_LIMIT = 45.0  # face_front: 顔の向きからカメラが離れてよい角度(度)
GAZE_WIDTH = 10  # face_front の顔の向きをならす前後のサンプル数(0.1 秒ごと)。ターンの間にカメラが振り回されない
GAZE_WIDTH_LOOK = 4  # --look の顔の向きのならし(前後 0.4 秒)。広いと速い首振りに遅れて斜めの絵になる
FACE_SCALE_LOOK = 0.25  # --look でショットの角度(±42 度ほど)を縮める割合
FACE_LIMIT_LOOK = 12.0  # --look の寄りでは、顔の正面からこの角度の中だけ。斜めの絵は ROLL の傾きで作る
HEAD_WIDTH_LOOK = 4  # --look anime の寄りで頭の道筋をならす前後のサンプル数。広いと、しゃがむ・起きる動きに見る点が遅れる


def face_front(loc, look, gaze_deg, facing0, limit=FACE_LIMIT, scale=1.0):
    """踊りのショットのカメラを、見る点の縦の軸のまわりに回して顔の側へ寄せる。
    ショットはステージの正面(facing0)を基準に角度を決めているので、その角度を顔の向き(gaze_deg、ならしたもの)の基準へ移し、±limit 度に収める。
    角度の差を顔の向きから取らないので、背中側で左右が入れ替わる飛びが出ない。距離と高さはそのまま"""
    dx, dy = loc[0] - look[0], loc[1] - look[1]
    r = math.hypot(dx, dy)
    if r < 1e-4:
        return loc
    a = math.degrees(math.atan2(dx, -dy))  # around の角度
    off = (a - facing0 + 180) % 360 - 180
    b = math.radians(gaze_deg + max(-limit, min(limit, off * scale)))  # scale はショットの角度を縮める割合。止め切らず、角度の違いを少し残す
    return (look[0] + math.sin(b) * r, look[1] - math.cos(b) * r, loc[2])


# tighten: --look anime の踊りのショットを寄りにする。画面の縦に入れる高さ(m)、最低の焦点距離(mm)。wide_push だけ頭の 4 割で全身から寄る
HEAD_TOP = 0.2  # 頭の骨から頭の上(帽子を含む)まで
TIGHT = {
    'wide_push': (1.35, 35), 'orbit': (1.3, 40), 'crane_up': (1.4, 35), 'crane_down': (1.4, 35),
    'high_top': (1.5, 35), 'low_feet': (1.45, 30), 'side_track': (0.8, 60), 'close': (0.68, 70),
}
WIDE_OPEN = (2.15, 0.4)  # wide_push の始めの全身の高さ(m)と、寄り切るまでの進み(0..1)


def tighten(kind, u, loc, look, lens, p):
    """ショットのカメラの向き(見る点からカメラへの向き)を保ったまま、寄りの大きさになる距離へ置き直す。
    見る点は顔が画面の上の方に来る高さ(顔の高さから入れる高さの 0.28 倍下。寄りは 0.2 倍)。焦点距離は TIGHT の下限まで長くする。答えは (位置, 見る点, 焦点距離)"""
    if kind not in TIGHT:
        return loc, look, lens
    cover, min_lens = TIGHT[kind]
    if kind == 'wide_push':
        cover = WIDE_OPEN[0] + (cover - WIDE_OPEN[0]) * ease(u / WIDE_OPEN[1])
    lens = max(lens, min_lens)
    d = _unit(_sub(loc, look))
    fz = face_z(p)
    at = (p['head'][0], p['head'][1], fz - 0.2 * cover) if cover < 1.0 else (p['hips'][0], p['hips'][1], fz - 0.28 * cover)  # 寄りは頭の上を切らないよう顔を少し下げる
    dist = cover * lens / FRAME_HEIGHT
    return (at[0] + d[0] * dist, at[1] + d[1] * dist, at[2] + d[2] * dist), at, lens


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _unit(a):
    n = math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) or 1e-9
    return (a[0] / n, a[1] / n, a[2] / n)


# --look の傾き(ロール、度)。カメラは正面に置いたまま、画面だけをゆっくり傾ける。全部のショットでは傾けない
ROLL = {
    'close': ('settle', 10.0),  # 傾いた所から水平へ戻る
    'orbit': ('sway', 8.0),  # 片側へ傾いて戻る(半周期)
    'side_track': ('lean', 12.0),  # 水平から傾いていく
    'low_feet': ('hold', 9.0),  # 傾いたまま。見上げる絵の勢い
}


def roll_at(kind, u, r):
    """ショットの進み u(0..1)での傾き(度)。向きは shots.json の dir。どれもゆっくり動き、揺れは入れない"""
    how, deg = ROLL.get(kind, (None, 0.0))
    d = deg * r.get('dir', 1)
    if how == 'settle':
        return d * (1 - ease(u / 0.6))
    if how == 'sway':
        return d * math.sin(math.pi * u)
    if how == 'lean':
        return d * ease(u)
    if how == 'hold':
        return d * ease(u / 0.3)
    return 0.0


def hold_max(values, keys, radius):
    """values[i] を、同じ keys(ショットの番号)の前後 radius 個の最大にしてから平均でならす。答えはどのコマでも元の値以上"""
    n = len(values)
    mx = [max(values[j] for j in range(max(0, i - radius), min(n, i + radius + 1)) if keys[j] == keys[i]) for i in range(n)]
    return [sum(mx[j] for j in range(max(0, i - radius), min(n, i + radius + 1)) if keys[j] == keys[i]) / sum(1 for j in range(max(0, i - radius), min(n, i + radius + 1)) if keys[j] == keys[i]) for i in range(n)]


STAND = 0.6  # 2 人のとき、mark から左右へ離す距離(m)
INWARD = 60.0  # 2 人のとき、互いの方へ回す角度(度)。肩越しで相手の方を向いて見え、手前からは両方の顔が見える深さ


def stand(mark, facing, count, spread=STAND, inward=INWARD):
    """人数ごとの立ち位置。[(位置, 向き(度), 左右)]。左右は mark の手前から見て左が -1、右が +1。1 人は mark のまま。spread と inward は 2 人が並んで歩くときに替える"""
    if count <= 1:
        return [(tuple(mark), facing, 0)]
    a = math.radians(facing)
    sides = [-1, 1] if count == 2 else [-1, 0, 1]
    out = []
    for side in sides:
        x, y = side * spread * (1 if count == 2 else 1.5), 0.35 if count == 3 and side == 0 else 0.0
        out.append(((mark[0] + x * math.cos(a) - y * math.sin(a), mark[1] + x * math.sin(a) + y * math.cos(a), mark[2]), facing - side * inward * (1 if count == 2 else 0.7), side))
    return out


def fit_lane(paths, heads):
    """腰の道筋 [[(t, (x, y, z))]] を時刻についての直線に当てはめる。答えは (x の切片, x の速さ, y の切片, y の速さ, 顔の高さ)"""
    pts = [(t, p) for path in paths for t, p in path]
    n = len(pts)
    mt = sum(t for t, _ in pts) / n
    var = max(sum((t - mt) ** 2 for t, _ in pts), 1e-6)
    line = []
    for j in (0, 1):
        m = sum(p[j] for _, p in pts) / n
        b = sum((t - mt) * (p[j] - m) for t, p in pts) / var
        line += [m - b * mt, b]
    zs = sorted(p[2] for path in heads for _, p in path)
    return (*line, zs[len(zs) // 2] + FACE_ABOVE_HEAD)


def lane_samples(path, plan):
    """道筋 [(t, 点)] のうち、lane を追うショットの間のもの。そのショットが無ければ全部。立ち止まる終わりのカットを道の当てはめに入れない"""
    spans = [(s['start'], s['end']) for s in plan if s['kind'] in LANE_KINDS]
    kept = [(t, x) for t, x in path if any(a <= t < b for a, b in spans)]
    return kept or path


def lane_at(lane, t):
    """時刻 t の当てはめた点 ((x, y), 顔の高さ)"""
    return (lane[0] + lane[1] * t, lane[2] + lane[3] * t), lane[4]


def clear_bodies(loc, bodies, radius=0.4):
    """カメラが人の体に入らないよう、水平に押し出す。bodies は [(x, y)]"""
    x, y = loc[0], loc[1]
    for bx, by in bodies:
        dx, dy = x - bx, y - by
        d = math.hypot(dx, dy)
        if d < radius:
            k = radius / max(d, 1e-3)
            x, y = bx + dx * k, by + dy * k
    return (x, y, loc[2])


def facing_angle(left, right):
    """左右の肩の位置から、around の角度(度)で体の向きを返す"""
    dx, dy = left[0] - right[0], left[1] - right[1]
    return math.degrees(math.atan2(dy, dx))


def smooth_path(samples, width):
    """[(t, (x, y, z))] を前後 width 個の平均でならす"""
    out = []
    for i, (t, _) in enumerate(samples):
        part = [p for _, p in samples[max(0, i - width):i + width + 1]]
        out.append((t, tuple(sum(c) / len(part) for c in zip(*part))))
    return out


def shot_index(t, shots):
    return next((i for i, s in enumerate(shots) if s['start'] <= t < s['end']), len(shots) - 1)


def smooth_in_shots(samples, width, shots):
    """smooth_path と同じ前後の平均だが、同じショットの中で、前後に同じ数ずつ取れる幅だけを使う。
    切り替えの瞬間はならす前の値になり、前のショットの姿勢も、片側だけの平均のずれ(先の動きへの先回り)も入らない"""
    ids = [shot_index(t, shots) for t, _ in samples]
    first, last = {}, {}
    for i, k in enumerate(ids):
        first.setdefault(k, i)
        last[k] = i
    out = []
    for i, (t, _) in enumerate(samples):
        w = min(width, i - first[ids[i]], last[ids[i]] - i)
        part = [p for _, p in samples[i - w:i + w + 1]]
        out.append((t, tuple(sum(c) / len(part) for c in zip(*part))))
    return out


def sample_path(path, t):
    if t <= path[0][0]:
        return path[0][1]
    for (a, pa), (b, pb) in zip(path[:-1], path[1:]):
        if a <= t <= b:
            return lerp3(pa, pb, (t - a) / max(b - a, 1e-6))
    return path[-1][1]


def beats_of(bpm, seconds, offset=0.0):
    step = 60.0 / bpm
    n = int((seconds - offset) / step) + 2
    return [offset + i * step for i in range(n)]
