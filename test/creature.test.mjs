// 生き物(docs/creature.md): スタイル、版の取り込み(Blender は差し替え)、VRM の操作の断り、概要、take.creature の参照、出演した動画
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Library, STYLES} from '../lib/library.mjs';
import {checkCreatureSpec, checkCues, checkSpecAgainstActions, importCreature, listBlendActions, resolveCreature} from '../lib/creature.mjs';
import {takeBody, shortBody} from '../lib/short.mjs';
import {overview} from '../lib/overview.mjs';
import {faceInfo} from '../lib/face-check.mjs';
import {findBlender} from '../lib/platform.mjs';
import {fakeGlb, startServer, tempDir} from './helpers.mjs';

const SPEC = {scale: 0.62, drop: 0.07, yaw: 237, fps: 24, rest: ['perch', 60, 60], fly: ['flap', 1, 121],
  clips: {down: ['perch', 96, 135], tilt: ['perch', 100, 160], stare: ['perch', 120, 192], caw: ['perch', 182, 186]}};
const ACTIONS = {armatures: ['AutoRig'], actions: {flap: {frames: [1, 121]}, perch: {frames: [1, 193]}}};
const PATH = [[2.4, 10, 3], [1.3, 4, 1.9], [0.6, -3, 3]];

async function setup() {
  const lib = new Library(await tempDir());
  const blend = path.join(await tempDir(), 'crow.blend');
  await fs.writeFile(blend, Buffer.concat([Buffer.from('BLENDER-v500'), Buffer.alloc(64, 7)]));
  await lib.createCharacter({id: 'crow', name: 'カラス', style: 'creature'});
  await lib.createCharacter({id: 'c1', name: 'C1', style: 'standard'});
  return {lib, blend};
}
const mock = (thumbs = []) => ({blender: 'blender-none', list: async () => ACTIONS, thumb: async (b, spec, out) => { thumbs.push(out); await fs.writeFile(out, 'png'); }});

test('スタイル: creature を作れる。ほかの値は断る', async () => {
  assert.deepEqual(STYLES, ['standard', 'chibi', 'creature']);
  const {lib} = await setup();
  assert.equal((await lib.getCharacter('crow')).style, 'creature');
  await assert.rejects(lib.createCharacter({id: 'x', name: 'X', style: 'Creature'}), {code: 'bad-input'});
});

test('spec: 生き物の値だけを受ける。場面ごとの値、知らない項目、形の誤りは断る', () => {
  assert.deepEqual(checkCreatureSpec(SPEC), SPEC);
  for (const k of ['perch', 'path', 'flight', 'events', 'blend']) assert.throws(() => checkCreatureSpec({...SPEC, [k]: 1}), /場面ごと/, k);
  assert.throws(() => checkCreatureSpec({...SPEC, color: 1}), /知らない項目/);
  for (const k of ['rest', 'scale', 'yaw', 'fps']) { const s = {...SPEC}; delete s[k]; assert.throws(() => checkCreatureSpec(s), new RegExp(k), k); }
  for (const rest of [['perch', 60], ['perch', 60, 50], ['perch', 1.5, 3], [1, 2, 3], 'perch']) assert.throws(() => checkCreatureSpec({...SPEC, rest}), {code: 'bad-input'}, JSON.stringify(rest));
  assert.throws(() => checkCreatureSpec({...SPEC, clips: {'a b': ['perch', 1, 2]}}), /名前/);
  assert.throws(() => checkCreatureSpec({...SPEC, scale: 0}), /scale/);
  assert.equal('drop' in checkCreatureSpec({rest: SPEC.rest, scale: 1, yaw: 0, fps: 24}), false);
});

test('Action の照合: 無い名前は errors、範囲の外は warnings', () => {
  assert.deepEqual(checkSpecAgainstActions(SPEC, ACTIONS), {errors: [], warnings: []});
  const r = checkSpecAgainstActions({...SPEC, fly: ['nope', 1, 2], clips: {big: ['perch', 1, 300]}}, ACTIONS);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /fly.*nope/);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /clips\.big/);
});

