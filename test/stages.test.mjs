// ステージの画面の API(GET /api/stages、lib/stages.mjs の stageOverview): シーンの一覧、サムネイル、そのシーンを使うショートと MV
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startServer, tempDir} from './helpers.mjs';

async function stageDir() {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'stages'));
  await fs.mkdir(path.join(dir, 'assets', 'thumbs'), {recursive: true});
  await fs.writeFile(path.join(dir, 'stages', 'catalog.json'), JSON.stringify([{id: 'concert', label: 'コンサート'}, {id: 'classroom', label: '教室'}, {id: 'parkway', label: '公園の並木道'}]));
  for (const id of ['concert', 'classroom']) await fs.writeFile(path.join(dir, 'assets', 'thumbs', id + '.jpg'), 'jpg');
  return dir;
}

async function fill(lib) {
  await lib.createCharacter({id: 'c1', name: 'いち', style: 'standard'});
  const cut = stage => ({stage, motionId: 'talk', camera: 'talk_bust'});
  await lib.saveShort('s-talk', {title: '放課後', style: 'drama', cuts: [cut('classroom'), cut('concert'), cut('classroom')]});
  await lib.saveShort('s-walk', {title: '並木道', style: 'drama', take: {motions: ['walk'], mark: [0, 0, 0]}, cuts: [cut('parkway')]});
  await lib.saveShort('s-dance', {title: '踊る', style: 'dance', music: {stages: ['concert']}, cuts: [{...cut('concert'), camera: 'wide_push'}]});
  await lib.saveShort('s-graphic', {title: 'グラフィック', style: 'dance', music: {look: 'graphic'}, cuts: [{...cut(''), scene: 'pop'}]});
  const shoot = path.join(lib.dir, 'characters', 'c1', 'shoots', 'mv1');
  await fs.mkdir(shoot, {recursive: true});
  await fs.writeFile(path.join(shoot, 'shoot.json'), JSON.stringify({id: 'mv1', kind: 'mv', charId: 'c1', verId: 'v1', quality: 'preview', aspect: '9:16', seconds: 10, mv: {stages: ['concert', 'parkway']}, createdAt: '2026-11-01T00:00:00.000Z'}));
}

for (const edition of ['full', 'kit']) {
  test(`${edition}: GET /api/stages はシーンごとに名前、ID、サムネイル、使うショートと MV を返す`, async t => {
    const s = await startServer({stageStudioDir: await stageDir(), edition});
    t.after(() => s.close());
    await fill(s.server.jobs.lib);
    const r = await fetch(s.base + '/api/stages');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.configured, true);
    assert.deepEqual(body.stages.map(x => [x.id, x.label]), [['concert', 'コンサート'], ['classroom', '教室'], ['parkway', '公園の並木道']], 'catalog.json の順');
    const by = Object.fromEntries(body.stages.map(x => [x.id, x]));
    assert.equal(by.concert.thumb, '/api/mv/stages/concert.jpg');
    assert.equal(by.parkway.thumb, null, 'サムネイルのファイルが無ければ null');
    assert.deepEqual(by.concert.shorts.map(x => x.id).sort(), ['s-dance', 's-talk'], 'カットの stage とダンス MV の music.stages');
    assert.deepEqual(by.classroom.shorts.map(x => [x.id, x.title, x.style, x.take]), [['s-talk', '放課後', 'drama', false]], '同じショートは 1 回だけ数える');
    assert.deepEqual(by.parkway.shorts.map(x => [x.id, x.take]), [['s-walk', true]]);
    assert.deepEqual(by.concert.mvs.map(x => [x.id, x.charId, x.charName, x.quality]), [['mv1', 'c1', 'いち', 'preview']]);
    assert.deepEqual(by.parkway.mvs.map(x => x.id), ['mv1']);
    assert.deepEqual(by.classroom.mvs, []);
    assert.ok(!body.stages.some(x => x.shorts.some(y => y.id === 's-graphic')), 'グラフィック MV のカットはシーンを使わない');
    assert.equal((await fetch(s.base + '/api/stages', {method: 'POST'})).status, 405);
  });
}

test('stage-studio が未設定なら configured が false で、シーンは空', async t => {
  const s = await startServer({});
  t.after(() => s.close());
  const body = await (await fetch(s.base + '/api/stages')).json();
  assert.deepEqual(body, {configured: false, stages: []});
});
