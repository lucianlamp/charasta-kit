// モーションをつなぐジョブ motion-recipe(docs/motion-compose.md の「画面からつなぐ」)。
//   レシピ(保管場所のモーションの ID、確認待ちのジョブの結果、MotionBricks の条件の並びと、間のつなぎ) -> tools/compose/compose.py(子プロセス) -> つないだ VRMA と report.json -> 確認待ち
// 本番のモーションには入れない。確認の画面で「取り込む」を押して初めてモーションになる。motion.json は書き換えない(ADR 0002)。
// MotionBricks の条件の区間は compose.py が motionbricks_gen.py で作る(条件は motion-gen ジョブと同じ規則、lib/motion-gen.mjs の motionGenConditions)。
// 確認待ちのジョブの結果(文章の候補 motion-text、動画の結果 video-motion、MotionBricks の結果 motion-gen)は、取り込みと同じファイルと利用条件を読み、実行の直前に作業フォルダへ写してから使う。
// 試しの動き(環境変数。サーバーの config.env でも渡せる):
//   CHARASTA_FAKE_MOTIONBRICKS=1  compose.py に --fake を付ける(MotionBricks を呼ばず、MotionBricks の区間は作りものの動き、つなぎは補間)。fail はつなぐ前の失敗
//   CHARASTA_MOTION_RECIPE_TIMEOUT_MS  compose.py の時間の上限(ミリ秒)。省くと 15 分(初回は MotionBricks が TensorRT のエンジンを作る)
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {root} from './config.mjs';
import {venvPython} from './platform.mjs';
import {LibraryError, checkId, readJsonOr, writeJson} from './library.mjs';
import {limitOf} from './terms.mjs';
import {candidateFile, motionTextLicense} from './motion-text.mjs';
import {clipFile} from './video-motion.mjs';
import {motionGenConditions, motionGenLicense, describe as describeGen, genFile, mbEnv} from './motion-gen.mjs';

export const MAX_SEGMENTS = 8, MIN_SEGMENTS = 2, MAX_LABEL = 100;
export const SPEED = [0.25, 4];
export const BRIDGE_SECONDS = [0, 3];
// つなぎの作り方。MotionBricks の範囲(0.53〜1.87 秒)の外は compose.py が補間にして、理由を記録に書く
export const BRIDGE_METHODS = {motionbricks: 'MotionBricks で作る', interpolate: '補間'};
export const MOTIONBRICKS_SECONDS = [16 / 30, 56 / 30];
export const DEFAULT_BRIDGE = {seconds: 1.2, method: 'motionbricks'};
// 区間に使える確認待ちのジョブの種類
export const JOB_SOURCES = {'motion-text': '文章', 'video-motion': '動画', 'motion-gen': 'MotionBricks'};
const TIMEOUT_MS = 15 * 60 * 1000;
const PACK = 'motion-compose（モーションをつないだ）';
const COMPOSE = path.join(root, 'tools', 'compose', 'compose.py');
// 確認の画面に出す report.json の値(全部は generated と一緒に取り込む)
const REPORT_KEYS = ['frames', 'seconds', 'seams', 'elsewhereP99', 'footSlide', 'hipsHeight', 'handInBody'];

async function isDir(dir) { try { return !!dir && (await fs.stat(dir)).isDirectory(); } catch { return false; } }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

// 画面が読むもの(GET /api/motion-recipes の options)
export async function motionRecipeOptions(motionbricksDir, env, {defaultMethod} = {}) {
  return {motionbricks: !!env.CHARASTA_FAKE_MOTIONBRICKS || await isDir(motionbricksDir), motionbricksDir: motionbricksDir ?? null, fake: env.CHARASTA_FAKE_MOTIONBRICKS ? String(env.CHARASTA_FAKE_MOTIONBRICKS) : null,
    maxSegments: MAX_SEGMENTS, minSegments: MIN_SEGMENTS, speed: SPEED, bridgeSeconds: BRIDGE_SECONDS, bridgeMethods: BRIDGE_METHODS, motionbricksSeconds: MOTIONBRICKS_SECONDS,
    defaultBridge: defaultMethod ? {...DEFAULT_BRIDGE, method: defaultMethod} : DEFAULT_BRIDGE};
}

// ---- 確認待ちのジョブの結果を区間にする({source: 'job', job, n?})。jobs は jobs.mjs が渡す {get(id): ジョブか null, dir(id): 作業フォルダ} ----

