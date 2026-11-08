// 版の顔の確認(lib/face-check.mjs): 方式の判定、API、確かめの撮影のジョブ。ブラウザでは撮らない(CHARASTA_FAKE_CAPTURE)。ffmpeg は要る。
// 本物の VRM を本物のブラウザで撮る試験は CHARASTA_TEST_VRM=<VRM のパス> のときだけ動く(test/face-check-real.test.mjs)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Library} from '../lib/library.mjs';
import {faceOf, fclName, keyPlan, motionPlan, swapIn} from '../lib/face-check.mjs';
import {startServer, fakeGlb, fakeCharakuru, tempDir, STUDIO_ENV} from './helpers.mjs';

const fcl = {nodes: [{name: 'Face', mesh: 0}], meshes: [{extras: {targetNames: ['Fcl_ALL_Neutral', 'Fcl_EYE_Close', 'Fcl_MTH_A', 'Fcl_HA_Fung1', 'Fcl_HA_Hide', 'other']}}], materials: [{name: 'N00_000_00_Face_00_SKIN (Instance)'}],
  extensions: {VRMC_vrm: {humanoid: {humanBones: {leftEye: {node: 0}, rightEye: {node: 0}}}, lookAt: {type: 'bone'},
    expressions: {preset: {neutral: {morphTargetBinds: [{node: 0, index: 0, weight: 1}]}, blink: {morphTargetBinds: [{node: 0, index: 1, weight: 1}]}, aa: {morphTargetBinds: [{node: 0, index: 2, weight: 1}]}, lookUp: {}}}}}};
const v0 = {nodes: [{name: 'Face', mesh: 0}], meshes: [{extras: {targetNames: ['Fcl_ALL_Joy', 'Fcl_EYE_Close']}}],
  extensions: {VRM: {humanoid: {humanBones: [{bone: 'leftEye'}, {bone: 'rightEye'}]}, firstPerson: {lookAtTypeName: 'Bone'},
    blendShapeMaster: {blendShapeGroups: [{presetName: 'joy', binds: [{mesh: 0, index: 0, weight: 100}]}, {presetName: 'blink', binds: [{mesh: 0, index: 1, weight: 100}]}]}}}};

test('方式の判定: Fcl_ のキー、顔画像の方式、それ以外', () => {
  const f = faceOf(fcl);
  assert.equal(f.method, 'shapekey'); assert.equal(f.vrm, 1); assert.deepEqual(f.keys, ['Fcl_ALL_Neutral', 'Fcl_EYE_Close', 'Fcl_MTH_A', 'Fcl_HA_Fung1', 'Fcl_HA_Hide']);
  assert.equal(f.lookAt, 'bone'); assert.equal(f.eyeBones, true); assert.equal(f.skinMaterial, 'Face_00_SKIN');   // VRoid の材質の名前の一部
  assert.equal(f.presets.length, 14); assert.deepEqual(f.presets.find(p => p.name === 'blink').keys, ['Fcl_EYE_Close']);
  assert.equal(f.presets.find(p => p.name === 'happy').bound, false);
  assert.equal(faceOf({images: [{name: 'FaceAtlas_upper_lid'}]}).method, 'atlas');
  assert.equal(faceOf({nodes: [{name: 'Face_layers'}]}).method, 'atlas');
  assert.equal(faceOf({}).method, 'other'); assert.equal(faceOf({}).vrm, null);
});

test('材質の前置きが付いた Fcl_ のキー: シェイプキー方式として読み、組み合わせも元の名前で作る', () => {
  const m = 'Face.M_F00_000_00_', names = [m + 'Fcl_ALL_Angry', m + 'Fcl_MTH_A', m + 'Fcl_HA_Fung1', 'notFcl_x'];
  const f = faceOf({meshes: [{extras: {targetNames: names}}]});
  assert.equal(f.method, 'shapekey'); assert.deepEqual(f.keys, names.slice(0, 3));
  assert.equal(fclName(m + 'Fcl_MTH_A'), 'Fcl_MTH_A'); assert.equal(fclName('Fcl_MTH_A'), 'Fcl_MTH_A'); assert.equal(fclName('other'), 'other');
  const plan = keyPlan(f.keys);
  assert.deepEqual(plan.map(p => p.group), ['ALL', 'MTH', 'HA', 'MIX']);
  assert.equal(plan[1].name, 'Fcl_MTH_A'); assert.equal(plan[1].key, m + 'Fcl_MTH_A');
  assert.equal(plan[3].key, `${m}Fcl_MTH_A+${m}Fcl_HA_Fung1`); assert.equal(plan[3].name, 'Fcl_MTH_A+Fcl_HA_Fung1');
});

