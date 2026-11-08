// 文章からモーションを作るジョブ motion-text(docs/motion-text.md)。
//   文章(日本語可) -> 英語の説明文(claude -p。10 秒以内の区間に分ける) -> Kimodo(作業プロセス tools/kimodo_worker.py) -> 候補ごとの VRMA と contacts.json -> 確認待ち
// 本番のモーションには入れない。確認の画面で候補を選んで「取り込む」を押して初めてモーションになる。
// 試しの動き(環境変数。サーバーの config.env でも渡せる):
//   CHARASTA_FAKE_KIMODO=1  claude と Kimodo を呼ばず、作りものの動きで通す(ふだんの python と numpy は要る)。
//                           high は hips が 2.5 m まで上がる動き、fail は Kimodo の失敗、load-fail は読み込みの失敗、claude-fail は英語への変換の失敗
//   CHARASTA_CLAUDE  claude コマンドの場所(省くと PATH の claude)。CHARASTA_CLAUDE_MODEL  英語への変換に使うモデル(既定 sonnet)
//   CHARASTA_KIMODO_ENCODER  文章のエンコーダ。stream(既定。層ごとに読む別プロセス、CUDA)、stream-cpu(同じく CPU。今までと同じ値)、cpu(今までの経路。RAM 16 GB)
//   CHARASTA_KIMODO_MIN_FREE_GB  読み込み前に要る RAM の空き(GB、既定は RAM_GB)。CHARASTA_GPU_WAIT_MS / CHARASTA_GPU_POLL_MS  GPU の空きを待つ上限と間隔
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {LibraryError, checkId, readJsonOr} from './library.mjs';
import {KimodoWorker} from './kimodo-worker.mjs';

export const MODEL = 'Kimodo-SOMA-RP-v1.2';
export const MAX_SEG_SEC = 10, MIN_SEG_SEC = 1, MAX_TOTAL_SEC = 22, MAX_SEGMENTS = 6, MAX_TEXT = 1000, MAX_LABEL = 100;
export const MIN_SPEED_MPS = 0.5, MAX_SPEED_MPS = 2, MAX_WALK_SEC = 40, MAX_WALK_SEGMENTS = 10, WALK_STEP_SEC = 0.1;   // 腰の道を決めた歩きは長くても腰が上がらないので、話す動画の 1 本分まで作る
export const CANDIDATES = {min: 1, max: 3, default: 2};
export const ROOTS = {keep: '進む', inplace: 'その場'};
export const LOAD_MINUTES = 1;        // モデルの読み込みの目安(stream は 30〜41 秒。cpu は SSD の hfCacheDir で 46〜92 秒、HDD では 541〜635 秒だった)
export const MAX_HIPS_M = 2;            // これを超える動きは壊れている(15 秒の単発で 3.9 m まで上がった)
export const ENCODERS = ['stream', 'stream-cpu', 'cpu'];
// RAM の空き(GB)。load は作業プロセスの読み込み前(読み込みと、続く文章の符号化の分)、encode は読み込み済みのときの生成の前(符号化の別プロセスの分)。
// load は tools/kimodo_text_encoder.py の RAM_GB_LOAD_AND_ENCODE と同じ。測った値は docs/motion-text.md の「実測」
export const RAM_GB = {stream: {load: 5, encode: 2}, cpu: {load: 16, encode: 0}};   // cpu: 読み込みの最大が 14〜15.5 GB
export const MIN_FREE_RAM_GB = RAM_GB.stream.load;
// モードごとに要る GPU の空き(MiB)。stream は実測で、作業プロセスと符号化の別プロセスが同時に使う GPU の最大が 3417 MiB(CUDA の文脈を含む)。
// cpu と stream-cpu は GPU に載るのが Kimodo だけ(約 1.3 GB)で、符号化は CPU なので GPU を使わない
export const VRAM_MIB = {stream: 4000, 'stream-cpu': 2500, cpu: 2500};
export const MIN_FREE_VRAM_MIB = VRAM_MIB.cpu;   // 符号化の分を足さない、Kimodo だけの必要量
// 読み込み済みの作業プロセスは、文章が全部キャッシュにあれば符号化の別プロセスを起こさない。キャッシュの鍵は Python 側の設定(モデルのスナップショット)で
// 決まり node からは引けないので、読み込み済みなら Kimodo だけの量で待つ(足りない文章があれば、符号化の別プロセスの失敗がジョブのエラーになる)
export function vramNeed(env, loaded) {
  const mode = encoderMode(env);
  return loaded ? MIN_FREE_VRAM_MIB : VRAM_MIB[mode];
}
const TRANSLATE_MS = 3 * 60 * 1000, GENERATE_MS = 15 * 60 * 1000;
const GPU_WAIT_MS = 10 * 60 * 1000, GPU_POLL_MS = 10 * 1000;

