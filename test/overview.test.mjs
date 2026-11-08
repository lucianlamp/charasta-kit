// ライブラリの集計(lib/overview.mjs)、利用条件の札、作り方の記録、きゃらくるのプロジェクトからの版の取り込み。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {overview, stageProgress, finishedVersions, projectProgress, vrmExpressions} from '../lib/overview.mjs';
import {Library} from '../lib/library.mjs';
import {limitOf} from '../lib/terms.mjs';
import {tempDir, fakeGlb, fakeCharakuru, startServer, STUDIO_ENV} from './helpers.mjs';

const ALL = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
async function call(base, method, url, body) {
  const r = await fetch(base + url, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* 本文が無い */ }
  return {status: r.status, body: json};
}

test('stageProgress: 記録から出す。判定できないものは「途中」にしない', () => {
  assert.deepEqual(stageProgress({versions: 0, motions: 3}), {create: 'none', motion: 'none', expression: 'none', finish: 'none'});
  assert.equal(stageProgress({versions: 0, motions: 3, method: 'kimi'}).create, 'doing');
  assert.equal(stageProgress({versions: 0, motions: 3, projects: 1}).create, 'doing');
  assert.deepEqual(stageProgress({versions: 1, motions: 0}), {create: 'done', motion: 'none', expression: 'none', finish: 'none'});
  assert.equal(stageProgress({versions: 1, motions: 1}).motion, 'done');
  assert.equal(stageProgress({versions: 1, motions: 1, expressions: ALL}).expression, 'done');
  assert.equal(stageProgress({versions: 1, motions: 1, expressions: ['happy']}).expression, 'doing');
  assert.equal(stageProgress({versions: 1, motions: 1, expressions: ['aa', 'blink']}).expression, 'none');   // 感情が 1 つも無ければ、口とまばたきだけでは表情にならない
  assert.equal(stageProgress({versions: 1, motions: 1, studios: [{versions: [], prototypes: 0}]}).expression, 'doing');
  assert.equal(stageProgress({versions: 1, motions: 1, studios: [{versions: [], prototypes: 0}]}).finish, 'none');
  assert.equal(stageProgress({versions: 1, motions: 1, studios: [{versions: [], prototypes: 2}]}).finish, 'doing');
  assert.equal(stageProgress({versions: 1, motions: 1, studios: [{versions: ['v2'], prototypes: 2}]}).finish, 'done');
});

test('finishedVersions: 版にした版と最新の版。新しい順', () => {
  const ch = {latestVersion: 'v1', versions: [{id: 'v1', order: 1}, {id: 'v2', order: 2}, {id: 'v3', order: 3}]};
  assert.deepEqual(finishedVersions(ch, []).map(v => [v.id, v.promoted, v.latest]), [['v1', false, true]]);
  assert.deepEqual(finishedVersions(ch, [{versions: ['v3']}]).map(v => [v.id, v.promoted, v.latest]), [['v3', true, false], ['v1', false, true]]);
  assert.deepEqual(finishedVersions({latestVersion: null, versions: []}, []), []);
});

test('projectProgress: キットの記録から工程を読む', () => {
  const done = p => projectProgress(p).filter(s => s.done).map(s => s.key);
  assert.deepEqual(done({}), []);
  const slots = Object.fromEntries([...Array(8).keys()].map(i => ['s' + i, {adopted: 'x'}]));
  assert.deepEqual(done({imageLibrary: {slots}}), ['images']);
  assert.deepEqual(done({imageLibrary: {slots}, production: {phase: 'candidates', candidates: {head: [1], body: [1]}}}), ['images', 'candidates']);
  assert.deepEqual(done({imageLibrary: {slots}, production: {phase: 'assembled', candidates: {head: [1], body: [1]}}, mode: 'assembled', workflow: {phase: 'weighted'}}), ['images', 'candidates', 'materials', 'rig']);
  assert.deepEqual(done({imageLibrary: {slots}, production: {phase: 'assembled', candidates: {head: [1], body: [1]}}, mode: 'assembled', workflow: {phase: 'springs'}, reviewVRM: {path: 'x'}}),
    ['images', 'candidates', 'materials', 'rig', 'springs', 'vrm']);
});