// ジョブの結果 1 本を、取り込みと同じ規則で読む: VRMA と接地のファイル、利用条件(文章は Kimodo の記録、動画はジョブが作った記録をそのまま)。
// reviews は受け付ける確認の状態。積むときは waiting だけ。実行の直前は imported も受ける(取り込んでも、その候補のファイルは残る)
export function jobSource(jobs, id, n, at, reviews = ['waiting']) {
  const job = jobs.get(id);
  if (!job || !JOB_SOURCES[job.type]) throw new LibraryError('not-found', `${at} のジョブ ${id} が無い（文章、動画、MotionBricks のジョブだけを使える）`);
  if (job.state !== 'done' || !reviews.includes(job.result?.review)) {
    const why = job.result?.review === 'imported' ? `。取り込んだので保管場所のモーション ${job.result.motionId} を使う` : job.result?.review === 'discarded' ? '（捨てた）' : '';
    throw new LibraryError('bad-input', `${at} のジョブ ${id} は確認待ちではない${why}`);
  }
  const r = job.result, dir = jobs.dir(id);
  if (job.type === 'motion-text') {
    const c = r.candidates.find(x => x.n === n);
    if (!c) throw new LibraryError('bad-input', `${at} の n は文章のジョブの候補の番号（${r.candidates.map(x => x.n).join('・')}）`);
    return {type: job.type, job: id, n, name: `${r.label}（候補 ${n}）`, durationSec: c.durationSec, license: motionTextLicense(), pack: 'Kimodo で生成（文章から）',
      vrma: candidateFile(dir, n, 'motion.vrma'), contacts: candidateFile(dir, n, 'contacts.json')};
  }
  if (n != null) throw new LibraryError('bad-input', `${at} の${JOB_SOURCES[job.type]}のジョブは結果が 1 本なので n を書かない`);
  if (!r.license) throw new LibraryError('bad-input', `${at} のジョブ ${id} の結果に利用条件の記録が無い（推測で埋めない）`);
  if (job.type === 'motion-gen') return {type: job.type, job: id, n: null, name: r.label, durationSec: r.durationSec, license: r.license, pack: 'MotionBricks で生成',
    vrma: genFile(dir, 'motion.vrma'), contacts: genFile(dir, 'contacts.json')};
  return {type: job.type, job: id, n: null, name: r.label, durationSec: r.durationSec, license: r.license, pack: 'vrma-pipeline（動画から変換）',
    vrma: clipFile(dir, 'clip.vrma'), contacts: clipFile(dir, 'contacts.json')};
}

// 「つくる」の一覧に出す確認待ちの結果(文章は候補ごと、動画と MotionBricks は 1 本)。waiting は確認待ちのジョブ
export function jobSources(jobs, waiting) {
  return waiting.flatMap(j => (j.type === 'motion-text' ? j.result.candidates.map(c => c.n) : [null]).map(n => {
    const s = jobSource(jobs, j.id, n, '一覧');
    return {job: s.job, n: s.n, type: s.type, kind: JOB_SOURCES[s.type], name: s.name, durationSec: s.durationSec, license: s.license, limit: limitOf(s)};
  }));
}

// 配列などは Number() が数に直してしまう(['2'] -> 2)ので、number か数字の string だけを通す
function num(value, name, [lo, hi], fallback) {
  const blank = value === undefined || value === null || value === '';
  const v = blank ? fallback : typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  if (v === null) return null;
  if (!Number.isFinite(v) || v < lo || v > hi) throw new LibraryError('bad-input', `${name} は ${lo}〜${hi} の数`);
  return v;
}

function bridgeOf(value, name, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'object' || Array.isArray(value)) throw new LibraryError('bad-input', `${name} は {seconds, method}`);
  const method = value.method ?? fallback.method;
  if (typeof method !== 'string' || !Object.hasOwn(BRIDGE_METHODS, method)) throw new LibraryError('bad-input', `${name}.method は ${Object.keys(BRIDGE_METHODS).join(' / ')}`);
  return {seconds: num(value.seconds, `${name}.seconds`, BRIDGE_SECONDS, fallback.seconds), method};
}

