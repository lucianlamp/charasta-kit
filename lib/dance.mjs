// ダンス MV(ショートの型 dance): 曲と拍でカットを割り、stage-studio の tools/make_mv.py が描いたコマをカットごとのフォルダへ分ける。docs/shorts-dance-mv.md。
//   カットの秒は「拍から割る」(danceSplit)で決めて short.json に保存する。描くときは拍を求め直さず、make_mv.py の shots.json の時刻をカット表と照らす
//   stage-studio は読むだけ。割り方は lib/shots.py の plan と assign_stages をそのまま呼ぶ(tools/dance_plan.py)ので、乱数を JS へ移さない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {root} from './config.mjs';
import {findPython} from './platform.mjs';
import {LibraryError} from './library.mjs';
import {stageCatalog} from './stages.mjs';
import {MAX_SECONDS} from '../public/shoot-plan.mjs';
import {BEATS_PER_SHOT, MV_FPS, SHOTS_PER_SCENE} from '../public/mv-plan.mjs';
import {graphicBody, graphicCatalog, graphicCutsFromPlan, graphicPlan, graphicResplit, supportsGraphic} from './graphic-mv.mjs';

const exec = promisify(execFile);
export const DANCE_DEFAULTS = {bpm: 120, seed: 1, beatsPerShot: 8, shotsPerScene: 1, audioStart: 0};
// 新しく作るショートに置く演出。look を持たない保存済みのショートは plain(前の見た目)のまま
export const DANCE_NEW_LOOK = 'anime';
export const DANCE_LOOKS = ['anime', 'cel', 'plain', 'graphic'];   // graphic は stage-studio の make_graphic_mv.py で描く(lib/graphic-mv.mjs)。cel は make_mv.py の --look cel
export const DANCE_LUFS = -14;   // 曲が主役なので、語りの動画の BGM(-23)よりずっと大きい
const MIN_BPM = 40, MAX_BPM = 240, MAX_SEED = 9999, MAX_START = 3600, MIN_SECONDS = 3, DEFAULT_SECONDS = 15, SPLIT_TIMEOUT_MS = 180000, TOLERANCE = 0.02;

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const round6 = n => Math.round(n * 1e6) / 1e6;
// Python の round と同じ偶数丸め。コマの数が make_mv.py と 1 つずれないようにする
export function roundHalfEven(x) {
  const f = Math.floor(x), d = x - f;
  return d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
}

const num = (v, what, lo, hi) => {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n) || n < lo || n > hi) throw new LibraryError('bad-input', `${what} は ${lo} から ${hi}: ${JSON.stringify(v)}`);
  return n;
};
const oneOf = (v, what, list) => {
  const n = Number(v);
  if (!list.includes(n)) throw new LibraryError('bad-input', `${what} は ${list.join(' / ')}: ${JSON.stringify(v)}`);
  return n;
};

// short.json の music。曲の音声は short.audioId、動きは music.motionId(出演者は cast[0] の 1 人)。raw に無い欄は既定値
export async function musicBody(lib, stageDir, raw) {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw new LibraryError('bad-input', 'music が連想配列ではない');
  const m = raw ?? {}, out = {
    bpm: num(m.bpm ?? DANCE_DEFAULTS.bpm, 'bpm', MIN_BPM, MAX_BPM), seed: Math.round(num(m.seed ?? DANCE_DEFAULTS.seed, 'seed', 0, MAX_SEED)),
    beatsPerShot: oneOf(m.beatsPerShot ?? DANCE_DEFAULTS.beatsPerShot, 'beatsPerShot', BEATS_PER_SHOT), shotsPerScene: oneOf(m.shotsPerScene ?? DANCE_DEFAULTS.shotsPerScene, 'shotsPerScene', SHOTS_PER_SCENE),
    audioStart: num(m.audioStart ?? DANCE_DEFAULTS.audioStart, 'audioStart', 0, MAX_START),
    };
  // 演出。anime は stage-studio の --look anime(キャラのトゥーン、リム、顔の光、霞、被写界深度、ブルーム、顔を正面寄りに寄りで撮り、スカートの中を映さないカメラ)。plain は前の見た目。
  // cel は --look cel(VRM の MToon の影の色を使った 3 段のセル塗りと輪郭線。カメラ、顔の光、霞、ぼけは anime と同じ)。
  // 無いものは無いまま返す(保存のたびに anime を足すと、関係ない保存で danceKey が変わり全コマを描き直す)。新規作成だけが DANCE_NEW_LOOK を置く
  if (m.look !== undefined) {
    if (!DANCE_LOOKS.includes(m.look)) throw new LibraryError('bad-input', `look は ${DANCE_LOOKS.join(' / ')}: ${JSON.stringify(m.look)}`);
    out.look = m.look;
    if (out.look === 'graphic' && !await supportsGraphic(stageDir)) throw new LibraryError('bad-input', 'この stage-studio にはグラフィック MV の道具(tools/make_graphic_mv.py)が無い');
    if (out.look === 'cel' && !(await lookChoices(stageDir)).includes('cel')) throw new LibraryError('bad-input', 'この stage-studio の make_mv.py は --look cel を受けない');
  }
  // グラフィックの文字、色、表情、スカート。演出を anime や plain に戻しても残す(戻したときにまた使える)
  if (m.graphic != null) out.graphic = graphicBody(m.graphic);
  if (m.motionId) out.motionId = (await lib.getMotion(m.motionId)).id;
  if (m.stages !== undefined) {
    if (!Array.isArray(m.stages) || !m.stages.length) throw new LibraryError('bad-input', 'music.stages はシーンの配列');
    const known = (await stageCatalog(stageDir)).map(s => s.id);
    for (const s of m.stages) if (!known.includes(s)) throw new LibraryError('bad-input', `知らないシーン: ${JSON.stringify(s)}`);
    if (new Set(m.stages).size !== m.stages.length) throw new LibraryError('bad-input', '同じシーンを 2 回選べない');
    out.stages = m.stages;
  }
  return out;
}

