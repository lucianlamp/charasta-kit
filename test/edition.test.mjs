// 版の種類(lib/edition.mjs、docs/edition.md): キットで外した機能はジョブも API も断り、画面の名前を変える。作者の版は変わらない。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../lib/config.mjs';
import {fakeGlb, FAKE_ENV, SAMPLE_VRMA, startServer, tempDir} from './helpers.mjs';

const ENV = {...FAKE_ENV, CHARASTA_FAKE_VOICEVOX: '1', CHARASTA_FAKE_VRMA_PIPELINE: '1', CHARASTA_FAKE_MOTIONBRICKS: '1', CHARASTA_FAKE_KIMODO: '1'};
const REMOVED_JOBS = ['motion-text', 'game-export', 'short-draft', 'short-figures'];

async function stageDir() {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'stages'));
  await fs.writeFile(path.join(dir, 'stages', 'catalog.json'), JSON.stringify([{id: 'concert', label: 'コンサート'}, {id: 'classroom', label: '教室'}]));
  return dir;
}

async function server(edition) {
  const s = await startServer({stageStudioDir: await stageDir(), env: ENV, ...(edition && {edition})});
  const lib = s.server.jobs.lib;
  await lib.createCharacter({id: 'c1', name: 'いち', style: 'standard'});
  await lib.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({a: 1})});
  await lib.importMotion({id: 'talk', data: await fs.readFile(SAMPLE_VRMA), label: '話す', license: {holder: 'h', summary: '改変可', redistribution: false}});
  const api = async (method, url, body) => {
    const r = await fetch(s.base + url, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)});
    return {status: r.status, json: await r.json().catch(() => null)};
  };
  return {...s, api};
}
const CUT = {stage: 'classroom', motionId: 'talk', expression: 'neutral', camera: 'talk_bust', text: 'こんにちは', telop: ''};
const short = (o = {}) => ({title: '話す', charId: 'c1', cuts: [CUT], ...o});
const kitRefusal = r => r.status === 400 && /配布版には無い/.test(r.json?.error ?? '');

test('設定: edition は環境変数、config.json、root の edition.json の順。無ければ full、ほかの値は止める', async () => {
  const dir = await tempDir();
  assert.equal(loadConfig(dir, {}).edition, 'full');
  await fs.writeFile(path.join(dir, 'edition.json'), JSON.stringify({edition: 'kit'}));
  assert.equal(loadConfig(dir, {}).edition, 'kit');
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({edition: 'full'}));
  assert.equal(loadConfig(dir, {}).edition, 'full');
  assert.equal(loadConfig(dir, {CHARASTA_EDITION: 'kit'}).edition, 'kit');
  assert.throws(() => loadConfig(dir, {CHARASTA_EDITION: 'lite'}), /edition/);
});

test('キット: overview は版の種類と名前を返し、Kimi は出さない。使える機能は外した機能を理由つきで使えないにする', async t => {
  const s = await server('kit');
  t.after(() => s.close());
  const ov = (await s.api('GET', '/api/overview')).json;
  assert.equal(ov.edition, 'kit');
  assert.deepEqual(ov.labels.methods.map(m => m[0]), ['tripo']);
  assert.equal(ov.labels.methods[0][1], 'きゃらくる（Tripo Studio）');
  assert.doesNotMatch(JSON.stringify(ov.labels), /Kimi|本家|顔の出来/);
  assert.deepEqual(ov.labels.styles, {standard: 'スタンダード体型', chibi: 'チビ体型'}, '生き物のスタイルはキットに無い');
  assert.deepEqual(ov.labels.shortStyles, {trivia: '雑学', drama: '対話型', pop: '派手', news: 'ニュース', dance: 'ダンス MV'}, '型の名前は対話型とダンス MV を差し替え、保管場所に残るフル版の型は元の名前のまま');
  assert.equal(ov.labels.newShortStyle, 'drama');
  assert.equal(ov.labels.agent.ni, 'エージェントに', 'キットは Codex でも使うので「Claude」と書かない');
  assert.doesNotMatch(JSON.stringify(ov.labels.agent), /Claude/);
  const caps = (await s.api('GET', '/api/capabilities')).json;
  assert.equal(caps.edition, 'kit');
  for (const k of ['kimodo', 'rgbmocap', 'sam3d', 'figureImageGen', 'gameExport', 'shortDraft', 'shortFigures', 'talkStyles', 'creature']) assert.deepEqual(caps[k], {available: false, setting: 'edition', note: '配布版には無い機能'}, k);
  assert.deepEqual(caps.motionRecipe, {available: true, setting: 'edition'}, 'モーションをつなぐはキットにも残す');
  assert.equal(caps.motionbricks.available, true, 'MotionBricks はキットにも残す(道具の設定で決まる)');
  assert.equal(caps.videoMotion.available, true);
  assert.deepEqual(ov.capabilities, caps);
});

