// 段階 2 の API: PATCH /api/characters/<id>、/api/jobs、DELETE /api/characters/<id>/lines/<lineId>
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Library} from '../lib/library.mjs';
import {startServer, fakeGlb, FAKE_ENV} from './helpers.mjs';

const call = async (base, method, url, body, headers = {}) => {
  const r = await fetch(base + url, {method, headers: body === undefined ? headers : {'content-type': 'application/json', ...headers},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)});
  return {status: r.status, body: await r.json().catch(() => null)};
};
async function withServer(fn) {
  const s = await startServer({env: FAKE_ENV});
  try {
    const lib = new Library(s.libraryDir);
    await lib.createCharacter({id: 'c1', name: 'C1', note: 'n', voice: 'grok:eve'});
    await lib.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({a: 1})});
    await fn(s, lib);
  } finally { await s.close(); }
}
async function waitDone(base, id) {
  for (let i = 0; i < 200; i++) {
    const j = (await call(base, 'GET', '/api/jobs/' + id)).body;
    if (j.state === 'done' || j.state === 'failed') return j;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error('ジョブが終わらない');
}

test('PATCH /api/characters/<id>: voice / note / latestVersion だけ。ほかの項目は 400 で何も変えない', async () => {
  await withServer(async (s, lib) => {
    const file = path.join(lib.dir, 'characters/c1/character.json');
    const before = await fs.readFile(file, 'utf8');
    for (const body of [{name: 'X'}, {id: 'c9'}, {voice: 'grok:leo', lines: []}, {}, '[]', 'not json']) {
      const r = await call(s.base, 'PATCH', '/api/characters/c1', body); assert.equal(r.status, 400, JSON.stringify(body)); assert.ok(r.body.error);
    }
    assert.equal((await call(s.base, 'PATCH', '/api/characters/c1', {voice: 'grok'})).status, 400);
    assert.equal((await call(s.base, 'PATCH', '/api/characters/c1', {latestVersion: 'v9'})).status, 404);
    assert.equal((await call(s.base, 'PATCH', '/api/characters/nope', {note: 'x'})).status, 404);
    assert.equal(await fs.readFile(file, 'utf8'), before);

    const r = await call(s.base, 'PATCH', '/api/characters/c1', {voice: 'grok:leo', note: '新しいメモ'});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.voice, {provider: 'grok', id: 'leo'}); assert.equal(r.body.note, '新しいメモ'); assert.equal(r.body.name, 'C1');
    assert.ok(Array.isArray(r.body.versions) && Array.isArray(r.body.lines)); // GET と同じ詳細を返す
    assert.deepEqual((await call(s.base, 'GET', '/api/characters/c1')).body.voice, {provider: 'grok', id: 'leo'});
    assert.equal((await call(s.base, 'PUT', '/api/characters/c1', {})).status, 405);
  });
});