// 積むときの確かめ。区間は保管場所のモーションの ID か、確認待ちのジョブの結果か、MotionBricks の条件。bridge は全体の既定、区間の bridge はその区間の前のつなぎ。
// MotionBricks の区間の speed は動きの速さ(m/s。motion-gen と同じ)なので、再生の速さは変えられない(速さの条件で決める)
export async function motionRecipeInput(lib, body, jobs, {defaultMethod} = {}) {
  const list = body.segments;
  if (!Array.isArray(list) || list.length < MIN_SEGMENTS || list.length > MAX_SEGMENTS) throw new LibraryError('bad-input', `segments は ${MIN_SEGMENTS}〜${MAX_SEGMENTS} 個の配列`);
  const bridge = bridgeOf(body.bridge, 'bridge', defaultMethod ? {...DEFAULT_BRIDGE, method: defaultMethod} : DEFAULT_BRIDGE);
  const names = [];
  const segments = [];
  for (const [k, s] of list.entries()) {
    const at = `区間 ${k + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new LibraryError('bad-input', `${at} は連想配列`);
    let seg, dur, name;
    if (s.source === 'motion') {
      const id = checkId(s.motion, `${at} のモーション ID`);
      if (!await lib.motionExists(id)) throw new LibraryError('not-found', `${at} のモーション ${id} が無い`);
      const m = await lib.getMotion(id);
      seg = {source: 'motion', motion: id}; dur = Number(m.durationSec); name = m.label || m.name || id;
    } else if (s.source === 'job') {
      const id = checkId(s.job, `${at} のジョブ ID`);
      if (s.n != null && !(Number.isInteger(s.n) && s.n >= 1)) throw new LibraryError('bad-input', `${at} の n は 1 からの整数`);
      const src = jobSource(jobs, id, s.n ?? null, at);
      seg = {source: 'job', job: id, ...(src.n != null && {n: src.n})}; dur = Number(src.durationSec); name = src.name;
    } else if (s.source === 'motionbricks') {
      // 長さは動く秒数で、止まる分は作るまで分からない。切り出しの終わりは compose.py が最後のコマに収める
      seg = {source: 'motionbricks', ...motionGenConditions(s, `${at} の `)}; dur = seg.seconds; name = describeGen(seg);
    } else throw new LibraryError('bad-input', `${at} の source は motion（保管場所のモーション）、job（確認待ちのジョブの結果）、motionbricks（MotionBricks の条件）のどれか`);
    if (s.trim != null) {
      if (!Array.isArray(s.trim) || s.trim.length !== 2) throw new LibraryError('bad-input', `${at} の trim は [開始の秒, 終了の秒 か null]`);
      const endMax = seg.source === 'motionbricks' ? Infinity : dur;
      const start = num(s.trim[0], `${at} の trim の開始`, [0, dur], 0), end = num(s.trim[1], `${at} の trim の終了`, [0, endMax], null);
      if (end !== null && end - start < 0.1) throw new LibraryError('bad-input', `${at} の trim の終了は開始より 0.1 秒以上あと`);
      if (end === null && dur - start < 0.1) throw new LibraryError('bad-input', `${at} の trim の開始は終わり（${dur} 秒）より 0.1 秒以上前`);
      if (start > 0 || end !== null) seg.trim = [start, end];
    }
    if (seg.source !== 'motionbricks') {
      const speed = num(s.speed, `${at} の speed`, SPEED, 1);
      if (speed !== 1) seg.speed = speed;
    }
    if (s.bridge != null) {
      if (k === 0) throw new LibraryError('bad-input', '最初の区間の前につなぎは無い（bridge は 2 つ目から）');
      seg.bridge = bridgeOf(s.bridge, `${at} の bridge`, bridge);
    }
    segments.push(seg);
    names.push(name);
  }
  if (body.label != null && typeof body.label !== 'string') throw new LibraryError('bad-input', 'label は文字列');
  const label = (body.label ?? '').trim() || [...names.join(' + ')].slice(0, MAX_LABEL).join('');
  if ([...label].length > MAX_LABEL) throw new LibraryError('bad-input', `label は ${MAX_LABEL} 文字まで`);
  return {label, segments, bridge};
}

// compose.py の計画。srcs[k] は区間の {name, plan}。plan は区間の中身で、保管場所のモーションは {motion}、ジョブの結果は {path, contacts?, license, motionRecord}(どちらも source は vrma)、
// MotionBricks の条件は {source: 'motionbricks', kind, speed, …}。
// 区間の label は「番号: 名前」(report.json と spans の名前になる)
export function composePlan(libraryDir, input, srcs) {
  return {library: libraryDir, bridge: input.bridge, segments: input.segments.map((s, k) => ({source: 'vrma', ...srcs[k].plan, label: `${k + 1}: ${srcs[k].name}`,
    ...(s.trim && {trim: s.trim}), ...(s.speed && {speed: s.speed}), ...(s.bridge && {bridge: s.bridge})}))};
}

// MotionBricks の条件の区間。許諾は作る前なので見本の動きの一覧が空(compose.py が作ったあとに使った BVH を入れる)
function genSource(s) {
  const {source, trim, bridge, ...conditions} = s;
  return {name: describeGen(conditions), limit: limitOf({license: motionGenLicense([])}), plan: {source: 'motionbricks', ...conditions}};
}

// 実行の直前に、ジョブの結果を作業フォルダの segments/<番号>/ へ写す。写したあとはジョブが捨てられても取り込まれても使える。
// 記録(motionRecord)は保管場所のモーションと同じ形(id、library、sha256、source、contacts)で、どのジョブのどの候補かを job に残す
async function copyJobSource(jobs, s, k, workDir, libraryDir) {
  const at = `区間 ${k + 1}`, src = jobSource(jobs, s.job, s.n ?? null, at, ['waiting', 'imported']);
  if (!await exists(src.vrma)) throw new Error(`${at} のジョブ ${s.job} の結果のファイルが無い（${src.n ? `候補 ${src.n}。` : ''}捨てたか、別の候補を取り込んで消えた）`);
  const dir = path.join(workDir, 'segments', String(k + 1)), vrma = path.join(dir, 'motion.vrma'), contacts = path.join(dir, 'contacts.json'), license = path.join(dir, 'license.json');
  await fs.mkdir(dir, {recursive: true});
  await fs.copyFile(src.vrma, vrma);
  const hasContacts = await exists(src.contacts);
  if (hasContacts) await fs.copyFile(src.contacts, contacts);
  await writeJson(license, src.license);
  const sha256 = crypto.createHash('sha256').update(await fs.readFile(vrma)).digest('hex');
  return {name: src.name, limit: limitOf(src), plan: {path: vrma, ...(hasContacts && {contacts}), license,
    motionRecord: {id: null, library: libraryDir, sha256, source: {path: path.relative(libraryDir, src.vrma).split(path.sep).join('/'), pack: src.pack}, contacts: hasContacts ? 'contacts.json' : null,
      job: {id: s.job, type: src.type, candidate: src.n}}}};
}

const outDir = workDir => path.join(workDir, 'out');
const urlOf = (jobId, file) => `/api/motion-recipes/${jobId}/${file}`;

// ジョブ 1 件を動かす。ctx は jobs.mjs の {job, workDir, log, step, run}。jobs は区間のジョブを引くもの(jobSource の jobs)。取り込みはしない
export async function runMotionRecipe(ctx, {lib, tools, env, jobs}) {
  const {job, workDir} = ctx, i = job.input, fake = env.CHARASTA_FAKE_MOTIONBRICKS ? String(env.CHARASTA_FAKE_MOTIONBRICKS) : null;
  const bridges = i.segments.slice(1).map(s => s.bridge ?? i.bridge);
  const genSegs = i.segments.some(s => s.source === 'motionbricks');
  const usesMb = genSegs || bridges.some(b => b.method === 'motionbricks' && b.seconds > 0);
  if (fake === 'fail') throw new Error('試しの動き: つなぐ前に失敗した');
  if (usesMb && !fake && !await isDir(tools.motionbricksDir)) throw new Error(`MotionBricks が見つからない（設定の motionbricksDir: ${tools.motionbricksDir ?? 'なし'}）。${genSegs ? 'MotionBricks の条件の区間を外し、' : ''}つなぎを補間にすれば動かせる`);

  await ctx.step('区間を確認する');
  const srcs = [];
  for (const [k, s] of i.segments.entries()) {   // 積んだあとに消されたモーションや結果が無くなったジョブは、compose.py より前に分かりやすく断る
    if (s.source === 'job') { srcs.push(await copyJobSource(jobs, s, k, workDir, lib.dir)); continue; }
    if (s.source === 'motionbricks') { srcs.push(genSource(s)); continue; }
    if (!await lib.motionExists(s.motion)) throw new Error(`モーション ${s.motion} が保管場所に無い（受け付けたあとに消された？）`);
    const m = await lib.getMotion(s.motion);
    srcs.push({name: m.label || m.name || m.id, limit: m.limit, plan: {motion: s.motion}});
  }
  const plan = composePlan(lib.dir, i, srcs), planFile = path.join(workDir, 'plan.json');
  await fs.writeFile(planFile, JSON.stringify(plan, null, 2));

  await ctx.step(fake ? 'つなぐ（試しの動き。つなぎは補間）' : genSegs ? 'つなぐ（MotionBricks で区間とつなぎを作る）' : usesMb ? 'つなぐ（MotionBricks でつなぎを作る）' : 'つなぐ（補間）');
  const out = outDir(workDir);
  await ctx.run('python', [COMPOSE, planFile, '--out', out, '--work', path.join(workDir, 'work'), ...(fake ? ['--fake'] : [])], {
    // compose.py の外の道具の場所は設定から渡す(compose.py に既定の場所は無い)
    env: {CHARASTA_LIBRARY: lib.dir, ...(tools.motionbricksDir && {MOTIONBRICKS_DIR: tools.motionbricksDir, ...mbEnv(tools)}), ...(tools.vrmaPipelineDir && {VRMA_PIPELINE_DIR: tools.vrmaPipelineDir}),
      ...(tools.kimodoDir && {KIMODO_PYTHON: venvPython(tools.kimodoDir)}), ...(tools.hfCacheDir && {HF_HUB_CACHE: tools.hfCacheDir}), ...((env.CHARASTA_BLENDER || tools.blender) && {VRMA_BLENDER: env.CHARASTA_BLENDER || tools.blender})},
    timeoutMs: Number(env.CHARASTA_MOTION_RECIPE_TIMEOUT_MS) || TIMEOUT_MS});

  await ctx.step('結果を確認する');
  const generated = await readJsonOr(path.join(out, 'generated.json')), report = await readJsonOr(path.join(out, 'report.json')), license = await readJsonOr(path.join(out, 'license.json'));
  if (!generated || !report || !license) throw new Error('compose.py の出力(generated.json、report.json、license.json)が揃っていない');
  return {review: 'waiting', label: i.label, fake: !!fake, frames: generated.frames, durationSec: generated.durationSec,
    segments: i.segments.map((s, k) => ({...s, name: srcs[k].name, limit: srcs[k].limit})), bridges: generated.bridges, spans: generated.spans,
    report: Object.fromEntries(REPORT_KEYS.filter(k => k in report).map(k => [k, report[k]])), license,
    vrmaUrl: urlOf(job.id, 'motion.vrma'), contactsUrl: urlOf(job.id, 'contacts.json')};
}

// 確認の画面の「取り込む」。job は jobs.mjs が確かめた、確認待ちのジョブ
export async function importMotionRecipe(lib, workDir, job, body) {
  const r = job.result, out = outDir(workDir);
  if (body.label != null && typeof body.label !== 'string') throw new LibraryError('bad-input', 'label は文字列');
  const label = (body.label ?? '').trim() || r.label;
  if ([...label].length > MAX_LABEL) throw new LibraryError('bad-input', `label は ${MAX_LABEL} 文字まで`);
  const id = body.motionId ? checkId(body.motionId, 'モーション ID') : 'compose-' + job.id;
  if (await lib.motionExists(id)) throw new LibraryError('exists', `モーション ${id} は既にある（上書きしない）`);
  const g = await readJsonOr(path.join(out, 'generated.json'));
  const generated = {...g, tool: 'motion-compose', job: job.id, fake: r.fake, recipe: {segments: job.input.segments, bridge: job.input.bridge}, report: await readJsonOr(path.join(out, 'report.json'))};
  return lib.importMotion({id, name: label, label, data: await fs.readFile(path.join(out, 'motion.vrma')), sourcePath: '', pack: PACK,
    license: await readJsonOr(path.join(out, 'license.json')), generated, contacts: await readJsonOr(path.join(out, 'contacts.json'))});
}

// 確認の画面が読むファイル(VRMA と contacts.json だけ配る)
export function recipeFile(workDir, name) {
  if (!['motion.vrma', 'contacts.json'].includes(name)) throw new LibraryError('not-found', `ファイル ${name} は無い`);
  return path.join(outDir(workDir), name);
}
