// 撮るジョブ(shoot): 完成モデルにモーション・セリフ・音声を当てて動画を作る。docs/voice-and-jobs.md の「shoot ジョブ」。
//   長さを決める -> tools/shoot.mjs が GPU のブラウザで 1 コマずつ撮る -> ffmpeg でまとめる -> characters/<id>/shoots/<jobId>/ に記録する
import fs from 'node:fs/promises';
import path from 'node:path';
import {root} from './config.mjs';
import {LibraryError, EMOTIONS, checkId} from './library.mjs';
import {mediaSeconds} from './audio.mjs';
import {videoTerms} from './terms.mjs';
import {h264Args, runH264} from './encoder.mjs';
import {MAX_SECONDS, shootSeconds} from '../public/shoot-plan.mjs';

export const ASPECTS = {'9:16': [9, 16], '16:9': [16, 9], '1:1': [1, 1]};
export const QUALITIES = {'1080p30': {short: 1080, fps: 30}, '1080p60': {short: 1080, fps: 60}, '720p30': {short: 720, fps: 30}};
export const SHOT_FRAMINGS = ['full', 'upper', 'face'];
export const SHOT_EXPRESSIONS = ['motion', 'neutral', ...EMOTIONS];
export const MAX_LOOPS = 10, MAX_AUDIO_NOTE = 200;
const FADE_SEC = 0.5;        // 音声を動画の長さで切るとき、最後のこの秒数で音を小さくする
const SONG_UNDER_LINE = 0.5; // セリフと重ねるときの曲の音量
const PROBE_MS = 30000;      // ffprobe の上限(壊れたファイルや網の先のファイルで止まらないように)
const MAX_AUDIO_START = 36000;

export function shootSize(aspect, quality) {
  const [a, b] = ASPECTS[aspect], {short, fps} = QUALITIES[quality];
  const long = Math.round(short * Math.max(a, b) / Math.min(a, b));
  return {width: a < b ? short : long, height: a < b ? long : short, fps};
}

// 時間の上限(ミリ秒)。ジョブ全体の実測は 1 コマ 0.07 秒(RTX 4070、1080x1920)。その 4 倍ほどに、ブラウザの起動の分を足す
export const shootTimeoutMs = frames => 120000 + frames * 300;

function pick(v, list, what) {
  if (!list.includes(v)) throw new LibraryError('bad-input', `${what} は ${list.join(' / ')}: ${JSON.stringify(v)}`);
  return v;
}
function number(v, what, ok) {
  const n = Number(v);
  if (!Number.isFinite(n) || !ok(n)) throw new LibraryError('bad-input', `${what} が範囲の外: ${JSON.stringify(v)}`);
  return n;
}

// 音声の入力を確かめて out に書く。撮るジョブと MV ジョブが使う
export async function shootAudioInput(lib, out, body) {
  if (!body.audioId) return;
  const a = await lib.getAudio(body.audioId);
  out.audioId = a.id; out.audioName = a.name;
  if (body.audioSummary != null && typeof body.audioSummary !== 'string') throw new LibraryError('bad-input', 'audioSummary は文字列');
  out.audioSummary = (body.audioSummary ?? '').trim();
  if ([...out.audioSummary].length > MAX_AUDIO_NOTE) throw new LibraryError('bad-input', `audioSummary は ${MAX_AUDIO_NOTE} 文字まで`);
  if (body.audioPublic != null && typeof body.audioPublic !== 'boolean') throw new LibraryError('bad-input', 'audioPublic は true か false');
  out.audioPublic = body.audioPublic === true;
  out.audioStart = number(body.audioStart ?? 0, 'audioStart', n => n >= 0 && n <= MAX_AUDIO_START);
}

