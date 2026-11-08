# ショートの効果音を numpy で合成して assets/sfx/ に置く。外部の素材は使わず、乱数は種を固定するので毎回同じ音になる。
#   使い方: python tools/make_sfx.py [出力先フォルダ]
#   音は 48 kHz、16 bit、ステレオの wav。高い音は同じピークでも大きく聞こえるので、音ごとのピークを変えて聞こえ方をそろえる。混ぜるときの音量は呼ぶ側が決める
import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

RATE = 48000


def times(seconds):
    return np.arange(int(seconds * RATE)) / RATE


def lowpass(x, hz):
    return sosfilt(butter(4, hz, 'lowpass', fs=RATE, output='sos'), x)


def highpass(x, hz):
    return sosfilt(butter(4, hz, 'highpass', fs=RATE, output='sos'), x)


def sweep_bandpass(noise, centers, q):
    """中心周波数が時間で動く帯域通過。状態変数フィルタを 1 標本ずつ回す"""
    out, low, band = np.zeros_like(noise), 0.0, 0.0
    damp = 1.0 / q
    for i, (x, hz) in enumerate(zip(noise, centers)):
        f = 2.0 * np.sin(np.pi * min(hz, RATE / 6.5) / RATE)
        low += f * band
        high = x - low - damp * band
        band += f * high
        out[i] = band
    return out


def room(stereo, rng, seconds, wet, damping_hz=6000.0):
    """指数で減衰するノイズの残響。左右で別のノイズを使い、音に広がりを足す"""
    n = int(seconds * RATE)
    decay = np.exp(-6.9 * np.arange(n) / n)
    out = []
    for ch in range(2):
        ir = lowpass(rng.standard_normal(n), damping_hz) * decay
        ir /= np.sqrt(np.sum(ir ** 2))
        out.append(fftconvolve(stereo[ch], ir)[:len(stereo[ch]) + n])
    tail = np.stack(out)
    dry = np.zeros_like(tail)
    dry[:, :stereo.shape[1]] = stereo
    return dry + wet * tail


def pan(mono, position):
    """position: -1 が左、1 が右。等パワー。配列を渡すと時間で動く"""
    angle = (np.asarray(position) + 1) * np.pi / 4
    return np.stack([mono * np.cos(angle), mono * np.sin(angle)])


def attack(t, seconds):
    return np.clip(t / seconds, 0, 1)


def whoosh(rng):
    """空気を切る音。帯域通過のノイズの中心を上げて下げ、音を左から右へ動かす"""
    t = times(0.5)
    shape = np.exp(-((t - 0.2) / 0.085) ** 2)
    centers = 260 + 3000 * shape ** 1.4
    air = sweep_bandpass(rng.standard_normal(len(t)), centers, 1.6)
    body = sweep_bandpass(rng.standard_normal(len(t)), 110 + 420 * shape, 2.2)
    mono = (air * 0.8 + body * 0.9) * shape ** 1.15
    return room(pan(mono, np.tanh((t - 0.2) / 0.11) * 0.75), rng, 0.25, 0.12)


def pop(rng):
    """丸い短い音。高さが急に下がる正弦波に、頭の小さなノイズを足す"""
    t = times(0.16)
    pitch = 430 + 900 * np.exp(-t / 0.016)
    phase = 2 * np.pi * np.cumsum(pitch) / RATE
    tone = np.sin(phase) * np.exp(-t / 0.045) + 0.28 * np.sin(2 * phase) * np.exp(-t / 0.02)
    click = highpass(rng.standard_normal(len(t)), 2500) * np.exp(-t / 0.0025) * 0.22
    mono = (tone * attack(t, 0.0012) + click)
    return room(pan(mono, 0.0), rng, 0.12, 0.1)


def bell(t, hz, decay, level=1.0):
    """鐘の部分音(整数倍から外れた比)。高い音ほど早く消える"""
    partials = [(1.0, 1.0), (2.0, 0.55), (2.76, 0.42), (4.07, 0.2), (5.4, 0.14), (8.93, 0.05)]
    out = sum(a * np.sin(2 * np.pi * hz * r * t) * np.exp(-t * r ** 0.7 / decay) for r, a in partials)
    return level * out * attack(t, 0.0015)


