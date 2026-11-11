// ゲーム用の書き出し(docs/game-export.md)。バージョンの model.vrm から、ゲームに入れる軽い VRM と、その場で動く VRMA を作る。
//   1. primitive をまとめる(tools/vrm/merge_prims.py)  2. 三角形を減らす(tools/vrm/decimate.mjs)  3. 揺れものを硬くする
//   4. meta を埋める(lib/vrm-meta.mjs)  5. 画像を縮める(tools/make_lite.py)  6. 選んだモーションの hips の水平の動きを消す
// 元の model.vrm と取り込んだモーションは変えない。書き出しはバージョンのフォルダの game/<exportId>/ に毎回新しく作る。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {root} from './config.mjs';
import {LibraryError, checkId, inside, readJsonOr, rejectCreature, writeJson} from './library.mjs';
import {parseGlb, buildGlb, readAccessor, readGlbJson} from './glb.mjs';
import {parseVrma} from './vrma.mjs';
import {fillMeta, checkVrmMeta} from './vrm-meta.mjs';
import {decimate, planBudget, DEFAULTS as DECIMATE} from '../tools/vrm/decimate.mjs';

export const GAME_EXPORT_JOB = 'game-export';
export {planBudget, fillMeta};
export const DEFAULT_SPRINGS = {skirt: [1.5, 0.6, 0.3]};   // [硬さ, 抵抗, 重力]。ARCHERIA の実測(スカートが腰より上に来たフレームが走りで 0%)
export const TARGET_RANGE = [1000, 1000000];
export const TEXTURE = {body: 1024, atlas: 4096};

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n;

// ---- 揺れもの ----

// springs: {名前の一部: [硬さ, 抵抗, 重力]}。名前に一部を含む(大小無視)spring の全 joint を絶対値で書き換える。戻りは変えた spring の記録
export function tuneSprings(json, springs) {
  const out = [];
  const list = json.extensions?.VRMC_springBone?.springs ?? [];
  for (const [key, [stiffness, dragForce, gravityPower]] of Object.entries(springs ?? {})) {
    const hit = list.filter(s => (s.name ?? '').toLowerCase().includes(key.toLowerCase()));
    const before = new Map();
    for (const s of hit) for (const j of s.joints) {
      before.set(`${j.stiffness},${j.dragForce},${j.gravityPower}`, [j.stiffness, j.dragForce, j.gravityPower]);
      j.stiffness = stiffness; j.dragForce = dragForce; j.gravityPower = gravityPower;
    }
    out.push({rule: key, springs: hit.map(s => s.name), joints: hit.reduce((n, s) => n + s.joints.length, 0), before: [...before.values()].map(v => v.map(x => round(x))), after: [stiffness, dragForce, gravityPower]});
  }
  return out;
}

// 画面・CLI・API の springs を確かめる。誤りは bad-input
export function checkSprings(v) {
  if (v === undefined) return structuredClone(DEFAULT_SPRINGS);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new LibraryError('bad-input', 'springs は {名前の一部: [硬さ, 抵抗, 重力]}');
  const out = {};
  for (const [k, a] of Object.entries(v)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(k)) throw new LibraryError('bad-input', `springs の名前は英数字・_・- の 32 文字まで: ${k}`);
    if (!Array.isArray(a) || a.length !== 3 || a.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new LibraryError('bad-input', `springs.${k} は [硬さ, 抵抗, 重力] の数 3 つ`);
    const [s, d, g] = a;
    if (s < 0 || s > 10 || d < 0 || d > 1 || g < 0 || g > 10) throw new LibraryError('bad-input', `springs.${k} の範囲は 硬さ 0〜10、抵抗 0〜1、重力 0〜10`);
    out[k] = [s, d, g];
  }
  return out;
}

// CLI の --springs skirt=1.5,0.6,0.3 を {skirt: [..]} にする
export function parseSpringArgs(list) {
  return Object.fromEntries((list ?? []).map(s => {
    const m = /^([^=]+)=([^,]+),([^,]+),([^,]+)$/.exec(s);
    if (!m) throw new LibraryError('bad-input', `--springs は 名前=硬さ,抵抗,重力: ${s}`);
    return [m[1], [Number(m[2]), Number(m[3]), Number(m[4])]];
  }));
}

