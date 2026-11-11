// モーションを作るジョブ motion-gen(docs/motionbricks.md)。MotionBricks(NVIDIA)で SOMA の動きを作り、
// tools/motionbricks_gen.py が VRM の骨に移し替えて VRMA にする。終わったら確認待ちにする。取り込むのは確認の画面のボタン(文章・動画・つなぐと同じ)。
// 試しの動き(環境変数。サーバーの config.env でも渡せる):
//   CHARASTA_FAKE_MOTIONBRICKS=1  MotionBricks を呼ばず、作りものの動きを同じ移し替えで書く(ふだんの python と numpy で動く)。fail は失敗
//   CHARASTA_MOTION_GEN_TIMEOUT_MS  動きを作る外部コマンドの時間の上限(ミリ秒)。省くと 15 分(テストが短くする)
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {MB_BACKENDS, root} from './config.mjs';
import {LibraryError, checkId, readJsonOr, writeJson} from './library.mjs';

// 選べる値は lib/motion-gen-options.json(tools/compose/compose.py の motionbricks の区間も同じファイルで確かめる)。
// 種類ごとの速さ(m/s)は MotionBricks の app/runtime/soma/presets.py の LocomotionMode(minimum_speed、default_speed、max_speed)。
// 途中の動作(歩き・走りのときだけ)は MotionBricks の Smart Primitive(jump_0_5m、jump_0_75m、avoidance)
const OPTIONS = JSON.parse(fsSync.readFileSync(new URL('./motion-gen-options.json', import.meta.url), 'utf8'));
export const MOTION_KINDS = OPTIONS.kinds;
export const MOTION_DIRECTIONS = OPTIONS.directions;
export const MOTION_ACTIONS = OPTIONS.actions;
export const MOTION_ENDINGS = OPTIONS.endings;
export const MOTION_ROOTS = OPTIONS.roots;
const SECONDS = OPTIONS.seconds, TURN = OPTIONS.turn, ACTION_MIN_SECONDS = OPTIONS.actionMinSeconds, D = OPTIONS.defaults;
const TIMEOUT_MS = 15 * 60 * 1000;   // 初回は TensorRT のエンジンを作るので長い

// 推論の選び方(設定の motionbricksBackend。tools/mb_onnx_engine.py)。trt は TensorRT(NVIDIA の GPU と CUDA が要る)、
// onnx は同じ ONNX のモデルを ONNX Runtime で動かす(CPU でも動く)、auto は TensorRT が動けば trt、動かなければ onnx。
// onnx を使うことがあるときは、onnxruntime を uv run の --with で足す(MotionBricks の環境には入れない)。
// バージョンは tools/mb_onnx_engine.py の ONNXRUNTIME_DEFAULT と同じ。設定の motionbricksOnnxRuntime で替えられる
export {MB_BACKENDS};
export const ONNXRUNTIME_DEFAULT = 'onnxruntime==1.30.0';
export function mbBackend(value) {
  const v = value ?? 'auto';
  if (!MB_BACKENDS.includes(v)) throw new Error(`設定の motionbricksBackend は ${MB_BACKENDS.join(' / ')}: ${v}`);
  return v;
}
// MotionBricks の uv の環境で python を動かす uv の引数(uv の後ろ。tools/mb_onnx_engine.py の uv_python と同じ形)
export function mbUvArgs(dir, {motionbricksBackend, motionbricksOnnxRuntime} = {}) {
  const withOrt = mbBackend(motionbricksBackend) === 'trt' ? [] : ['--with', motionbricksOnnxRuntime || ONNXRUNTIME_DEFAULT];
  return ['run', '--project', dir, '--no-sync', ...withOrt, 'python'];
}
// compose.py(つなぐ)に渡す環境変数。compose.py は uv の引数と、motionbricks_gen.py と mb_bridge.py の推論をこれで決める
export function mbEnv({motionbricksBackend, motionbricksOnnxRuntime} = {}) {
  return {CHARASTA_MB_BACKEND: mbBackend(motionbricksBackend), ...(motionbricksOnnxRuntime && {CHARASTA_MB_ONNXRUNTIME: motionbricksOnnxRuntime})};
}
// どの推論で動くかの見込み(使える機能の一覧に出す)。auto は nvidia-smi が PATH にあれば TensorRT とみなす。実際に使ったものは generated.json の backend
export function expectedBackend(value, {fake, nvidia}) {
  if (fake) return 'fake';
  const v = mbBackend(value);
  return v === 'trt' || (v === 'auto' && nvidia) ? 'tensorrt' : 'onnxruntime';
}
const MODEL = 'MotionBricks-SOMA-RP-v1（mmm_v6_soma_fp32.onnx）';
const PACK = 'MotionBricks で生成';

// 画面が選べる条件(GET /api/motion-gen)
export async function motionGenOptions(motionbricksDir, env) {
  return {kinds: MOTION_KINDS, directions: MOTION_DIRECTIONS, actions: MOTION_ACTIONS, endings: MOTION_ENDINGS, roots: MOTION_ROOTS,
    seconds: SECONDS, turn: TURN, actionMinSeconds: ACTION_MIN_SECONDS, available: !!env.CHARASTA_FAKE_MOTIONBRICKS || await isDir(motionbricksDir),
    motionbricksDir: motionbricksDir ?? null};
}