const SYSTEM = `You convert a description of a human body motion, written in Japanese or English, into English text prompts for the Kimodo text-to-motion model.
Reply with one JSON object and nothing else: {"segments":[{"prompt":"A person ...","seconds":6}]}
Rules:
- Each prompt is one short, plain English sentence that starts with "A person" and has one main action, for example "A person walks forward." or "A person waves the right hand.". Put each action of the description in its own segment, in the order given. Do not join several actions with "then" or "and" in one sentence.
- Keep a walking, running or other travelling sentence plain. Do not write step counts, speeds or endings such as "three steps", "at a steady pace", "slows down" or "comes to a stop" in it; the model then barely moves. If the person must stop, add a separate short segment such as "A person stands still.".
- A travelling segment needs at least 5 seconds, and should be the longest segment. A short segment such as waving or bowing takes 2 to 3 seconds.
- Do not use names, camera directions, or objects other than something the person holds.
- Each segment is at most ${MAX_SEG_SEC} seconds (a number from 2 to ${MAX_SEG_SEC}). Use one segment unless the description has clearly separate phases or the total is over ${MAX_SEG_SEC} seconds. Never use more than ${MAX_SEGMENTS} segments.
- The seconds of all segments add up to at most ${MAX_TOTAL_SEC}. If a total length is given, they add up to exactly that total.`;

// 画面が読むもの(GET /api/motion-texts の options)
export function motionTextOptions(available, env) {
  return {available, fake: env.CHARASTA_FAKE_KIMODO ? String(env.CHARASTA_FAKE_KIMODO) : null, model: MODEL, maxSegmentSec: MAX_SEG_SEC, maxTotalSec: MAX_TOTAL_SEC,
    candidates: CANDIDATES, roots: ROOTS, maxText: MAX_TEXT, loadMinutes: LOAD_MINUTES};
}

function int(value, name, [lo, hi], fallback) {
  const blank = value === undefined || value === null || value === '';
  const v = blank ? fallback : typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  if (!Number.isInteger(v) || v < lo || v > hi) throw new LibraryError('bad-input', `${name} は ${lo}〜${hi} の整数`);
  return v;
}