test('キット: 外した機能のジョブと API を 400 で断り、MotionBricks と動画からは断らない', async t => {
  const s = await server('kit');
  t.after(() => s.close());
  for (const type of REMOVED_JOBS) assert.ok(kitRefusal(await s.api('POST', '/api/jobs', {type, charId: 'c1', verId: 'v1'})), type);
  for (const [method, url] of [['GET', '/api/motion-texts'], ['POST', '/api/short-draft/prompt'], ['POST', '/api/short-draft/import'], ['GET', '/api/characters/c1/versions/v1/game-exports']]) {
    assert.ok(kitRefusal(await s.api(method, url, method === 'POST' ? {} : undefined)), `${method} ${url}`);
  }
  const gen = await s.api('POST', '/api/jobs', {type: 'motion-gen', seconds: 1, motionId: 'mb-a'});
  assert.equal(gen.status, 201, JSON.stringify(gen.json));
  // RGB MoCap は選べず、送っても断る。MediaPipe は積める
  const vm = (await s.api('GET', '/api/video-motions')).json;
  assert.deepEqual(Object.keys(vm.engines), ['mediapipe']);
  assert.equal(vm.defaultEngine, 'mediapipe');
  const video = {type: 'video-motion', charId: 'c1', verId: 'v1', url: 'https://example.com/v.mp4', rights: '自分で撮った動画'};
  assert.equal((await s.api('POST', '/api/jobs', {...video, engine: 'exmr'})).status, 400);
  assert.equal((await s.api('POST', '/api/jobs', {...video, engine: 'sam3d'})).status, 400, 'SAM 3D Body は NVIDIA の GPU 専用でキットに無い');
  assert.ok(!('sam3d' in vm.engines));
  const mp = await s.api('POST', '/api/jobs', video);
  assert.equal(mp.status, 201, JSON.stringify(mp.json));
  assert.equal(mp.json.input.engine, 'mediapipe');
});

const SEGS = [{source: 'motion', motion: 'talk'}, {source: 'motion', motion: 'talk', trim: [0, 1]}];
const recipeJob = extra => ({type: 'motion-recipe', segments: SEGS, ...extra});

test('キット: モーションをつなぐは使え、文章の区間(source: text、文章のジョブの結果)は 400 で断る', async t => {
  const s = await server('kit');
  t.after(() => s.close());
  const o = await s.api('GET', '/api/motion-recipes');
  assert.equal(o.status, 200);
  assert.equal(o.json.motionbricks, true);
  assert.equal(o.json.defaultBridge.method, 'motionbricks');
  const ok = await s.api('POST', '/api/jobs', recipeJob({bridge: {seconds: 0.8, method: 'interpolate'}}));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.ok(kitRefusal(await s.api('POST', '/api/jobs', recipeJob({segments: [SEGS[0], {source: 'text', text: '手を振る'}]}))));
  // 文章のジョブは積めないが、作者の版の保管場所から来た結果が残っていても区間にはできない
  s.server.jobs.jobs.set('jtext', {id: 'jtext', type: 'motion-text', state: 'done', result: {review: 'waiting', candidates: [{n: 1, durationSec: 2}], label: '文章'}});
  const refused = await s.api('POST', '/api/jobs', recipeJob({segments: [SEGS[0], {source: 'job', job: 'jtext', n: 1}]}));
  assert.ok(kitRefusal(refused), JSON.stringify(refused.json));
  assert.deepEqual((await s.api('GET', '/api/motion-recipes')).json.sources, [], 'キットは文章の結果を区間の一覧に出さない');
});