// カットの秒から累積の境を作る。ジョブも画面もこれを使う
export function danceBounds(cuts) {
  let t = 0;
  return cuts.map(c => { const start = t; t = round6(t + c.seconds); return {start, end: t}; });
}
export const danceSeconds = cuts => danceBounds(cuts).at(-1)?.end ?? 0;

// カット表を make_mv.py の shots.json と同じ形にする(--shots-in に渡す。照らすときの期待値にも使う)
export function shotsFromCuts(cuts) {
  const bounds = danceBounds(cuts);
  return cuts.map((c, i) => ({kind: c.camera, start: bounds[i].start, end: bounds[i].end, a: c.angle ?? 0, dir: c.shot?.dir ?? 1, seed: c.shot?.seed ?? 0, stage: c.stage}));
}

// ショットごとのコマの数。stage-studio の lib/shots.py の camera_at と同じ規則(コマ f の時刻 (f-1)/30 を含むショットのもの。どれにも入らなければ最後)
export function ownedFrames(shots, frames) {
  const counts = shots.map(() => 0);
  for (let f = 1; f <= frames; f++) {
    const t = (f - 1) / MV_FPS, k = shots.findIndex(s => s.start <= t && t < s.end);
    counts[k < 0 ? shots.length - 1 : k]++;
  }
  return counts;
}

// make_mv.py が書いた shots.json を、保存したカット表と照らす。ずれていたら理由を付けて失敗にする(画面の秒と動画の秒を一致させる)
export function checkShots(cuts, shots) {
  const want = shotsFromCuts(cuts), hint = '拍から割り直す。カメラやシーンを手で直したカットは、stage-studio の make_mv.py に --shots-in を足すと反映できる';
  if (!Array.isArray(shots) || shots.length !== want.length) throw new Error(`カット表は ${want.length} カットだが、stage-studio のカット割りは ${shots?.length ?? 0} カット。${hint}`);
  want.forEach((w, i) => {
    const s = shots[i], at = `カット ${i + 1}`;
    if (s.stage !== w.stage) throw new Error(`${at} のシーンがカット表(${w.stage})と違う(${s.stage})。${hint}`);
    if (s.kind !== w.kind) throw new Error(`${at} のカメラがカット表(${w.kind})と違う(${s.kind})。${hint}`);
    if (Math.abs(s.start - w.start) > TOLERANCE || Math.abs(s.end - w.end) > TOLERANCE) throw new Error(`${at} の時刻がカット表と違う(表 ${w.start.toFixed(3)}〜${w.end.toFixed(3)}、描画 ${Number(s.start).toFixed(3)}〜${Number(s.end).toFixed(3)} 秒)。${hint}`);
    if (Math.abs((s.a ?? 0) - w.a) > 1e-6) throw new Error(`${at} の角度がカット表(${w.a})と違う(${s.a})。${hint}`);
  });
}

// stage-studio の make_mv.py が --look を受けるか(足すだけの変更なので、古い stage-studio では渡さない)
export async function supportsLook(stageDir) {
  return (await fs.readFile(path.join(stageDir, 'tools', 'make_mv.py'), 'utf8').catch(() => '')).includes('--look');
}