test('VRM 0: Fcl_ のキーがあればプリセットも読める', () => {
  const f = faceOf(v0);
  assert.equal(f.vrm, 0); assert.equal(f.method, 'shapekey'); assert.equal(f.lookAt, 'bone'); assert.equal(f.eyeBones, true);
  assert.deepEqual(f.presets.find(p => p.name === 'happy').keys, ['Fcl_ALL_Joy']);
  assert.equal(f.presets.find(p => p.name === 'blink').bound, true); assert.equal(f.presets.find(p => p.name === 'aa').bound, false);
});

test('撮影の一覧の形: ファイル名はキーの名前によらない。組み合わせは両方のキーがあるときだけ', () => {
  const list = keyPlan(['Fcl_MTH_A', 'Fcl_HA_Fung1', '../x:y']);
  assert.deepEqual(list.map(p => p.key), ['Fcl_MTH_A', 'Fcl_HA_Fung1', '../x:y', 'Fcl_MTH_A+Fcl_HA_Fung1']);
  assert.ok(list.every(p => /^k\d{3}\.png$/.test(p.file) && p.kind === 'key'));
  assert.equal(new Set(list.map(p => p.file)).size, list.length);
  assert.deepEqual(list.map(p => p.group), ['MTH', 'HA', 'OTHER', 'MIX']);
  const m = motionPlan(24, 16);
  assert.equal(m.length, 90);
  assert.deepEqual(m.slice(0, 4).map(p => [p.expr, p.view]), [['none', 'y0'], ['none', 'y45'], ['aa', 'y0'], ['aa', 'y45']]);
  assert.ok(m.every(p => p.kind === 'motion' && /^f_\d{4}\.jpg$/.test(p.file)));
});

const call = async (base, method, url, body) => {
  const r = await fetch(base + url, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  return {status: r.status, body: await r.json().catch(() => null)};
};
async function waitAll(base) {
  for (let i = 0; i < 1200; i++) {
    const jobs = (await call(base, 'GET', '/api/jobs')).body;
    if (!jobs.some(j => j.state === 'queued' || j.state === 'running')) return jobs;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error('ジョブが 120 秒で終わらない');
}
const verDir = (s, v) => path.join(s.libraryDir, 'characters', 'c1', 'versions', v);
const job = (s, b) => call(s.base, 'POST', '/api/jobs', {type: 'face-check', charId: 'c1', verId: 'v1', ...b});

async function withServer(env, fn) {
  const s = await startServer({env, charakuruApp: await fakeCharakuru()});
  try {
    const lib = new Library(s.libraryDir);
    await lib.createCharacter({id: 'c1', name: 'C1'});
    const data = fakeGlb(fcl);
    await lib.importVersion({charId: 'c1', id: 'v1', label: '', note: 'n', data, sourcePath: 'x.vrm'});
    await lib.importVersion({charId: 'c1', id: 'v2', label: '', note: 'n', data: fakeGlb({images: [{name: 'FaceAtlas_mouth'}]}), sourcePath: 'y.vrm'});
    await fn(s, lib, data);
  } finally { await s.close(); }
}
async function addMotion(s, id) {
  const dir = path.join(s.libraryDir, 'motions', id);
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, 'motion.json'), JSON.stringify({id, name: id, label: id, license: {summary: '', redistribution: false}}));
  await fs.writeFile(path.join(dir, 'motion.vrma'), fakeGlb());
}

