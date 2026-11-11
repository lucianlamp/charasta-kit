// MV ジョブ、動画ギャラリーの API、カット割りの計算。Blender は CHARASTA_FAKE_CAPTURE で省く(ffmpeg は要る)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Library} from '../lib/library.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {mvKey} from '../lib/mv.mjs';
import {mvOptions, stageThumb} from '../lib/stages.mjs';
import {mvCuts, mvEstimateSec} from '../public/mv-plan.mjs';
import {tempDir, fakeGlb, FAKE_ENV, SAMPLE_VRMA, startServer} from './helpers.mjs';

const CATALOG = [{id: 'concert', label: 'コンサート'}, {id: 'classroom', label: '教室'}];

async function stageDir() {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'stages'));
  await fs.mkdir(path.join(dir, 'assets', 'thumbs'), {recursive: true});
  await fs.writeFile(path.join(dir, 'stages', 'catalog.json'), JSON.stringify(CATALOG));
  await fs.writeFile(path.join(dir, 'assets', 'thumbs', 'concert.jpg'), 'jpg');
  return dir;
}

async function setup(env = FAKE_ENV) {
  const lib = new Library(await tempDir()), stageStudioDir = await stageDir();
  await lib.createCharacter({id: 'c1', name: 'C1', voice: 'grok:eve'});
  await lib.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({a: 1})});
  await lib.importMotion({id: 'dance', data: await fs.readFile(SAMPLE_VRMA), label: 'ダンス', license: {holder: 'h', summary: '改変可', redistribution: false}});
  return {lib, q: new JobQueue({lib, env, tools: {stageStudioDir}})};
}
const body = (o = {}) => ({type: 'mv', charId: 'c1', motionId: 'dance', stages: ['concert', 'classroom'], seconds: 3, ...o});
const fail = (q, o, re) => assert.rejects(q.enqueue(body(o)), re);
const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,color_space,color_range:format=duration', '-of', 'json', file]));

test('カット割り: 最初のカットまで beatsPerShot 拍、末尾の短いカットを作らない。シーンは順に回り、2 カットごとにもできる', () => {
  const cuts = mvCuts({seconds: 15, bpm: 120, stages: ['a', 'b', 'c'], beatsPerShot: 8});   // stage-studio の plan(120 BPM、8 拍)と同じ 0、4、8、12、15
  assert.deepEqual(cuts.map(c => [c.start, c.end, c.stage]), [[0, 4, 'a'], [4, 8, 'b'], [8, 12, 'c'], [12, 15, 'a']]);
  assert.deepEqual(mvCuts({seconds: 15, bpm: 120, stages: ['a', 'b'], shotsPerScene: 2}).map(c => c.stage), ['a', 'a', 'b', 'b']);
  assert.equal(mvCuts({seconds: 4.3, bpm: 120, stages: ['a']}).length, 1);   // 4 秒の切り替えは終わりの 0.6 秒より後ろ
  assert.ok(mvEstimateSec('final', 15, 1) > mvEstimateSec('preview', 15, 1));
});

test('入力: シーン、長さ、カット、モーションを確かめる', async () => {
  const {q} = await setup();
  await fail(q, {stages: []}, /stages/);
  await fail(q, {stages: ['nowhere']}, /知らないステージ/);
  await fail(q, {stages: ['concert', 'concert']}, /2 回/);
  await fail(q, {seconds: 1}, /seconds/);
  await fail(q, {seconds: 500}, /seconds/);
  await fail(q, {beatsPerShot: 5}, /beatsPerShot/);
  await fail(q, {quality: 'x'}, /quality/);
  await fail(q, {motionId: undefined}, /motionId/);
  await fail(q, {motionId: 'nothing'}, /nothing/);
  assert.equal((await q.enqueue(body({seconds: 3.15}))).input.seconds, 3);   // Python と JS で丸めが分かれる小数を通さない
  await q.close();
});

test('同じ条件は同じ作業フォルダ、条件が違えば別', () => {
  const i = {charId: 'c', verId: 'v', motionId: 'm', stages: ['a'], seconds: 3, bpm: 120, seed: 1, beatsPerShot: 8, shotsPerScene: 1, audioId: null, audioStart: 0, quality: 'preview'};
  assert.equal(mvKey(i), mvKey({...i}));
  assert.notEqual(mvKey(i), mvKey({...i, quality: 'final'}));
  assert.notEqual(mvKey(i), mvKey({...i, stages: ['a', 'b']}));
  assert.notEqual(mvKey(i, ['x']), mvKey(i, ['y']));   // コードやモーションの中身が変わった
});