// make_mv.py の --look が受ける値(choices=[...] の中)。--look が無いか choices が読めなければ空
export async function lookChoices(stageDir) {
  const src = await fs.readFile(path.join(stageDir, 'tools', 'make_mv.py'), 'utf8').catch(() => '');
  const m = /['"]--look['"][^\n]*?choices\s*=\s*\[([^\]]*)\]/.exec(src);
  return m ? [...m[1].matchAll(/['"]([\w-]+)['"]/g)].map(x => x[1]) : [];
}

// make_mv.py が --shots-in を受けるか。受けるなら、カット表のカメラ・角度・シーンを手で直した分も描画に反映できる
export async function supportsShotsIn(stageDir) {
  return (await fs.readFile(path.join(stageDir, 'tools', 'make_mv.py'), 'utf8').catch(() => '')).includes('--shots-in');
}

// 描画に使うシーンの並び。カット表に最初に出た順
export const danceStages = cuts => [...new Set(cuts.map(c => c.stage))];

// ---- 拍から割る ----
const python = (stageDir, python = findPython() ?? 'python') => (file, args, timeout = SPLIT_TIMEOUT_MS) => exec(python, [file, ...args], {cwd: stageDir, timeout, windowsHide: true, maxBuffer: 1 << 24, env: {...process.env, CHARASTA_ROOT: root, PYTHONUNBUFFERED: '1'}});

// short の music と body の指定から、カット(stage、camera、seconds、angle、shot)を割る。保存はしない。
//   body: {stages, seconds?, bpm?, seed?, beatsPerShot?, shotsPerScene?, audioStart?, motionId?}。曲(short.audioId)があれば tools/beats.py の拍、無ければ bpm
//   答えは {music, cuts, source: 'audio' | 'bpm', detectedBpm}
export async function danceSplit({lib, stageDir, python: py = findPython() ?? 'python'}, short, body = {}) {
  if (short.style !== 'dance') throw new LibraryError('bad-input', 'ダンス MV の型のショートだけ拍から割れる');
  if (!await fs.stat(path.join(stageDir, 'lib', 'shots.py')).catch(() => null)) throw new LibraryError('bad-input', 'stage-studio が見つからない(lib/shots.py)');
  const music = await musicBody(lib, stageDir, {...short.music, ...Object.fromEntries(['bpm', 'seed', 'beatsPerShot', 'shotsPerScene', 'audioStart', 'motionId', 'stages', 'look'].filter(k => body[k] !== undefined).map(k => [k, body[k]]))});
  const graphic = music.look === 'graphic';
  if (!music.stages && !graphic) throw new LibraryError('bad-input', 'stages にシーンを 1 つ以上選ぶ');
  const motionId = music.motionId ?? short.cuts[0]?.motionId;
  if (!motionId) throw new LibraryError('bad-input', 'motionId(踊る動き)が要る');
  music.motionId = (await lib.getMotion(motionId)).id;
  const seconds = Number(num(body.seconds ?? (short.cuts.length ? danceSeconds(short.cuts) : DEFAULT_SECONDS), 'seconds', MIN_SECONDS, MAX_SECONDS).toFixed(3));
  const run = python(stageDir, py), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'charasta-dance-'));
  try {
    let beats = null, detectedBpm = null;
    const audio = short.audioId ? await lib.getAudio(short.audioId) : null;
    if (audio) {
      const probe = Number((await exec(process.env.CHARASTA_FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio.file], {timeout: 30000, windowsHide: true})).stdout.trim());
      if (probe > 0 && probe - music.audioStart < seconds - 1e-4) throw new LibraryError('bad-input', `曲が足りない: 開始位置から ${Math.max(0, Math.round((probe - music.audioStart) * 1000) / 1000)} 秒しかない(必要 ${seconds} 秒): ${audio.name}`);
      const out = path.join(tmp, 'beats.json');
      const r = await run(path.join(stageDir, 'tools', 'beats.py'), [audio.file, out, '--start', String(music.audioStart), '--seconds', String(seconds + 5)]);
      beats = JSON.parse(await fs.readFile(out, 'utf8'));
      detectedBpm = Number(/bpm ([\d.]+)/.exec(r.stdout)?.[1]) || null;
      if (!beats.length) throw new LibraryError('bad-input', `曲から拍を見つけられなかった: ${audio.name}`);
    }
    if (graphic) {   // グラフィック: stage-studio の --plan-only が場面の並びと秒を決める。拍は make_graphic_mv.py が曲から求める(beats.py と同じ)
      // 曲の拍はここで求めた beats を渡す(make_graphic_mv.py に beats.py をもう一度走らせない)
      const r = await graphicPlan({stageDir, python: py}, {seconds, bpm: detectedBpm ?? music.bpm, seed: music.seed, audioStart: music.audioStart, ...(beats ? {beats} : {}), text: {words: music.graphic?.text.words}});
      const cuts = graphicCutsFromPlan(r.plan, music.motionId);
      music.graphic = await graphicResplit({lib, short, music, cuts});   // 表情は新しい並びから作り直す。手で足した分は新しい長さの中だけ残す
      return {music, cuts, source: r.source, detectedBpm: audio ? (detectedBpm ?? r.bpm) : null};
    }
    const input = path.join(tmp, 'in.json'), output = path.join(tmp, 'out.json');
    await fs.writeFile(input, JSON.stringify({beats, bpm: music.bpm, seconds, seed: music.seed, beatsPerShot: music.beatsPerShot, shotsPerScene: music.shotsPerScene, stages: music.stages}));
    await run(path.join(root, 'tools', 'dance_plan.py'), [stageDir, input, output]);
    const plan = JSON.parse(await fs.readFile(output, 'utf8'));
    const cuts = plan.map(p => ({stage: p.stage, motionId: music.motionId, expression: 'motion', camera: p.kind, angle: p.a, text: '', telop: '', seconds: round6(p.end - p.start), shot: {dir: p.dir, seed: p.seed}}));
    return {music, cuts, source: audio ? 'audio' : 'bpm', detectedBpm};
  } catch (e) {
    if (e instanceof LibraryError) throw e;
    throw new Error(`拍から割れなかった: ${(e.stderr || e.message || String(e)).toString().trim().split('\n').slice(-3).join(' / ')}`);
  } finally { await fs.rm(tmp, {recursive: true, force: true}); }
}

// ---- 書き出し ----
// 書き出しの前の確かめ(shortJobInput)。画面が保存した形のカット表が描ける状態か
export async function danceJobCheck(lib, short, stageDir) {
  if (short.music?.look === 'graphic') {
    if (!await supportsGraphic(stageDir)) throw new LibraryError('bad-input', 'この stage-studio にはグラフィック MV の道具が無い');
    if (!short.music.graphic) throw new LibraryError('bad-input', 'グラフィックの値が無い。「拍から割る」か「既定に戻す」を押す');
    const ids = (await graphicCatalog(stageDir)).map(s => s.id);
    for (const c of short.cuts) if (!ids.includes(c.scene)) throw new LibraryError('bad-input', `カットに場面が無い(${JSON.stringify(c.scene)})。演出を変えたあとは「拍から割る」を押す`);
    if (danceSeconds(short.cuts) > MAX_SECONDS) throw new LibraryError('bad-input', `ダンス MV は ${MAX_SECONDS} 秒まで`);
    if (short.audioId) await lib.getAudio(short.audioId);
    if (!short.cast?.length) throw new LibraryError('bad-input', 'ダンス MV には出演者が要る');
    return;
  }
  const known = (await stageCatalog(stageDir)).map(s => s.id);
  if (!known.length) throw new LibraryError('bad-input', 'シーンが無い(stage-studio が見つからない)');
  if (short.cuts.some(c => !(c.seconds > 0))) throw new LibraryError('bad-input', 'ダンス MV のカットには秒が要る。拍から割る');
  if (danceSeconds(short.cuts) > MAX_SECONDS) throw new LibraryError('bad-input', `ダンス MV は ${MAX_SECONDS} 秒まで`);
  for (const c of short.cuts) if (!known.includes(c.stage)) throw new LibraryError('bad-input', `知らないシーン: ${JSON.stringify(c.stage)}`);
  if (short.audioId) await lib.getAudio(short.audioId);
  if (!short.cast?.length) throw new LibraryError('bad-input', 'ダンス MV には出演者が要る');
}

// 描画の条件のハッシュ。作業フォルダ(work/<quality>/mv-<key>/)の名前で、同じ条件ならコマの続きから描く。code は描画のコードの中身のハッシュ
// lookOn: stage-studio が --look を受ける(supportsLook)。受けないなら look は描画に効かないのでキーに入れない
export function danceKey({code, version, motion, cast, cuts, stageCodes, music, audio, pct, samples, lookOn = false}) {
  return sha1(JSON.stringify([code, version, motion, cast.charId, cast.verId, cuts.map((c, i) => [c.stage, stageCodes[i], c.camera, c.angle, c.shot ?? null, c.seconds]), music.bpm, music.seed, music.beatsPerShot, music.shotsPerScene, audio, music.audioStart, pct, samples, ...(lookOn && music.look && music.look !== 'plain' ? [music.look] : [])])).slice(0, 16);
}
export const danceCutId = (key, i) => sha1(JSON.stringify([key, i])).slice(0, 16);

const pngCount = async (dir, max) => (await fs.readdir(dir).catch(() => [])).filter(f => /^\d{5}\.png$/.test(f) && Number(f.slice(0, 5)) >= 1 && Number(f.slice(0, 5)) <= max).length;
export const danceDrawn = (mvDir, frames) => pngCount(path.join(mvDir, 'frames'), frames);

// コマを描く(または、描いたコマが揃っていれば何もしない)。mvDir/frames/00001.png から frames 枚と mvDir/shots.json ができる
//   fake: CHARASTA_FAKE_CAPTURE(ffmpeg で無地のコマとカット表どおりの shots.json を作る)
export async function drawDance(ctx, {lib, short, stageDir, blender, getPort, env, mvDir, frames, q, left, fake}) {
  const {music} = short, cuts = short.cuts, cast = short.cast[0], dir = path.join(mvDir, 'frames'), shotsFile = path.join(mvDir, 'shots.json');
  await fs.mkdir(dir, {recursive: true});
  if (await danceDrawn(mvDir, frames) === frames && await fs.stat(shotsFile).catch(() => null)) { ctx.log('描いたコマが揃っているので、描き直さない\n'); return; }
  if (fake) {
    await ctx.run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x445566:s=${q.width}x${q.height}:r=${MV_FPS}`, '-frames:v', String(frames), '-start_number', '1', path.join(dir, '%05d.png')]);
    await fs.writeFile(shotsFile, JSON.stringify(shotsFromCuts(cuts)));
    return;
  }
  const audio = short.audioId ? await lib.getAudio(short.audioId) : null, direct = await supportsShotsIn(stageDir), motionId = music.motionId ?? cuts[0].motionId;
  const extra = [];
  if (direct) { const f = path.join(mvDir, 'shots.in.json'); await fs.writeFile(f, JSON.stringify(shotsFromCuts(cuts))); extra.push('--shots-in', f); }
  if ((music.look ?? 'plain') !== 'plain' && await supportsLook(stageDir)) extra.push('--look', music.look);
  await ctx.run('python', [path.join(stageDir, 'tools', 'make_mv.py'), '--stage', danceStages(cuts).join(','), '--char', cast.charId, '--ver', cast.verId, '--motion', motionId, '--seconds', String(danceSeconds(cuts)), '--bpm', String(music.bpm), '--seed', String(music.seed),
    '--beats-per-shot', String(music.beatsPerShot), '--shots-per-scene', String(music.shotsPerScene), '--pct', String(q.pct), '--samples', String(q.samples), '--out', mvDir, '--base', `http://127.0.0.1:${getPort()}`, '--charasta', root, '--frames-only',
    ...(audio ? ['--audio', audio.file, '--audio-start', String(music.audioStart)] : []), ...extra], {cwd: stageDir, timeoutMs: left(), env: {CHARASTA_LIBRARY: lib.dir, CHARASTA_ROOT: root, ...(blender && {BLENDER: blender}), PYTHONUNBUFFERED: '1'}});
}