test('API: 版の顔の情報、不正な入力、撮影の結果の形、版の model.vrm は変えない', async () => {
  await withServer(STUDIO_ENV, async (s, lib, data) => {
    let r = await call(s.base, 'GET', '/api/characters/c1/versions/v1/face');
    assert.equal(r.status, 200); assert.equal(r.body.method, 'shapekey'); assert.deepEqual(r.body.checks, {});
    assert.equal((await call(s.base, 'GET', '/api/characters/c1/versions/v2/face')).body.method, 'atlas');
    assert.equal((await call(s.base, 'GET', '/api/characters/c1/versions/zz/face')).status, 404);
    assert.equal((await job(s, {verId: 'zz', set: 'grid'})).status, 404);
    for (const set of ['x', 'constructor', '__proto__', ['grid'], undefined]) assert.equal((await job(s, {set})).status, 400, String(set));
    assert.equal((await job(s, {set: 'motion'})).status, 400);
    assert.equal((await job(s, {set: 'motion', motionId: 'nope'})).status, 404);
    assert.equal((await job(s, {verId: 'v2', set: 'keys'})).status, 400);
    r = await job(s, {set: 'keys'});
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r));
    const jobs = await waitAll(s.base), j = jobs.find(x => x.id === r.body.id);
    assert.equal(j.state, 'done', j.error);
    r = await call(s.base, 'GET', '/api/characters/c1/versions/v1/face');
    assert.equal(r.body.checks.keys.count, 5 + 2);   // キー 5 と組み合わせ 2(Fung1、Hide)
    for (const img of r.body.checks.keys.images) { assert.equal(img.kind, 'key'); assert.equal((await fetch(s.base + img.url)).status, 200); }
    assert.deepEqual(await fs.readFile(path.join(verDir(s, 'v1'), 'model.vrm')), data);
    assert.deepEqual(await fs.readdir(path.join(verDir(s, 'v1'), 'checks')), ['keys']);
  });
});

// 終わらない撮影。上限が来るまで必ず実行中なので、409 の確かめが時間に依存しない
const HANG = {...STUDIO_ENV, CHARASTA_FAKE_CAPTURE: 'hang', CHARASTA_SHOOT_TIMEOUT_MS: '1500'};

test('実行中: 同じ版の同じ種類は 409、使っているモーションと版はごみ箱へ移せない', async () => {
  await withServer(HANG, async s => {
    await addMotion(s, 'm1');
    const a = await job(s, {set: 'motion', motionId: 'm1'});
    assert.ok(a.status < 300, JSON.stringify(a)); assert.equal(a.body.input.motionId, 'm1');
    assert.equal((await job(s, {set: 'motion', motionId: 'm1'})).status, 409);
    assert.equal((await call(s.base, 'DELETE', '/api/motions/m1')).status, 409);
    assert.equal((await call(s.base, 'DELETE', '/api/characters/c1/versions/v1')).status, 409);
    await waitAll(s.base);
    assert.equal((await call(s.base, 'DELETE', '/api/motions/m1')).status, 200);
  });
});

test('VRM 0 の版: 情報は読めるが、モーションの撮影は前後が逆になるので断る', async () => {
  await withServer(STUDIO_ENV, async (s, lib) => {
    await addMotion(s, 'm1');
    await lib.importVersion({charId: 'c1', id: 'v0', label: '', note: 'n', data: fakeGlb(v0), sourcePath: 'z.vrm'});
    const info = (await call(s.base, 'GET', '/api/characters/c1/versions/v0/face')).body;
    assert.equal(info.vrm, 0); assert.equal(info.method, 'shapekey');
    const r = await job(s, {verId: 'v0', set: 'motion', motionId: 'm1'});
    assert.equal(r.status, 400); assert.match(r.body.error, /VRM 1 へ変換/);
    assert.ok((await job(s, {verId: 'v0', set: 'keys'})).status < 300);
    await waitAll(s.base);
  });
});

test('swapIn: 置き換えの途中で失敗しても前の撮影と新しい撮影を失わない', async () => {
  const dir = await tempDir(), out = path.join(dir, 'grid'), tmp = out + '.tmp', old = out + '.old';
  const put = async (d, text) => { await fs.mkdir(d, {recursive: true}); await fs.writeFile(path.join(d, 'a.txt'), text); };
  const read = d => fs.readFile(path.join(d, 'a.txt'), 'utf8');
  await put(out, '前'); await put(tmp, '新');
  const refuse = when => (from, to) => when(from, to) ? Promise.reject(Object.assign(new Error('差し込んだ失敗'), {code: 'EPERM'})) : fs.rename(from, to);
  await assert.rejects(swapIn(tmp, out, old, refuse((from, to) => to === out && from === tmp)), /差し込んだ失敗/);   // 新しい撮影を置けない
  assert.equal(await read(out), '前'); assert.equal(await read(tmp), '新');
  await assert.rejects(swapIn(tmp, out, old, refuse(from => from === out)), /差し込んだ失敗/);   // 前の撮影を避けられない
  assert.equal(await read(out), '前'); assert.equal(await read(tmp), '新');
  await swapIn(tmp, out, old, fs.rename);
  assert.equal(await read(out), '新'); assert.deepEqual(await fs.readdir(dir), ['grid']);
  await fs.rm(dir, {recursive: true, force: true});
});