// 積むときの確かめ(文章の中身は問わない。英語に直すのはジョブの中)
export function motionTextInput(body) {
  if (typeof body.text !== 'string') throw new LibraryError('bad-input', 'text は文字列');
  const text = body.text.trim();
  if (!text) throw new LibraryError('bad-input', '動きの文章を書く');
  if ([...text].length > MAX_TEXT) throw new LibraryError('bad-input', `文章は ${MAX_TEXT} 文字まで`);
  let seconds = null;
  if (body.seconds !== undefined && body.seconds !== null && body.seconds !== '') {
    seconds = typeof body.seconds === 'number' || (typeof body.seconds === 'string' && body.seconds.trim() !== '') ? Number(body.seconds) : NaN;
    if (!Number.isFinite(seconds) || seconds < MIN_SEG_SEC || seconds > MAX_TOTAL_SEC) {
      throw new LibraryError('bad-input', `長さは ${MIN_SEG_SEC}〜${MAX_TOTAL_SEC} 秒（1 区間は ${MAX_SEG_SEC} 秒まで。${MAX_SEG_SEC} 秒を超える分は区間を分けて続ける）`);
    }
    seconds = Math.round(seconds * 2) / 2;
  }
  const root = body.root ?? 'keep';
  if (typeof root !== 'string' || !Object.hasOwn(ROOTS, root)) throw new LibraryError('bad-input', 'root は ' + Object.keys(ROOTS).join(' / '));
  if (body.label != null && typeof body.label !== 'string') throw new LibraryError('bad-input', 'label は文字列');
  const label = (body.label ?? '').trim() || [...text.replace(/\s+/g, ' ')].slice(0, 40).join('');
  if ([...label].length > MAX_LABEL) throw new LibraryError('bad-input', `label は ${MAX_LABEL} 文字まで`);
  // speed(m/s)を付けると、腰を指定の速さでまっすぐ進ませる(歩きながら話すショートの道)。省くと Kimodo に任せる
  const speed = body.speed == null ? null : Number(body.speed);
  if (speed !== null && !(speed >= MIN_SPEED_MPS && speed <= MAX_SPEED_MPS)) throw new LibraryError('bad-input', `speed は ${MIN_SPEED_MPS}〜${MAX_SPEED_MPS} m/s`);
  // segments は英語の区間の直接の指定。歩きながら話す動きは、セリフの時刻に区間を合わせるのでこれで渡す(秒は 0.1 秒単位、区間の speed で止まれる)。claude を呼ばない
  let segments = null;
  if (body.segments != null) {
    try { segments = parseSegments(JSON.stringify({segments: body.segments}), null, speed ? {maxSegments: MAX_WALK_SEGMENTS, maxTotal: MAX_WALK_SEC, step: WALK_STEP_SEC, walk: true} : {}); }
    catch (e) { throw new LibraryError('bad-input', e.message); }
  }
  return {text, seconds, candidates: int(body.candidates, 'candidates', [CANDIDATES.min, CANDIDATES.max], CANDIDATES.default), root, label, ...(speed ? {speed} : {}), ...(segments ? {segments} : {})};
}

// ---- 英語の説明文 ----
const roundHalf = x => Math.round(x * 2) / 2;

// 変換の返事(JSON の文字列。前後の説明やコードの囲みは捨てる)を区間の並びにして確かめる。seconds が空でなければ、合計をそれに合わせる
//   step は秒の丸めの幅。walk(腰の道を決めた歩き)では区間ごとの speed(0 で止まる)を受ける
export function parseSegments(raw, seconds, {maxSegments = MAX_SEGMENTS, maxTotal = MAX_TOTAL_SEC, step = 0.5, walk = false} = {}) {
  const a = String(raw).indexOf('{'), b = String(raw).lastIndexOf('}');
  let j;
  try { j = JSON.parse(String(raw).slice(a, b + 1)); } catch { throw new Error('英語への変換の返事を読めない: ' + String(raw).slice(0, 200)); }
  const list = j?.segments;
  if (!Array.isArray(list) || !list.length) throw new Error('英語への変換の返事に区間が無い');
  if (list.length > maxSegments) throw new Error(`区間が ${list.length} 個ある（${maxSegments} 個まで）`);
  let segs = list.map((s, k) => {
    const prompt = typeof s?.prompt === 'string' ? s.prompt.trim().replace(/\s+/g, ' ') : '';
    const sec = Number(s?.seconds);
    if (!prompt || prompt.length > 400 || !Number.isFinite(sec) || sec <= 0) throw new Error(`区間 ${k + 1} の説明文か秒数が正しくない`);
    if (s.speed != null && !(walk && Number(s.speed) >= 0 && Number(s.speed) <= MAX_SPEED_MPS)) throw new Error(`区間 ${k + 1} の speed は道を決めた歩きだけで、0〜${MAX_SPEED_MPS} m/s`);
    return {prompt, seconds: Number((Math.round(sec / step) * step).toFixed(3)), ...(s.speed != null ? {speed: Number(s.speed)} : {})};
  });
  if (seconds !== null) {   // 指定の合計に合わせて比例配分し、端数は最後の区間に寄せる
    const sum = segs.reduce((t, s) => t + s.seconds, 0);
    if (!(sum > 0)) throw new Error('区間の秒数が全部 0 になった（0.5 秒単位に丸めると 0）');
    segs = segs.map(s => ({...s, seconds: roundHalf(s.seconds * seconds / sum)}));
    segs[segs.length - 1].seconds = roundHalf(seconds - segs.slice(0, -1).reduce((t, s) => t + s.seconds, 0));
  }
  const total = segs.reduce((t, s) => t + s.seconds, 0);
  // NaN も外す形で確かめる(比較が偽になるものは全部断る)
  const bad = segs.findIndex(s => !(s.seconds >= MIN_SEG_SEC && s.seconds <= MAX_SEG_SEC));
  if (bad >= 0) {
    const sec = segs[bad].seconds;
    throw new Error(sec > MAX_SEG_SEC ? `区間 ${bad + 1} が ${sec} 秒ある。1 区間は ${MAX_SEG_SEC} 秒まで（長い動きは区間を分ける）` : `区間 ${bad + 1} が ${sec} 秒しかない（${MIN_SEG_SEC} 秒以上）`);
  }
  if (!(total <= maxTotal)) throw new Error(`合計 ${total} 秒になった（${maxTotal} 秒まで）`);
  return segs;
}