test('キット: MotionBricks が無くても、つなぎを補間にすればつなげる。MotionBricks の区間とつなぎは積む前に断る', async t => {
  const {CHARASTA_FAKE_MOTIONBRICKS, ...env} = ENV;
  const s = await startServer({stageStudioDir: await stageDir(), env, edition: 'kit'});
  t.after(() => s.close());
  await s.server.jobs.lib.importMotion({id: 'talk', data: await fs.readFile(SAMPLE_VRMA), label: '話す', license: {holder: 'h', summary: '改変可', redistribution: false}});
  const api = async (method, url, body) => {
    const r = await fetch(s.base + url, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)});
    return {status: r.status, json: await r.json().catch(() => null)};
  };
  const o = (await api('GET', '/api/motion-recipes')).json;
  assert.equal(o.motionbricks, false);
  assert.equal(o.defaultBridge.method, 'interpolate', 'MotionBricks が無ければ、つなぎの既定は補間');
  assert.equal((await api('GET', '/api/capabilities')).json.motionRecipe.available, true);
  const ok = await api('POST', '/api/jobs', recipeJob());   // つなぎを書かない: 補間になる
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.input.bridge.method, 'interpolate');
  const refuse = async body => { const r = await api('POST', '/api/jobs', body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.json.error, /MotionBricks が見つからない/); };
  await refuse(recipeJob({segments: [SEGS[0], {source: 'motionbricks', kind: 'forward', speed: 1, turn: 0, seconds: 2, ending: 'stop', root: 'keep'}]}));
  await refuse(recipeJob({bridge: {seconds: 1, method: 'motionbricks'}}));
  await refuse(recipeJob({segments: [SEGS[0], {...SEGS[1], bridge: {seconds: 1, method: 'motionbricks'}}], bridge: {seconds: 0, method: 'interpolate'}}));
  const zero = await api('POST', '/api/jobs', recipeJob({bridge: {seconds: 0, method: 'motionbricks'}}));   // 0 秒は MotionBricks を呼ばない
  assert.equal(zero.status, 201, JSON.stringify(zero.json));
});

test('作者の版: MotionBricks が無くてもつなぎの既定は MotionBricks のまま(今までの動き)', async t => {
  const {CHARASTA_FAKE_MOTIONBRICKS, ...env} = ENV;
  const s = await startServer({stageStudioDir: await stageDir(), env});
  t.after(() => s.close());
  const r = await fetch(s.base + '/api/motion-recipes');
  const o = await r.json();
  assert.equal(o.motionbricks, false);
  assert.equal(o.defaultBridge.method, 'motionbricks');
});

test('キット: 作り方 kimi のキャラは作るときも直すときも断る', async t => {
  const s = await server('kit');
  t.after(() => s.close());
  assert.ok(kitRefusal(await s.api('POST', '/api/characters', {id: 'c2', name: 'に', style: 'standard', method: 'kimi'})));
  assert.equal((await s.api('POST', '/api/characters', {id: 'c3', name: 'さん', style: 'chibi', method: 'tripo'})).status, 201);
  assert.ok(kitRefusal(await s.api('PATCH', '/api/characters/c1', {method: 'kimi'})));
  assert.equal((await s.api('PATCH', '/api/characters/c1', {method: 'tripo'})).status, 200);
});

test('キット: ショートは対話型(型 drama)とダンス MV だけ。型を書かなければ対話型、雑学などは断る。シーンとカメラは選べる', async t => {
  const s = await server('kit');
  t.after(() => s.close());
  const made = await s.api('POST', '/api/shorts', short({cuts: [CUT, {...CUT, stage: 'concert', camera: 'two_shot'}]}));
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.style, 'drama');
  assert.deepEqual(made.json.cuts.map(c => [c.stage, c.camera]), [['classroom', 'talk_bust'], ['concert', 'two_shot']]);
  for (const style of ['trivia', 'pop', 'news']) {
    assert.ok(kitRefusal(await s.api('POST', '/api/shorts', short({style}))), style);
    assert.ok(kitRefusal(await s.api('PUT', '/api/shorts/' + made.json.id, {...made.json, style})), 'PUT ' + style);
  }
  assert.equal((await s.api('PUT', '/api/shorts/' + made.json.id, {...made.json, title: '直した'})).status, 200);
  const dance = await s.api('POST', '/api/dance-shorts', {charId: 'c1', verId: 'v1'});
  assert.equal(dance.status, 201, JSON.stringify(dance.json));
});

