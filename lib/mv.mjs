// MV ジョブ(mv): 完成モデルとモーションを Blender のシーンで踊らせ、カメラワーク付きの動画を作る。docs/shorts-dance-mv.md の「mv ジョブ」。
//   stage-studio の tools/make_mv.py が 焼き込み -> カット割り -> シーンごとの描画 をして、ここで動画にまとめて撮った動画として記録する
//   作業は 保管場所の mv-work/<条件のハッシュ>/ に置き、失敗しても残す。同じ条件で積み直すと、できたコマの続きから描く
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {root} from './config.mjs';
import {LibraryError, checkId, readJsonOr} from './library.mjs';
import {stageCatalog, stageCode} from './stages.mjs';
import {mediaSeconds} from './audio.mjs';
import {videoTerms} from './terms.mjs';
import {runH264} from './encoder.mjs';
import {encodeArgs, shootAudioInput} from './shoot.mjs';
import {MAX_SECONDS} from '../public/shoot-plan.mjs';
import {MV_FPS, MV_QUALITIES, BEATS_PER_SHOT, SHOTS_PER_SCENE, mvEstimateSec} from '../public/mv-plan.mjs';

const WORK_DIR = 'mv-work';
const WORK_KEEP_MS = 14 * 24 * 3600 * 1000;   // 失敗して残った作業のうち、これより古いものは次の MV のときに片づける
const PROGRESS_MS = 15000;
const MIN_SECONDS = 3, MAX_BPM = 240, MIN_BPM = 40, MAX_SEED = 9999;

function whole(v, what, list) {
  const n = Number(v);
  if (!list.includes(n)) throw new LibraryError('bad-input', `${what} は ${list.join(' / ')}: ${JSON.stringify(v)}`);
  return n;
}
function range(v, what, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new LibraryError('bad-input', `${what} は ${lo} から ${hi}: ${JSON.stringify(v)}`);
  return n;
}

// 同じ絵になる条件のハッシュ。作業フォルダの名前で、同じ条件の積み直しはここへ続きを描く。sources: モデル、モーション、シーンのコードの中身のハッシュ
export function mvKey(i, sources = []) {
  return crypto.createHash('sha1').update(JSON.stringify([i.charId, i.verId, i.motionId, i.stages, i.seconds, i.bpm, i.seed, i.beatsPerShot, i.shotsPerScene, i.audioId, i.audioStart, i.quality, sources])).digest('hex').slice(0, 16);
}

async function mvSources(lib, i, stageDir) {
  const ch = await lib.getCharacter(i.charId);
  return [ch.versions.find(v => v.id === i.verId)?.sha256, (await lib.getMotion(i.motionId)).sha256, ...await Promise.all(i.stages.map(s => stageCode(stageDir, s)))];
}

