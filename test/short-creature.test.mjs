// ショートの編集画面の生き物の欄(public/short-creature.mjs): 選んだときの take.creature、前の書き方を保つこと、カットの動きの選べるかどうか
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Library} from '../lib/library.mjs';
import {importCreature} from '../lib/creature.mjs';
import {CREATURE_CUES as SERVER_CUES, takeBody} from '../lib/short.mjs';
import {overview} from '../lib/overview.mjs';
import {CREATURE_CUES, DEFAULT_PATH, DEFAULT_PERCH, creatureChars, creatureMode, cueOptions, cueSpec, pickCreature} from '../public/short-creature.mjs';
import {shortKind} from '../public/short-camera.mjs';
import {tempDir} from './helpers.mjs';

const SPEC = {scale: 0.62, drop: 0.07, yaw: 237, fps: 24, rest: ['perch', 60, 60], fly: ['flap', 1, 121],
  clips: {down: ['perch', 96, 135], tilt: ['perch', 100, 160], stare: ['perch', 120, 192], caw: ['perch', 182, 186]}};
// testlib の smvyu9mx3 にある前の書き方
const LEGACY = {blend: 'legacy/crow.blend', perch: 0, drop: 0.07, scale: 0.62, yaw: 237, fps: 24, rest: ['perch', 60, 60], fly: ['flap', 1, 121], flight: 1.7,
  path: [[2.6, 12.8, 3.2], [1.2, 10.6, 1.3], [-4, 9.8, 1.7]], clips: SPEC.clips};

async function setup() {
  const lib = new Library(await tempDir());
  const blend = path.join(await tempDir(), 'crow.blend');
  await fs.writeFile(blend, Buffer.concat([Buffer.from('BLENDER-v500'), Buffer.alloc(64, 7)]));
  await lib.createCharacter({id: 'crow', name: 'カラス', style: 'creature'});
  await lib.createCharacter({id: 'owl', name: 'フクロウ', style: 'creature'});
  const mock = {blender: 'blender-none', list: async () => ({armatures: ['A'], actions: {flap: {frames: [1, 121]}, perch: {frames: [1, 193]}}}), thumb: async (b, spec, out) => fs.writeFile(out, 'png')};
  await importCreature(lib, {charId: 'crow', id: 'v1', src: blend, spec: SPEC}, mock);
  await importCreature(lib, {charId: 'owl', id: 'v1', src: blend, spec: {...SPEC, fly: undefined, clips: {tilt: SPEC.clips.tilt}}}, mock);
  // takeBody が使うライブラリの口。動きは確かめない
  const api = {getMotion: async () => ({}), getCharacterJson: id => lib.getCharacterJson(id), versionExists: (c, v) => lib.versionExists(c, v), versionDir: (c, v) => lib.versionDir(c, v)};
  return {lib, api};
}
const take = creature => ({motions: ['walk'], mark: [0, 0, 0], ...(creature ? {creature} : {})});

test('生き物の欄: 動きの名前はサーバーの CREATURE_CUES と同じ', () => {
  assert.deepEqual(CREATURE_CUES, SERVER_CUES);
});

test('生き物の欄: なしから選ぶと {charId, perch, path} の参照になり、保存するとその形のまま残る', async () => {
  const {api} = await setup();
  const t = take();
  assert.equal(creatureMode(t.creature), 'none');
  assert.equal(shortKind({take: t}), 'walk');
  t.creature = pickCreature(t.creature, 'crow');
  assert.deepEqual(t.creature, {charId: 'crow', perch: DEFAULT_PERCH, path: DEFAULT_PATH});
  assert.equal(shortKind({take: t}), 'creature');
  const saved = await takeBody(api, t, 1);
  assert.deepEqual(saved.creature, {charId: 'crow', perch: 0, path: DEFAULT_PATH});
  assert.equal(creatureMode(saved.creature), 'ref');
  // 止まり木を変えても参照の形のまま
  t.creature.perch = 2;
  assert.deepEqual((await takeBody(api, t, 1)).creature, {charId: 'crow', perch: 2, path: DEFAULT_PATH});
  // なしに戻すと take.creature を持たない
  assert.equal(pickCreature(t.creature, ''), undefined);
});

test('生き物の欄: 前の書き方は選び直すまでそのまま保存し、選び直すと perch、path、flight を保った参照になる', async () => {
  const {api} = await setup();
  const t = take(structuredClone(LEGACY));
  assert.equal(creatureMode(t.creature), 'legacy');
  assert.deepEqual((await takeBody(api, t, 1)).creature, LEGACY, '開いて保存しただけでは変えない');
  t.creature = pickCreature(t.creature, 'crow');
  assert.deepEqual(t.creature, {charId: 'crow', perch: 0, path: LEGACY.path, flight: 1.7});
  const saved = (await takeBody(api, t, 1)).creature;
  assert.deepEqual(saved, {charId: 'crow', perch: 0, path: LEGACY.path, flight: 1.7});
  assert.equal('blend' in saved, false);
});

test('生き物の欄: 同じキャラは今の参照のまま(版と上書きを保つ)、別のキャラへは perch と path だけ移す', () => {
  const now = {charId: 'crow', verId: 'v1', perch: 1, path: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], yaw: 100};
  assert.equal(pickCreature(now, 'crow'), now);
  assert.deepEqual(pickCreature(now, 'owl'), {charId: 'owl', perch: 1, path: now.path});
  // 形の崩れた perch と path は既定に戻す
  assert.deepEqual(pickCreature({charId: 'crow', perch: -1, path: [[1, 2]]}, 'owl'), {charId: 'owl', perch: DEFAULT_PERCH, path: DEFAULT_PATH});
});

test('カットの生き物の動き: 選んだ生き物の動きで、無い動きには足りないものを出す', async () => {
  const {lib} = await setup();
  const {chars} = await overview(lib, {list: async () => []}, {});
  assert.deepEqual(creatureChars(chars).map(c => c.id).sort(), ['crow', 'owl']);
  const lacks = c => Object.fromEntries(cueOptions(cueSpec(c, chars)).map(o => [o.id, o.lacks]));
  assert.deepEqual(lacks({charId: 'crow', perch: 0, path: DEFAULT_PATH}), {tilt: [], down: [], stare: [], takeoff: []});
  assert.deepEqual(lacks({charId: 'owl', perch: 0, path: DEFAULT_PATH}), {tilt: [], down: ['clips.down'], stare: ['clips.stare'], takeoff: ['clips.caw', 'fly']});
  // 前の書き方は take.creature そのものを照らす
  assert.deepEqual(lacks({...LEGACY, clips: {caw: LEGACY.clips.caw}}), {tilt: ['clips.tilt'], down: ['clips.down'], stare: ['clips.stare'], takeoff: []});
  // 一覧に無いキャラは分からないので出さない(撮る前にサーバーが断る)
  assert.deepEqual(lacks({charId: 'nobody', perch: 0, path: DEFAULT_PATH}), {tilt: [], down: [], stare: [], takeoff: []});
});
