// 声の区間を音量から求める。入力は ffmpeg が書いた 16 bit PCM の wav(モノラルでなくてもよい)。
// 20 ms ごとの RMS が thresholdDb(dBFS)を超えた窓を「声がある」とみなし、その合計の秒数を返す。

export function parseWav(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw Error('wav ではない');
  let fmt = null, off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4); let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = {format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14)};
    if (id === 'data') {
      if (!fmt) throw Error('wav の fmt が data より後ろにある');
      size = Math.min(size, buf.length - body); // ストリーム書き出しでサイズが 0xFFFFFFFF のことがある
      if (fmt.format !== 1 || fmt.bits !== 16) throw Error(`16 bit PCM の wav だけ読める(format ${fmt.format}, ${fmt.bits} bit)`);
      return {...fmt, samples: new Int16Array(buf.buffer.slice(buf.byteOffset + body, buf.byteOffset + body + (size & ~1)))};
    }
    off = body + size + (size & 1);
  }
  throw Error('wav に data が無い');
}

export function voicedSeconds(wav, {thresholdDb = -45, windowSec = 0.02} = {}) {
  const {samples, channels, rate} = typeof wav.samples === 'undefined' ? parseWav(wav) : wav;
  const win = Math.max(1, Math.round(rate * windowSec)) * channels;
  const limit = 32768 * 10 ** (thresholdDb / 20);
  let windows = 0, voiced = 0;
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += samples[j] * samples[j];
    windows++;
    if (Math.sqrt(sum / win) > limit) voiced++;
  }
  return {voiced: voiced * windowSec, total: windows * windowSec};
}

// 音声や動画の長さ(秒)を ffprobe で読む。ctx はジョブの道具(ctx.run)
export async function mediaSeconds(ctx, file) {
  const out = await ctx.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {capture: true, timeoutMs: 30000});   // 壊れたファイルで止まらないように上限を付ける
  const d = Number(out.trim());
  if (!(d > 0)) throw new Error('長さを読めない: ' + file.split(/[\\/]/).pop());
  return d;
}