// 試しの動き: 「。」か改行で区切り、先頭に A person を付けるだけ(翻訳はしない)
function fakeReply(text, seconds) {
  const parts = text.split(/[。\n]/).map(s => s.trim()).filter(Boolean).slice(0, MAX_SEGMENTS);
  const each = seconds === null ? 4 : roundHalf(seconds / parts.length);
  return JSON.stringify({segments: parts.map(p => ({prompt: `A person ${p}`, seconds: each}))});
}

// claude -p の引数。文章は含めない(標準入力で渡す)。ツール・MCP・スキル・設定を読ませず、1 回の返事だけ取る
export function claudeArgs(model) {
  return ['-p', '--model', model, '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '',
    '--output-format', 'json', '--system-prompt', SYSTEM];
}
export const claudeInput = (text, seconds) => `説明:
${text}
全体の長さ: ${seconds === null ? '指定なし（区間ごとに決める）' : seconds + ' 秒'}
`;

// claude -p --output-format json の出力から返事の文字列を取り出す
export function readClaudeOutput(out) {
  let j;
  try { j = JSON.parse(out); } catch { throw new Error('claude の出力を読めない: ' + String(out).slice(0, 200)); }
  if (j.is_error || typeof j.result !== 'string') throw new Error('claude が失敗した: ' + String(j.result ?? j.subtype ?? '').slice(0, 200));
  return j.result;
}

async function translate(ctx, env, fake) {
  const {text, seconds, segments} = ctx.job.input;
  if (segments) return segments;
  let reply;
  if (fake) {
    if (fake === 'claude-fail') throw new Error('試しの動き: claude が使えない');
    reply = fakeReply(text, seconds);
  } else {
    let out;
    try { out = await ctx.run('claude', claudeArgs(env.CHARASTA_CLAUDE_MODEL || 'sonnet'), {capture: true, input: claudeInput(text, seconds), cwd: ctx.workDir, timeoutMs: TRANSLATE_MS}); }
    catch (e) { throw new Error(`英語の説明文に直せなかった（claude が使えない？）: ${e.message}`); }
    reply = readClaudeOutput(out);
  }
  try { return parseSegments(reply, seconds); }
  catch (e) { throw new Error(`英語の説明文を確かめられなかった: ${e.message}`); }
}