// ---- 測る ----

const imageBytes = json => (json.images ?? []).reduce((n, im) => n + (im.bufferView != null ? json.bufferViews[im.bufferView].byteLength : 0), 0);
export function measureJson(json, bytes) {
  const prims = (json.meshes ?? []).flatMap(m => m.primitives);
  const ex = json.extensions?.VRMC_vrm?.expressions ?? {};
  const outline = (json.materials ?? []).filter(m => { const t = m.extensions?.VRMC_materials_mtoon; return t && t.outlineWidthMode && t.outlineWidthMode !== 'none' && (t.outlineWidthFactor ?? 0) > 0; }).length;
  return {
    triangles: prims.reduce((n, p) => n + ((p.mode ?? 4) === 4 && p.indices != null ? json.accessors[p.indices].count / 3 : 0), 0),
    meshes: json.meshes?.length ?? 0, primitives: prims.length, materials: json.materials?.length ?? 0, outlineMaterials: outline,
    expressions: Object.keys(ex.preset ?? {}).length + Object.keys(ex.custom ?? {}).length,
    springJoints: (json.extensions?.VRMC_springBone?.springs ?? []).reduce((n, s) => n + s.joints.length, 0),
    springs: json.extensions?.VRMC_springBone?.springs?.length ?? 0, textureBytes: imageBytes(json), bytes};
}

// ---- その場の VRMA ----

const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}
function inverseAffine(m) {
  const [a, b, c, , d, e, f, , g, h, i, , tx, ty, tz] = m;   // 列ごとに (a,b,c) (d,e,f) (g,h,i)
  const det = a * (e * i - h * f) - d * (b * i - h * c) + g * (b * f - e * c);
  if (Math.abs(det) < 1e-12) throw new Error('hips の親の行列が逆に引けない');
  const R = [[e * i - h * f, g * f - d * i, d * h - g * e], [h * c - b * i, a * i - g * c, g * b - a * h], [b * f - e * c, d * c - a * f, a * e - d * b]].map(r => r.map(v => v / det));
  return [R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0,
    -(R[0][0] * tx + R[0][1] * ty + R[0][2] * tz), -(R[1][0] * tx + R[1][1] * ty + R[1][2] * tz), -(R[2][0] * tx + R[2][1] * ty + R[2][2] * tz), 1];
}
const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

function writeFloats(json, bin, idx, values, width) {
  const a = json.accessors[idx], bv = json.bufferViews[a.bufferView], base = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || width * 4;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) dv.setFloat32(base + i * stride + k * 4, values[i * width + k], true);
  if (a.min || a.max) {
    a.min = Array(width).fill(Infinity); a.max = Array(width).fill(-Infinity);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) { const v = values[i * width + k]; a.min[k] = Math.min(a.min[k], v); a.max[k] = Math.max(a.max[k], v); }
  }
}