test('vrmExpressions: 中身のある表情だけを JSON チャンクから読む。VRM でなければ空', async () => {
  const dir = await tempDir(), file = path.join(dir, 'm.vrm');
  await fs.writeFile(file, fakeGlb({extensions: {VRMC_vrm: {expressions: {preset: {happy: {morphTargetBinds: [{}]}, sad: {textureTransformBinds: [{}]}, angry: {morphTargetBinds: []}}}}}}));
  assert.deepEqual(await vrmExpressions(file), ['happy', 'sad']);
  await fs.writeFile(file, 'not a glb, just some text longer than the head');
  assert.deepEqual(await vrmExpressions(file), []);
  assert.deepEqual(await vrmExpressions(path.join(dir, 'none.vrm')), []);
});

test('limitOf: 評価用、個人利用、二次配布の札', () => {
  assert.deepEqual(limitOf({license: {evaluationOnly: true, redistribution: false}}), {text: '評価用のみ', warn: true});
  assert.deepEqual(limitOf({license: {summary: '個人利用のみ。公開・再配布は不可', redistribution: false}}), {text: '個人利用のみ', warn: true});
  assert.deepEqual(limitOf({license: {summary: '改変可', redistribution: false}}), {text: '二次配布 不可', warn: false});
  assert.deepEqual(limitOf({license: {redistribution: true}}), {text: '二次配布 可', warn: false});
  assert.deepEqual(limitOf({}), {text: '利用条件の記録なし', warn: false});
});

test('作り方: 作るときと PATCH で記録し、ほかの値は拒否する', async () => {
  const lib = new Library(await tempDir());
  assert.equal((await lib.createCharacter({id: 'c1', name: 'C1', method: 'kimi'})).method, 'kimi');
  assert.equal((await lib.createCharacter({id: 'c2', name: 'C2'})).method, undefined);
  await assert.rejects(lib.createCharacter({id: 'c3', name: 'C3', method: 'x'}), {code: 'bad-input'});
  assert.equal((await lib.updateCharacter('c2', {method: 'tripo'})).method, 'tripo');
  assert.equal((await lib.updateCharacter('c2', {method: null})).method, null);
  await assert.rejects(lib.updateCharacter('c2', {method: 'x'}), {code: 'bad-input'});
});

test('スタイル: 作るときと PATCH で記録し、無いキャラは null、不正な値は拒否する', async () => {
  const lib = new Library(await tempDir());
  assert.equal((await lib.createCharacter({id: 'c1', name: 'C1', style: 'standard'})).style, 'standard');
  assert.equal((await lib.createCharacter({id: 'c2', name: 'C2'})).style, undefined);   // ライブラリ層は省略を許す
  for (const bad of ['x', '', 'Standard', 5, null, false]) {
    await assert.rejects(lib.createCharacter({id: 'c3', name: 'C3', style: bad}), {code: 'bad-input'}, JSON.stringify(bad));
    await assert.rejects(lib.updateCharacter('c1', {style: bad}), {code: 'bad-input'}, JSON.stringify(bad));
  }
  await assert.rejects(fs.stat(path.join(lib.dir, 'characters/c3')), {code: 'ENOENT'});   // 失敗したら作らない
  assert.equal((await lib.getCharacter('c1')).style, 'standard');
  assert.equal((await lib.getCharacter('c2')).style, null);
  assert.equal((await lib.updateCharacter('c2', {style: 'chibi'})).style, 'chibi');
  assert.equal((await lib.getCharacter('c2')).style, 'chibi');
  await assert.rejects(lib.updateCharacter('c2', {nick: 1}), /style/);   // 許すキーの案内に style が出る
  assert.deepEqual((await lib.listCharacters()).map(c => [c.id, c.style]), [['c1', 'standard'], ['c2', 'chibi']]);
  await lib.createCharacter({id: 'c4', name: 'C4'});
  assert.equal((await lib.listCharacters()).find(c => c.id === 'c4').style, null);
  const ov = await overview(lib, {list: async () => []}, {});
  assert.deepEqual(ov.chars.map(c => [c.id, c.style]), [['c1', 'standard'], ['c2', 'chibi'], ['c4', null]]);
});