// ---- 資源の確かめ ----
export function encoderMode(env) {
  const mode = env.CHARASTA_KIMODO_ENCODER || 'stream';
  if (!ENCODERS.includes(mode)) throw new Error(`CHARASTA_KIMODO_ENCODER は ${ENCODERS.join(' / ')}（${mode} になっている）`);
  return mode;
}
// 要る RAM の空き(GB)。0 なら測らない
export function ramNeed(env, loaded) {
  const r = encoderMode(env) === 'cpu' ? RAM_GB.cpu : RAM_GB.stream;
  return loaded ? r.encode : Number(env.CHARASTA_KIMODO_MIN_FREE_GB) || r.load;
}
const defaultFreeGB = () => os.freemem() / 2 ** 30;
// nvidia-smi の出力(1 行目が MiB の整数)から空きを読む。読めなければ null(0 MiB は 0 のまま返す)
export function parseGpuFree(out) {
  const n = Number.parseInt(String(out).trim().split(/\r?\n/)[0], 10);
  return Number.isFinite(n) ? n : null;
}
function defaultGpuFreeMiB() {
  return new Promise(resolve => execFile('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], {timeout: 10000, windowsHide: true},
    (err, out) => resolve(err ? null : parseGpuFree(out))));
}
// 待つ。signal が取り消されたら、すぐ戻る
const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();   // 待ち始める前に取り消されていたら、待たない
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', done, {once: true});
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
});
// サーバーを止める取り消し(JobQueue.close)を受けていたら、ジョブを中断する
const checkAbort = ctx => { if (ctx.signal?.aborted) throw new Error('サーバーを止めるので、ジョブを中断した'); };

// GPU の空きが足りなければ、空くまで待つ(上限まで)。測れなければ(nvidia-smi が無い)待たない
async function waitGpu(ctx, gpuFree, env, need) {
  const limit = Number(env.CHARASTA_GPU_WAIT_MS) || GPU_WAIT_MS, poll = Number(env.CHARASTA_GPU_POLL_MS) || GPU_POLL_MS, until = Date.now() + limit;
  let waited = false;
  for (;;) {
    checkAbort(ctx);
    const free = await gpuFree();
    if (!Number.isFinite(free) || free >= need) { if (waited) ctx.log(`GPU が空いた（空き ${free} MiB）\n`); return; }
    if (Date.now() >= until) throw new Error(`GPU の空きが ${free} MiB しかない（${need} MiB 要る）まま ${Math.round(limit / 60000)} 分待ったので止めた。ほかの処理が終わってからやり直す`);
    if (!waited) { waited = true; await ctx.step(`GPU が空くのを待っている（空き ${free} MiB、${need} MiB 要る）`); }
    await sleep(Math.min(poll, Math.max(1, until - Date.now())), ctx.signal);
  }
}

// ---- ジョブ ----
const candDir = workDir => path.join(workDir, 'cand');
const urlOf = (jobId, n, file) => `/api/motion-texts/${jobId}/candidates/${n}/${file}`;

// ジョブ 1 件を動かす。ctx は jobs.mjs の {job, workDir, log, step, run}、worker は KimodoWorker。取り込みはしない
export async function runMotionText(ctx, {worker, env, tools = {}}) {
  const release = worker.hold();   // このジョブの間は、使わないことによる作業プロセスの終了を止める
  try { return await runLocked(ctx, {worker, env, tools}); } finally { release(); }
}