test('取り込み: model.blend をコピーし、creature.json と version.json(kind creature)を書き、サムネイルを撮る', async () => {
  const {lib, blend} = await setup(), thumbs = [];
  const r = await importCreature(lib, {charId: 'crow', id: 'v1', label: '歩き', note: 'n', src: blend, spec: SPEC, latest: true}, mock(thumbs));
  assert.equal(r.version.kind, 'creature');
  assert.equal(r.thumbError, null);
  const dir = path.join(lib.dir, 'characters/crow/versions/v1');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['creature.json', 'model.blend', 'thumb.png', 'version.json']);   // model.vrm は作らない
  assert.deepEqual(await fs.readFile(path.join(dir, 'model.blend')), await fs.readFile(blend));
  assert.equal(thumbs[0], path.join(dir, 'thumb.png'));
  const ch = await lib.getCharacter('crow'), v = ch.versions[0];
  assert.equal(ch.latestVersion, 'v1');
  assert.equal(v.kind, 'creature');
  assert.equal(v.model, null);
  assert.equal(v.modelLite, null);
  assert.equal(v.thumb, '/lib/characters/crow/versions/v1/thumb.png');
  assert.deepEqual(v.creature.clipNames, ['down', 'tilt', 'stare', 'caw']);
  assert.deepEqual(v.creature.rest, ['perch', 60, 60]);
  assert.deepEqual(v.creature.fly, ['flap', 1, 121]);
  assert.equal(v.sha256.length, 64);
});

test('取り込み: Action が無ければ何も作らない。同じ版 ID と生き物でないキャラは断る。サムネイルの失敗は版を残す', async () => {
  const {lib, blend} = await setup();
  await assert.rejects(importCreature(lib, {charId: 'crow', id: 'v1', src: blend, spec: {...SPEC, fly: ['nope', 1, 2]}}, mock()), /nope/);
  await assert.rejects(fs.stat(path.join(lib.dir, 'characters/crow/versions/v1')), {code: 'ENOENT'});
  await assert.rejects(importCreature(lib, {charId: 'crow', id: 'v1', src: path.join(os.tmpdir(), 'nothing.blend'), spec: SPEC}, mock()), /blend が無い/);
  await assert.rejects(importCreature(lib, {charId: 'c1', id: 'v1', src: blend, spec: SPEC}, mock()), /生き物ではない/);
  const bad = path.join(await tempDir(), 'x.blend');
  await fs.writeFile(bad, 'not blender');
  await assert.rejects(importCreature(lib, {charId: 'crow', id: 'v1', src: bad, spec: SPEC}, mock()), /Blender のファイルではない/);
  await assert.rejects(fs.stat(path.join(lib.dir, 'characters/crow/versions/v1')), {code: 'ENOENT'});
  const r = await importCreature(lib, {charId: 'crow', id: 'v1', src: blend, spec: SPEC}, {...mock(), thumb: async () => { throw new Error('GPU なし'); }});
  assert.equal(r.thumbError, 'GPU なし');
  assert.equal((await lib.getCharacter('crow')).versions[0].thumb, null);
  await assert.rejects(importCreature(lib, {charId: 'crow', id: 'v1', src: blend, spec: SPEC}, mock()), {code: 'exists'});
});

test('Blender が無いとき listBlendActions は理由を付けて断る', async () => {
  await assert.rejects(listBlendActions('x.blend', {blender: path.join(os.tmpdir(), 'no-such-blender.exe')}), {code: 'bad-input'});
});

test('生き物のキャラに VRM の版は入らず、生き物の版は生き物のキャラにだけ入る', async () => {
  const {lib, blend} = await setup();
  await assert.rejects(lib.importVersion({charId: 'crow', id: 'v1', data: fakeGlb(), sourcePath: 'x'}), /生き物/);
  await assert.rejects(lib.importCreatureVersion({charId: 'c1', id: 'v1', blendFile: blend, spec: SPEC}), {code: 'bad-input'});
  await importCreature(lib, {charId: 'crow', id: 'v1', src: blend, spec: SPEC}, mock());
  // 版があるキャラは、生き物とそれ以外を行き来できない。版が無ければ変えられる
  await assert.rejects(lib.updateCharacter('crow', {style: 'standard'}), /行き来/);
  await lib.createCharacter({id: 'empty', name: 'E', style: 'standard'});
  assert.equal((await lib.updateCharacter('empty', {style: 'creature'})).style, 'creature');
});