// 描いたコマをカットごとのフォルダ(work/<id>/frames/00001.png から)へハードリンクで分ける。コマの数はカット表ではなく shots.json の時刻から数える。
//   cuts と shots.json の照らし合わせ(checkShots)もここで行い、ずれていれば失敗にする。答えはカットごとのコマの数
export async function splitDanceFrames({mvDir, work, ids, cuts, frames, check = checkShots}) {
  const shots = JSON.parse(await fs.readFile(path.join(mvDir, 'shots.json'), 'utf8'));
  check(cuts, shots);
  const counts = ownedFrames(shots, frames);
  if (counts.some(n => n < 1)) throw new Error(`コマが 0 枚のカットがある: ${counts.join(', ')}`);
  let g = 0;
  for (const [i, n] of counts.entries()) {
    const to = path.join(work, ids[i], 'frames');
    await fs.rm(to, {recursive: true, force: true});
    await fs.mkdir(to, {recursive: true});
    for (let f = 1; f <= n; f++) {
      g++;
      const from = path.join(mvDir, 'frames', `${String(g).padStart(5, '0')}.png`), dest = path.join(to, `${String(f).padStart(5, '0')}.png`);
      await fs.link(from, dest).catch(() => fs.copyFile(from, dest));   // 別のドライブなどでリンクできなければコピー
    }
  }
  return counts;
}