async function runLocked(ctx, {worker, env, tools}) {
  const {job, workDir} = ctx, i = job.input, fake = env.CHARASTA_FAKE_KIMODO ? String(env.CHARASTA_FAKE_KIMODO) : null, t0 = Date.now();
  const timings = {};
  encoderMode(env);   // 設定の誤りは文章を外へ送る前に断る
  // 動かせないと分かっているなら、文章を外へ送る前に断る
  if (!KimodoWorker.available(worker.kimodoDir, fake)) throw new Error(`Kimodo の .venv が見つからない（設定の kimodoDir: ${worker.kimodoDir ?? 'なし'}）`);

  await ctx.step(fake ? '英語の説明文に直す(試しの動き)' : '英語の説明文に直す(claude)');
  let t = Date.now();
  const segments = await translate(ctx, env, fake);
  timings.translateSec = Number(((Date.now() - t) / 1000).toFixed(1));
  ctx.log(segments.map((s, k) => `区間 ${k + 1}（${s.seconds} 秒）: ${s.prompt}\n`).join(''));

  const freeGB = tools.freeMemGB ?? (fake ? null : defaultFreeGB), gpuFree = tools.gpuFreeMiB ?? (fake ? async () => null : defaultGpuFreeMiB);
  await waitGpu(ctx, gpuFree, env, vramNeed(env, worker.loaded));

  // RAM は読み込みの直前に測る(GPU を待つ間に変わるため)。終わらせている最中のプロセスの分を数えないよう、その終わりを待つ。
  // 読み込み済みでも、stream は生成の前に文章の符号化の別プロセスが動くことがあるので、その分を測る(cpu は測らない)
  await worker.closing;
  checkAbort(ctx);
  const need = ramNeed(env, worker.loaded);
  if (need > 0 && freeGB) {
    const free = freeGB(), what = worker.loaded ? '文章の符号化' : '文章のモデルの読み込み';
    ctx.log(`RAM の空き ${free.toFixed(1)} GB（${what}に ${need} GB 要る）\n`);
    if (!(free >= need)) throw new Error(`RAM の空きが ${Number(free).toFixed(1)} GB しかない（${what}に ${need} GB 要る）。ほかのアプリを閉じてからやり直す`);
  }

  t = Date.now();
  await ctx.step(worker.loaded ? '文章のモデルは読み込み済み' : `文章のモデルを読み込んでいる（約 ${LOAD_MINUTES} 分）`);
  const onLog = text => ctx.log(text);
  checkAbort(ctx);
  await worker.ensureLoaded({onLog});
  timings.loadSec = Number(((Date.now() - t) / 1000).toFixed(1));

  checkAbort(ctx);
  await ctx.step(`動きを作る（候補 ${i.candidates} 本）`);
  t = Date.now();
  const base = crypto.randomInt(1, 90000), seeds = Array.from({length: i.candidates}, (_, k) => base + k);
  await fs.rm(candDir(workDir), {recursive: true, force: true});
  const reply = await worker.request('generate', {segments, seeds, root: i.root, ...(i.speed ? {speed: i.speed} : {}), outDir: candDir(workDir)},
    {onProgress: text => { ctx.step(text).catch(() => {}); }, onLog, timeoutMs: Number(env.CHARASTA_KIMODO_TIMEOUT_MS) || GENERATE_MS});
  timings.generateSec = Number(((Date.now() - t) / 1000).toFixed(1));
  if (reply.encodeSec != null) timings.encodeSec = reply.encodeSec;   // 生成の内の、文章の符号化(キャッシュに無い文章だけ)

  await ctx.step('候補を確かめる');
  const candidates = [], dropped = [];
  for (const c of reply.candidates) {
    if (!(c.hipsMaxM <= MAX_HIPS_M)) {
      dropped.push({n: c.n, seed: c.seed, reason: `hips が ${c.hipsMaxM} m まで上がる（上限 ${MAX_HIPS_M} m）`});
      await fs.rm(path.join(candDir(workDir), String(c.n)), {recursive: true, force: true});
    } else candidates.push({n: c.n, seed: c.seed, frames: c.frames, durationSec: c.durationSec, hipsMaxM: c.hipsMaxM, travelM: c.travelM, generateSec: c.generateSec,
      vrmaUrl: urlOf(job.id, c.n, 'motion.vrma'), contactsUrl: urlOf(job.id, c.n, 'contacts.json')});
  }
  for (const d of dropped) ctx.log(`候補 ${d.n}（seed ${d.seed}）を捨てた: ${d.reason}\n`);
  if (!candidates.length) throw new Error(`作った ${reply.candidates.length} 本とも、hips が ${MAX_HIPS_M} m を超えて壊れていた（${dropped.map(d => d.reason).join('、')}）。文章か長さを替えてやり直す`);
  timings.totalSec = Number(((Date.now() - t0) / 1000).toFixed(1));
  return {review: 'waiting', label: i.label, text: i.text, segments, english: segments.map(s => s.prompt).join(' '), root: i.root, model: MODEL, fake: !!fake,
    candidates, dropped, licenseSummary: motionTextLicense().summary, durationSec: candidates[0].durationSec, frames: candidates[0].frames, timings, encoder: reply.encoder ?? null};
}

