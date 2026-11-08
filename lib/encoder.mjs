// H.264 の書き出し。ffmpeg が持つ GPU のエンコーダー(NVENC。macOS は VideoToolbox)があればまずそれで書き、失敗したら libx264(CPU)で書き直す。
//   CHARASTA_ENCODER=cpu   最初から libx264 で書く(GPU のある機械で CPU 側の動きを確かめるとき)
//   CHARASTA_HW_ENCODER    使う GPU のエンコーダーを決め打ちする(h264_nvenc / h264_videotoolbox。none なら使わない)。省くと ffmpeg -encoders で調べる
// 書き直さないとき: ジョブの停止とタイムアウト(runH264 に渡る例外の stopped が真)。止めたものを CPU でやり直さないため。
// 画質の測定(RTX 4070、ffmpeg 8.1、h264_nvenc -preset p5 -tune hq -rc vbr、cq = libx264 の crf + CQ_OFFSET)。VMAF は libx264 -crf 18 / NVENC の順:
//   実写の切り出し(illit 36 秒)  98.43 → 98.37(cq 23 は元動画に対して。サイズ 27.2MB → 36.7MB。cq 26 だと 98.32、27.1MB)
//   実写の切り出し(trenza 8 秒)  99.16 → 99.09(8.9MB → 8.7MB。cq 26 だと 97.52 に落ちる)
//   実写の JPEG コマ(撮影の経路)  98.09 → 98.64(9.0MB → 11.2MB。cq 26 だと 98.00、8.0MB)
//   3D の撮影コマ(JPEG)          96.88 → 98.06(5.5MB → 8.8MB)
//   crf 20 / cq 25 の実写の切り出し  illit 97.91 / 98.51、trenza 97.93 / 98.12
// cq = crf + 8 では、内容によって VMAF の差が -0.1 から -1.6 まで動き、実写の trenza で落ちた。+ 5 にして、測った範囲ではどれも -0.1 以内にした(サイズは最大 +60%)。
// 測った映像はすべて 30fps。測っていない範囲: crf 18 と 20 以外、1080 より小さい映像、60fps の撮影と実写。
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {isMac} from './platform.mjs';

export const CQ_OFFSET = 5;

// h264_videotoolbox(macOS)は測っていない。-q:v は 1 から 100 で大きいほど高画質。crf 18 に当たりそうな 65 を基準に、crf が 1 上がるごとに 2 下げる(crf 20 なら 61)。
// 動かない機械(古い ffmpeg など)では runH264 が libx264 で書き直す。-allow_sw 1 は、ハードウェアが使えないときのソフトウェア側の書き出しを許す。
export const vtQuality = crf => Math.max(1, Math.min(100, 65 - 2 * (crf - 18)));

// ffmpeg の -c:v 以降の引数。crf は libx264 の値で、NVENC では cq = crf + CQ_OFFSET。キーフレームは libx264 の既定と同じ 250 コマごと
export function h264Args(encoder, crf) {
  if (encoder === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(crf + CQ_OFFSET), '-b:v', '0', '-g', '250', '-profile:v', 'high'];
  if (encoder === 'h264_videotoolbox') return ['-c:v', 'h264_videotoolbox', '-q:v', String(vtQuality(crf)), '-allow_sw', '1', '-g', '250', '-profile:v', 'high'];
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-profile:v', 'high'];
}

// ffmpeg -encoders を ffmpeg ごとに一度だけ読んで、使える GPU のエンコーダーを決める。無ければ null(= libx264 だけ)。
// 載っているだけで動くとは限らないので、実際に動くかは runH264 の書き直しで受ける。
const probed = new Map();
export function hwEncoder(env = process.env) {
  const forced = env.CHARASTA_HW_ENCODER;
  if (forced) return Promise.resolve(forced === 'none' ? null : forced);
  const bin = env.CHARASTA_FFMPEG || 'ffmpeg';
  if (!probed.has(bin)) {
    probed.set(bin, new Promise(resolve => {
      let out = '';
      const child = spawn(bin, ['-hide_banner', '-encoders'], {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true});
      const timer = setTimeout(() => child.kill(), 15000);
      child.stdout.on('data', d => { out += d; });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', () => { clearTimeout(timer); resolve(/\bh264_nvenc\b/.test(out) ? 'h264_nvenc' : isMac && /\bh264_videotoolbox\b/.test(out) ? 'h264_videotoolbox' : null); });
    }));
  }
  return probed.get(bin);
}

// ffmpeg を NVENC で走らせ、失敗したら libx264 で書き直す。書きかけの out は失敗のたびに消す。
//   argsFor(encoder) が ffmpeg の引数を返す。opts は ctx.run へ渡す({timeoutMs} など。timeoutMs は関数でもよく、走らせるたびに呼ぶ)。
//   戻り値は使ったエンコーダー。例外に stopped が付いている(止めた・時間切れ)ときは書き直さずそのまま投げる。
export async function runH264(ctx, argsFor, {out, ...opts}, env = process.env) {
  const run = encoder => ctx.run('ffmpeg', argsFor(encoder), {...opts, timeoutMs: typeof opts.timeoutMs === 'function' ? opts.timeoutMs() : opts.timeoutMs});
  const clean = () => fs.rm(out, {force: true});
  const hw = String(env.CHARASTA_ENCODER ?? '').toLowerCase() === 'cpu' ? null : await hwEncoder(env);
  if (hw) {
    let hwError;
    try { await run(hw); return hw; } catch (e) {
      await clean();
      if (e.stopped) throw e;
      hwError = e;
    }
    ctx.log(`!! ${hw === 'h264_nvenc' ? 'NVENC' : hw} で書けなかったので libx264 で書き直す: ${hwError.message}\n`);
  }
  try { await run('libx264'); return 'libx264'; } catch (e) { await clean(); throw e; }
}