async function isDir(dir) { try { return !!dir && (await fs.stat(dir)).isDirectory(); } catch { return false; } }

function pick(value, table, name, fallback) {
  const v = value ?? fallback;
  if (typeof v !== 'string' || !Object.hasOwn(table, v)) throw new LibraryError('bad-input', `${name} は ${Object.keys(table).join(' / ')}`);
  return v;
}
function num(value, name, [lo, hi], fallback) {
  // 配列などは Number() が数に直してしまう(['2'] -> 2)ので、number か数字の string だけを通す
  const blank = value === undefined || value === null || value === '';
  const v = blank ? fallback : typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  if (!Number.isFinite(v) || v < lo || v > hi) throw new LibraryError('bad-input', `${name} は ${lo}〜${hi} の数`);
  return v;
}

// 条件の確かめ(motion-gen ジョブと、レシピの motionbricks の区間で同じ。compose.py の mb_conditions も同じ規則)。at は文の頭(区間の番号など)
export function motionGenConditions(body, at = '') {
  const kind = pick(body.kind, MOTION_KINDS, at + 'kind', D.kind), k = MOTION_KINDS[kind];
  const c = {kind,
    speed: Math.round(num(body.speed, at + 'speed', [k.min, k.max], k.default) * 1000) / 1000,
    direction: k.directions ? pick(body.direction, MOTION_DIRECTIONS, at + 'direction', D.direction) : 'forward',
    turn: num(body.turn, at + 'turn', TURN, D.turn),
    seconds: num(body.seconds, at + 'seconds', SECONDS, D.seconds),
    action: pick(body.action, MOTION_ACTIONS, at + 'action', D.action),
    ending: pick(body.ending, MOTION_ENDINGS, at + 'ending', D.ending),
    root: pick(body.root, MOTION_ROOTS, at + 'root', D.root)};
  if (c.action !== 'none' && kind !== 'forward') throw new LibraryError('bad-input', at + '途中の動作は「歩き・走り」のときだけ');
  if (c.action !== 'none' && c.seconds < ACTION_MIN_SECONDS) throw new LibraryError('bad-input', `${at}途中の動作を入れるときは長さを ${ACTION_MIN_SECONDS} 秒以上にする`);
  return c;
}

// 積むときの確かめ。pendingMotion(id) は、その ID のモーションを作るジョブが順番待ちか実行中か確認待ちにあるか
export async function motionGenInput(lib, body, pendingMotion) {
  const input = motionGenConditions(body);
  if (body.label != null && typeof body.label !== 'string') throw new LibraryError('bad-input', 'label は文字列');
  const label = (body.label ?? '').trim();
  if ([...label].length > 100) throw new LibraryError('bad-input', 'label は 100 文字まで');
  input.label = label || describe(input);
  input.motionId = body.motionId ? checkId(body.motionId, 'モーション ID') : `mb-${input.kind}-${Date.now().toString(36)}${crypto.randomBytes(1).toString('hex')}`;
  if (await lib.motionExists(input.motionId)) throw new LibraryError('exists', `モーション ${input.motionId} は既にある（上書きしない）`);
  if (pendingMotion(input.motionId)) throw new LibraryError('exists', `モーション ${input.motionId} を作るジョブが既にある`);
  return input;
}

// 条件から作るラベル(例「歩き・走り 2.3 m/s、左へ 90 度、6 秒、止まる」)
export function describe(i) {
  const parts = [`${MOTION_KINDS[i.kind].label} ${i.speed} m/s`];
  if (MOTION_KINDS[i.kind].directions && i.direction !== 'forward') parts.push(MOTION_DIRECTIONS[i.direction] + 'へ');
  if (i.turn) parts.push(`${i.turn > 0 ? '左' : '右'}へ ${Math.abs(i.turn)} 度曲がる`);
  if (i.action !== 'none') parts.push(MOTION_ACTIONS[i.action]);
  parts.push(`${i.seconds} 秒`, i.ending === 'stop' ? '止まる' : '止まらない');
  if (i.root === 'inplace') parts.push('その場');
  return parts.join('、');
}

// ライセンスの記録(motion.json の license)。生成の文脈と目標に見本の動き(BVH)のポーズを使うので、その許諾も書く。
// 値は lib/model-licenses.json の motionbricksGen(tools/compose/records.py も同じファイルを読む)。見本の動きの許諾の clips に使った BVH を入れる。
// 見本の動きの許諾は社内での評価・テストだけ。作ったモーションを使った動画の公開も不可(evaluationOnly。redistribution は取り出せる状態での配布だけを指す)
const LICENSE = JSON.parse(fsSync.readFileSync(new URL('./model-licenses.json', import.meta.url), 'utf8')).motionbricksGen;
export function motionGenLicense(sampleClips) {
  const l = structuredClone(LICENSE);
  l.terms.find(t => Array.isArray(t.clips)).clips = [...sampleClips];
  return l;
}

