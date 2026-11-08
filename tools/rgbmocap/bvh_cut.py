"""BVH の頭の数コマが別のカットのとき、次の落ち着いた姿勢で置き換える。

ExMR の BVH は、動画の頭に前のカットの残りがあると、最初の遷移で 100 度跳ぶ。

  python bvh_cut.py in.bvh out.bvh [--report r.json]

判定: 先頭 WINDOW 回の遷移のうち、全関節の回転の最大角が JUMP_DEG 度を超え、かつ動き全体の中央値の JUMP_RATIO 倍を超えるもの（複数なら最後）を切れ目とする。
切れ目の次のコマから、まだ大きな遷移（跳びの 15% 超かつ中央値の 2 倍超）が続く間は最大 MAX_SETTLE コマ進め、そのコマの行（腰の位置と全関節）を先頭まで写す。
"""
import argparse
import json
from pathlib import Path

import numpy as np

WINDOW = 8
JUMP_DEG = 60.0
JUMP_RATIO = 6.0
MAX_SETTLE = 3


def parse_bvh(text):
    """(階層の文字列, [(関節, [チャンネル名])], 'Frames' と 'Frame Time' の 2 行, データ (T, 列数))。"""
    head, _, motion = text.partition("MOTION")
    channels, name = [], None
    for line in head.splitlines():
        s = line.split()
        if s and s[0] in ("ROOT", "JOINT"):
            name = s[1]
        elif s and s[0] == "CHANNELS":
            channels.append((name, s[2:]))
    rows = [ln for ln in motion.strip().splitlines() if ln.strip()]
    data = np.array([[float(x) for x in ln.split()] for ln in rows[2:]])
    return head, channels, rows[:2], data


def step_angles(channels, data):
    """隣り合うコマの間で、全関節の回転が動いた最大の角（度）。長さ T-1。"""
    from scipy.spatial.transform import Rotation as R
    steps = np.zeros(len(data) - 1)
    col = 0
    for _, ch in channels:
        rc = [(k, c) for k, c in enumerate(ch) if "rotation" in c]
        if len(rc) == 3:
            r = R.from_euler("".join(c[0] for _, c in rc), data[:, [col + k for k, _ in rc]], degrees=True)
            steps = np.maximum(steps, np.degrees((r[:-1].inv() * r[1:]).magnitude()))
        col += len(ch)
    return steps


def find_cut(steps, window=WINDOW, jump_deg=JUMP_DEG, jump_ratio=JUMP_RATIO, max_settle=MAX_SETTLE):
    """先頭が別のカットなら、置き換えの元にするコマの番号（それより前を捨てる）。無ければ 0。"""
    steps = np.asarray(steps, float)
    if len(steps) < window + 2:
        return 0
    med = float(np.median(steps))
    big = [i for i in range(window) if steps[i] > jump_deg and steps[i] > jump_ratio * med]
    if not big:
        return 0
    j = big[-1]
    k = j + 1
    while k < min(j + 1 + max_settle, len(steps)) and steps[k] > 0.15 * steps[j] and steps[k] > 2 * med:
        k += 1
    return k


def fix_text(text):
    """(新しい BVH の文字列, 報告)。切れ目が無ければ元のまま。"""
    head, channels, mhead, data = parse_bvh(text)
    steps = step_angles(channels, data)
    k = find_cut(steps)
    rep = {"cut_frame": k, "jump_deg": round(float(steps[:k].max()), 1) if k else 0.0}
    if not k:
        return text, rep
    data[:k] = data[k]
    body = "\n".join(" ".join(f"{v:.9f}" for v in row) for row in data)
    return head + "MOTION\n" + "\n".join(mhead) + "\n" + body + "\n", rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bvh")
    ap.add_argument("out")
    ap.add_argument("--report")
    a = ap.parse_args()
    text, rep = fix_text(Path(a.bvh).read_text(encoding="utf-8"))
    Path(a.out).write_text(text, encoding="utf-8")
    print(json.dumps(rep))
    if a.report:
        Path(a.report).write_text(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
