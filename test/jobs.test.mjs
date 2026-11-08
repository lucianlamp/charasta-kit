// ジョブの順番待ち。CHARASTA_FAKE_GROK と CHARASTA_FAKE_CAPTURE で、Grok もブラウザも使わずに動かす(ffmpeg は要る)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Library} from '../lib/library.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {tempDir, fakeGlb, FAKE_ENV} from './helpers.mjs';

async function setup(env = FAKE_ENV) {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c1', name: 'C1', voice: 'grok:eve'});
  await lib.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({a: 1})});
  return {lib, q: new JobQueue({lib, env})};
}
const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', file], {encoding: 'utf8'}));
const exists = f => fs.access(f).then(() => true, () => false);

test('voice ジョブ: 積む -> done -> セリフ(reading、source.mp4、audio.mp3)ができ、状態とログが保管場所に残る', async () => {
  const {lib, q} = await setup();
  const job = await q.enqueue({type: 'voice', charId: 'c1', lineId: 'hello', text: '今日は晴れ', reading: 'きょうははれ', emotion: 'happy'});
  assert.equal(job.state, 'queued'); assert.equal(job.input.verId, 'v1'); assert.deepEqual(job.input.voice, {provider: 'grok', id: 'eve'});
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.error, null); assert.ok(done.startedAt && done.finishedAt);
  assert.equal(done.result.lineId, 'hello'); assert.ok(done.result.voicedSec > 1);
  assert.equal(done.result.audioUrl, '/lib/characters/c1/lines/hello/audio.mp3');
  const line = await lib.getLine('c1', 'hello');
  assert.equal(line.text, '今日は晴れ'); assert.equal(line.reading, 'きょうははれ'); assert.equal(line.emotion, 'happy');
  assert.deepEqual(line.voice, {provider: 'grok', id: 'eve'}); assert.equal(line.source.grokJob, job.id); assert.equal(line.source.video, 'source.mp4');
  assert.ok(probe(path.join(line.dir, 'source.mp4')).streams.some(s => s.codec_type === 'video'));
  const mp3 = probe(path.join(line.dir, 'audio.mp3'));
  assert.deepEqual(mp3.streams.map(s => s.codec_type), ['audio']); assert.ok(Number(mp3.format.duration) > 1.5);
  // jobs/<id>.json と jobs/<id>.log
  assert.equal(JSON.parse(await fs.readFile(path.join(lib.dir, 'jobs', job.id + '.json'), 'utf8')).state, 'done');
  const log = await fs.readFile(path.join(lib.dir, 'jobs', job.id + '.log'), 'utf8');
  assert.match(log, /== 顔を撮る/); assert.match(log, /== セリフとして取り込む/); assert.match(log, /声の区間 合計/);
  assert.equal(done.logTail.length > 0, true);
});

test('video ジョブ: lines/<lineId>/videos/<verId>-<framing>.mp4 ができ、映像と音声がある', async () => {
  const {lib, q} = await setup();
  await q.enqueue({type: 'voice', charId: 'c1', lineId: 'hello', text: 'こんにちは'}); await q.whenIdle();
  const job = await q.enqueue({type: 'video', charId: 'c1', lineId: 'hello'}); // verId は最新、framing は face
  assert.equal(job.input.framing, 'face');
  const upper = await q.enqueue({type: 'video', charId: 'c1', lineId: 'hello', verId: 'v1', framing: 'upper'});
  await q.whenIdle();
  for (const [j, framing] of [[job, 'face'], [upper, 'upper']]) {
    const done = await q.get(j.id); assert.equal(done.state, 'done', done.error);
    assert.equal(done.result.url, `/lib/characters/c1/lines/hello/videos/v1-${framing}.mp4`);
    const info = probe(path.join(lib.dir, 'characters/c1/lines/hello/videos', `v1-${framing}.mp4`));
    assert.deepEqual(info.streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
    assert.ok(Math.abs(Number(info.format.duration) - 2) < 0.3, info.format.duration);
  }
  assert.deepEqual((await lib.getCharacter('c1')).lines[0].videos.map(v => v.framing), ['face', 'upper']);
  assert.equal(await exists(path.join(lib.dir, 'jobs', job.id, 'frames')), false); // 撮ったコマは片づける
});

test('順番に 1 件ずつ動く: 前のジョブが終わってから次が始まる', async () => {
  const {q} = await setup();
  const jobs = [];
  for (const id of ['l1', 'l2', 'l3']) jobs.push(await q.enqueue({type: 'voice', charId: 'c1', lineId: id, text: id + 'です'}));
  assert.deepEqual((await q.list()).map(j => j.id), [...jobs].reverse().map(j => j.id)); // 新しい順
  await q.whenIdle();
  const done = await Promise.all(jobs.map(j => q.get(j.id)));
  assert.deepEqual(done.map(j => j.state), ['done', 'done', 'done']);
  for (let i = 1; i < done.length; i++) assert.ok(done[i].startedAt >= done[i - 1].finishedAt, `${i}: ${done[i].startedAt} < ${done[i - 1].finishedAt}`);
});

test('失敗の記録: Grok の失敗、声がほとんど無い動画、どちらもセリフを作らず failed とエラーの文を残す', async () => {
  for (const [mode, re] of [['fail', /Grok が失敗した/], ['silent', /声がほとんど無い/]]) {
    const {lib, q} = await setup({...FAKE_ENV, CHARASTA_FAKE_GROK: mode});
    const job = await q.enqueue({type: 'voice', charId: 'c1', lineId: 'x', text: 'あ'});
    await q.whenIdle();
    const f = await q.get(job.id);
    assert.equal(f.state, 'failed'); assert.match(f.error, re); assert.equal(f.result, null); assert.ok(f.finishedAt);
    assert.equal(await lib.lineExists('c1', 'x'), false);
    assert.match(await fs.readFile(path.join(lib.dir, 'jobs', job.id + '.log'), 'utf8'), /!! /);
    // 失敗のあとも次のジョブが動く
    const next = await q.enqueue({type: 'voice', charId: 'c1', lineId: 'y', text: 'い'}); await q.whenIdle();
    assert.equal((await q.get(next.id)).state, 'failed');
  }
});

test('外部コマンドの失敗(ffmpeg が無い)も failed になり、サーバーは動き続ける', async () => {
  const {q} = await setup({...FAKE_ENV, CHARASTA_FFMPEG: 'no-such-ffmpeg-command'});
  const job = await q.enqueue({type: 'voice', charId: 'c1', lineId: 'x', text: 'あ'}); await q.whenIdle();
  const f = await q.get(job.id); assert.equal(f.state, 'failed'); assert.match(f.error, /起動できない/);
});

test('再起動: running と queued のまま残ったジョブは failed「サーバーが止まった」になる', async () => {
  const {lib} = await setup();
  const dir = path.join(lib.dir, 'jobs'); await fs.mkdir(dir, {recursive: true});
  const mk = (id, state, createdAt) => fs.writeFile(path.join(dir, id + '.json'), JSON.stringify({id, type: 'voice', state, step: '顔を撮る', input: {}, result: null, error: null, createdAt, startedAt: null, finishedAt: null}));
  await mk('jold-running', 'running', '2026-10-01T00:00:00.000Z'); await mk('jold-queued', 'queued', '2026-10-01T00:00:01.000Z'); await mk('jold-done', 'done', '2026-10-01T00:00:02.000Z');
  const q = new JobQueue({lib, env: FAKE_ENV});
  const list = await q.list();
  assert.deepEqual(list.map(j => [j.id, j.state]), [['jold-done', 'done'], ['jold-queued', 'failed'], ['jold-running', 'failed']]);
  assert.equal(list[2].error, 'サーバーが止まった'); assert.ok(list[2].finishedAt);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'jold-running.json'), 'utf8')).state, 'failed'); // ファイルにも書く
});

