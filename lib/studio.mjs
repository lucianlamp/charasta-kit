// 表情づくり(docs/expression-studio.md): 保管場所の studio/<キャラ>/<ID>/ の作業場所と work.json。
// 版と違い中身は作業中に変わる。きゃらくるのプロジェクトは読むだけで、材料はコピーしてから使う(ADR 0001)。
// 工程ごとに「入力の指紋」(使うファイルの sha256 と設定の JSON をまとめたハッシュ)を残し、今の指紋と違えば「古い」。
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {root} from './config.mjs';
import {LibraryError, checkId, inside, readJsonOr, rejectCreature, writeJson} from './library.mjs';
import {readZipMember} from './zip.mjs';
import {projectProgress} from './overview.mjs';

const run = promisify(execFile);
const now = () => new Date().toISOString();
const exists = f => fs.access(f).then(() => true, () => false);
// 材料のコピー中(work.json の steps.copy が running)。動かしているプロセスが死んでいれば、止まった残りとして数えない
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export const copyBusy = w => w.steps.copy?.state === 'running' && pidAlive(w.steps.copy.pid);
export const busyOf = w => Object.entries(w.steps).filter(([k, s]) => k === 'copy' ? copyBusy(w) : s.state === 'queued' || s.state === 'running').map(([k]) => k);