async function version(dir) {
  try { return /__version__\s*=\s*["']([^"']+)/.exec(await fs.readFile(path.join(dir, 'motionbricks', '_version.py'), 'utf8'))?.[1] ?? null; }
  catch { return null; }
}

// 作業フォルダの中の結果。確認の画面に配るのは motion.vrma と contacts.json だけ
export const genFile = (workDir, name) => {
  if (!['motion.vrma', 'contacts.json'].includes(name)) throw new LibraryError('not-found', `ファイル ${name} は無い`);
  return path.join(workDir, name);
};
const urlOf = (jobId, file) => `/api/motion-gen/${jobId}/${file}`;

// ジョブ 1 件を動かす。ctx は jobs.mjs の {job, workDir, log, step, run}。保管場所には入れず、確認待ちにする
// tools は jobs.mjs の tools(motionbricksDir、motionbricksBackend、motionbricksOnnxRuntime)
export async function runMotionGen(ctx, {tools, env}) {
  const motionbricksDir = tools.motionbricksDir, backend = mbBackend(tools.motionbricksBackend);
  const i = ctx.job.input, fake = env.CHARASTA_FAKE_MOTIONBRICKS;
  const limit = {timeoutMs: Number(env.CHARASTA_MOTION_GEN_TIMEOUT_MS) || TIMEOUT_MS};
  const out = genFile(ctx.workDir, 'motion.vrma'), infoFile = path.join(ctx.workDir, 'info.json'), contactsFile = genFile(ctx.workDir, 'contacts.json');
  const args = [path.join(root, 'tools', 'motionbricks_gen.py'), '--out', out, '--info', infoFile, '--contacts', contactsFile, '--kind', i.kind, '--speed', String(i.speed),
    '--direction', i.direction, '--turn', String(i.turn), '--seconds', String(i.seconds), '--action', i.action, '--ending', i.ending, '--root', i.root, '--backend', backend];

  await ctx.step(fake ? 'モーションを作る（試しの動き）' : 'MotionBricks でモーションを作る');
  if (fake === 'fail') throw new Error('試しの動き: MotionBricks が失敗した');
  if (fake) await ctx.run('python', [...args, '--fake'], limit);
  else {
    if (!await isDir(motionbricksDir)) throw new Error('MotionBricks の場所が無い（設定の motionbricksDir）: ' + motionbricksDir);
    // MotionBricks の uv の環境で動かす(--no-sync: ジョブのたびに依存を入れ直さない)。.trt-cache は MotionBricks の中に置く
    await ctx.run('uv', [...mbUvArgs(motionbricksDir, tools), ...args, '--motionbricks', motionbricksDir], {cwd: motionbricksDir, ...limit});
  }
  const info = JSON.parse(await fs.readFile(infoFile, 'utf8'));
  ctx.log(`${info.frames} コマ、${info.durationSec.toFixed(2)} 秒、進んだ距離 ${info.travelM} m\n`);

  await ctx.step('確認を待つ');
  const generated = {tool: 'MotionBricks', version: fake ? null : await version(motionbricksDir), model: fake ? '試しの動き' : MODEL,
    engine: info.engine, backend: info.backend, providers: info.providers, tokens: info.tokens, job: ctx.job.id, options: info.options, frames: info.frames, fps: info.fps, travelM: info.travelM,
    speedUsed: info.speedUsed, actionStartedSec: info.actionStartedSec, timings: {...info.timings, totalSec: info.totalSec},
    retarget: 'SOMA の T ポーズからのワールドの回転の差を VRM の正規化した骨へ（docs/adr/0003-motionbricks-retarget.md）'};
  await writeJson(path.join(ctx.workDir, 'generated.json'), generated);
  return {review: 'waiting', motionId: i.motionId, label: i.label, durationSec: info.durationSec, frames: info.frames, travelM: info.travelM,
    sourcePath: fake ? '' : motionbricksDir, license: motionGenLicense(info.sampleClips), vrmaUrl: urlOf(ctx.job.id, 'motion.vrma'), contactsUrl: urlOf(ctx.job.id, 'contacts.json')};
}

// 確認の画面の「取り込む」。job は jobs.mjs が確かめた、確認待ちのジョブ。ID の既定は積んだときの mb-…。作業フォルダは残す(つなぐジョブが写して使う)
export async function importMotionGen(lib, workDir, job, body) {
  const r = job.result;
  if (body.label != null && typeof body.label !== 'string') throw new LibraryError('bad-input', 'label は文字列');
  const label = (body.label ?? '').trim() || r.label;
  if ([...label].length > 100) throw new LibraryError('bad-input', 'label は 100 文字まで');
  const id = body.motionId ? checkId(body.motionId, 'モーション ID') : r.motionId;
  if (await lib.motionExists(id)) throw new LibraryError('exists', `モーション ${id} は既にある（上書きしない）`);
  return lib.importMotion({id, name: label, label, data: await fs.readFile(genFile(workDir, 'motion.vrma')), sourcePath: r.sourcePath ?? '', pack: PACK,
    license: r.license, generated: await readJsonOr(path.join(workDir, 'generated.json')), contacts: await readJsonOr(genFile(workDir, 'contacts.json'))});
}