// 入力を確かめる。input には charId と verId が入っている
export async function shootInput(lib, input, body) {
  const out = {...input,
    framing: pick(body.framing ?? 'full', SHOT_FRAMINGS, 'framing'),
    aspect: pick(body.aspect ?? '9:16', Object.keys(ASPECTS), 'aspect'),
    quality: pick(body.quality ?? '1080p30', Object.keys(QUALITIES), 'quality'),
    expression: pick(body.expression ?? 'motion', SHOT_EXPRESSIONS, 'expression'),
    motionId: null, loops: 1, seconds: 0, lineId: null, audioId: null, audioName: '', audioSummary: '', audioPublic: false, audioStart: 0, background: 'viewer'};
  if (body.motionId) {
    out.motionId = (await lib.getMotion(body.motionId)).id;
    out.loops = number(body.loops ?? 1, 'loops', n => Number.isInteger(n) && n >= 1 && n <= MAX_LOOPS);
  } else if (body.seconds != null) out.seconds = number(body.seconds, 'seconds', n => n >= 1 / QUALITIES[out.quality].fps && n <= MAX_SECONDS);   // 下限は 1 コマ
  if (body.lineId) out.lineId = (await lib.getLine(input.charId, checkId(body.lineId, 'セリフ ID'))).id;
  await shootAudioInput(lib, out, body);
  if (body.background != null && body.background !== 'viewer') {
    if (typeof body.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.background)) throw new LibraryError('bad-input', 'background は viewer か #rrggbb: ' + JSON.stringify(body.background));
    out.background = body.background.toLowerCase();
  }
  return out;
}