// 工程の順(docs/expression-studio.md の表の 1・2・4・5・7・8・9。3 と 6 は 3b)
export const STEPS = ['copy', 'front', 'rects', 'build', 'video', 'checks', 'promote'];
export const STEP_LABELS = {copy: '1 材料をコピー', front: '2 正面を撮る', rects: '4 区画の範囲', build: '5 組み立て', video: '7 中割り', checks: '8 確かめ', promote: '9 版にする'};
// ジョブの種類 -> 工程
export const STUDIO_JOBS = {'studio-front': 'front', 'studio-build': 'build', 'studio-video': 'video', 'studio-checks': 'checks'};
export const EXPRESSIONS = ['blink', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh'];
// 依頼の工程(docs/expression-studio.md の 3 と 6。Claude が image_gen で候補を出し、画面で人が採用か却下を決める)
export const REQUEST_STEPS = {face: '3 顔の絵', expr: '6 表情の絵'};
// 依頼の状態: 未着手(Claude が読む) -> 候補あり(画面で決める) -> 採用済み。候補を全部却下すると未着手に戻る。取り下げは人が閉じたもの
export const REQUEST_STATES = ['未着手', '候補あり', '採用済み', '取り下げ'];
const MAX_REQUEST_TEXT = 2000;
const isPng = b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const SUBDIRS = ['inputs', 'face', 'candidates', 'drawn', 'video', 'out', 'checks', 'work'];
// 画面と /lib/studio/ で配ってよい場所(材料の .blend と work/ は配らない)
export const SERVED = ['face', 'drawn', 'video', 'out', 'checks', 'candidates'];

export const DEFAULT_OPTIONS = {
  // 2 正面を撮る: align = 位置合わせする採用した絵(最初の絵の位置合わせを全部に使う。--same)、
  // cheek = 頭のテクスチャに焼くチーク {overlay, align: 位置合わせの名前}、jaw = あごをなめらかにする {mouthZ, cuts, iters}
  front: {size: 2048, align: [], cheek: null, jaw: null},
  // 5 組み立て: atlas.cells = 区画ごとの絵(無い表情は neutral の絵)、atlas.env / gaze.env = スクリプトの環境変数、
  // gaze.holeMask = 目の中の範囲(区画の座標)、gaze.holeGreen = {file, align}: 目の中を緑で塗った絵から、組み立てのたびに区画の座標の範囲を作る
  // (hole_mask.py。holeMask とどちらか一方)、iris =瞳の層を描いた瞳で置き直す {align, irises: [{file, box}], env}
  build: {atlas: {cells: {neutral: 'drawn/neutral.png'}, env: {}, overlay: null}, gaze: {env: {}, holeMask: null}, iris: null},
  // 7 中割り: open = 髪のない中立の区画、videos = [{name, file}](並びのとおり渡す)、drawn = 描いた表情の区画のフォルダ、masks = 開いた所のマスクのフォルダ
  video: {open: null, videos: [], drawn: null, masks: null, env: {}},
  // 組み立てと中割りの最後に、髪の揺れ骨の当たりを整える(with-kimi の spring_tune.py の引数。null なら整えない)
  springTune: null,
};

// ---- ファイルの sha256(大きいファイルを何度も読まないよう、大きさと更新時刻で覚える) ----
const shaCache = new Map();
export async function sha256File(file) {
  const st = await fs.stat(file);
  const hit = shaCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha;
  const sha = await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fsSync.createReadStream(file).on('data', c => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
  shaCache.set(file, {size: st.size, mtimeMs: st.mtimeMs, sha});
  return sha;
}
async function shaOrNull(file) { try { return await sha256File(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function listFiles(dir) {
  const out = [];
  for (const d of await fs.readdir(dir, {withFileTypes: true}).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...await listFiles(p)); else if (d.isFile()) out.push(p);
  }
  return out.sort();
}
const rel = (base, file) => path.relative(base, file).split(path.sep).join('/');

// 設定の中の、作業場所のファイルを指す文字列(drawn/、video/、inputs/ で始まる)
function refsOf(obj, out = new Set()) {
  if (typeof obj === 'string') { if (/^(drawn|video|inputs)\//.test(obj)) out.add(obj); }
  else if (obj && typeof obj === 'object') for (const v of Object.values(obj)) refsOf(v, out);
  return out;
}

// 区画の範囲: {upper: [x0,y0,x1,y1] か四角のリスト, mouth: 同じ(任意)}。座標は正面の撮影の画素(0..size)
export function checkRects(rects, size = 2048) {
  if (!rects || typeof rects !== 'object' || Array.isArray(rects)) throw new LibraryError('bad-input', '区画の範囲は {upper, mouth} の形');
  const bad = Object.keys(rects).filter(k => !['upper', 'mouth'].includes(k));
  if (bad.length) throw new LibraryError('bad-input', '知らない区画: ' + bad.join(', ') + '(upper と mouth だけ)');
  if (!rects.upper) throw new LibraryError('bad-input', 'upper(目・眉の範囲)が要る');
  const out = {};
  for (const [k, v] of Object.entries(rects)) {
    if (v == null) continue;
    const list = Array.isArray(v) && Array.isArray(v[0]) ? v : [v];
    if (!list.length || list.length > 8) throw new LibraryError('bad-input', `${k}: 四角は 1〜8 個`);
    for (const r of list) {
      if (!Array.isArray(r) || r.length !== 4 || !r.every(n => Number.isInteger(n))) throw new LibraryError('bad-input', `${k}: 四角は整数 4 つ [x0, y0, x1, y1]: ${JSON.stringify(r)}`);
      const [x0, y0, x1, y1] = r;
      if (x0 < 0 || y0 < 0 || x1 > size || y1 > size) throw new LibraryError('bad-input', `${k}: 撮影の外(0〜${size}): ${JSON.stringify(r)}`);
      if (x1 - x0 < 8 || y1 - y0 < 8) throw new LibraryError('bad-input', `${k}: 四角が小さすぎる(左上より右下を 8 画素以上先に): ${JSON.stringify(r)}`);
    }
    out[k] = list.length === 1 ? list[0] : list;
  }
  return out;
}

// 設定の中のファイル(作業場所の drawn/ か video/ の下の相対パス)。どの項目がファイルかは studio-jobs.mjs の RUN が読む場所のとおり
function checkOptionFiles(p) {
  const bad = (name, v) => new LibraryError('bad-input', `${name} は drawn/ か video/ の下の相対パス(.. と \\ は使えない): ${JSON.stringify(v)}`);
  const ref = (name, v) => { if (typeof v !== 'string' || !/^(drawn|video)\//.test(v) || v.includes('..') || v.includes('\\')) throw bad(name, v); };
  const obj = (name, v) => { if (v == null) return {}; if (typeof v !== 'object' || Array.isArray(v)) throw new LibraryError('bad-input', `${name} は連想配列`); return v; };
  const list = (name, v) => { if (v == null) return []; if (!Array.isArray(v)) throw new LibraryError('bad-input', `${name} は配列`); return v; };
  const front = obj('front', p.front), build = obj('build', p.build), video = obj('video', p.video);
  list('front.align', front.align).forEach((v, i) => ref(`front.align[${i}]`, v));
  if (front.cheek != null) ref('front.cheek.overlay', obj('front.cheek', front.cheek).overlay);
  const atlas = obj('build.atlas', build.atlas), cells = obj('build.atlas.cells', atlas.cells);
  for (const [k, v] of Object.entries(cells)) ref(`build.atlas.cells.${k}`, v);
  if (atlas.overlay != null) ref('build.atlas.overlay.file', obj('build.atlas.overlay', atlas.overlay).file);
  const gaze = obj('build.gaze', build.gaze);
  if (gaze.holeMask != null) ref('build.gaze.holeMask', gaze.holeMask);
  if (gaze.holeGreen != null) {
    const g = obj('build.gaze.holeGreen', gaze.holeGreen);
    ref('build.gaze.holeGreen.file', g.file);
    if (typeof g.align !== 'string' || !g.align) throw new LibraryError('bad-input', 'build.gaze.holeGreen.align は位置合わせの名前(例 neutral)');
    if (gaze.holeMask != null) throw new LibraryError('bad-input', 'build.gaze は holeMask と holeGreen のどちらか一方');
  }
  if (build.iris != null) list('build.iris.irises', obj('build.iris', build.iris).irises).forEach((it, i) => ref(`build.iris.irises[${i}].file`, obj('build.iris.irises[]', it).file));
  for (const k of ['open', 'drawn', 'masks']) if (video[k] != null) ref(`video.${k}`, video[k]);
  list('video.videos', video.videos).forEach((it, i) => ref(`video.videos[${i}].file`, obj('video.videos[]', it).file));
}

export function checkOptions(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new LibraryError('bad-input', '設定は JSON の連想配列');
  const bad = Object.keys(patch).filter(k => !(k in DEFAULT_OPTIONS));
  if (bad.length) throw new LibraryError('bad-input', '知らない設定: ' + bad.join(', ') + '(' + Object.keys(DEFAULT_OPTIONS).join(' / ') + ')');
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'springTune') { if (v !== null && !(Array.isArray(v) && v.every(s => typeof s === 'string'))) throw new LibraryError('bad-input', 'springTune は文字列の配列か null'); }
    else if (!v || typeof v !== 'object' || Array.isArray(v)) throw new LibraryError('bad-input', `${k} は連想配列`);
  }
  for (const r of refsOf(patch)) if (r.includes('..') || r.includes('\\')) throw new LibraryError('bad-input', '作業場所の外を指している: ' + r);
  checkOptionFiles(patch);
}

export class Studio {
  // lib: Library、charakuruApp: きゃらくるのアプリのフォルダ(projects/ を読むだけ)、blender: Blender の実行ファイル
  constructor(lib, {charakuruApp = '', blender = '', env = {}} = {}) {
    this.lib = lib; this.charakuruApp = charakuruApp; this.blender = blender; this.extraEnv = env;
    this.locks = new Map();
  }

  get env() { return {...process.env, ...this.extraEnv}; }
  dir(charId, id) { return inside(this.lib.dir, 'studio', checkId(charId, 'キャラ ID'), checkId(id, '表情づくり ID')); }
  file(charId, id, relPath) { return inside(this.dir(charId, id), relPath); }
  url(charId, id, relPath) { return '/lib/studio/' + [charId, id, ...relPath.split('/')].map(encodeURIComponent).join('/'); }

  // work.json を読み書きする間は同じ表情づくりの書き込みを待たせる(サーバーの中の API とジョブの取り合い)
  async update(charId, id, fn) {
    const key = charId + '/' + id, prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const w = await this.read(charId, id);
      const r = await fn(w);
      await writeJson(path.join(this.dir(charId, id), 'work.json'), w);
      return r === undefined ? w : r;
    });
    this.locks.set(key, next.catch(() => {}));
    return next;
  }

  // ジョブが順番待ちか実行中の間は、材料・採用した絵・区画・設定を変えない(ジョブが読んでいる途中のファイルを替えないため。
  // CLI は別のプロセスなので、サーバーが work.json に書く工程の状態で見る)
  async assertIdle(charId, id) {
    const w = await this.read(charId, id), busy = busyOf(w);
    if (busy.length) throw new LibraryError('exists', `ジョブ(${busy.join('・')})が順番待ちか実行中なので、終わってから変える`);
    return w;
  }

  async read(charId, id) {
    const w = await readJsonOr(path.join(this.dir(charId, id), 'work.json'));
    if (!w) throw new LibraryError('not-found', `表情づくり ${charId}/${id} が無い`);
    return w;
  }

  async create({charId, id, note = ''}) {
    rejectCreature(await this.lib.getCharacterJson(checkId(charId, 'キャラ ID')), '表情づくり');
    id = id ? checkId(id, '表情づくり ID') : 's' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex');
    if (typeof note !== 'string') throw new LibraryError('bad-input', 'note は文字列');
    const dir = this.dir(charId, id);
    await fs.mkdir(path.dirname(dir), {recursive: true});
    try { await fs.mkdir(dir); } catch (e) { if (e.code === 'EEXIST') throw new LibraryError('exists', `表情づくり ${charId}/${id} は既にある`); throw e; }
    for (const d of SUBDIRS) await fs.mkdir(path.join(dir, d));
    const w = {id, charId, note, createdAt: now(), source: null, inputs: [], adopted: [], rects: null,
      options: structuredClone(DEFAULT_OPTIONS), steps: {}, prototypes: [], checks: [], versions: [], requests: []};
    await writeJson(path.join(dir, 'work.json'), w);
    return w;
  }

  async list(charId) {
    const base = inside(this.lib.dir, 'studio', checkId(charId, 'キャラ ID'));
    const ids = (await fs.readdir(base, {withFileTypes: true}).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).filter(d => d.isDirectory()).map(d => d.name).sort();
    const out = [];
    for (const id of ids) {
      const w = await readJsonOr(path.join(base, id, 'work.json'));
      if (w) out.push({id: w.id, note: w.note, createdAt: w.createdAt, source: w.source, prototypes: w.prototypes.length, versions: w.versions.map(v => v.verId),
        steps: Object.fromEntries(Object.entries(w.steps).map(([k, s]) => [k, s.state]))});
    }
    return out;
  }

  // ---- 1 材料をコピー ----
  async listProjects() {
    const base = path.join(this.charakuruApp, 'projects');
    const out = [];
    for (const d of await fs.readdir(base, {withFileTypes: true}).catch(() => [])) {
      if (!d.isDirectory()) continue;
      const dir = path.join(base, d.name), blend = path.join(dir, 'work', 'character.blend');
      let name = null, savedAt = null, progress = null;
      try { const p = JSON.parse((await readZipMember(path.join(dir, 'project.charakit'), 'project.json')).toString('utf8')); name = p.name ?? null; savedAt = p.savedAt ?? null; progress = projectProgress(p); } catch { /* 正本が無い・読めないプロジェクト */ }
      const st = await fs.stat(blend).catch(() => null);
      out.push({id: d.name, name, savedAt, hasBlend: !!st, blendModified: st ? st.mtime.toISOString() : null, hasReview: await exists(path.join(dir, 'work', 'review.vrm')), progress});
    }
    return out.sort((a, b) => String(b.blendModified).localeCompare(String(a.blendModified)));
  }

  // .blend が読む外部の画像(取り込んで固めていないもの)を Blender で調べる。CHARASTA_FAKE_BLENDER では調べない。
  async externalImages(blend) {
    if (this.env.CHARASTA_FAKE_BLENDER) return [];
    const {stdout} = await run(this.blender, ['-b', '--factory-startup', blend, '--python', path.join(root, 'studio', 'list_images.py')], {maxBuffer: 16 << 20, windowsHide: true});
    const line = stdout.split(/\r?\n/).find(l => l.startsWith('IMAGES '));
    if (!line) throw new Error('Blender で画像を調べられなかった: ' + stdout.slice(-300));
    return JSON.parse(line.slice(7)).filter(i => !i.packed && i.abs);
  }

  // project: きゃらくるのプロジェクトの ID、fromStudio: 同じキャラの前の表情づくりの ID。元は読むだけ。
  async copyInputs(charId, id, {project, fromStudio} = {}) {
    if (!project === !fromStudio) throw new LibraryError('bad-input', 'project か fromStudio のどちらか一方を指定する');
    if (fromStudio === id) throw new LibraryError('bad-input', '自分自身からはコピーできない');
    await this.assertIdle(charId, id);
    const dir = this.dir(charId, id), inDir = path.join(dir, 'inputs');
    let files, source;
    if (project) {
      const pdir = inside(path.join(this.charakuruApp, 'projects'), checkId(project, 'プロジェクト ID'));
      const blend = path.join(pdir, 'work', 'character.blend');
      if (!await exists(blend)) throw new LibraryError('not-found', 'プロジェクトに work/character.blend が無い: ' + project);
      files = [{name: 'character.blend', from: blend}];
      const review = path.join(pdir, 'work', 'review.vrm');   // 組み立て(face_vrm.py build)が残すメッシュを決める見本
      if (await exists(review)) files.push({name: 'review.vrm', from: review});
      const names = new Set();
      for (const img of await this.externalImages(blend)) {
        if (!await exists(img.abs)) throw new LibraryError('not-found', `.blend が読む画像が無い: ${img.abs}`);
        const ext = path.extname(img.abs), base = path.basename(img.abs, ext);
        let name = base + ext;
        for (let i = 2; names.has(name.toLowerCase()); i++) name = `${base}-${i}${ext}`;   // 別のフォルダの同じ名前
        names.add(name.toLowerCase());
        files.push({name: 'images/' + name, from: img.abs, blendPath: img.filepath});
      }
      source = {type: 'charakuru', project, dir: pdir};
    } else {
      const src = await this.read(charId, checkId(fromStudio, '表情づくり ID'));
      if (!src.inputs.length) throw new LibraryError('bad-input', `表情づくり ${fromStudio} には材料が無い`);
      // 前の表情づくりの .blend は、もうその inputs/images/ を指している(linkedPath)
      files = src.inputs.map(f => ({name: f.name, from: this.file(charId, fromStudio, 'inputs/' + f.name), blendPath: f.linkedPath ?? f.blendPath}));
      source = {type: 'studio', studio: fromStudio};
    }
    // コピーは inputs.new/ に行い、全部済んでから入れ替える(途中で失敗しても前の材料が残る)。
    // コピー中は steps.copy を running にして、ジョブを積めなくする(積むときの確かめと assertIdle が断る)。
    // 確かめと書き込みは update の中で一度にやる(同時に 2 つのコピーが通らないように)
    const newDir = path.join(dir, 'inputs.new');
    await this.update(charId, id, w => {
      const busy = busyOf(w);
      if (busy.length) throw new LibraryError('exists', `ジョブ(${busy.join('・')})が順番待ちか実行中なので、終わってから変える`);
      w.steps.copy = {...(w.steps.copy ?? {}), state: 'running', pid: process.pid, at: now(), error: null};
    });
    try {
      await fs.rm(newDir, {recursive: true, force: true});
      await fs.mkdir(newDir, {recursive: true});
      const inputs = [];
      for (const f of files) {
        const to = inside(newDir, f.name), st = await fs.stat(f.from);
        await fs.mkdir(path.dirname(to), {recursive: true});
        await fs.copyFile(f.from, to);
        const sha = await sha256File(to);
        if (sha !== await sha256File(f.from)) throw new Error('コピーの途中で元が変わった: ' + f.from);
        inputs.push({name: f.name, from: f.from, sha256: sha, size: st.size, mtimeMs: st.mtimeMs, ...(f.blendPath ? {blendPath: f.blendPath} : {})});
      }
      // 外部の画像は、コピーした .blend の中の場所を inputs/images/ に付け替える(元の .blend は変えない)。
      // 付け替えた先は入れ替えたあとの inputs/ の場所
      const ext = inputs.filter(f => f.blendPath);
      if (ext.length && !this.env.CHARASTA_FAKE_BLENDER) {
        const {stdout} = await run(this.blender, ['-b', '--factory-startup', path.join(newDir, 'character.blend'), '--python', path.join(root, 'studio', 'relink_images.py'), '--',
          JSON.stringify(Object.fromEntries(ext.map(f => [f.blendPath, path.join(inDir, f.name)])))], {maxBuffer: 16 << 20, windowsHide: true});
        const n = Number(/^RELINKED (\d+)/m.exec(stdout)?.[1]);
        if (n !== ext.length) throw new Error(`.blend の画像を付け替えられなかった(付け替える ${ext.length} 枚のうち ${Number.isNaN(n) ? '数が読めない' : n + ' 枚'})`);
        inputs[0].relinkedSha256 = await sha256File(path.join(newDir, 'character.blend'));
        for (const f of ext) f.linkedPath = path.join(inDir, f.name);
      }
      let trashed = null;
      if ((await fs.readdir(inDir).catch(() => [])).length) trashed = await this.#trash(dir, inDir);   // 前の材料は trash/ へ
      await fs.rm(inDir, {recursive: true, force: true});   // 空のフォルダが残っていると、Windows では上に重ねて rename できない
      try { await fs.rename(newDir, inDir); }
      catch (e) { if (trashed) await fs.rename(trashed, inDir).catch(() => {}); throw e; }
      return await this.update(charId, id, w => {
        w.source = source; w.inputs = inputs;
        w.steps.copy = {state: 'done', at: now(), inputHash: hashOf({inputs: inputs.map(f => [f.name, f.sha256])})};
      });
    } catch (e) {
      await fs.rm(newDir, {recursive: true, force: true}).catch(() => {});
      await this.update(charId, id, w => { w.steps.copy = {state: 'failed', at: now(), error: e.message}; })
        .catch(err => console.error('材料のコピーの失敗を work.json に書けない', charId, id, err.message));
      throw e;
    }
  }

  // ---- 採用した絵の取り込み(3a: 既存の絵のフォルダから。3b は候補から) ----
  // from: ファイルかフォルダ(フォルダは直下のファイルだけ)、to: drawn/ の下の行き先、pattern: ファイル名の * の型
  async adopt(charId, id, {from, to = '', pattern = '*', note = ''}) {
    if (!from) throw new LibraryError('bad-input', 'from が要る');
    await this.assertIdle(charId, id);
    const dir = this.dir(charId, id), drawn = path.join(dir, 'drawn');
    const dest = to ? inside(drawn, to) : drawn;
    const st = await fs.stat(from).catch(() => null);
    if (!st) throw new LibraryError('not-found', '取り込む元が無い: ' + from);
    const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    const srcs = st.isDirectory() ? (await fs.readdir(from, {withFileTypes: true})).filter(d => d.isFile() && re.test(d.name)).map(d => path.join(from, d.name)).sort() : [from];
    if (!srcs.length) throw new LibraryError('not-found', `取り込む絵が無い: ${from} ${pattern}`);
    await fs.mkdir(dest, {recursive: true});
    const added = [];
    for (const src of srcs) {
      const target = path.join(dest, path.basename(src)), r = rel(dir, target);
      const same = await exists(target) && await sha256File(target) === await sha256File(src);
      if (!same) {
        if (await exists(target)) await this.#trash(dir, target);   // 前の絵は作業場所の trash/ へ(消さない)
        await fs.copyFile(src, target);
      }
      added.push(r);
      const sha = await sha256File(target);
      await this.update(charId, id, w => {
        if (same && w.adopted.some(a => a.path === r && a.sha256 === sha)) return;
        w.adopted = w.adopted.filter(a => a.path !== r);
        w.adopted.push({path: r, from: src, sha256: sha, request: null, candidate: null, note, adoptedAt: now()});
      });
    }
    return {adopted: added};
  }

  // ---- 依頼と候補(工程 3・6) ----
  // step: face か expr、target: 採用したときに替わる drawn/ の下の .png、text: 人が Claude に頼むこと
  async createRequest(charId, id, body) {
    let {step, target, text} = body ?? {};   // 本文が JSON の null でも 500 にしない
    if (!REQUEST_STEPS[step]) throw new LibraryError('bad-input', 'step は ' + Object.keys(REQUEST_STEPS).join(' / '));
    if (typeof target !== 'string' || !/^drawn\/[\w\-/]+\.png$/.test(target) || target.includes('..') || target.includes('//'))
      throw new LibraryError('bad-input', 'target は drawn/ の下の .png(英数字・_・-・/ だけ): ' + JSON.stringify(target));
    text = typeof text === 'string' ? text.trim() : '';
    if (!text) throw new LibraryError('bad-input', '依頼の文(text)が要る');
    if (text.length > MAX_REQUEST_TEXT) throw new LibraryError('bad-input', `依頼の文は ${MAX_REQUEST_TEXT} 文字まで`);
    const base = await this.#targetSha(charId, id, target);
    return this.update(charId, id, w => {
      const n = Math.max(0, ...w.requests.map(r => Number(r.id.slice(1)))) + 1;
      const r = {id: 'r' + String(n).padStart(3, '0'), step, target, text, state: '未着手', createdAt: now(), base, candidates: []};
      w.requests.push(r);
      return r;
    });
  }

  // 替える絵の今の sha256(まだ無ければ null)。依頼を出したときの値を base に残し、候補を置くときと採用のときに照らす
  async #targetSha(charId, id, target) {
    const file = this.file(charId, id, target);
    return await exists(file) ? await sha256File(file) : null;
  }

  // 依頼のあとに替える絵が変わっていたら(別の依頼の採用、CLI の adopt など)、その絵を元にした候補は黙って上書きしない
  async #assertBase(charId, id, r, base) {
    if (await this.#targetSha(charId, id, r.target) !== base)
      throw new LibraryError('exists', `${r.target} は依頼 ${r.id} のあとに替わった。この依頼は取り下げて、今の絵から出し直す`);
  }

  #request(w, reqId) {
    const r = w.requests.find(x => x.id === reqId);
    if (!r) throw new LibraryError('not-found', `依頼 ${reqId} が無い`);
    return r;
  }

  // Claude が出した候補を candidates/<依頼 ID>/cNN.png に置く(画面で人が決めるまで組み立てには使わない)
  async addCandidate(charId, id, reqId, {data, note = '', from = null}) {
    if (!Buffer.isBuffer(data) || !isPng(data)) throw new LibraryError('bad-input', '候補は PNG');
    if (typeof note !== 'string') throw new LibraryError('bad-input', 'note は文字列');
    const dir = this.dir(charId, id);
    return this.update(charId, id, async w => {
      const r = this.#request(w, reqId);
      if (r.state !== '未着手' && r.state !== '候補あり') throw new LibraryError('bad-input', `依頼 ${reqId} は${r.state}なので候補を足せない`);
      await this.#assertBase(charId, id, r, r.base ?? null);
      const n = (r.candidates.at(-1)?.n ?? 0) + 1, rel = `candidates/${r.id}/c${String(n).padStart(2, '0')}.png`;
      await fs.mkdir(path.join(dir, 'candidates', r.id), {recursive: true});
      await fs.writeFile(path.join(dir, rel), data);
      const c = {n, file: rel, sha256: crypto.createHash('sha256').update(data).digest('hex'), base: r.base ?? null, note: note.trim(), from, state: '候補', at: now()};
      r.candidates.push(c); r.state = '候補あり';
      return c;
    });
  }

  // 却下: 理由は任意(Claude が次の候補を作るときに読む)。決めていない候補が残っていなければ、依頼は未着手に戻る
  async rejectCandidate(charId, id, reqId, n, body) {
    const {reason = ''} = body ?? {};   // 本文が JSON の null でも 500 にしない
    if (typeof reason !== 'string') throw new LibraryError('bad-input', 'reason は文字列');
    return this.update(charId, id, w => {
      const r = this.#request(w, reqId), c = this.#pending(r, n);
      Object.assign(c, {state: '却下', reason: reason.trim(), decidedAt: now()});
      if (!r.candidates.some(x => x.state === '候補')) r.state = '未着手';
    });
  }

  #pending(r, n) {
    const c = r.candidates.find(x => x.n === Number(n));
    if (!c) throw new LibraryError('not-found', `依頼 ${r.id} に候補 ${n} が無い`);
    if (r.state !== '候補あり' || c.state !== '候補') throw new LibraryError('bad-input', `候補 ${n} はもう決まっている(依頼は${r.state}、候補は${c.state})`);
    return c;
  }

  // 採用: 候補を依頼の target(drawn/ の下)へ写す。前の絵は trash/ へ。採用した絵に依頼と候補を記録する。
  // その絵を使う工程は、入力の指紋が変わって「古い」になる
  // (確かめ・写す・記録を work.json の書き込みを待たせた中で一度に行う。途中で失敗すれば work.json は書かない)
  async adoptCandidate(charId, id, reqId, n) {
    const dir = this.dir(charId, id);
    return this.update(charId, id, async w => {
      const busy = busyOf(w);
      if (busy.length) throw new LibraryError('exists', `ジョブ(${busy.join('・')})が順番待ちか実行中なので、終わってから採用する`);
      const r = this.#request(w, reqId), c = this.#pending(r, n);
      const target = this.file(charId, id, r.target), src = this.file(charId, id, c.file);
      if (await sha256File(src) !== c.sha256) throw new LibraryError('bad-input', '候補のファイルが置いたときと違う: ' + c.file);
      await this.#assertBase(charId, id, r, c.base ?? null);
      await fs.mkdir(path.dirname(target), {recursive: true});
      // 先に target.new へ写し、前の絵を trash/ へ移してから置く(写すのが失敗しても drawn/ の絵は残る)
      const tmp = target + '.new';
      try {
        await fs.copyFile(src, tmp);
        const trashed = await exists(target) ? await this.#trash(dir, target) : null;   // 前の絵は trash/ へ(消さない)
        try { await fs.rename(tmp, target); }
        catch (e) { if (trashed) await fs.rename(trashed, target).catch(() => {}); throw e; }
      } catch (e) { await fs.rm(tmp, {force: true}).catch(() => {}); throw e; }
      Object.assign(c, {state: '採用', decidedAt: now()});
      r.state = '採用済み'; r.adopted = c.n;
      w.adopted = w.adopted.filter(a => a.path !== r.target);
      w.adopted.push({path: r.target, from: c.file, sha256: c.sha256, request: r.id, candidate: c.n, note: r.text, adoptedAt: now()});
    });
  }

  async withdrawRequest(charId, id, reqId) {
    return this.update(charId, id, w => {
      const r = this.#request(w, reqId);
      if (r.state === '採用済み') throw new LibraryError('bad-input', `依頼 ${reqId} は採用済み`);
      r.state = '取り下げ'; r.closedAt = now();
    });
  }

  async #trash(dir, file) {
    const to = path.join(dir, 'trash', now().replace(/[:.]/g, '-') + '-' + rel(dir, file).replace(/\//g, '_'));
    await fs.mkdir(path.dirname(to), {recursive: true});
    await fs.rename(file, to);
    return to;
  }

  // ---- 4 区画の範囲 ----
  async setRects(charId, id, rects) {
    await this.assertIdle(charId, id);
    const cam = await readJsonOr(this.file(charId, id, 'face/cam.json'));
    if (!cam) throw new LibraryError('bad-input', '先に「正面を撮る」を済ませる(区画の範囲は正面の撮影の画素で決める)');
    const clean = checkRects(rects, cam.size);
    const inputHash = await this.stepHash(charId, id, 'rects');
    return this.update(charId, id, w => { w.rects = clean; w.steps.rects = {state: 'done', at: now(), inputHash}; });
  }

  async setOptions(charId, id, patch) {
    checkOptions(patch);
    await this.assertIdle(charId, id);
    // 2 段目まで重ねる(例 {video: {env}} は video.videos を残す)。配列と null はそのまま置き換える
    return this.update(charId, id, w => {
      const plain = o => o && typeof o === 'object' && !Array.isArray(o);
      for (const [k, v] of Object.entries(structuredClone(patch))) w.options[k] = plain(v) && plain(w.options[k]) ? {...w.options[k], ...v} : v;
    });
  }

  // ---- 7 中割りの動画を手で置く(mp4 を作業場所の video/ へコピー) ----
  async addVideo(charId, id, {name, src, data}) {
    if (!EXPRESSIONS.includes(name)) throw new LibraryError('bad-input', '表情の名前は ' + EXPRESSIONS.join(' / '));
    await this.assertIdle(charId, id);
    const dir = this.dir(charId, id), file = path.join(dir, 'video', name + '.mp4');
    if (data) {
      if (data.length < 12 || data.toString('latin1', 4, 8) !== 'ftyp') throw new LibraryError('bad-input', 'mp4 ではない');
    } else if (!src || !/\.mp4$/i.test(src) || !await exists(src)) throw new LibraryError('bad-input', 'mp4 のファイルが無い: ' + src);
    await fs.mkdir(path.dirname(file), {recursive: true});
    const incoming = data ? crypto.createHash('sha256').update(data).digest('hex') : await sha256File(src);
    if (await exists(file) && await sha256File(file) !== incoming) await this.#trash(dir, file);   // 前の動画は trash/ へ
    if (data) await fs.writeFile(file, data); else await fs.copyFile(src, file);
    const r = 'video/' + name + '.mp4', sha = await sha256File(file);
    return this.update(charId, id, w => {
      const list = (w.options.video.videos ?? []).filter(v => v.name !== name);
      // 並びは EXPRESSIONS の順(expr_video.py に渡す順)
      list.push({name, file: r});
      w.options.video.videos = list.sort((a, b) => EXPRESSIONS.indexOf(a.name) - EXPRESSIONS.indexOf(b.name));
      w.adopted = w.adopted.filter(a => a.path !== r);
      w.adopted.push({path: r, from: src ?? 'upload', sha256: sha, request: null, candidate: null, note: '中割りの動画(手で置く)', adoptedAt: now()});
      return {name, file: r, sha256: sha};
    });
  }

  // ---- 工程の入力の指紋 ----
  // 工程が使うファイル(作業場所からの相対パス)と設定。ファイルは sha256 で見る。
  async stepInputs(w, step, proto = null) {
    const o = w.options, inputs = w.inputs.map(f => 'inputs/' + f.name);
    switch (step) {
      case 'front': return {opts: o.front, files: [...inputs.filter(n => n !== 'inputs/review.vrm'), ...refsOf(o.front)]};
      case 'rects': return {opts: null, files: ['face/cam.json']};
      case 'build': return {opts: {build: o.build, rects: w.rects, springTune: o.springTune},
        files: ['face/cam.json', 'face/skin.png', 'face/with_hair.png', 'face/align.json', 'work/face.blend', 'inputs/review.vrm', ...refsOf(o.build)]};
      case 'video': return {opts: {video: o.video, springTune: o.springTune}, files: ['face/gaze/face_gaze.vrm', ...refsOf(o.video)]};
      // 撮った試作(proto を渡す。無ければいちばん新しい試作)。古い試作を撮ったときは、新しい試作の指紋と違うので「古い」
      case 'checks': { const p = proto != null ? w.prototypes.find(x => x.n === proto) : w.prototypes.at(-1); return {opts: null, files: p ? [p.file] : []}; }
      default: return null;
    }
  }

  async stepHash(charId, id, step, w, proto = null) {
    w ??= await this.read(charId, id);
    if (step === 'copy') return hashOf({inputs: w.inputs.map(f => [f.name, f.sha256])});
    const spec = await this.stepInputs(w, step, proto);
    if (!spec) return null;
    const dir = this.dir(charId, id), files = {};
    for (const r of spec.files) {
      const abs = inside(dir, r), st = await fs.stat(abs).catch(() => null);
      if (st?.isDirectory()) for (const f of await listFiles(abs)) files[rel(dir, f)] = await sha256File(f);
      else files[r] = st ? await sha256File(abs) : null;
    }
    return hashOf({opts: spec.opts, files});
  }

  // 画面に出す形: work.json に、工程ごとの「古いかどうか」、ジョブの今の状態、ファイルの URL を足したもの。
  // jobOf(jobId): ジョブの順番待ちが知っているジョブ(サーバーの再起動で止まったものは failed になっている)
  async status(charId, id, jobOf = () => null) {
    const w = await this.read(charId, id);
    const steps = {}; let upstream = false;
    for (const step of STEPS) {
      const s = {...(w.steps[step] ?? {state: 'none'})};
      if (step === 'copy' && s.state === 'running' && !copyBusy(w)) { s.state = 'failed'; s.error = 'コピーの途中でプロセスが止まった'; }
      const job = s.jobId ? jobOf(s.jobId) : null;
      if (job && (s.state === 'queued' || s.state === 'running')) { s.state = job.state; s.error = job.error ?? s.error; s.progress = job.step; }
      if (job) { s.job = {id: job.id, state: job.state, step: job.step, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error}; }
      if (step !== 'promote' && s.state === 'done') {
        const cur = await this.stepHash(charId, id, step, w);
        s.stale = cur !== s.inputHash;
      } else s.stale = false;
      if (step === 'copy' && s.state === 'done') {   // 元のファイル(きゃらくる側)が変わったか
        for (const f of w.inputs) {
          const st = await fs.stat(f.from).catch(() => null);
          if (!st || st.size !== f.size || st.mtimeMs !== f.mtimeMs) { s.sourceChanged = true; break; }
        }
      }
      s.upstreamStale = upstream && step !== 'promote';
      if (s.stale || s.sourceChanged) upstream = true;
      steps[step] = s;
    }
    const dir = this.dir(charId, id), u = r => this.url(charId, id, r);
    const files = {};
    for (const r of ['face/with_hair.png', 'face/skin.png', 'face/cam.json', 'face/align.json', 'face/pre/with_hair.png', 'face/atlas_upper.png', 'face/atlas_mouth.png', 'work/video/sheet.png'])
      if (await exists(path.join(dir, r))) files[r] = r.startsWith('work/') ? null : u(r);
    const cam = await readJsonOr(path.join(dir, 'face/cam.json'));
    const checks = [];
    for (const c of w.checks) checks.push({...c, images: ((await readJsonOr(path.join(dir, c.dir, 'index.json'))) ?? []).map(i => ({...i, url: u(c.dir + '/' + i.file)}))});
    return {...w, dir, steps, files, cam, prototypes: w.prototypes.map(p => ({...p, url: u(p.file)})), checks,
      adopted: w.adopted.map(a => ({...a, url: u(a.path)})),
      requests: w.requests.map(r => ({...r, targetUrl: u(r.target), candidates: r.candidates.map(c => ({...c, url: u(c.file)}))}))};
  }

  // スマホ用の軽い VRM(import-version.mjs と同じ。失敗しても取り込みは済んでいる)
  async makeLite(charId, verId) {
    if (this.env.CHARASTA_FAKE_BLENDER) return null;
    const vdir = path.join(this.lib.dir, 'characters', charId, 'versions', verId);
    try { return (await run(this.env.CHARASTA_PYTHON || 'python', [path.join(root, 'tools', 'make_lite.py'), path.join(vdir, 'model.vrm'), path.join(vdir, 'model-lite.vrm')], {windowsHide: true})).stdout.trim(); }
    catch (e) { return 'スマホ用の軽い VRM を作れなかった: ' + e.message.split('\n')[0]; }
  }

  // きゃらくるのプロジェクトの work/review.vrm を版として取り込む(元は読むだけ。ADR 0001)
  async importProjectVersion(charId, {project, verId, label = '', note, latest = false}) {
    if (typeof latest !== 'boolean') throw new LibraryError('bad-input', 'latest は true / false');
    if (!note || typeof note !== 'string') throw new LibraryError('bad-input', '変えたこと(note)を書く');
    const file = path.join(inside(path.join(this.charakuruApp, 'projects'), checkId(project, 'プロジェクト ID')), 'work', 'review.vrm');
    if (!await exists(file)) throw new LibraryError('not-found', 'プロジェクトに work/review.vrm が無い: ' + project);
    const ver = await this.lib.importVersion({charId, id: checkId(verId, '版 ID'), label: String(label), note, data: await fs.readFile(file), sourcePath: file, charakuruProject: project, latest});
    return {version: ver, lite: await this.makeLite(charId, ver.id)};
  }

  // ---- 9 版にする(試作を、キャラの版として取り込む。段階 1 の import-version と同じ) ----
  async promote(charId, id, {proto, verId, label = '', note = '', latest = false}) {
    if (typeof latest !== 'boolean') throw new LibraryError('bad-input', 'latest は true / false');   // 文字列 "false" を true にしない
    const w = await this.read(charId, id);
    const p = w.prototypes.find(x => x.n === Number(proto));
    if (!p) throw new LibraryError('not-found', `試作 ${proto} が無い`);
    if (!note || typeof note !== 'string') throw new LibraryError('bad-input', '変えたこと(note)を書く');
    const file = this.file(charId, id, p.file), data = await fs.readFile(file);
    const ver = await this.lib.importVersion({charId, id: checkId(verId, '版 ID'), label: String(label), note, data, sourcePath: file,
      charakuruProject: w.source?.type === 'charakuru' ? w.source.project : null, latest});
    const lite = await this.makeLite(charId, ver.id);
    await this.update(charId, id, w => {
      w.versions.push({verId: ver.id, proto: p.n, sha256: ver.sha256, at: now()});
      w.steps.promote = {state: 'done', at: now(), verId: ver.id, proto: p.n};
    });
    return {version: ver, lite};
  }
}

export function hashOf(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }
