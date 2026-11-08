// ゲーム用の書き出し(lib/game-export.mjs、tools/vrm/decimate.mjs、lib/vrm-meta.mjs)。小さな glb を作って確かめる。python(numpy と PIL)が要る。
import test from 'node:test';
import {findPython} from '../lib/platform.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseGlb, readAccessor} from '../lib/glb.mjs';
import {parseVrma} from '../lib/vrma.mjs';
import {decimateGlb, planBudget, expressionMorphs} from '../tools/vrm/decimate.mjs';
import {runGameExport, gameExportInput, listGameExports, tuneSprings, checkSprings, parseSpringArgs, inPlaceVrma, DEFAULT_SPRINGS, measureJson} from '../lib/game-export.mjs';
import {fillMeta, checkVrmMeta, PLACEHOLDER} from '../lib/vrm-meta.mjs';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Library} from '../lib/library.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {tempDir, fakeGlb, startServer} from './helpers.mjs';
import {makeVrm, makeVrma, sphere} from './game-export-fixture.mjs';

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const primArrays = (json, bin, p) => ({idx: readAccessor(json, bin, p.indices), ...Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, readAccessor(json, bin, v)]))});
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

test('planBudget: 守る分を引いて割合を決める。下限で止まり、届かないときは reached が false', () => {
  const prims = [{id: 'a', triangles: 10000, alphaMode: 'OPAQUE', indexed: true}, {id: 'b', triangles: 2000, alphaMode: 'MASK', indexed: true}, {id: 'c', triangles: 500, alphaMode: 'OPAQUE', indexed: true}];
  const p = planBudget(prims, {target: 7000});
  assert.equal(p.protectedTriangles, 2500); assert.equal(p.ratio, 0.45); assert.equal(p.reached, true);
  assert.deepEqual(p.items.map(i => i.reason !== null), [false, true, true]);
  const low = planBudget(prims, {target: 2600});
  assert.equal(low.ratio, 0.1); assert.equal(low.reached, false);   // 守る分 2500 + 1000
  assert.equal(planBudget(prims, {target: 100000}).ratio, 1);
});

test('decimate: 目標の ±10% 以内、継ぎ目が開かない、重みとモーフはそのまま、表情の頂点は残る、MASK は同じ', async () => {
  const src = makeVrm(), before = parseGlb(src), total = measureJson(before.json, src.length).triangles;
  const target = 6000, {glb, report} = await decimateGlb(src, {target, minPrimTris: 100});
  const after = parseGlb(glb), t = measureJson(after.json, glb.length).triangles;
  assert.ok(Math.abs(t - target) <= target * 0.1, `${total} -> ${t}`);
  assert.equal(report.primitives.find(p => p.alphaMode === 'MASK').protectedBy, 'alphaMode MASK');
  // MASK の primitive は index も属性もそのまま
  const maskOld = primArrays(before.json, before.bin, before.json.meshes[1].primitives[0]), maskNew = primArrays(after.json, after.bin, after.json.meshes[1].primitives[0]);
  for (const k of Object.keys(maskOld)) assert.ok(same(maskOld[k], maskNew[k]), k);
  // 縮めた primitive: 残った頂点の JOINTS / WEIGHTS / モーフの差分は、位置と UV が同じ元の頂点と同じ値
  const morphs = expressionMorphs(before.json), key = (a, v) => [...a.POSITION.subarray(v * 3, v * 3 + 3), ...a.TEXCOORD_0.subarray(v * 2, v * 2 + 2)].join(',');
  for (const pi of [0, 1]) {
    const po = before.json.meshes[0].primitives[pi], pn = after.json.meshes[0].primitives[pi];
    const o = primArrays(before.json, before.bin, po), n = primArrays(after.json, after.bin, pn);
    const dOld = readAccessor(before.json, before.bin, po.targets[0].POSITION), dNew = readAccessor(after.json, after.bin, pn.targets[0].POSITION);
    const byKey = new Map();
    for (let v = 0; v < o.POSITION.length / 3; v++) byKey.set(key(o, v), v);
    const count = n.POSITION.length / 3, keptKeys = new Set();
    for (let v = 0; v < count; v++) {
      const ov = byKey.get(key(n, v));
      assert.notEqual(ov, undefined);
      keptKeys.add(key(n, v));
      assert.ok(same(n.JOINTS_0.subarray(v * 4, v * 4 + 4), o.JOINTS_0.subarray(ov * 4, ov * 4 + 4)));
      assert.ok(same(n.WEIGHTS_0.subarray(v * 4, v * 4 + 4), o.WEIGHTS_0.subarray(ov * 4, ov * 4 + 4)));
      assert.ok(same(dNew.subarray(v * 3, v * 3 + 3), dOld.subarray(ov * 3, ov * 3 + 3)));
    }
    // 表情が動かす頂点(差分 0.1 mm 超)は 1 個も消えない
    let moved = 0, kept = 0;
    for (let v = 0; v < o.POSITION.length / 3; v++) if (Math.hypot(dOld[v * 3], dOld[v * 3 + 1], dOld[v * 3 + 2]) > 1e-4) { moved++; if (keptKeys.has(key(o, v))) kept++; }
    assert.ok(moved > 0);
    assert.equal(kept, moved);
    // 継ぎ目: 位置で溶接した縁の辺が 0(球は閉じている)。index は頂点の範囲内
    const weld = new Map(), ids = [];
    for (let v = 0; v < count; v++) { const k = [...n.POSITION.subarray(v * 3, v * 3 + 3)].map(x => Math.round(x * 1e5)).join(','); if (!weld.has(k)) weld.set(k, weld.size); ids.push(weld.get(k)); }
    const edges = new Map();
    for (let f = 0; f < n.idx.length; f += 3) for (let e = 0; e < 3; e++) {
      const a = ids[n.idx[f + e]], b = ids[n.idx[f + (e + 1) % 3]];
      if (a === b) continue;
      const k = a < b ? a + '_' + b : b + '_' + a;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
    assert.equal([...edges.values()].filter(c => c === 1).length, 0, `primitive ${pi} の縁`);
    assert.ok(Math.max(...n.idx) < count);
  }
  assert.ok(morphs.get(0).has(0));
  const bind = after.json.extensions.VRMC_vrm.expressions.preset.happy.morphTargetBinds[0];
  assert.ok(bind.index < after.json.meshes[0].primitives[0].targets.length);
});

test('decimate: 下限の割合で止まり、届かないときは理由を残す', async () => {
  const {report} = await decimateGlb(makeVrm(), {target: 1000, minPrimTris: 100});
  assert.equal(report.reached, false);
  assert.match(report.note, /届かない/);
  assert.ok(report.primitives.filter(p => !p.protectedBy).every(p => p.ratio >= 0.09));
});

test('tuneSprings: 名前が合う spring だけが変わり、ほかはそのまま', () => {
  const {json} = parseGlb(makeVrm()), hair = JSON.stringify(json.extensions.VRMC_springBone.springs[1]);
  const r = tuneSprings(json, {SKIRT: [1.5, 0.6, 0.3]});
  const [skirt, other] = json.extensions.VRMC_springBone.springs;
  assert.ok(skirt.joints.every(j => j.stiffness === 1.5 && j.dragForce === 0.6 && j.gravityPower === 0.3));
  assert.equal(JSON.stringify(other), hair);
  assert.deepEqual(r[0].springs, ['Skirt-skirt0_0']);
  assert.deepEqual(r[0].before, [[0.5, 0.05, 0]]);
  assert.equal(tuneSprings(json, {nothing: [1, 1, 1]})[0].joints, 0);
});

test('checkSprings / parseSpringArgs', () => {
  assert.deepEqual(checkSprings(undefined), DEFAULT_SPRINGS);
  assert.deepEqual(checkSprings({}), {});
  assert.throws(() => checkSprings({skirt: [1, 2]}), /3 つ/);
  assert.throws(() => checkSprings({skirt: [11, 0, 0]}), /範囲/);
  assert.throws(() => checkSprings({'a b': [1, 0, 0]}), /名前/);
  assert.deepEqual(parseSpringArgs(['skirt=1.5,0.6,0.3', 'hair=2,0.5,0.1']), {skirt: [1.5, 0.6, 0.3], hair: [2, 0.5, 0.1]});
});

test('meta: vrmMeta が先、仮の値は missing で出力に残らず、既定値は defaulted、入力に無い作者名は出ない', () => {
  const fill = (meta, o) => { const {json} = parseGlb(makeVrm({meta})); return {...fillMeta(json, o), json}; };
  const placeholder = {name: 'Motion review', version: 'undefined', authors: [PLACEHOLDER], licenseUrl: 'https://vrm.dev/licenses/1.0/'};
  const a = fill(placeholder, {charName: 'ナース', verId: 'v1'});
  assert.deepEqual(a.meta.authors, ['未記入']);
  assert.deepEqual(a.missing, ['authors']);
  assert.equal(a.meta.name, 'ナース'); assert.equal(a.meta.version, 'v1'); assert.equal(a.sources.name, 'record');
  assert.ok(!JSON.stringify(a.json.extensions.VRMC_vrm.meta).includes(PLACEHOLDER));
  assert.deepEqual(a.defaulted.sort(), ['allowRedistribution', 'avatarPermission', 'commercialUsage', 'creditNotation', 'modification']);
  assert.equal(a.meta.commercialUsage, 'personalNonProfit'); assert.equal(a.meta.modification, 'prohibited'); assert.equal(a.meta.allowRedistribution, false);
  const b = fill(placeholder, {vrmMeta: {authors: ['LUCIAN'], commercialUsage: 'corporation'}});
  assert.deepEqual(b.meta.authors, ['LUCIAN']);
  assert.equal(b.sources.authors, 'vrmMeta'); assert.deepEqual(b.missing, []);
  assert.equal(b.meta.commercialUsage, 'corporation'); assert.ok(!b.defaulted.includes('commercialUsage'));
  const c = fill({...placeholder, name: 'Model', authors: ['Someone']}, {vrmMeta: {authors: ['Mine']}});
  assert.deepEqual(c.meta.authors, ['Mine']);   // vrmMeta が model より先
  const d = fill({...placeholder, name: 'Model', authors: ['Someone'], version: '2'}, {});
  assert.deepEqual(d.meta.authors, ['Someone']);
  assert.equal(d.sources.authors, 'model'); assert.equal(d.meta.name, 'Model');
  for (const r of [a, b, c, d]) for (const name of r.meta.authors) assert.ok(['未記入', 'LUCIAN', 'Mine', 'Someone'].includes(name));
  assert.throws(() => fillMeta(parseGlb(fakeGlb({})).json, {}), /VRMC_vrm/);
});

test('checkVrmMeta: 型の検査と、仮の値の拒否', () => {
  assert.deepEqual(checkVrmMeta({authors: [' A ', ''], allowRedistribution: true, commercialUsage: 'corporation', licenseUrl: 'https://example.com/x'}),
    {authors: ['A'], allowRedistribution: true, commercialUsage: 'corporation', licenseUrl: 'https://example.com/x'});
  assert.equal(checkVrmMeta(null), null);
  assert.equal(checkVrmMeta({}), null);
  for (const bad of [[], {name: 'x'}, {authors: 'A'}, {authors: [PLACEHOLDER]}, {allowRedistribution: 'yes'}, {commercialUsage: 'free'}, {licenseUrl: 'ftp://x'}, {authors: Array(9).fill('a')}]) assert.throws(() => checkVrmMeta(bad), Error);
});

test('inPlaceVrma: world の水平の動きが 0、y と回転のバイト列は元のまま', () => {
  const src = makeVrma(), r = inPlaceVrma(src), a = parseGlb(src), b = parseGlb(r.glb);
  const s = Math.SQRT1_2, world = ([x, y, z]) => [s * z + 1, y, -s * x + 2];   // root: Y 軸まわり 90 度(q = (0, s, 0, s))と (1, 0, 2)
  // accessor: 0 times、1 translation、2 rotation の順(makeVrma)
  const pts = arr => [...Array(4)].map((_, k) => world([...arr.subarray(k * 3, k * 3 + 3)]));
  const o = pts(readAccessor(a.json, a.bin, 1)), n = pts(readAccessor(b.json, b.bin, 1));
  assert.ok(o.some(p => Math.hypot(p[0] - o[0][0], p[2] - o[0][2]) > 0.1));
  for (const p of n) { assert.ok(Math.abs(p[0] - n[0][0]) < 1e-5); assert.ok(Math.abs(p[2] - n[0][2]) < 1e-5); }
  n.forEach((p, i) => assert.ok(Math.abs(p[1] - o[i][1]) < 1e-5));
  assert.ok(same(readAccessor(a.json, a.bin, 2), readAccessor(b.json, b.bin, 2)));   // rotation
  assert.ok(r.info.removedTravel > 0.1);
  assert.ok(Math.abs(r.info.vertical - 0.2) < 1e-4, JSON.stringify(r.info));
  assert.deepEqual(parseVrma(r.glb), parseVrma(src));
  assert.ok(inPlaceVrma(makeVrma({rotateParent: false})).glb);
});

test('inPlaceVrma: translation が無い、親が動くクリップは理由を付けて飛ばす', () => {
  assert.match(inPlaceVrma(makeVrma({translation: false})).skipped, /translation/);
  assert.match(inPlaceVrma(makeVrma({animateParent: true})).skipped, /親が動く/);
  assert.match(inPlaceVrma(Buffer.from('xx')).skipped, /読めない/);
});

async function setup(env = {}) {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c1', name: 'キャラ1', style: 'standard'});
  await lib.importVersion({charId: 'c1', id: 'v1', data: makeVrm()});
  await lib.importMotion({id: 'm1', name: 'M1', data: makeVrma(), license: {holder: 'h', summary: 's', redistribution: false}});
  return {lib, q: new JobQueue({lib, env})};
}
const sorted = async d => (await fs.readdir(d)).sort();

test('game-export ジョブ: 書き出し一式ができ、2 回目は別のフォルダで前のファイルは変わらない', async () => {
  const {lib, q} = await setup();
  await lib.updateCharacter('c1', {vrmMeta: {authors: ['ALICE']}});
  const j1 = await q.enqueue({type: 'game-export', charId: 'c1', verId: 'v1', motions: ['m1'], target: 3000});
  await q.whenIdle();
  const d1 = await q.get(j1.id);
  assert.equal(d1.state, 'done', d1.error);
  const base = path.join(lib.dir, 'characters/c1/versions/v1/game'), [id1] = await sorted(base);
  assert.match(id1, /^g\d{8}-\d{6}$/);
  assert.deepEqual(await sorted(path.join(base, id1)), ['export.json', 'model-game.vrm', 'motions']);
  const rec = JSON.parse(await fs.readFile(path.join(base, id1, 'export.json'), 'utf8'));
  assert.equal(rec.steps.merge.primitivesBefore, 4);
  assert.equal(rec.steps.merge.primitivesAfter, 3);
  assert.equal(rec.steps.meta.sources.authors, 'vrmMeta');
  assert.deepEqual(rec.steps.meta.missing, []);
  assert.deepEqual(rec.checks, {expressions: true, springJoints: true});
  assert.deepEqual(rec.steps.springs[0].after, [1.5, 0.6, 0.3]);
  assert.equal(rec.motions[0].file, 'motions/m1.vrma');
  assert.equal(rec.motions[0].license.redistribution, false);
  assert.ok(rec.warnings.some(w => /m1/.test(w)));
  assert.equal(rec.sourceSha256, sha(await fs.readFile(path.join(lib.dir, 'characters/c1/versions/v1/model.vrm'))));
  const out = parseGlb(await fs.readFile(path.join(base, id1, 'model-game.vrm')));
  assert.ok(!JSON.stringify(out.json.extensions.VRMC_vrm.meta).includes(PLACEHOLDER));
  const hashes = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir, {recursive: true})).filter(f => f.includes('.')).map(async f => [f, sha(await fs.readFile(path.join(dir, f)))])));
  const h1 = await hashes(path.join(base, id1));
  const j2 = await q.enqueue({type: 'game-export', charId: 'c1', verId: 'v1', target: 3000, springs: {}});
  await q.whenIdle();
  assert.equal((await q.get(j2.id)).state, 'done');
  const ids = await sorted(base);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(await hashes(path.join(base, id1)), h1);
});

test('game-export ジョブ: 入力の誤りと同じ版の二重は断る', async () => {
  const {lib, q} = await setup();
  await assert.rejects(q.enqueue({type: 'game-export', charId: 'c1', verId: 'v1', motions: ['nope']}), {code: 'not-found'});
  await assert.rejects(q.enqueue({type: 'game-export', charId: 'c1', verId: 'zz'}), {code: 'not-found'});
  await assert.rejects(q.enqueue({type: 'game-export', charId: 'c1', verId: 'v1', target: 5}), {code: 'bad-input'});
  await assert.rejects(q.enqueue({type: 'game-export', charId: 'c1', verId: 'v1', springs: {a: [1]}}), {code: 'bad-input'});
  await lib.importVersion({charId: 'c1', id: 'v0x', data: makeVrm({vrm0: true})});
  await assert.rejects(q.enqueue({type: 'game-export', charId: 'c1', verId: 'v0x'}), {code: 'bad-input'});
  await lib.createCharacter({id: 'cr', name: '生き物', style: 'creature'});
  await assert.rejects(q.enqueue({type: 'game-export', charId: 'cr', verId: 'v1'}), {code: 'bad-input'});
  await q.enqueue({type: 'game-export', charId: 'c1', verId: 'v1', target: 3000});
  await assert.rejects(q.enqueue({type: 'game-export', charId: 'c1', verId: 'v1', target: 3000}), {code: 'busy'});
  await q.whenIdle();
});