test('VRM が前提の入口は生き物を断る(撮影、顔の確かめ、出演者)', async () => {
  const s = await startServer();
  try {
    const lib = new Library(s.libraryDir);
    await lib.createCharacter({id: 'crow', name: 'カラス', style: 'creature'});
    const post = async (url, body) => { const r = await fetch(s.base + url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}); return {status: r.status, body: await r.json()}; };
    const made = await post('/api/characters', {id: 'owl', name: 'フクロウ', style: 'creature'});
    assert.equal(made.status, 201);
    assert.equal(made.body.style, 'creature');
    assert.equal((await post('/api/jobs', {type: 'shoot', charId: 'crow', motionId: 'm'})).status, 400);
    assert.equal((await post('/api/jobs', {type: 'face-check', charId: 'crow', verId: 'v1', set: 'keys'})).status, 400);
    await assert.rejects(faceInfo(lib, 'crow', 'v1'), /生き物/);
    assert.equal((await post('/api/shorts', {title: 't', charId: 'crow', cuts: []})).status, 400);
    const ov = await (await fetch(s.base + '/api/overview')).json();
    assert.deepEqual(ov.chars.map(c => [c.id, c.style, c.kind]).sort(), [['crow', 'creature', 'creature'], ['owl', 'creature', 'creature']]);
  } finally { await s.close(); }
});

test('概要: 生き物は kind と動きの要約を持ち、VRM の表情は読まない', async () => {
  const {lib, blend} = await setup();
  await importCreature(lib, {charId: 'crow', id: 'v1', src: blend, spec: SPEC}, mock());
  const ov = await overview(lib, {list: async () => []}, {});
  const crow = ov.chars.find(c => c.id === 'crow'), c1 = ov.chars.find(c => c.id === 'c1');
  assert.equal(crow.kind, 'creature');
  assert.deepEqual(crow.creature.clipNames, ['down', 'tilt', 'stare', 'caw']);
  assert.equal(crow.thumb, '/lib/characters/crow/versions/v1/thumb.png');
  assert.deepEqual(crow.finished.map(v => [v.id, v.kind, v.model]), [['v1', 'creature', null]]);
  assert.equal(c1.kind, 'vrm');
  assert.equal(c1.creature, null);
});

test('take.creature: 前からの書き方はそのまま通り、新しい書き方は生き物のキャラと版を確かめる', async () => {
  const {lib, blend} = await setup();
  await importCreature(lib, {charId: 'crow', id: 'v1', src: blend, spec: SPEC}, mock());
  const motions = {getMotion: async () => ({}), getCharacterJson: id => lib.getCharacterJson(id), versionExists: (c, v) => lib.versionExists(c, v), versionDir: (c, v) => lib.versionDir(c, v)};
  const take = creature => ({motions: ['a'], mark: [0, 0, 0], creature});
  const raw = {blend: 'D:/x/crow.blend', perch: 0, scale: 1, yaw: 0, fps: 24, rest: ['perch', 1, 1], path: PATH};
  assert.deepEqual((await takeBody(motions, take(raw), 1)).creature, raw);
  const ref = {charId: 'crow', perch: 0, path: PATH, flight: 2.8, yaw: 200, junk: undefined};
  delete ref.junk;
  assert.deepEqual((await takeBody(motions, take(ref), 1)).creature, ref);
  assert.deepEqual((await takeBody(motions, take({...ref, verId: 'v1'}), 1)).creature.verId, 'v1');
  for (const bad of [{...ref, charId: 'c1'}, {...ref, charId: 'nobody'}, {...ref, verId: 'v9'}, {...ref, perch: -1}, {...ref, perch: 'a'}, {...ref, path: [[1, 2, 3]]},
    {...ref, flight: 0}, {...ref, blend: 'x'}, {...ref, rest: ['perch', 1, 1]}, {...ref, charId: 'BAD ID'}]) {
    await assert.rejects(takeBody(motions, take(bad), 1), {code: /bad-input|bad-id|not-found/}, JSON.stringify(bad));
  }
});

