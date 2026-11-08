"""音楽の拍を求める: python tools/beats.py song.m4a beats.json [--start 秒] [--seconds 秒]
音量の立ち上がりの自己相関でテンポのあたりを付け、立ち上がりに一番合う周期と位置へ拍の列を合わせる。答えは拍の時刻(秒)の配列で、--start の位置を 0 とする。"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib import portable as Pt  # noqa: E402

a = argparse.ArgumentParser()
a.add_argument('audio')
a.add_argument('out')
a.add_argument('--start', type=float, default=0)
a.add_argument('--seconds', type=float, default=120)
x = a.parse_args()
SR, HOP = 22050, 512
raw = subprocess.run([Pt.find_ffmpeg(), '-v', 'error', '-ss', str(x.start), '-t', str(x.seconds), '-i', x.audio, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], check=True, capture_output=True).stdout
y = np.frombuffer(raw, np.float32)
n = len(y) // HOP
energy = np.array([np.sqrt(np.mean(y[i * HOP:(i + 1) * HOP] ** 2) + 1e-9) for i in range(n)])
onset = np.maximum(np.diff(np.log(energy + 1e-4), prepend=0), 0)
onset -= onset.mean()
rate = SR / HOP
lags = np.arange(int(rate * 60 / 180), int(rate * 60 / 70))
ac = np.array([np.dot(onset[:-k], onset[k:]) for k in lags])
ac *= np.exp(-0.5 * (np.log2(60 * rate / lags / 120)) ** 2)  # 120 前後を好む
lag = lags[int(ac.argmax())]
# 自己相関の周期はコマの整数倍で粗いので、周期と位置を細かく振って、立ち上がりの合計が一番大きい組を選ぶ
times = np.arange(n) / rate


def comb(period, phase):
    k = np.round((phase + np.arange(int((times[-1] - phase) / period) + 1) * period) * rate).astype(int)
    k = k[k < n]
    return onset[k].sum() + 0.5 * onset[np.minimum(k + 1, n - 1)].sum() + 0.5 * onset[np.maximum(k - 1, 0)].sum()


base = lag / rate
period, offset = max(((p, o) for p in np.linspace(base * 0.97, base * 1.03, 121) for o in np.arange(0, p, 1 / rate)), key=lambda c: comb(*c))
bpm = 60 / period
beats = [round(float(offset + i * period), 4) for i in range(int((n / rate - offset) / period) + 1)]
json.dump(beats, open(x.out, 'w'))
print('bpm', round(bpm, 1), 'offset', round(offset, 3), 'beats', len(beats))