// ライセンスの記録(motion.json の license)。値は lib/model-licenses.json の kimodoText(tools/compose/records.py も同じファイルを読む)。
// 見本の動き(MotionBricks の BVH)は使わない。商用で使えるかの判断はここに書かない(条件の事実だけ)
const LICENSES = JSON.parse(fsSync.readFileSync(new URL('./model-licenses.json', import.meta.url), 'utf8'));
export function motionTextLicense() {
  return structuredClone(LICENSES.kimodoText);
}

// 確認の画面の「取り込む」。job は jobs.mjs が確かめた、確認待ちのジョブ。選ばなかった候補のファイルは消す(作業フォルダの中の作り直せるもの)
// keep: 消さない候補の番号(順番待ちか実行中のつなぐジョブが区間に使っている候補)
export async function importMotionText(lib, workDir, job, body, env = {}, keep = new Set()) {
  const r = job.result, n = int(body.n, 'n', [1, CANDIDATES.max], null);
  const cand = r.candidates.find(c => c.n === n);
  if (!cand) throw new LibraryError('bad-input', `候補 ${body.n} は無い（${r.candidates.map(c => c.n).join('・')}）`);
  if (body.label != null && typeof body.label !== 'string') throw new LibraryError('bad-input', 'label は文字列');
  const label = (body.label ?? '').trim() || r.label;
  if ([...label].length > MAX_LABEL) throw new LibraryError('bad-input', `label は ${MAX_LABEL} 文字まで`);
  const id = body.motionId ? checkId(body.motionId, 'モーション ID') : 'text-' + job.id;
  if (await lib.motionExists(id)) throw new LibraryError('exists', `モーション ${id} は既にある(上書きしない)`);
  const dir = path.join(candDir(workDir), String(n));
  const generated = {tool: 'Kimodo', model: MODEL, fake: r.fake, job: job.id, text: job.input.text, english: r.english, segments: r.segments, seed: cand.seed, candidate: n,
    candidates: r.candidates.length, root: r.root, frames: cand.frames, fps: 30, durationSec: cand.durationSec, travelM: cand.travelM, hipsMaxM: cand.hipsMaxM,
    translation: r.fake ? {tool: '試しの動き'} : {tool: 'claude -p', model: env.CHARASTA_CLAUDE_MODEL || 'sonnet'}, sampleMotions: false, timings: r.timings,
    retarget: 'SOMA の T ポーズからのワールドの回転の差を VRM の正規化した骨へ（docs/adr/0003-motionbricks-retarget.md）'};
  const m = await lib.importMotion({id, name: label, label, data: await fs.readFile(path.join(dir, 'motion.vrma')), sourcePath: '', pack: 'Kimodo で生成（文章から）',
    license: motionTextLicense(), generated, contacts: await readJsonOr(path.join(dir, 'contacts.json'))});
  for (const c of r.candidates) if (c.n !== n && !keep.has(c.n)) await dropCandidate(workDir, c.n);
  return m;
}

// 候補 1 つのフォルダ(cand/<n>/)だけを消す。n は 1〜9 の 1 桁に限る
export async function dropCandidate(workDir, n) {
  if (!/^[1-9]$/.test(String(n))) throw new LibraryError('bad-input', `候補の番号が不正: ${n}`);
  await fs.rm(path.join(candDir(workDir), String(n)), {recursive: true, force: true});
}

// 候補のファイル(配るのは VRMA と contacts.json だけ)
export function candidateFile(workDir, n, name) {
  if (!/^[1-9]$/.test(String(n)) || !['motion.vrma', 'contacts.json'].includes(name)) throw new LibraryError('not-found', `候補のファイル ${n}/${name} は無い`);
  return path.join(candDir(workDir), String(n), name);
}