test('キット: 生き物は無い。キャラのスタイル creature とショートの生き物(take.creature、カットの動き、生き物のカメラ)を 400 で断る', async t => {
  const s = await server('kit');
  t.after(() => s.close());
  assert.ok(kitRefusal(await s.api('POST', '/api/characters', {id: 'crow', name: 'カラス', style: 'creature'})));
  assert.ok(kitRefusal(await s.api('PATCH', '/api/characters/c1', {style: 'creature'})));
  assert.equal((await s.api('PATCH', '/api/characters/c1', {style: 'chibi'})).status, 200, 'ほかのスタイルへは変えられる');
  const take = {motions: ['talk'], mark: [0, 0, 0]};
  const walk = await s.api('POST', '/api/shorts', short({take}));
  assert.equal(walk.status, 201, '生き物の無い歩く 1 テイクは作れる: ' + JSON.stringify(walk.json));
  const crow = {charId: 'crow', perch: 0, path: [[0, 0, 0], [1, 0, 0], [2, 0, 0]]};
  for (const body of [short({take: {...take, creature: crow}}), short({cuts: [{...CUT, creature: 'tilt'}]}), short({cuts: [{...CUT, camera: 'crow_close'}]}), short({cuts: [{...CUT, camera: 'crow_takeoff'}]})]) {
    assert.ok(kitRefusal(await s.api('POST', '/api/shorts', body)), JSON.stringify(body));
    assert.ok(kitRefusal(await s.api('PUT', '/api/shorts/' + walk.json.id, {...walk.json, ...body, take: body.take ?? walk.json.take})), 'PUT ' + JSON.stringify(body));
  }
});

test('作者の版: overview は full と今までの名前、外す機能もサーバーは断らない', async t => {
  const s = await server();
  t.after(() => s.close());
  const ov = (await s.api('GET', '/api/overview')).json;
  assert.equal(ov.edition, 'full');
  assert.deepEqual(ov.labels.methods.map(m => m[0]), ['tripo', 'kimi']);
  assert.deepEqual(ov.labels.styles, {standard: 'スタンダード', chibi: 'チビ', creature: '生き物'});
  assert.equal(ov.labels.agent.ni, 'Claude に');
  assert.equal(ov.labels.shortStyles.trivia, '雑学');
  assert.equal(ov.labels.newShortStyle, 'trivia');
  for (const k of ['motionRecipe', 'gameExport', 'shortDraft', 'shortFigures', 'talkStyles', 'creature']) assert.equal(ov.capabilities[k].available, true, k);
  assert.equal(ov.capabilities.edition, 'full');
  for (const type of REMOVED_JOBS) assert.ok(!kitRefusal(await s.api('POST', '/api/jobs', {type, charId: 'c1', verId: 'v1'})), type);
  assert.equal((await s.api('GET', '/api/motion-recipes')).status, 200);
  assert.equal((await s.api('GET', '/api/characters/c1/versions/v1/game-exports')).status, 200);
  assert.ok((await s.api('GET', '/api/video-motions')).json.engines.exmr, '試しの動きでは ExMR を使える');
  assert.ok((await s.api('GET', '/api/video-motions')).json.engines.sam3d, '試しの動きでは SAM 3D Body を使える');
  assert.equal(ov.capabilities.sam3d.available, true);
  assert.equal((await s.api('POST', '/api/characters', {id: 'c2', name: 'に', style: 'standard', method: 'kimi'})).status, 201);
  assert.equal((await s.api('POST', '/api/characters', {id: 'crow', name: 'カラス', style: 'creature'})).status, 201, '生き物は作者の版で作れる');
  const crowCut = await s.api('POST', '/api/shorts', short({cuts: [{...CUT, camera: 'crow_close', creature: 'tilt'}]}));
  assert.equal(crowCut.status, 201, '生き物のカメラと動きは作者の版で断らない: ' + JSON.stringify(crowCut.json));
  const trivia = await s.api('POST', '/api/shorts', short());
  assert.equal(trivia.status, 201);
  assert.equal(trivia.json.style, 'trivia');
});

test('バージョンの検査の文: スタイル未設定の理由はキットでスタンダード体型・チビ体型、作者の版はスタンダード・チビ', async t => {
  for (const [edition, want, not] of [['kit', /スタンダード体型かチビ体型/, null], [undefined, /スタンダードかチビを/, /体型/]]) {
    const s = await server(edition);
    t.after(() => s.close());
    await s.server.jobs.lib.createCharacter({id: 'un', name: 'みせってい'});
    await s.server.jobs.lib.importVersion({charId: 'un', id: 'v1', data: fakeGlb({a: 1})});
    const r = await s.api('GET', '/api/characters/un/versions/v1/check');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.applicable, false);
    assert.match(r.json.reason, want);
    if (not) assert.doesNotMatch(r.json.reason, not);
  }
});