test('take.creature: 撮るときに model.blend と creature.json の値へ解き、場面ごとの値を優先する', async () => {
  const {lib, blend} = await setup();
  const {version} = await importCreature(lib, {charId: 'crow', id: 'v1', src: blend, spec: SPEC}, mock());
  const raw = {blend: 'x.blend', perch: 0};
  assert.deepEqual(await resolveCreature(lib, raw), {spec: raw, sha256: null});
  const {spec, sha256} = await resolveCreature(lib, {charId: 'crow', perch: 1, yaw: 100, path: PATH, flight: 3});
  assert.equal(spec.blend, path.join(lib.dir, 'characters/crow/versions/v1/model.blend'));
  assert.equal(path.isAbsolute(spec.blend), true);
  assert.equal(spec.yaw, 100);   // 場面ごとの値が creature.json の 237 に勝つ
  assert.equal(spec.scale, 0.62);
  assert.equal(spec.perch, 1);
  assert.equal(spec.flight, 3);
  assert.deepEqual(spec.path, PATH);
  assert.deepEqual(spec.clips.caw, ['perch', 182, 186]);
  assert.equal('charId' in spec, false);
  assert.equal(sha256, version.sha256);
});

test('カットの動き: takeoff は caw と fly、ほかは同じ名前の clip が要る', () => {
  checkCues(SPEC, ['tilt', 'down', 'stare', 'takeoff']);
  assert.throws(() => checkCues({...SPEC, fly: undefined}, ['takeoff']), /fly/);
  assert.throws(() => checkCues({...SPEC, clips: {down: SPEC.clips.down}}, ['takeoff', 'tilt']), /clips\.caw.*clips\.tilt|clips\.tilt.*clips\.caw/);
  checkCues(SPEC, []);
});

test('出演した動画: take.creature.charId のショートも数える', async () => {
  const {lib} = await setup();
  await lib.saveShort('s-crow', {title: 'カラス', style: 'trivia', charId: 'c1', take: {motions: [], mark: [0, 0, 0], creature: {charId: 'crow', perch: 0, path: PATH}}});
  await lib.saveShort('s-raw', {title: '直書き', style: 'trivia', charId: 'c1', take: {motions: [], mark: [0, 0, 0], creature: {blend: 'x.blend'}}});
  assert.deepEqual((await lib.getCharacter('crow')).appearances.map(a => a.shortId), ['s-crow']);
  assert.deepEqual((await lib.getCharacter('c1')).appearances.map(a => a.shortId).sort(), ['s-crow', 's-raw']);
});

test('ショートの出演者に生き物は選べない', async () => {
  const {lib} = await setup();
  await assert.rejects(shortBody(lib, os.tmpdir(), {title: 't', charId: 'crow', cuts: []}), /生き物/);
  await assert.rejects(shortBody(lib, os.tmpdir(), {title: 't', cast: [{charId: 'crow', name: 'a'}], cuts: []}), /生き物/);
});

// 本物の Blender と本物のカラス(読むだけ)があるときだけ動く
// CHARASTA_REAL_CROW_BLEND に crow.blend の場所を渡し、Blender は CHARASTA_BLENDER か自動で探す
const REAL_BLEND = process.env.CHARASTA_REAL_CROW_BLEND, BLENDER = findBlender();
test('本物の Blender: crow.blend の Action を読み、spec と照らせる', {skip: REAL_BLEND && BLENDER && existsSync(REAL_BLEND) && existsSync(BLENDER) ? false : 'Blender か crow.blend(環境変数 CHARASTA_REAL_CROW_BLEND)が無い'}, async () => {
  const listing = await listBlendActions(REAL_BLEND, {blender: BLENDER});
  assert.deepEqual(Object.keys(listing.actions).sort(), ['flap', 'perch']);
  assert.deepEqual(checkSpecAgainstActions(SPEC, listing), {errors: [], warnings: []});
});

test('取り込み: サムネイルは保存した model.blend から描く。パックされていない外部の画像は注意に出し、止めない', async () => {
  const {lib, blend} = await setup(), sources = [];
  const ext = {...ACTIONS, externalImages: ['//tex/feather.png']};
  const r = await importCreature(lib, {charId: 'crow', id: 'v1', src: blend, spec: SPEC},
    {blender: 'blender-none', list: async () => ext, thumb: async (b, spec, out) => { sources.push(b); await fs.writeFile(out, 'png'); }});
  assert.equal(sources[0], path.join(lib.dir, 'characters/crow/versions/v1/model.blend'));
  assert.equal(r.thumbError, null);
  assert.ok(r.warnings.some(w => w.includes('//tex/feather.png') && w.includes('パック')));
  const clean = await importCreature(lib, {charId: 'crow', id: 'v2', src: blend, spec: SPEC}, mock());
  assert.ok(!clean.warnings.some(w => w.includes('パック')));
});