// hips の水平の動きを消す: world 空間で各キーの x と z を先頭キーの値にそろえ、y は残す。回転のチャンネルと、ほかのバイト列は変えない。
// 戻りは {glb, info} か、直せないときの {skipped: 理由}
//   info.removedTravel: 消した水平の道のり(m。元の hips の world での水平の道のり)、startToEnd: 始点から終点までの水平の差(m)、vertical: 上下の幅(m)
export function inPlaceVrma(buf) {
  let json, bin;
  try { ({json, bin} = parseGlb(buf)); } catch (e) { return {skipped: 'VRMA を読めない: ' + e.message}; }
  const hipsNode = json.extensions?.VRMC_vrm_animation?.humanoid?.humanBones?.hips?.node;
  if (hipsNode == null) return {skipped: 'hips の節点が無い'};
  const parent = new Map();
  (json.nodes ?? []).forEach((n, i) => (n.children ?? []).forEach(c => parent.set(c, i)));
  const ancestors = [];
  for (let p = parent.get(hipsNode); p != null; p = parent.get(p)) ancestors.push(p);
  const channels = (json.animations ?? []).flatMap(an => an.channels.map(c => ({c, an})));
  if (channels.some(({c}) => ancestors.includes(c.target?.node))) return {skipped: 'hips の親が動くクリップ'};
  const mine = channels.filter(({c}) => c.target?.node === hipsNode && c.target.path === 'translation');
  if (!mine.length) return {skipped: 'hips の translation のチャンネルが無い'};
  let world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const n of ancestors.reverse()) world = mul(world, nodeMatrix(json.nodes[n]));
  const inv = inverseAffine(world), copy = Buffer.from(bin);   // bin は元のバッファの一部なので、書く前に写す
  let info = null;
  for (const {c, an} of mine) {
    const s = an.samplers[c.sampler], out = json.accessors[s.output];
    if (s.interpolation === 'CUBICSPLINE') return {skipped: 'CUBICSPLINE の translation には対応していない'};
    if (out.type !== 'VEC3' || out.componentType !== 5126) return {skipped: 'translation が float の VEC3 ではない'};
    const src = readAccessor(json, bin, s.output), pts = Array.from({length: out.count}, (_, i) => apply(world, [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]]));
    if (!pts.length) continue;
    const next = new Float32Array(src.length), ys = pts.map(p => p[1]);
    let travel = 0;
    pts.forEach((p, i) => {
      if (i) travel += Math.hypot(p[0] - pts[i - 1][0], p[2] - pts[i - 1][2]);
      const q = apply(inv, [pts[0][0], p[1], pts[0][2]]);
      next.set(q, i * 3);
    });
    writeFloats(json, copy, s.output, next, 3);
    const last = pts.at(-1), cur = {removedTravel: round(travel), startToEnd: round(Math.hypot(last[0] - pts[0][0], last[2] - pts[0][2])), vertical: round(Math.max(...ys) - Math.min(...ys))};
    info = info ? {removedTravel: Math.max(info.removedTravel, cur.removedTravel), startToEnd: Math.max(info.startToEnd, cur.startToEnd), vertical: Math.max(info.vertical, cur.vertical)} : cur;
  }
  if (!info) return {skipped: 'hips の translation が空'};
  return {glb: buildGlb(json, copy), info};
}

// ---- 入力の確かめ ----