test('一覧は新しい順に最大 50 件、1 件ずつは ID で引く', async () => {
  const {lib} = await setup();
  const dir = path.join(lib.dir, 'jobs'); await fs.mkdir(dir, {recursive: true});
  for (let i = 0; i < 55; i++) {
    const id = 'j' + String(i).padStart(3, '0');
    await fs.writeFile(path.join(dir, id + '.json'), JSON.stringify({id, type: 'video', state: 'done', createdAt: `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z`}));
  }
  const q = new JobQueue({lib, env: FAKE_ENV});
  const list = await q.list();
  assert.equal(list.length, 50); assert.equal(list[0].id, 'j054'); assert.equal(list[49].id, 'j005');
  assert.equal((await q.get('j000')).id, 'j000');
  await assert.rejects(q.get('nope'), {code: 'not-found'});
  await assert.rejects(q.get('../x'), {code: 'bad-id'});
});

test('積むときの入力検査', async () => {
  const {lib, q} = await setup();
  await lib.importLine({charId: 'c1', id: 'taken', text: 'あ', data: Buffer.from('x'), ext: '.mp3'});
  const bad = async (body, code) => assert.rejects(q.enqueue(body), {code}, JSON.stringify(body));
  await bad(null, 'bad-input'); await bad({type: 'nope', charId: 'c1'}, 'bad-input'); await bad({type: 'voice'}, 'bad-id');
  await bad({type: 'voice', charId: 'zzz', text: 'a'}, 'not-found'); await bad({type: 'voice', charId: 'c1', verId: 'v9', text: 'a'}, 'not-found');
  await bad({type: 'voice', charId: 'c1'}, 'bad-input'); await bad({type: 'voice', charId: 'c1', text: '  '}, 'bad-input');
  await bad({type: 'voice', charId: 'c1', text: 'あ'.repeat(201)}, 'bad-input'); await bad({type: 'voice', charId: 'c1', text: 'a', text2: 1, emotion: 'x'}, 'bad-input');
  await bad({type: 'voice', charId: 'c1', text: 5}, 'bad-input'); await bad({type: 'voice', charId: 'c1', text: 'a', voice: 'openai:x'}, 'bad-input');
  await bad({type: 'voice', charId: 'c1', text: 'a', lineId: 'taken'}, 'exists'); await bad({type: 'voice', charId: 'c1', text: 'a', lineId: '../x'}, 'bad-id');
  await bad({type: 'video', charId: 'c1', lineId: 'nope'}, 'not-found'); await bad({type: 'video', charId: 'c1', lineId: 'taken', framing: 'full'}, 'bad-input');
  await bad({type: 'video', charId: 'c1'}, 'bad-id');
  await lib.updateCharacter('c1', {voice: null});
  await bad({type: 'voice', charId: 'c1', text: 'a'}, 'bad-input'); // 声の種類が決まっていない
  assert.equal((await q.list()).length, 0);
  // 同じ lineId を作るジョブが順番待ちにあれば断る
  const j = await q.enqueue({type: 'voice', charId: 'c1', text: 'a', voice: 'grok:leo', lineId: 'same'});
  await bad({type: 'voice', charId: 'c1', text: 'b', voice: 'grok:leo', lineId: 'same'}, 'exists');
  await q.whenIdle(); assert.equal((await q.get(j.id)).state, 'done');
});