// ffmpeg の引数。song は音声ファイル、voice はセリフの音声。無い音は省く。音があれば動画の長さちょうどの AAC にする
// songStart: 音声のこの秒から使う。songSec: 使う部分の長さ(開始位置より後ろ)。pattern、startNumber: コマのファイル名と最初の番号
export function encodeArgs({frames, pattern = 'f%05d.jpg', startNumber = 0, fps, seconds, voice = null, song = null, songStart = 0, songSec = 0, out, encoder = 'libx264'}) {
  const inputs = ['-framerate', String(fps), '-start_number', String(startNumber), '-i', path.join(frames, pattern)];
  const parts = [], labels = [];
  let n = 1;
  if (voice) { inputs.push('-i', voice); parts.push(`[${n}:a]aresample=48000[voice]`); labels.push('[voice]'); n++; }
  if (song) {
    inputs.push(...(songStart > 0 ? ['-ss', String(songStart)] : []), '-i', song);
    const fade = songSec > seconds ? `,afade=t=out:st=${Math.max(0, seconds - FADE_SEC).toFixed(3)}:d=${Math.min(FADE_SEC, seconds)}` : '';
    parts.push(`[${n}:a]aresample=48000,atrim=0:${seconds}${fade}${voice ? `,volume=${SONG_UNDER_LINE}` : ''}[song]`);
    labels.push('[song]');
  }
  const mix = labels.length === 2 ? `${labels.join('')}amix=inputs=2:duration=longest:normalize=0,` : labels[0] ?? '';
  const graph = labels.length ? [...parts, `${mix}apad=whole_dur=${seconds},atrim=0:${seconds}[a]`].join(';') : null;
  return ['-y', '-v', 'error', ...inputs, ...(graph ? ['-filter_complex', graph, '-map', '0:v', '-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : []),
    // 撮ったコマは BT.601 のフルレンジの JPEG。スマホの再生に合わせて BT.709 のリミテッドレンジへ直し、タグも付ける
    '-vf', 'scale=in_range=full:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int+bicubic,format=yuv420p',
    ...h264Args(encoder, 18), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-frames:v', String(Math.round(seconds * fps)), '-movflags', '+faststart', out];
}

export async function runShoot(ctx, {lib, getPort, env}) {
  const {job, workDir} = ctx, input = job.input, {charId, verId, motionId, lineId, audioId, framing, aspect, quality, expression, loops, background} = input;
  const motion = motionId ? await lib.getMotion(motionId) : null;
  const line = lineId ? await lib.getLine(charId, lineId) : null;
  const audio = audioId ? await lib.getAudio(audioId) : null;

  await ctx.step('長さを決める');
  const lineSec = line ? await mediaSeconds(ctx, line.audioFile) : 0, audioFull = audio ? await mediaSeconds(ctx, audio.file) : 0;
  if (audio && !(await ctx.run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', audio.file], {capture: true, timeoutMs: PROBE_MS})).trim()) throw new Error('音声ファイルに音が入っていない: ' + audio.name);
  const audioStart = audio ? input.audioStart : 0;
  if (audio && audioStart >= audioFull) throw new Error(`音声の開始位置 ${audioStart} 秒が、音声の長さ ${audioFull.toFixed(2)} 秒より後ろ: ${audio.name}`);
  const audioSec = audioFull - audioStart;   // 開始位置から後ろの長さ。動画の長さの計算にはこれを使う
  const seconds = shootSeconds({motionSec: motion?.durationSec ?? 0, loops, seconds: input.seconds, lineSec, audioSec});
  const {width, height, fps} = shootSize(aspect, quality), count = Math.round(seconds * fps);
  job.timeoutMs = env.CHARASTA_SHOOT_TIMEOUT_MS ? Number(env.CHARASTA_SHOOT_TIMEOUT_MS) : shootTimeoutMs(count);
  const deadline = Date.now() + job.timeoutMs, left = () => Math.max(1, deadline - Date.now());
  ctx.log(`${seconds.toFixed(2)} 秒、${count} コマ、${width}x${height}、${fps} fps、上限 ${Math.round(job.timeoutMs / 1000)} 秒\n`);

  const frames = path.join(workDir, 'frames'), out = path.join(workDir, 'video.mp4'), poster = path.join(workDir, 'poster.jpg');
  let saved, record, terms;
  try {
    await ctx.step('1 コマずつ撮る');
    await fs.rm(frames, {recursive: true, force: true});
    await fs.mkdir(frames, {recursive: true});
    const fake = env.CHARASTA_FAKE_CAPTURE;
    if (fake === 'hang') await ctx.run('node', ['-e', 'setTimeout(() => {}, 60000)'], {timeoutMs: left()});
    else if (fake) await ctx.run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x445566:s=${width}x${height}:r=${fps}`, '-frames:v', String(count), '-start_number', '0', path.join(frames, 'f%05d.jpg')]);
    else {
      await ctx.run('node', [path.join(root, 'tools', 'shoot.mjs'), '--char', charId, '--ver', verId, '--framing', framing, '--aspect', aspect, '--expression', expression,
        '--background', background, '--width', String(width), '--height', String(height), '--fps', String(fps), '--seconds', String(seconds), '--out', frames, '--port', String(getPort()),
        ...(motionId ? ['--motion', motionId] : []), ...(lineId ? ['--line', lineId, '--line-seconds', String(lineSec)] : [])], {timeoutMs: left()});
    }

    await ctx.step('動画にまとめる');
    await runH264(ctx, encoder => encodeArgs({frames, fps, seconds, voice: line?.audioFile, song: audio?.file, songStart: audioStart, songSec: audioSec, out, encoder}), {out, timeoutMs: left}, env);
    await fs.copyFile(path.join(frames, `f${String(Math.floor(count / 2)).padStart(5, '0')}.jpg`), poster);

    terms = videoTerms({motion, audio: audio && {name: audio.name, summary: input.audioSummary, publishOk: input.audioPublic}});
    record = {id: job.id, charId, verId, motionId, motionLabel: motion ? motion.label || motion.name || motion.id : null, loops, lineId, lineText: line?.text ?? null,
      audio: audio ? {id: audio.id, name: audio.name, summary: input.audioSummary, publicOk: input.audioPublic, start: audioStart, seconds: Number(audioSec.toFixed(2)), cut: audioSec > seconds} : null,
      framing, aspect, quality, expression, background, width, height, fps, seconds: Number(seconds.toFixed(3)), frames: count, terms, createdAt: new Date().toISOString()};
    saved = await lib.saveShoot(record, {video: out, poster});
  } finally {   // 失敗しても作業のコマと途中の動画を残さない(成功したときは保管場所へ移したあとで、何も残っていない)
    await fs.rm(frames, {recursive: true, force: true});
    await fs.rm(out, {force: true});
    await fs.rm(poster, {force: true});
  }
  return {shootId: job.id, url: saved.url, posterUrl: saved.posterUrl, seconds: record.seconds, width, height, fps, terms};
}