test('API: vrmMeta の PATCH の検査と、game-exports の一覧', async () => {
  const s = await startServer();
  try {
    const lib = new Library(s.libraryDir);
    await lib.createCharacter({id: 'c1', name: 'C1', style: 'standard'});
    await lib.importVersion({charId: 'c1', id: 'v1', data: makeVrm()});
    const patch = body => fetch(`${s.base}/api/characters/c1`, {method: 'PATCH', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    assert.equal((await patch({vrmMeta: {commercialUsage: 'free'}})).status, 400);
    assert.equal((await patch({vrmMeta: {name: 'x'}})).status, 400);
    assert.equal((await patch({vrmMeta: {authors: ['A'], allowRedistribution: false}})).status, 200);
    assert.deepEqual((await lib.getCharacterJson('c1')).vrmMeta, {authors: ['A'], allowRedistribution: false});
    assert.equal((await patch({vrmMeta: null})).status, 200);
    assert.equal((await lib.getCharacterJson('c1')).vrmMeta, undefined);
    assert.deepEqual(await (await fetch(`${s.base}/api/characters/c1/versions/v1/game-exports`)).json(), []);
    const job = await (await fetch(`${s.base}/api/jobs`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({type: 'game-export', charId: 'c1', verId: 'v1', target: 3000})})).json();
    await s.server.jobs.whenIdle();
    const list = await (await fetch(`${s.base}/api/characters/c1/versions/v1/game-exports`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].jobId, job.id);
    assert.equal((await fetch(s.base + list[0].modelUrl)).status, 200);
    assert.equal((await fetch(`${s.base}/api/characters/c1/versions/nope/game-exports`)).status, 404);
  } finally { await s.close(); }
});

test('planBudget: 大きい MASK は減らし、小さい MASK と BLEND は守る', () => {
  const prims = [{id: 'big', triangles: 10000, alphaMode: 'MASK', indexed: true}, {id: 'small', triangles: 2000, alphaMode: 'MASK', indexed: true}, {id: 'blend', triangles: 5000, alphaMode: 'BLEND', indexed: true}];
  const p = planBudget(prims, {target: 9000});
  assert.deepEqual(p.items.map(i => i.reason !== null), [false, true, true]);
  assert.equal(p.protectedTriangles, 7000);
  assert.equal(planBudget(prims, {target: 9000, maskMinTris: 20000}).items.every(i => i.reason), true);
});

test('decimate: 大きい MASK も減る。alphaCutoff と UV と表情のモーフ数は変わらない', async () => {
  const src = makeVrm(), before = parseGlb(src);
  const {glb, report} = await decimateGlb(src, {target: 2500, minPrimTris: 100, maskMinTris: 1000});
  const after = parseGlb(glb), mask = report.primitives.find(p => p.alphaMode === 'MASK');
  assert.equal(mask.protectedBy, null);
  assert.ok(mask.after < mask.before, `${mask.before} -> ${mask.after}`);
  assert.deepEqual(after.json.materials[1], before.json.materials[1]);
  const n = primArrays(after.json, after.bin, after.json.meshes[1].primitives[0]);
  assert.ok(n.TEXCOORD_0.length / 2 === n.POSITION.length / 3 && Math.max(...n.idx) < n.POSITION.length / 3);
  const small = await decimateGlb(src, {target: 2500, minPrimTris: 100});   // 既定の閾値(2,000)以下の MASK は守る
  assert.equal(small.report.primitives.find(p => p.alphaMode === 'MASK').protectedBy, 'alphaMode MASK');
  const a = measureJson(before.json, src.length), b = measureJson(after.json, glb.length);
  assert.equal(b.expressions, a.expressions);
  assert.equal(JSON.stringify(after.json.extensions.VRMC_vrm.expressions), JSON.stringify(before.json.extensions.VRMC_vrm.expressions));
  assert.ok(b.triangles < a.triangles);
});

const execFileP = promisify(execFile);
const pyCtx = (input, extra = {}) => ({job: {input}, workDir: path.join(os.tmpdir(), 'charasta-ge-test-' + crypto.randomUUID()), log() {}, step: async () => {},
  run: async (cmd, args) => (await execFileP(findPython() ?? 'python', args, {env: {...process.env, PYTHONUTF8: '1'}, maxBuffer: 1 << 26})).stdout, ...extra});

test('game-export: 積んだあとに消されたモーションはそれだけ skipped にして続ける', async () => {
  const {lib} = await setup();
  await lib.importMotion({id: 'm2', name: 'M2', data: makeVrma()});
  const input = await gameExportInput(lib, {charId: 'c1', verId: 'v1', motions: ['m1', 'm2'], target: 3000});
  await fs.rm(lib.motionDir('m1'), {recursive: true});
  const ctx = pyCtx(input);
  try {
    const r = await runGameExport(ctx, {lib});
    assert.equal(r.motions, 1); assert.equal(r.skippedMotions, 1);
    const rec = JSON.parse(await fs.readFile(path.join(lib.dir, 'characters/c1/versions/v1/game', r.exportId, 'export.json'), 'utf8'));
    assert.equal(rec.status, 'done');
    assert.match(rec.motions.find(m => m.motionId === 'm1').skipped, /消された/);
    assert.equal(rec.motions.find(m => m.motionId === 'm2').file, 'motions/m2.vrma');
  } finally { await fs.rm(ctx.workDir, {recursive: true, force: true}); }
});

test('game-export: 途中で止まった書き出しは一覧に running で出て、次の書き出しの開始で消える', async () => {
  const {lib} = await setup();
  const base = path.join(lib.dir, 'characters/c1/versions/v1/game');
  await fs.mkdir(path.join(base, 'g-stale-running'), {recursive: true});
  await fs.writeFile(path.join(base, 'g-stale-running/export.json'), JSON.stringify({exportId: 'g-stale-running', status: 'running', pid: 2 ** 22 + 12345, createdAt: '2026-01-01T00:00:00.000Z'}));
  await fs.mkdir(path.join(base, 'g-stale-empty'), {recursive: true});
  await fs.mkdir(path.join(base, 'g-other-live'), {recursive: true});
  await fs.writeFile(path.join(base, 'g-other-live/export.json'), JSON.stringify({exportId: 'g-other-live', status: 'running', pid: process.pid, createdAt: '2026-01-01T00:00:00.000Z'}));
  assert.deepEqual((await listGameExports(lib, 'c1', 'v1')).map(r => r.exportId).sort(), ['g-other-live', 'g-stale-running']);
  const input = await gameExportInput(lib, {charId: 'c1', verId: 'v1', target: 3000});
  let during = null;
  const ctx = pyCtx(input, {step: async name => { if (name.includes('三角形') && !during) during = (await listGameExports(lib, 'c1', 'v1')).filter(r => r.status === 'running').map(r => r.exportId); }});
  try {
    const r = await runGameExport(ctx, {lib});
    assert.deepEqual(await sorted(base), ['g-other-live', r.exportId].sort());   // 死んだ pid の running と export.json の無いものは消え、生きているものは残る
    assert.ok(during.includes(r.exportId) && !during.includes('g-stale-running'));
  } finally { await fs.rm(ctx.workDir, {recursive: true, force: true}); }
});

test('sphere fixture の三角形の数', () => { assert.equal(sphere(8, 8).idx.length / 3, 128); });