test('撮り直し: 前の撮影を置き換え、.tmp と .old を残さない', async () => {
  await withServer(STUDIO_ENV, async s => {
    const a = await job(s, {set: 'grid'});
    assert.ok(a.status < 300);
    await waitAll(s.base);
    const first = (await call(s.base, 'GET', '/api/characters/c1/versions/v1/face')).body.checks.grid;
    assert.equal(first.jobId, a.body.id);
    const c = await job(s, {set: 'grid'}); assert.ok(c.status < 300, JSON.stringify(c));
    await waitAll(s.base);
    const again = (await call(s.base, 'GET', '/api/characters/c1/versions/v1/face')).body.checks.grid;
    assert.equal(again.jobId, c.body.id); assert.notEqual(again.at, first.at);
    assert.deepEqual(await fs.readdir(path.join(verDir(s, 'v1'), 'checks')), ['grid']);
  });
});

test('失敗: 時間の上限を超えた撮影は failed で、作業の .tmp を消し、前の撮影は残る', async () => {
  await withServer({...STUDIO_ENV, CHARASTA_FAKE_CAPTURE: '1'}, async s => {
    const a = await job(s, {set: 'grid'}); await waitAll(s.base);
    assert.ok(a.status < 300);
    const dir = path.join(verDir(s, 'v1'), 'checks');
    const before = await fs.readFile(path.join(dir, 'grid', 'check.json'), 'utf8');
    s.server.jobs.extraEnv.CHARASTA_FAKE_CAPTURE = 'hang'; s.server.jobs.extraEnv.CHARASTA_SHOOT_TIMEOUT_MS = '300';
    const b = await job(s, {set: 'grid'});
    const f = (await waitAll(s.base)).find(x => x.id === b.body.id);
    assert.equal(f.state, 'failed'); assert.match(f.error, /秒で終わらなかった/); assert.equal(f.timeoutMs, 300);
    assert.deepEqual(await fs.readdir(dir), ['grid']);
    assert.equal(await fs.readFile(path.join(dir, 'grid', 'check.json'), 'utf8'), before);
  });
});

test('置き換えが途中で止まった残りの .old は、次の撮影で戻してから進む', async () => {
  await withServer(STUDIO_ENV, async s => {
    await job(s, {set: 'grid'}); await waitAll(s.base);
    const dir = path.join(verDir(s, 'v1'), 'checks');
    await fs.rename(path.join(dir, 'grid'), path.join(dir, 'grid.old'));
    const c = await job(s, {set: 'grid'}); await waitAll(s.base);
    assert.ok(c.status < 300);
    assert.deepEqual(await fs.readdir(dir), ['grid']);
  });
});

test('motion: 表情とコマの一覧と髪の測定。測れないときは hair が null', async () => {
  await withServer(STUDIO_ENV, async s => {
    await addMotion(s, 'm1');
    const r = await job(s, {set: 'motion', motionId: 'm1'}); assert.ok(r.status < 300, JSON.stringify(r));
    assert.equal(r.body.input.motionId, 'm1');
    await waitAll(s.base);
    let c = (await call(s.base, 'GET', '/api/characters/c1/versions/v1/face')).body.checks.motion;
    assert.equal(c.motionId, 'm1'); assert.equal(c.hair.measured, true); assert.equal(c.images[1].view, 'y45');
    s.server.jobs.extraEnv.CHARASTA_FAKE_CAPTURE = 'nohair';
    await job(s, {set: 'motion', motionId: 'm1'}); await waitAll(s.base);
    c = (await call(s.base, 'GET', '/api/characters/c1/versions/v1/face')).body.checks.motion;
    assert.equal(c.hair, null);
  });
});

test('版をごみ箱へ移して戻すと、撮影も一緒に戻る', async () => {
  await withServer(STUDIO_ENV, async s => {
    await job(s, {set: 'grid'});
    await waitAll(s.base);
    const del = await call(s.base, 'DELETE', '/api/characters/c1/versions/v1');
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal((await call(s.base, 'GET', '/api/characters/c1/versions/v1/face')).status, 404);
    assert.equal((await call(s.base, 'POST', `/api/trash/${del.body.item.trashId}/restore`)).status, 200);
    const c = (await call(s.base, 'GET', '/api/characters/c1/versions/v1/face')).body.checks.grid;
    assert.equal(c.count, 1); assert.equal((await fetch(s.base + c.images[0].url)).status, 200);
  });
});