// 入力を確かめる。input には charId と verId が入っている。previewOf を渡すと、その試しと同じ条件の本番にする。active(key) はその条件のジョブが動いているか
export async function mvInput(lib, input, body, {stageDir, active}) {
  if (!stageDir) throw new LibraryError('bad-input', 'stage-studio が設定されていないので書き出せない(config.json の stageStudioDir)');
  let out;
  if (body.previewOf) {
    const id = checkId(body.previewOf, '動画 ID'), p = (await lib.shoots(input.charId)).find(s => s.id === id);
    if (!p) throw new LibraryError('not-found', `試しの動画 ${input.charId}/${id} が無い`);
    if (p.kind !== 'mv' || p.quality !== 'preview') throw new LibraryError('bad-input', `${id} は MV の試しではない`);
    if (!await lib.versionExists(input.charId, p.verId)) throw new LibraryError('not-found', `版 ${input.charId}/${p.verId} が無い`);
    await lib.getMotion(p.motionId);
    out = {charId: input.charId, verId: p.verId, motionId: p.motionId, stages: p.mv.stages, seconds: p.seconds, bpm: p.mv.bpm, seed: p.mv.seed, beatsPerShot: p.mv.beatsPerShot, shotsPerScene: p.mv.shotsPerScene,
      audioId: p.audio?.id ?? null, audioName: p.audio?.name ?? '', audioSummary: p.audio?.summary ?? '', audioPublic: p.audio?.publicOk ?? false, audioStart: p.audio?.start ?? 0, quality: 'final', previewOf: id};
    if (out.audioId) await lib.getAudio(out.audioId);
  } else {
    const known = (await stageCatalog(stageDir)).map(s => s.id);
    if (!known.length) throw new LibraryError('bad-input', 'シーンが無い(stage-studio が見つからない)');
    const stages = body.stages;
    if (!Array.isArray(stages) || !stages.length) throw new LibraryError('bad-input', 'stages はシーンの配列');
    for (const s of stages) if (!known.includes(s)) throw new LibraryError('bad-input', `知らないシーン: ${JSON.stringify(s)}`);
    if (new Set(stages).size !== stages.length) throw new LibraryError('bad-input', '同じシーンを 2 回選べない');
    if (!body.motionId) throw new LibraryError('bad-input', 'motionId が要る');
    if (!Object.hasOwn(MV_QUALITIES, body.quality ?? 'preview')) throw new LibraryError('bad-input', 'quality は ' + Object.keys(MV_QUALITIES).join(' / '));
    out = {...input, motionId: (await lib.getMotion(body.motionId)).id, stages,
      seconds: Math.round(range(body.seconds ?? 15, 'seconds', MIN_SECONDS, MAX_SECONDS)), bpm: range(body.bpm ?? 120, 'bpm', MIN_BPM, MAX_BPM),
      seed: Math.round(range(body.seed ?? 1, 'seed', 0, MAX_SEED)), beatsPerShot: whole(body.beatsPerShot ?? 8, 'beatsPerShot', BEATS_PER_SHOT), shotsPerScene: whole(body.shotsPerScene ?? 1, 'shotsPerScene', SHOTS_PER_SCENE),
      audioId: null, audioName: '', audioSummary: '', audioPublic: false, audioStart: 0, quality: body.quality ?? 'preview', previewOf: null};
    await shootAudioInput(lib, out, body);
  }
  out.key = mvKey(out, await mvSources(lib, out, stageDir));
  if (active(out.key)) throw new LibraryError('busy', '同じ条件の MV を書き出している');
  return out;
}

// 上限(ミリ秒)。目安の 4 倍。描く時間は場面で 3 倍ほど違い、ほかのジョブの GPU とも重なる
export const mvTimeoutMs = (quality, seconds, scenes) => mvEstimateSec(quality, seconds, scenes) * 4000;

// 長く放っておかれた作業を片づける。今のジョブのフォルダには触らない
async function sweepWork(base, keep) {
  for (const e of await fs.readdir(base, {withFileTypes: true}).catch(() => [])) {
    if (!e.isDirectory() || e.name === keep) continue;
    const dir = path.join(base, e.name), st = await fs.stat(dir).catch(() => null);
    if (st && Date.now() - st.mtimeMs > WORK_KEEP_MS) await fs.rm(dir, {recursive: true, force: true});
  }
}