const pad = n => String(n).padStart(2, '0');
export const newExportId = (d = new Date()) => `g${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
export const gameDir = (lib, charId, verId) => inside(lib.dir, 'characters', checkId(charId, 'キャラ ID'), 'versions', checkId(verId, 'バージョン ID'), 'game');

// 積むときの確かめ。pending(input): 同じバージョンのゲーム用の書き出しが順番待ちか実行中か
export async function gameExportInput(lib, body, pending = () => false) {
  const ch = rejectCreature(await lib.getCharacterJson(checkId(body.charId, 'キャラ ID')), 'ゲーム用の書き出し');
  const verId = body.verId ? checkId(body.verId, 'バージョン ID') : ch.latestVersion;
  if (!verId || !await lib.versionExists(ch.id, verId)) throw new LibraryError('not-found', `バージョン ${ch.id}/${verId} が無い`);
  const js = await readGlbJson(inside(lib.dir, 'characters', ch.id, 'versions', verId, 'model.vrm'));
  if (js.extensions?.VRM && !js.extensions?.VRMC_vrm) throw new LibraryError('bad-input', 'VRM 0.x のバージョンはゲーム用に書き出せない。VRM 1 へ変換してバージョンにしてから書き出す');
  if (!js.extensions?.VRMC_vrm) throw new LibraryError('bad-input', 'VRM 1.0(VRMC_vrm)のバージョンではない');
  const motions = body.motions ?? [];
  if (!Array.isArray(motions) || motions.length > 50 || motions.some(m => typeof m !== 'string')) throw new LibraryError('bad-input', 'motions はモーション ID の配列（50 本まで）');
  for (const m of [...new Set(motions)]) await lib.getMotion(checkId(m, 'モーション ID'));   // 無ければ not-found
  const target = body.target === undefined ? DECIMATE.target : body.target;
  if (!Number.isInteger(target) || target < TARGET_RANGE[0] || target > TARGET_RANGE[1]) throw new LibraryError('bad-input', `target は ${TARGET_RANGE[0]}〜${TARGET_RANGE[1]} の整数`);
  const input = {charId: ch.id, verId, motions: [...new Set(motions)], target, springs: checkSprings(body.springs)};
  if (pending(input)) throw new LibraryError('busy', `${ch.id}/${verId} のゲーム用の書き出しが既に順番待ちか実行中にある`);
  return input;
}

// ---- 書き出し ----

// ctx: {job, workDir, step, log, run}(JobQueue の #execute と同じ形。CLI は scripts/game-export.mjs が同じ形を作る)
export async function runGameExport(ctx, {lib, now = () => new Date(), exportId = null}) {
  const {charId, verId, motions, target, springs} = ctx.job.input;
  const ch = await lib.getCharacterJson(charId), verDir = inside(lib.dir, 'characters', charId, 'versions', verId), modelFile = path.join(verDir, 'model.vrm');
  const source = await fs.readFile(modelFile), sourceJson = parseGlb(source).json, before = measureJson(sourceJson, source.length);
  await removeStaleExports(lib, charId, verId);
  const dir = await newExportDir(lib, charId, verId, exportId, now);
  const id = path.basename(dir), work = ctx.workDir;
  try {
    await writeJson(path.join(dir, 'export.json'), {exportId: id, charId, verId, status: 'running', pid: process.pid, createdAt: now().toISOString(), jobId: ctx.job.id ?? null});
    await fs.mkdir(path.join(dir, 'motions'), {recursive: true});
    await fs.mkdir(work, {recursive: true});
    const merged = path.join(work, '1-merged.vrm'), edited = path.join(work, '2-edited.vrm'), game = path.join(dir, 'model-game.vrm');

    await ctx.step('primitive をまとめる');
    await ctx.run('python', [path.join(root, 'tools', 'vrm', 'merge_prims.py'), modelFile, merged]);
    const mergedGlb = await fs.readFile(merged), mergedParsed = parseGlb(mergedGlb);

    await ctx.step('三角形を減らす');
    const primitivesMerged = measureJson(mergedParsed.json, mergedGlb.length).primitives;
    const {json, bin, report} = await decimate(mergedParsed.json, mergedParsed.bin, {target});
    if (report.note) ctx.log(report.note + '\n');

    await ctx.step('揺れものと meta を直す');
    const springReport = tuneSprings(json, springs), metaReport = fillMeta(json, {vrmMeta: ch.vrmMeta ?? null, charName: ch.name, verId});
    await fs.writeFile(edited, buildGlb(json, bin));

    await ctx.step('画像を縮める');
    await ctx.run('python', [path.join(root, 'tools', 'make_lite.py'), edited, game, '--body', String(TEXTURE.body), '--atlas', String(TEXTURE.atlas)]);
    const out = await fs.readFile(game), after = measureJson(parseGlb(out).json, out.length);

    const motionReports = [];
    for (const mid of motions) {
      await ctx.step(`モーション ${mid} をその場にする`);
      let m;
      try { m = await lib.getMotion(mid); } catch (e) {
        if (e.code !== 'not-found') throw e;   // 積んだあとに消されたモーション。全体は止めず、これだけ飛ばす
        motionReports.push({motionId: mid, name: null, license: null, skipped: 'モーションが無い（受け付けたあとに消された）'});
        continue;
      }
      const r = inPlaceVrma(await fs.readFile(path.join(lib.motionDir(mid), 'motion.vrma')));
      const entry = {motionId: mid, name: m.name, license: m.license ?? null};
      if (r.skipped) motionReports.push({...entry, skipped: r.skipped});
      else {
        await fs.writeFile(path.join(dir, 'motions', mid + '.vrma'), r.glb);
        motionReports.push({...entry, file: `motions/${mid}.vrma`, durationSec: parseVrma(r.glb).durationSec, ...r.info});
      }
    }

    const record = {exportId: id, charId, verId, status: 'done', sourceSha256: sha256(source), createdAt: now().toISOString(), jobId: ctx.job.id ?? null,
      options: {target, springs, motions, texture: TEXTURE},
      steps: {
        merge: {primitivesBefore: before.primitives, primitivesAfter: primitivesMerged},
        decimate: report,
        springs: springReport,
        meta: {values: metaReport.meta, sources: metaReport.sources, missing: metaReport.missing, defaulted: metaReport.defaulted},
        textures: {beforeMB: round(before.textureBytes / 1e6, 2), afterMB: round(after.textureBytes / 1e6, 2)}},
      checks: {expressions: before.expressions === after.expressions, springJoints: before.springJoints === after.springJoints},
      measure: {before, after},
      motions: motionReports,
      warnings: [
        ...(report.note ? [report.note] : []),
        ...springReport.filter(r => !r.joints).map(r => `揺れものの指定 ${r.rule} に合う spring が無い`),
        ...(metaReport.meta.allowRedistribution === false ? ['allowRedistribution が false: Web のゲームに入れると VRM ファイルそのものが配信される。配ってよいかは作者が決める'] : []),
        ...motionReports.filter(m => m.license && (m.license.redistribution === false || m.license.evaluationOnly)).map(m => `モーション ${m.motionId} は二次配布 不可か評価用のみ（license を見る）`)]};
    await writeJson(path.join(dir, 'export.json'), record);
    return {exportId: id, charId, verId, url: exportUrl(charId, verId, id, 'model-game.vrm'), triangles: after.triangles, primitives: after.primitives, bytes: after.bytes,
      reached: report.reached, missing: metaReport.missing, motions: motionReports.filter(m => m.file).length, skippedMotions: motionReports.filter(m => m.skipped).length};
  } catch (e) {
    await fs.rm(dir, {recursive: true, force: true}).catch(() => {});
    throw e;
  }
}

const exportUrl = (charId, verId, id, ...rest) => '/lib/characters/' + [charId, 'versions', verId, 'game', id, ...rest].map(encodeURIComponent).join('/');

// 前の書き出しがサーバの停止などで途中のまま残っていれば消す。export.json が無いか、status が running で書いたプロセスがもう居ないものだけ。
// 同じバージョンの二重実行はジョブの busy で断っているので、自分以外に走りうるのは別プロセスの CLI だけで、そちらは pid が生きている
async function removeStaleExports(lib, charId, verId) {
  const base = gameDir(lib, charId, verId);
  for (const e of await fs.readdir(base, {withFileTypes: true}).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name), rec = await readJsonOr(path.join(dir, 'export.json'));
    if (rec && (rec.status !== 'running' || pidAlive(rec.pid))) continue;
    await fs.rm(dir, {recursive: true, force: true}).catch(() => {});
  }
}
const pidAlive = pid => { if (!Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// 新しい書き出しのフォルダを作る。ID を指定して同じものがあれば止める。指定が無ければ日時の ID で、同じ秒のものがあれば次の秒にする
async function newExportDir(lib, charId, verId, exportId, now) {
  const base = gameDir(lib, charId, verId);
  await fs.mkdir(base, {recursive: true});
  const t = now().getTime();
  for (let i = 0; i < 120; i++) {
    const id = exportId ?? newExportId(new Date(t + i * 1000)), dir = path.join(base, checkId(id, '書き出し ID'));
    try { await fs.mkdir(dir); return dir; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (exportId) throw new LibraryError('exists', `書き出し ${charId}/${verId}/${id} は既にある（上書きしない）`);
    }
  }
  throw new LibraryError('exists', '書き出しの ID が決まらない');
}

// バージョンの書き出しの一覧(新しい順)。各 export.json に、ファイルの URL を足す
export async function listGameExports(lib, charId, verId) {
  const ch = rejectCreature(await lib.getCharacterJson(charId), 'ゲーム用の書き出し');
  if (!await lib.versionExists(ch.id, verId)) throw new LibraryError('not-found', `バージョン ${charId}/${verId} が無い`);
  const base = gameDir(lib, charId, verId), out = [];
  for (const e of await fs.readdir(base, {withFileTypes: true}).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const rec = await readJsonOr(path.join(base, e.name, 'export.json'));
    if (!rec) continue;   // export.json を書く前に止まったもの。次の書き出しの開始で消える
    out.push({...rec, modelUrl: exportUrl(charId, verId, e.name, 'model-game.vrm'), motions: (rec.motions ?? []).map(m => ({...m, ...(m.file && {url: exportUrl(charId, verId, e.name, m.file)})}))});
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export {checkVrmMeta};