test('POST /api/jobs -> done -> GET /api/jobs と /api/jobs/<id> -> セリフが詳細に出る -> video ジョブ -> DELETE で trash/ へ', async () => {
  await withServer(async (s, lib) => {
    const post = await call(s.base, 'POST', '/api/jobs', {type: 'voice', charId: 'c1', lineId: 'hello', text: '今日は晴れ', reading: 'きょうははれ', emotion: 'happy'});
    assert.equal(post.status, 201);
    assert.deepEqual(Object.keys(post.body).sort(), ['createdAt', 'error', 'finishedAt', 'id', 'input', 'result', 'startedAt', 'state', 'step', 'type']);
    assert.equal(post.body.type, 'voice'); assert.equal(post.body.input.lineId, 'hello');
    const done = await waitDone(s.base, post.body.id);
    assert.equal(done.state, 'done', done.error);
    assert.equal(done.result.audioUrl, '/lib/characters/c1/lines/hello/audio.mp3'); assert.equal(typeof done.logTail, 'string');

    const list = (await call(s.base, 'GET', '/api/jobs')).body;
    assert.deepEqual(list.map(j => [j.id, j.state]), [[post.body.id, 'done']]); assert.equal(list[0].logTail, undefined);

    const d = (await call(s.base, 'GET', '/api/characters/c1')).body;
    assert.equal(d.lines.length, 1); assert.equal(d.lines[0].reading, 'きょうははれ'); assert.deepEqual(d.lines[0].videos, []);
    assert.equal((await fetch(s.base + d.lines[0].audioUrl)).status, 200);

    const v = await call(s.base, 'POST', '/api/jobs', {type: 'video', charId: 'c1', lineId: 'hello', framing: 'face'});
    assert.equal(v.status, 201);
    const vdone = await waitDone(s.base, v.body.id); assert.equal(vdone.state, 'done', vdone.error);
    const url = vdone.result.url; assert.equal(url, '/lib/characters/c1/lines/hello/videos/v1-face.mp4');
    const res = await fetch(s.base + url); assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.deepEqual((await call(s.base, 'GET', '/api/characters/c1')).body.lines[0].videos, [{verId: 'v1', framing: 'face', url}]);
    assert.equal((await call(s.base, 'GET', '/api/jobs')).body.length, 2);

    const del = await call(s.base, 'DELETE', '/api/characters/c1/lines/hello');
    assert.equal(del.status, 200); assert.equal(del.body.ok, true); assert.match(del.body.trashed, /^trash\//);
    assert.equal((await call(s.base, 'GET', '/api/characters/c1')).body.lines.length, 0);
    await fs.access(path.join(lib.dir, del.body.trashed, 'files/characters/c1/lines/hello/audio.mp3'));
    assert.equal((await call(s.base, 'DELETE', '/api/characters/c1/lines/hello')).status, 404);
    assert.equal((await call(s.base, 'DELETE', '/api/characters/c1/lines/..%2Fx')).status, 400);
    assert.equal((await call(s.base, 'GET', '/api/characters/c1/lines/hello')).status, 405);
  });
});

test('POST /api/jobs の入力の誤り: 400 / 404 / 409。ジョブは積まれない', async () => {
  await withServer(async (s) => {
    for (const [body, status] of [[{type: 'zzz', charId: 'c1'}, 400], [{type: 'voice', charId: 'c1'}, 400], [{type: 'voice', charId: 'nope', text: 'a'}, 404],
      [{type: 'video', charId: 'c1', lineId: 'nope'}, 404], ['{oops', 400], [[], 400]]) {
      const r = await call(s.base, 'POST', '/api/jobs', body); assert.equal(r.status, status, JSON.stringify(body)); assert.ok(r.body.error);
    }
    assert.equal((await call(s.base, 'GET', '/api/jobs/nope')).status, 404);
    assert.equal((await call(s.base, 'GET', '/api/jobs/..%2Fx')).status, 400);
    assert.equal((await call(s.base, 'PUT', '/api/jobs', {})).status, 405);
    assert.deepEqual((await call(s.base, 'GET', '/api/jobs')).body, []);
    const a = await call(s.base, 'POST', '/api/jobs', {type: 'voice', charId: 'c1', lineId: 'dup', text: 'a'});
    assert.equal((await call(s.base, 'POST', '/api/jobs', {type: 'voice', charId: 'c1', lineId: 'dup', text: 'b'})).status, 409);
    await waitDone(s.base, a.body.id);
    assert.equal((await call(s.base, 'POST', '/api/jobs', {type: 'voice', charId: 'c1', lineId: 'dup', text: 'b'})).status, 409);
  });
});

test('追加した道にも Host / Origin の検査がかかる', async () => {
  await withServer(async (s) => {
    const evil = {Origin: 'http://evil.example'};
    assert.equal((await call(s.base, 'PATCH', '/api/characters/c1', {note: 'x'}, evil)).status, 403);
    assert.equal((await call(s.base, 'POST', '/api/jobs', {type: 'voice', charId: 'c1', text: 'a'}, evil)).status, 403);
    assert.equal((await call(s.base, 'GET', '/api/jobs', undefined, evil)).status, 403);
    assert.equal((await call(s.base, 'DELETE', '/api/characters/c1/lines/x', undefined, evil)).status, 403);
    assert.equal((await call(s.base, 'GET', '/api/characters/c1')).body.note, 'n');
    assert.deepEqual((await call(s.base, 'GET', '/api/jobs')).body, []);
  });
});