test('API: /api/overview、POST /api/characters、プロジェクトからの版の取り込み(元は読むだけ)', async () => {
  const app = await fakeCharakuru(), s = await startServer({charakuruApp: app, env: STUDIO_ENV, charakuruUrl: 'http://127.0.0.1:8766/'});
  try {
    assert.equal((await call(s.base, 'POST', '/api/characters', {id: 'c1', name: 'C1', method: 'tripo', style: 'chibi'})).status, 201);
    assert.equal((await call(s.base, 'POST', '/api/characters', {id: 'c1', name: 'C1', style: 'chibi'})).status, 409);
    for (const bad of [{}, {style: null}, {style: 'big'}, {style: 5}]) {   // 新しいキャラは style が必須
      assert.equal((await call(s.base, 'POST', '/api/characters', {id: 'c9', name: 'C9', ...bad})).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call(s.base, 'GET', '/api/characters/c9')).status, 404);
    assert.equal((await call(s.base, 'GET', '/api/characters/c1')).body.style, 'chibi');
    assert.equal((await call(s.base, 'GET', '/api/characters')).body[0].style, 'chibi');
    assert.equal((await call(s.base, 'PATCH', '/api/characters/c1', {style: 'standard'})).body.style, 'standard');
    assert.equal((await call(s.base, 'PATCH', '/api/characters/c1', {style: 'x'})).status, 400);
    assert.equal((await call(s.base, 'POST', '/api/characters', {id: 'bad id', name: 'C', style: 'chibi'})).status, 400);
    let ov = (await call(s.base, 'GET', '/api/overview')).body;
    assert.equal(ov.charakuruUrl, 'http://127.0.0.1:8766/');
    assert.deepEqual(ov.chars[0].stages, {create: 'doing', motion: 'none', expression: 'none', finish: 'none'});
    assert.deepEqual(ov.chars[0].finished, []);

    const src = path.join(app, 'projects', 'p1', 'work', 'review.vrm'), before = await fs.stat(src);
    const url = '/api/characters/c1/versions';
    assert.equal((await call(s.base, 'POST', url, {project: 'p1', verId: 'v1'})).status, 400);   // 変えたことが要る
    assert.equal((await call(s.base, 'POST', url, {project: 'nope', verId: 'v1', note: 'n'})).status, 404);
    assert.equal((await call(s.base, 'POST', url, {project: '../x', verId: 'v1', note: 'n'})).status, 400);
    const r = await call(s.base, 'POST', url, {project: 'p1', verId: 'v1', note: '最初の版'});
    assert.equal(r.status, 201); assert.equal(r.body.version.source.charakuruProject, 'p1');
    assert.equal((await call(s.base, 'POST', url, {project: 'p1', verId: 'v1', note: '同じ ID'})).status, 409);
    assert.equal((await fs.stat(src)).mtimeMs, before.mtimeMs);
    ov = (await call(s.base, 'GET', '/api/overview')).body;
    assert.equal(ov.chars[0].stages.create, 'done');
    assert.deepEqual(ov.chars[0].projects, ['p1']);
    assert.deepEqual(ov.chars[0].finished.map(f => f.id), ['v1']);
    assert.equal((await call(s.base, 'GET', '/api/charakuru/projects')).body[0].progress.length, 6);
  } finally { await s.close(); await fs.rm(app, {recursive: true, force: true}); }
});
