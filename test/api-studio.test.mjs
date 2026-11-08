// 段階 3a の API: /api/studio/…、/api/charakuru/projects、studio-* のジョブの積み方、/lib/studio/ で配るもの。
// Blender・Python のスクリプト・ブラウザは呼ばない(CHARASTA_FAKE_BLENDER、CHARASTA_FAKE_CAPTURE)。ffmpeg は要る。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Library} from '../lib/library.mjs';
import {STEPS} from '../lib/studio.mjs';
import {startServer, tempDir, fakeCharakuru, STUDIO_ENV} from './helpers.mjs';

const call = async (base, method, url, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const r = await fetch(base + url, {method, headers: body === undefined ? headers : {'content-type': isBuf ? 'video/mp4' : 'application/json', ...headers},
    body: body === undefined ? undefined : isBuf || typeof body === 'string' ? body : JSON.stringify(body)});
  return {status: r.status, body: await r.json().catch(() => null)};
};
async function waitAll(base) {
  for (let i = 0; i < 300; i++) {
    const jobs = (await call(base, 'GET', '/api/jobs')).body;
    if (!jobs.some(j => j.state === 'queued' || j.state === 'running')) return jobs;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error('ジョブが終わらない');
}
async function withServer(fn) {
  const app = await fakeCharakuru();
  const s = await startServer({env: STUDIO_ENV, charakuruApp: app});
  try {
    const lib = new Library(s.libraryDir);
    await lib.createCharacter({id: 'c1', name: 'C1'});
    await fn(s, lib, app);
  } finally { await s.close(); }
}

test('API: 作る・一覧・状態の形、材料のコピー、区画の範囲、設定、動画を置く', async () => {
  await withServer(async (s, lib) => {
    assert.deepEqual((await call(s.base, 'GET', '/api/charakuru/projects')).body.map(p => p.id), ['p1']);
    let r = await call(s.base, 'POST', '/api/studio/c1', {id: 's1', note: 'n'});
    assert.equal(r.status, 201); assert.equal(r.body.id, 's1'); assert.deepEqual(Object.keys(r.body.steps), STEPS);
    assert.equal((await call(s.base, 'POST', '/api/studio/c1', {id: 's1'})).status, 409);
    assert.equal((await call(s.base, 'POST', '/api/studio/zz', {id: 's1'})).status, 404);
    assert.deepEqual((await call(s.base, 'GET', '/api/studio/c1')).body.map(x => x.id), ['s1']);
    assert.equal((await call(s.base, 'GET', '/api/studio/c1/nope')).status, 404);

    r = await call(s.base, 'POST', '/api/studio/c1/s1/copy', {project: 'p1'});
    assert.equal(r.status, 200); assert.deepEqual(r.body.inputs.map(f => f.name), ['character.blend', 'review.vrm']); assert.equal(r.body.steps.copy.state, 'done');
    assert.equal((await call(s.base, 'POST', '/api/studio/c1/s1/copy', {project: 'p1', fromStudio: 's0'})).status, 400);
    assert.equal((await call(s.base, 'PUT', '/api/studio/c1/s1/rects', {upper: [0, 0, 100, 100]})).status, 400);   // 正面を撮る前

    r = await call(s.base, 'PATCH', '/api/studio/c1/s1/options', {springTune: ['--auto-hit', 'x']});
    assert.equal(r.status, 200); assert.deepEqual(r.body.options.springTune, ['--auto-hit', 'x']);
    for (const bad of [{nope: 1}, {front: 3}, {springTune: 'x'}, {build: {atlas: {cells: {neutral: 'drawn/../../x.png'}}}}, []])
      assert.equal((await call(s.base, 'PATCH', '/api/studio/c1/s1/options', bad)).status, 400, JSON.stringify(bad));

    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
    r = await call(s.base, 'POST', '/api/studio/c1/s1/videos/happy', mp4);
    assert.equal(r.status, 200); assert.deepEqual(r.body.options.video.videos, [{name: 'happy', file: 'video/happy.mp4'}]);
    assert.equal((await call(s.base, 'POST', '/api/studio/c1/s1/videos/happy', Buffer.from('not a video'))).status, 400);
    assert.equal((await call(s.base, 'POST', '/api/studio/c1/s1/videos/smile', mp4)).status, 400);
    assert.equal((await call(s.base, 'POST', '/api/studio/c1/s1/nope', {})).status, 404);
    assert.equal((await call(s.base, 'DELETE', '/api/studio/c1/s1')).status, 405);
  });
});

test('ジョブの積み方: 前の工程が無ければ断り、続けて積むと順に動く。front -> (区画) -> build + video + checks、試作の番号と確かめ', async () => {
  await withServer(async (s, lib, app) => {
    await call(s.base, 'POST', '/api/studio/c1', {id: 's1'});
    const job = body => call(s.base, 'POST', '/api/jobs', {charId: 'c1', studioId: 's1', ...body});
    assert.equal((await job({type: 'studio-front'})).status, 400);   // 材料が無い
    await call(s.base, 'POST', '/api/studio/c1/s1/copy', {project: 'p1'});
    const d = await tempDir('charasta-draw-'); await fs.writeFile(path.join(d, 'neutral.png'), 'png');
    const st = await call(s.base, 'GET', '/api/studio/c1/s1');
    assert.equal(st.body.steps.front.state, 'none');
    assert.equal((await job({type: 'studio-build'})).status, 400);   // 正面がまだ
    assert.equal((await job({type: 'studio-checks'})).status, 400);   // 試作が無い

    const f = await job({type: 'studio-front'});
    assert.equal(f.status, 201); assert.equal(f.body.type, 'studio-front'); assert.deepEqual(f.body.input, {charId: 'c1', studioId: 's1'});
    assert.equal((await job({type: 'studio-front'})).status, 409);   // 同じ工程が順番待ちにある
    await waitAll(s.base);
    assert.equal((await call(s.base, 'GET', '/api/studio/c1/s1')).body.steps.front.state, 'done');
    assert.equal((await job({type: 'studio-build'})).status, 400);   // 区画の範囲がまだ
    assert.equal((await call(s.base, 'PUT', '/api/studio/c1/s1/rects', {upper: [100, 100, 900, 600], mouth: [[800, 1200, 1200, 1500], [900, 1500, 1100, 1600]]})).status, 200);
    assert.equal((await job({type: 'studio-video'})).status, 400);   // 組み立てがまだ

    // 組み立て・中割り・確かめを続けて積む(前の工程が順番待ちにあれば積める)
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
    await call(s.base, 'POST', '/api/studio/c1/s1/videos/blink', mp4);
    await call(s.base, 'PATCH', '/api/studio/c1/s1/options', {video: {open: 'video/blink.mp4'}});
    const b = await job({type: 'studio-build'}), v = await job({type: 'studio-video'}), c = await job({type: 'studio-checks', set: 'accept'});
    assert.deepEqual([b.status, v.status, c.status], [201, 201, 201]);
    let w = (await call(s.base, 'GET', '/api/studio/c1/s1')).body;
    assert.deepEqual(['build', 'video', 'checks'].map(x => w.steps[x].state).every(x => x === 'queued' || x === 'running'), true);
    const jobs = await waitAll(s.base);
    const mine = [b, v, c].map(x => jobs.find(j => j.id === x.body.id));
    assert.deepEqual(mine.map(j => j.state), ['done', 'done', 'done'], JSON.stringify(mine.map(j => j.error)));
    for (let i = 1; i < 3; i++) assert.ok(mine[i].startedAt >= mine[i - 1].finishedAt);
    w = (await call(s.base, 'GET', '/api/studio/c1/s1')).body;
    assert.deepEqual(w.prototypes.map(p => [p.n, p.step, p.file]), [[1, 'build', 'out/001/model.vrm'], [2, 'video', 'out/002/model.vrm']]);
    assert.equal(w.prototypes[1].url, '/lib/studio/c1/s1/out/002/model.vrm');
    assert.deepEqual(w.checks.map(x => [x.proto, x.dir, x.set, x.count]), [[2, 'checks/002', 'accept', 2]]);
    assert.equal(w.checks[0].images[0].url, '/lib/studio/c1/s1/checks/002/neutral_y0.png');
    assert.ok(STEPS.slice(0, 6).every(x => w.steps[x].state === 'done' && !w.steps[x].stale), JSON.stringify(w.steps));
    assert.equal(mine[2].result.proto, 2);
    // ジョブのログ
    assert.match((await call(s.base, 'GET', '/api/jobs/' + b.body.id)).body.logTail, /== 区画の三角形を選ぶ/);
    // 確かめは試作を選べる
    const c1 = await job({type: 'studio-checks', proto: 1}); assert.equal(c1.status, 201); await waitAll(s.base);
    assert.equal((await job({type: 'studio-checks', proto: 7})).status, 400);

    // 配るもの: 試作・撮影・確かめ。材料(.blend)と work/ は配らない
    for (const [u, code] of [['/lib/studio/c1/s1/out/002/model.vrm', 200], ['/lib/studio/c1/s1/checks/002/neutral_y0.png', 200], ['/lib/studio/c1/s1/face/cam.json', 200],
      ['/lib/studio/c1/s1/inputs/character.blend', 404], ['/lib/studio/c1/s1/work/face.blend', 404], ['/lib/studio/c1/s1/work.json', 404], ['/lib/studio/c1/s1/out/../inputs/review.vrm', 404]]) {
      assert.equal((await fetch(s.base + u)).status, code, u);
    }
    // %2F・%5C で包んだ .. は URL の正規化を通り抜ける。生の要求で送って確かめる
    const http = await import('node:http');
    const raw = p => new Promise((resolve, reject) => http.get({host: '127.0.0.1', port: new URL(s.base).port, path: p}, r => { r.resume(); resolve(r.statusCode); }).on('error', reject));
    for (const p of ['/lib/studio/c1/s1/out/..%2Finputs%2Freview.vrm', '/lib/studio/c1/s1/face/..%5Cwork.json', '/lib/studio/c1/s1/out/..%2F..%2Fs1%2Fwork.json', '/lib/studio/c1/s1/out%2F..%2Finputs/review.vrm'])
      assert.equal(await raw(p), 404, p);
    assert.equal(await raw('/lib/studio/c1/s1/out/002%2Fmodel.vrm'), 200);

    // 版にする
    const p = await call(s.base, 'POST', '/api/studio/c1/s1/promote', {proto: 2, verId: 'v1-face', label: 'L', note: '表情づくりから'});
    assert.equal(p.status, 201); assert.equal(p.body.version.id, 'v1-face');
    assert.equal((await call(s.base, 'GET', '/api/characters/c1')).body.versions[0].id, 'v1-face');
    assert.equal((await call(s.base, 'POST', '/api/studio/c1/s1/promote', {proto: 2, verId: 'v1-face', note: 'x'})).status, 409);
    assert.equal((await call(s.base, 'GET', '/api/studio/c1/s1')).body.steps.promote.state, 'done');
  });
});

test('配るもの: /lib/characters/ と /lib/motions/ から %2F・%5C で包んだ .. で出られない(studio/ や jobs/ は取れない)', async () => {
  await withServer(async (s) => {
    await call(s.base, 'POST', '/api/studio/c1', {id: 's1'});
    await call(s.base, 'POST', '/api/studio/c1/s1/copy', {project: 'p1'});
    const job = await call(s.base, 'POST', '/api/jobs', {type: 'studio-front', charId: 'c1', studioId: 's1'});
    await waitAll(s.base);
    const http = await import('node:http');
    const raw = p => new Promise((resolve, reject) => http.get({host: '127.0.0.1', port: new URL(s.base).port, path: p}, r => { r.resume(); resolve(r.statusCode); }).on('error', reject));
    for (const p of ['/lib/characters/..%2Fstudio/c1/s1/work.json', '/lib/characters/..%2Fstudio/c1/s1/inputs/character.blend', '/lib/characters/..%5Cstudio%5Cc1%5Cs1%5Cwork.json',
      `/lib/motions/..%2Fjobs/${job.body.id}.json`, '/lib/motions/..%2Fstudio/c1/s1/work.json'])
      assert.equal(await raw(p), 404, p);
    // 正しい経路は今までどおり(キャラの character.json)
    assert.equal(await raw('/lib/characters/c1/character.json'), 200);
  });
});

test('API: promote の latest が文字列なら 400、設定のファイルが drawn/ video/ の外なら 400', async () => {
  await withServer(async (s) => {
    await call(s.base, 'POST', '/api/studio/c1', {id: 's1'});
    assert.equal((await call(s.base, 'POST', '/api/studio/c1/s1/promote', {proto: 1, verId: 'v1', note: 'x', latest: 'false'})).status, 400);
    assert.equal((await call(s.base, 'PATCH', '/api/studio/c1/s1/options', {build: {atlas: {cells: {neutral: 'C:/Windows/win.ini'}}}})).status, 400);
    assert.equal((await call(s.base, 'PATCH', '/api/studio/c1/s1/options', {video: {open: 'work/face.blend'}})).status, 400);
    assert.equal((await call(s.base, 'PATCH', '/api/studio/c1/s1/options', {video: {open: 'drawn/neutral.png'}})).status, 200);
  });
});