export async function runMv(ctx, {lib, stageDir, blender, getPort, env}) {
  const {job} = ctx, input = job.input, {charId, verId, motionId, stages, seconds, bpm, seed, beatsPerShot, shotsPerScene, audioStart, quality, key} = input;
  const q = MV_QUALITIES[quality], motion = await lib.getMotion(motionId), audio = input.audioId ? await lib.getAudio(input.audioId) : null;
  const count = Math.round(seconds * MV_FPS), audioSec = audio ? await mediaSeconds(ctx, audio.file) - audioStart : 0;
  if (audio && audioSec <= 0) throw new Error(`音声の開始位置 ${audioStart} 秒が、音声の長さより後ろ: ${audio.name}`);
  job.timeoutMs = env.CHARASTA_SHOOT_TIMEOUT_MS ? Number(env.CHARASTA_SHOOT_TIMEOUT_MS) : mvTimeoutMs(quality, seconds, stages.length);
  const deadline = Date.now() + job.timeoutMs, left = () => Math.max(1, deadline - Date.now());
  const base = path.join(lib.dir, WORK_DIR), work = path.join(base, key), frames = path.join(work, 'frames'), out = path.join(ctx.workDir, 'video.mp4'), poster = path.join(ctx.workDir, 'poster.jpg');
  await fs.mkdir(frames, {recursive: true});
  await sweepWork(base, key);
  ctx.log(`${q.label}、${seconds} 秒、${count} コマ、シーン ${stages.join(', ')}、作業 ${work}、上限 ${Math.round(job.timeoutMs / 1000)} 秒\n`);

  const drawn = async () => (await fs.readdir(frames)).filter(f => /^\d{5}\.png$/.test(f) && Number(f.slice(0, 5)) >= 1 && Number(f.slice(0, 5)) <= count).length;
  let last = -1;
  const report = async () => { const n = await drawn(); if (n !== last) { last = n; await ctx.step(`コマを描く ${n} / ${count}`); } };
  await report();
  const timer = setInterval(() => report().catch(() => {}), PROGRESS_MS);
  try {
    const fake = env.CHARASTA_FAKE_CAPTURE;
    if (fake === 'hang') await ctx.run('node', ['-e', 'setTimeout(() => {}, 60000)'], {timeoutMs: left()});
    else if (fake) {
      await ctx.run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x445566:s=${q.width}x${q.height}:r=${MV_FPS}`, '-frames:v', String(count), '-start_number', '1', path.join(frames, '%05d.png')]);
      await fs.writeFile(path.join(work, 'shots.json'), JSON.stringify(stages.map((stage, i) => ({stage, kind: 'wide_push', start: seconds * i / stages.length, end: seconds * (i + 1) / stages.length}))));
    } else {
      await ctx.run('python', [path.join(stageDir, 'tools', 'make_mv.py'), '--stage', stages.join(','), '--char', charId, '--ver', verId, '--motion', motionId, '--seconds', String(seconds), '--bpm', String(bpm), '--seed', String(seed),
        '--beats-per-shot', String(beatsPerShot), '--shots-per-scene', String(shotsPerScene), '--pct', String(q.pct), '--samples', String(q.samples), '--out', work, '--base', `http://127.0.0.1:${getPort()}`, '--charasta', root, '--frames-only',
        ...(audio ? ['--audio', audio.file, '--audio-start', String(audioStart)] : [])], {cwd: stageDir, timeoutMs: left(), env: {CHARASTA_LIBRARY: lib.dir, CHARASTA_ROOT: root, ...(blender && {BLENDER: blender}), PYTHONUNBUFFERED: '1'}});
    }
  } finally { clearInterval(timer); }
  if (await drawn() !== count) throw new Error(`描いたコマが足りない: ${await drawn()} / ${count}`);

  await ctx.step('動画にまとめる');
  await fs.rm(out, {force: true});
  await runH264(ctx, encoder => encodeArgs({frames, pattern: '%05d.png', startNumber: 1, fps: MV_FPS, seconds, song: audio?.file, songStart: audioStart, songSec: audioSec, out, encoder}), {out, timeoutMs: left}, env);
  await ctx.run('ffmpeg', ['-y', '-v', 'error', '-i', path.join(frames, `${String(Math.ceil(count / 2)).padStart(5, '0')}.png`), '-q:v', '3', poster], {timeoutMs: left()});

  const shots = (await readJsonOr(path.join(work, 'shots.json'))) ?? [];
  const labels = Object.fromEntries((await stageCatalog(stageDir)).map(s => [s.id, s.label]));
  const terms = videoTerms({motion, audio: audio && {name: audio.name, summary: input.audioSummary, publishOk: input.audioPublic}});
  const record = {id: job.id, kind: 'mv', charId, verId, motionId, motionLabel: motion.label || motion.name || motion.id, loops: 1, lineId: null, lineText: null,
    audio: audio ? {id: audio.id, name: audio.name, summary: input.audioSummary, publicOk: input.audioPublic, start: audioStart, seconds: Number(audioSec.toFixed(2)), cut: audioSec > seconds} : null,
    framing: 'full', aspect: '9:16', quality, expression: 'motion', background: 'stage', width: q.width, height: q.height, fps: MV_FPS, seconds, frames: count, terms,
    mv: {stages, stageLabels: stages.map(s => labels[s] ?? s), bpm, seed, beatsPerShot, shotsPerScene, previewOf: input.previewOf, shots: shots.map(s => ({stage: s.stage, kind: s.kind, start: s.start, end: s.end}))},
    createdAt: new Date().toISOString()};
  const saved = await lib.saveShoot(record, {video: out, poster});
  await fs.rm(work, {recursive: true, force: true});   // できたので、コマと焼き込みは要らない
  return {shootId: job.id, url: saved.url, posterUrl: saved.posterUrl, seconds, width: q.width, height: q.height, fps: MV_FPS, terms};
}