test('試しから本番へ: 試しは小さい動画で記録し、本番は同じ条件を引き継いで 1080x1920 にする。作業は消える', async () => {
  const {lib, q} = await setup();
  const job = await q.enqueue(body({quality: 'preview', seed: 7, bpm: 100, beatsPerShot: 4}));
  await assert.rejects(q.enqueue(body({quality: 'preview', seed: 7, bpm: 100, beatsPerShot: 4})), /同じ条件/);
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error);
  const [p] = await lib.shoots('c1');
  assert.equal(p.kind, 'mv'); assert.equal(p.quality, 'preview'); assert.equal(p.width, 432);
  assert.deepEqual(p.mv.stageLabels, ['コンサート', '教室']);
  assert.deepEqual(p.mv.shots.map(s => s.stage), ['concert', 'classroom']);
  const pv = probe(path.join(lib.shootDir('c1', p.id), 'video.mp4'));
  assert.equal(pv.streams[0].height, 768); assert.equal(pv.streams[0].color_space, 'bt709'); assert.ok(Math.abs(pv.format.duration - 3) < 0.1);
  assert.deepEqual(await fs.readdir(path.join(lib.dir, 'mv-work')), []);

  await assert.rejects(q.enqueue({type: 'mv', charId: 'c1', previewOf: 'nothing'}), /無い/);
  const f = await q.enqueue({type: 'mv', charId: 'c1', previewOf: p.id});
  assert.equal(f.input.quality, 'final'); assert.equal(f.input.seed, 7); assert.deepEqual(f.input.stages, ['concert', 'classroom']);
  await q.whenIdle();
  const fin = (await lib.shoots('c1')).find(s => s.quality === 'final');
  assert.equal(fin.mv.previewOf, p.id); assert.equal(fin.height, 1920); assert.equal(fin.mv.bpm, 100);
  await assert.rejects(q.enqueue({type: 'mv', charId: 'c1', previewOf: fin.id}), /試しではない/);
  await q.close();
});

test('失敗しても描いたコマを残し、同じ条件で積み直すと続きになる', async () => {
  const {lib, q} = await setup({...FAKE_ENV, CHARASTA_FAKE_CAPTURE: 'hang', CHARASTA_SHOOT_TIMEOUT_MS: '500'});
  const job = await q.enqueue(body());
  const frames = path.join(lib.dir, 'mv-work', job.input.key, 'frames');
  await q.whenIdle();
  assert.equal((await q.get(job.id)).state, 'failed');
  await fs.access(frames);   // 作業は残っている
  q.extraEnv.CHARASTA_FAKE_CAPTURE = '1'; delete q.extraEnv.CHARASTA_SHOOT_TIMEOUT_MS;
  const again = await q.enqueue(body());
  assert.equal(again.input.key, job.input.key);
  await q.whenIdle();
  assert.equal((await q.get(again.id)).state, 'done');
  await q.close();
});

test('シーンの一覧と見本の画像: stage-studio が無ければ使えないと答える', async () => {
  const dir = await stageDir();
  const o = await mvOptions(dir);
  assert.equal(o.available, true); assert.equal(o.stages[0].thumb, '/api/mv/stages/concert.jpg');
  assert.equal((await mvOptions(path.join(dir, 'none'))).available, false);
  assert.throws(() => stageThumb(dir, '../x'));
});

test('API: /api/shoots は全キャラの動画を新しい順で返す。/api/mv はシーンを返す。見本の画像は配る', async () => {
  const s = await startServer({stageStudioDir: await stageDir(), env: FAKE_ENV});
  try {
    const post = (url, b) => fetch(s.base + url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(b)}).then(r => r.json());
    await post('/api/characters', {id: 'c1', name: 'いち', style: 'standard'});
    await post('/api/characters', {id: 'c2', name: 'に', style: 'chibi'});
    const lib = s.server.jobs.lib;
    for (const id of ['c1', 'c2']) await lib.importVersion({charId: id, id: 'v1', data: fakeGlb({a: 1})});
    await lib.importMotion({id: 'dance', data: await fs.readFile(SAMPLE_VRMA), label: 'ダンス'});
    await post('/api/jobs', body({charId: 'c1'}));
    await post('/api/jobs', body({charId: 'c2'}));
    await s.server.jobs.whenIdle();
    const all = await fetch(s.base + '/api/shoots').then(r => r.json());
    assert.deepEqual(all.map(x => x.charName).sort(), ['い' + 'ち', 'に'].sort());
    assert.ok(all[0].createdAt >= all[1].createdAt);
    assert.match(all[0].url, /video\.mp4$/);
    assert.equal((await fetch(s.base + '/api/mv').then(r => r.json())).stages.length, 2);
    assert.equal((await fetch(s.base + '/api/mv/stages/concert.jpg')).status, 200);
    assert.equal((await fetch(s.base + '/api/mv/stages/none.jpg')).status, 404);
  } finally { await s.close(); }
});
