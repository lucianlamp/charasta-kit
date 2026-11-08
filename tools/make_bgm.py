# ショートの既定の BGM を numpy で合成して assets/bgm/ に置く。外部の素材は使わず、種を固定するので毎回同じ音になる。
#   使い方: python tools/make_bgm.py [出力先フォルダ]
#   trivia: 明るい木琴と低音と軽い打楽器の 8 小節。drama: 間の多い静かなピアノと薄いパッド、響きの 8 小節。どちらも頭と終わりがつながるループ
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

RATE = 48000


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def note(out, at, wave):
    """ループの長さで折り返して重ねる"""
    start = int(at * RATE) % out.shape[1]
    idx = (start + np.arange(wave.shape[1])) % out.shape[1]
    np.add.at(out, (0, idx), wave[0])
    np.add.at(out, (1, idx), wave[1])


def pan(mono, p):
    a = (p + 1) * np.pi / 4
    return np.stack([mono * np.cos(a), mono * np.sin(a)])


def marimba(hz, seconds=0.5):
    t = np.arange(int(seconds * RATE)) / RATE
    body = np.sin(2 * np.pi * hz * t) * np.exp(-t / 0.16) + 0.5 * np.sin(2 * np.pi * hz * 4 * t) * np.exp(-t / 0.03) + 0.14 * np.sin(2 * np.pi * hz * 10 * t) * np.exp(-t / 0.008)
    return body * np.minimum(1, t / 0.002)


def bass(hz, seconds):
    t = np.arange(int(seconds * RATE)) / RATE
    return (np.sin(2 * np.pi * hz * t) + 0.35 * np.sin(4 * np.pi * hz * t)) * np.exp(-t / (seconds * 0.7)) * np.minimum(1, t / 0.006)


def tick(rng, seconds=0.05):
    n = int(seconds * RATE)
    return sosfilt(butter(2, 6000, 'highpass', fs=RATE, output='sos'), rng.standard_normal(n)) * np.exp(-np.arange(n) / RATE / 0.012)


def kick(seconds=0.22):
    t = np.arange(int(seconds * RATE)) / RATE
    return np.sin(2 * np.pi * np.cumsum(58 + 90 * np.exp(-t / 0.03)) / RATE) * np.exp(-t / 0.08)


def trivia(rng):
    beat = 60 / 118
    bars = 8
    length = bars * 4 * beat
    out = np.zeros((2, int(length * RATE)))
    chords = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]]
    pattern = [0, 1, 2, 1, 2, 1, 0, 2]
    for bar in range(bars):
        chord = chords[bar % 4]
        t0 = bar * 4 * beat
        note(out, t0, pan(bass(midi(chord[0] - 24), beat * 2), 0) * 0.55)
        note(out, t0 + beat * 2, pan(bass(midi(chord[0] - 24), beat * 1.5), 0) * 0.45)
        for step in range(8):
            at = t0 + step * beat / 2
            tone = chord[pattern[step]] + 12 + (12 if (bar % 4 == 3 and step > 4) else 0)
            note(out, at, pan(marimba(midi(tone)), 0.3 if step % 2 else -0.3) * (0.34 if step % 2 else 0.42))
            note(out, at, pan(tick(rng), 0.2) * (0.05 if step % 2 else 0.08))
        for b in (0, 2):
            note(out, t0 + b * beat, pan(kick(), 0) * 0.3)
    return out


def pad(hz, seconds, rng):
    t = np.arange(int(seconds * RATE)) / RATE
    env = np.sin(np.pi * t / seconds) ** 1.5
    wave = sum(np.sin(2 * np.pi * hz * (1 + d) * t + rng.uniform(0, 6)) for d in (-0.002, 0, 0.0025)) / 3 + 0.3 * np.sin(4 * np.pi * hz * t)
    return wave * env


def piano(hz, seconds=2.6):
    t = np.arange(int(seconds * RATE)) / RATE
    tone = sum(a * np.sin(2 * np.pi * hz * r * t) * np.exp(-t * r / 1.6) for r, a in ((1, 1), (2, 0.4), (3, 0.16), (4, 0.06)))
    return tone * np.minimum(1, t / 0.004)


def echoes(stereo):
    """ループの長さで折り返す減衰の響き。部屋の残響の代わりに、左右で違う間隔の反射を重ねる"""
    out = stereo.copy()
    for k, (sec, gain) in enumerate(((0.31, 0.32), (0.47, 0.26), (0.73, 0.2), (1.13, 0.14), (1.61, 0.09))):
        shift = int(sec * RATE)
        out[k % 2] += np.roll(stereo[k % 2], shift) * gain
        out[1 - k % 2] += np.roll(stereo[k % 2], shift + 311) * gain * 0.6
    return out


def drama(rng):
    # イ短調の静かな 8 小節。語りの帯域(1 から 4 kHz)を空けるため、ピアノは中低音で短く鳴らし、高い倍音を落とす
    beat = 60 / 58
    bars = 8
    length = bars * 4 * beat
    out = np.zeros((2, int(length * RATE)))
    chords = [[45, 57, 60, 64], [41, 53, 57, 60], [48, 55, 60, 64], [43, 55, 59, 62], [45, 57, 60, 64], [41, 53, 57, 60], [40, 52, 55, 59], [40, 52, 56, 59]]
    # (小節の中の拍、音、強さ)。音を置かない小節を残して、間を作る
    melody = {0: [(1, 72, 0.3), (2.5, 69, 0.2)], 1: [(1, 69, 0.26)], 2: [(0.5, 67, 0.24), (2, 72, 0.26)], 3: [(1.5, 71, 0.2)], 4: [(1, 76, 0.26), (2.5, 72, 0.2)], 5: [(1, 69, 0.24)], 6: [(0.5, 67, 0.2), (2, 71, 0.22)], 7: [(1.5, 68, 0.2)]}
    for bar in range(bars):
        t0 = bar * 4 * beat
        note(out, t0, pan(pad(midi(chords[bar][0]), beat * 4.5, rng), 0) * 0.2)
        for k, n in enumerate(chords[bar][1:]):
            note(out, t0, pan(pad(midi(n), beat * 5.5, rng), (k - 1) * 0.5) * 0.14)
        for at, tone, gain in melody[bar]:
            note(out, t0 + at * beat, pan(piano(midi(tone - 12)), -0.15 if tone % 2 else 0.15) * gain)
    return echoes(sosfilt(butter(2, 1800, 'lowpass', fs=RATE, output='sos'), out, axis=1))


def write(stereo, file):
    stereo = sosfilt(butter(2, 40, 'highpass', fs=RATE, output='sos'), stereo, axis=1)
    stereo = stereo * 10 ** (-6 / 20) / np.max(np.abs(stereo))
    with tempfile.TemporaryDirectory() as d:
        wav = Path(d) / 'x.wav'
        wavfile.write(wav, RATE, np.round(stereo.T * 32767).astype(np.int16))
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(wav), '-c:a', 'aac', '-b:a', '192k', str(file)], check=True)


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'assets' / 'bgm'
    out.mkdir(parents=True, exist_ok=True)
    write(trivia(np.random.default_rng(21)), out / 'trivia.m4a')
    write(drama(np.random.default_rng(22)), out / 'drama.m4a')


if __name__ == '__main__':
    main()