def ding(rng):
    """明るい 2 音の鐘。あとの音を 4 度上に重ねる"""
    t = times(1.0)
    first = bell(t, 1318.5, 0.34)
    second = np.zeros_like(t)
    delay = int(0.075 * RATE)
    second[delay:] = bell(t[:-delay], 1760.0, 0.42, 0.85)
    return room(np.stack([first * 0.9 + second * 0.6, first * 0.6 + second * 0.9]), rng, 0.6, 0.2)


def impact(rng):
    """打撃音。スマートフォンの小さなスピーカーは 150 Hz より下を鳴らせないので、低音の上に 200 Hz から 1 kHz の胴の音を重ねて歪ませる"""
    t = times(0.85)
    pitch = 62 + 150 * np.exp(-t / 0.04)
    phase = 2 * np.pi * np.cumsum(pitch) / RATE
    sub = np.sin(phase) * np.exp(-t / 0.22)
    body = (np.sin(3 * phase) * 0.5 + np.sin(5.1 * phase) * 0.3) * np.exp(-t / 0.09)
    thump = highpass(lowpass(rng.standard_normal(len(t)), 1400), 180) * np.exp(-t / 0.05) * 1.1
    crack = highpass(rng.standard_normal(len(t)), 2500) * np.exp(-t / 0.007) * 0.35
    mono = np.tanh(1.8 * (sub + body + thump)) + crack
    return room(pan(mono * attack(t, 0.001), 0.0), rng, 0.5, 0.14, 3000.0)


def sparkle(rng):
    """細かい鐘の粒を上へ散らす。音階は五音音階の高い所"""
    t = times(1.1)
    scale = np.array([0, 2, 4, 7, 9]) / 12.0
    out = np.zeros((2, len(t)))
    for i in range(16):
        at = 0.03 * i + rng.uniform(0, 0.012)
        hz = 1318.5 * 2 ** (i // 6 + scale[rng.integers(5)]) * (1 + 0.002 * rng.standard_normal())
        start = int(at * RATE)
        grain = bell(t[:len(t) - start], hz, 0.075 + 0.006 * i, 0.5 + 0.5 * np.sin(np.pi * i / 16))
        out[:, start:] += pan(grain, rng.uniform(-0.7, 0.7))
    return np.stack([lowpass(c, 9500) for c in room(out, rng, 0.5, 0.3, 8000.0)])


def glitch(rng):
    """デジタルの乱れ。短い区間ごとに、高域のノイズ、矩形波、無音のどれかを置き、粗く量子化する"""
    t = times(0.45)
    out = np.zeros_like(t)
    pos = 0
    while pos < len(t):
        length = int(rng.uniform(0.012, 0.05) * RATE)
        stop = min(pos + length, len(t))
        n = stop - pos
        kind = rng.integers(3)
        if kind == 0:
            out[pos:stop] = highpass(rng.standard_normal(n + 64), 1800)[64:] * 0.8
        elif kind == 1:
            hz = rng.choice([220, 440, 660, 1320, 2640])
            out[pos:stop] = np.sign(np.sin(2 * np.pi * hz * np.arange(n) / RATE)) * 0.5
        pos += length
    out = np.round(out * 6) / 6
    out = out * np.exp(-t / 0.22) * attack(t, 0.001)
    return room(pan(out, rng.uniform(-0.3, 0.3)), rng, 0.1, 0.08)


def finish(stereo, peak_db):
    """端を切って、音の頭と終わりが跳ねないようにし、ピークをそろえる"""
    stereo = stereo - stereo.mean(axis=1, keepdims=True)
    fade = np.minimum(1.0, (stereo.shape[1] - np.arange(stereo.shape[1])) / (0.03 * RATE))
    stereo = stereo * fade
    stereo = stereo * 10 ** (peak_db / 20) / np.max(np.abs(stereo))
    return np.round(stereo.T * 32767).astype(np.int16)


# 名前: (作る関数, 種, ピークの dBFS)
SOUNDS = {'whoosh': (whoosh, 11, -3.0), 'pop': (pop, 12, -3.0), 'ding': (ding, 13, -6.0), 'impact': (impact, 14, -3.0), 'sparkle': (sparkle, 15, -9.0), 'glitch': (glitch, 16, -6.0)}


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'assets' / 'sfx'
    out.mkdir(parents=True, exist_ok=True)
    for name, (make, seed, peak_db) in SOUNDS.items():
        wavfile.write(out / f'{name}.wav', RATE, finish(make(np.random.default_rng(seed)), peak_db))
        print(name)


if __name__ == '__main__':
    main()
