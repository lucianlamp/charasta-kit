// ステージの頼みごと(lib/stage-requests.mjs、/api/stage-requests、scripts/stage-requests.mjs)。docs/stages.md
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {startServer, tempDir} from './helpers.mjs';
import {createStageRequest, addStageRef, listStageRequests, startStageRequest, finishStageRequest, declineStageRequest, cancelStageRequest, getStageRequest} from '../lib/stage-requests.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);

// シーンが 2 つ(サムネイルは beach だけ)の stage-studio
async function stageDir() {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'stages'));
  await fs.mkdir(path.join(dir, 'assets', 'thumbs'), {recursive: true});
  await fs.writeFile(path.join(dir, 'stages', 'catalog.json'), JSON.stringify([{id: 'beach', label: '夏の浜辺'}, {id: 'cave', label: '洞窟'}]));
  await fs.writeFile(path.join(dir, 'assets', 'thumbs', 'beach.jpg'), JPG);
  return dir;
}

test('作る: 名前と説明を確かめ、対応待ちで残る。新しい順に並ぶ', async () => {
  const lib = await tempDir();
  for (const bad of [{}, {label: ' ', description: 'x'}, {label: 'x', description: ''}, {label: 'x'.repeat(41), description: 'x'}, {label: 'x', description: 'x'.repeat(1001)}, {label: 1, description: 'x'}])
    await assert.rejects(createStageRequest(lib, bad), {code: 'bad-input'}, JSON.stringify(bad).slice(0, 60));
  const a = await createStageRequest(lib, {label: ' 夏の浜辺 ', description: '昼の砂浜。海の家がある'}, new Date('2026-11-09T01:00:00Z'));
  const b = await createStageRequest(lib, {label: '洞窟', description: '光る苔'}, new Date('2026-11-09T02:00:00Z'));
  assert.deepEqual([a.label, a.state, a.refs, a.reply, a.repliedAt, a.stageId], ['夏の浜辺', 'waiting', [], '', null, null]);
  assert.match(a.id, /^20261109-010000-[0-9a-f]{4}$/);
  assert.deepEqual((await listStageRequests(lib)).map(r => r.id), [b.id, a.id]);
  assert.deepEqual(await listStageRequests(await tempDir()), [], '置き場所が無ければ空');
});

test('参考の絵: 画像だけ、4 枚まで、対応待ちのときだけ', async () => {
  const lib = await tempDir(), r = await createStageRequest(lib, {label: '浜辺', description: '砂浜'});
  await assert.rejects(addStageRef(lib, r.id, {name: 'a.png', data: Buffer.from('not an image')}), {code: 'bad-input'});
  await assert.rejects(addStageRef(lib, r.id, {name: 'a.png', data: Buffer.alloc(0)}), {code: 'bad-input'});
  await assert.rejects(addStageRef(lib, r.id, {name: 'a.png', data: Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)])}), {code: 'bad-input'});
  assert.deepEqual(await addStageRef(lib, r.id, {name: 'sea.png', data: PNG}), {file: 'ref-1.png', name: 'sea.png'});
  assert.deepEqual(await addStageRef(lib, r.id, {name: 'photo.png', data: JPG}), {file: 'ref-2.jpg', name: 'photo.png'}, '種類は中身で決める');
  await addStageRef(lib, r.id, {data: PNG}); await addStageRef(lib, r.id, {data: PNG});
  await assert.rejects(addStageRef(lib, r.id, {data: PNG}), /4 枚まで/);
  const r2 = await createStageRequest(lib, {label: '洞窟', description: '暗い'});
  await startStageRequest(lib, r2.id);
  await assert.rejects(addStageRef(lib, r2.id, {data: PNG}), {code: 'busy'});
  await assert.rejects(addStageRef(lib, 'nope', {data: PNG}), {code: 'not-found'});
  await assert.rejects(addStageRef(lib, '../x', {data: PNG}), {code: 'bad-id'});
});

test('状態: 始める、片付ける(シーンとサムネイルを確かめる)、見送る、取り下げる', async () => {
  const lib = await tempDir(), stages = await stageDir(), now = new Date('2026-11-09T03:00:00Z');
  const r = await createStageRequest(lib, {label: '浜辺', description: '砂浜'});
  assert.equal((await startStageRequest(lib, r.id)).state, 'working');
  await assert.rejects(startStageRequest(lib, r.id), {code: 'busy'});
  await assert.rejects(cancelStageRequest(lib, r.id), {code: 'busy'}, '作業中は取り下げられない');
  await assert.rejects(finishStageRequest(lib, r.id, {stageDir: stages, stageId: 'mountain', reply: 'x'}), /catalog\.json に無い/);
  await assert.rejects(finishStageRequest(lib, r.id, {stageDir: stages, stageId: 'cave', reply: 'x'}), /サムネイル/);
  await assert.rejects(finishStageRequest(lib, r.id, {stageDir: null, stageId: 'beach', reply: 'x'}), /stageStudioDir/);
  await assert.rejects(finishStageRequest(lib, r.id, {stageDir: stages, stageId: 'beach', reply: ' '}), /返事/);
  await assert.rejects(finishStageRequest(lib, r.id, {stageDir: stages, stageId: 'beach', reply: 'x'.repeat(401)}), /400 字/);
  const done = await finishStageRequest(lib, r.id, {stageDir: stages, stageId: 'beach', reply: '浜辺を作った', now});
  assert.deepEqual([done.state, done.stageId, done.reply, done.repliedAt], ['done', 'beach', '浜辺を作った', '2026-11-09T03:00:00.000Z']);
  await assert.rejects(declineStageRequest(lib, r.id, {reply: 'x'}), {code: 'busy'}, '完了は動かせない');
  const d = await createStageRequest(lib, {label: '宇宙', description: '無重力'});
  assert.deepEqual([(await declineStageRequest(lib, d.id, {reply: '無重力は描けない', now})).state], ['declined']);
  const c = await createStageRequest(lib, {label: '森', description: '木'});
  await addStageRef(lib, c.id, {data: PNG});
  await cancelStageRequest(lib, c.id);
  await assert.rejects(getStageRequest(lib, c.id), {code: 'not-found'});
  await assert.rejects(fs.access(path.join(lib, 'stage-requests', c.id)), 'フォルダごと消す');
});

for (const edition of ['full', 'kit']) {
  test(`${edition}: /api/stage-requests で作る、絵を足す、一覧、絵を見る、取り下げる`, async t => {
    const s = await startServer({edition});
    t.after(() => s.close());
    const api = '/api/stage-requests';
    assert.equal((await fetch(s.base + api, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({label: '', description: 'x'})})).status, 400);
    const r = await fetch(s.base + api, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({label: '浜辺', description: '昼の砂浜'})});
    assert.equal(r.status, 201);
    const req = await r.json();
    const up = await fetch(`${s.base}${api}/${req.id}/refs`, {method: 'POST', headers: {'x-filename': encodeURIComponent('海.png')}, body: PNG});
    assert.equal(up.status, 201);
    assert.deepEqual(await up.json(), {file: 'ref-1.png', name: '海.png'});
    assert.equal((await fetch(`${s.base}${api}/${req.id}/refs`, {method: 'POST', body: Buffer.from('text')})).status, 400);
    const list = await (await fetch(s.base + api)).json();
    assert.deepEqual(list.requests.map(x => [x.id, x.state, x.refs.map(f => f.url)]), [[req.id, 'waiting', [`/api/stage-requests/${req.id}/refs/ref-1.png`]]]);
    const img = await fetch(s.base + list.requests[0].refs[0].url);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    assert.equal((await fetch(`${s.base}${api}/${req.id}/refs/request.json`)).status, 404, 'request.json は配らない');
    assert.equal((await fetch(`${s.base}${api}/${req.id}/refs/..%2F..%2Fx.png`)).status, 404);
    assert.equal((await fetch(`${s.base}${api}/${req.id}`)).status, 200);
    assert.equal((await fetch(s.base + api, {method: 'PUT'})).status, 405);
    await startStageRequest(s.server.jobs.lib.dir, req.id);
    assert.equal((await fetch(`${s.base}${api}/${req.id}`, {method: 'DELETE'})).status, 409, '作業中は取り下げられない');
    const other = await (await fetch(s.base + api, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({label: '森', description: '木'})})).json();
    assert.equal((await fetch(`${s.base}${api}/${other.id}`, {method: 'DELETE'})).status, 200);
    assert.equal((await fetch(`${s.base}${api}/${other.id}`)).status, 404);
  });
}

test('画面: 送る前に参考の絵の枚数、大きさ、種類を確かめる', async () => {
  const {refsProblem, REQUEST_STATE} = await import('../public/stages.mjs');
  const f = (name, type = 'image/png', size = 10) => ({name, type, size});
  assert.equal(refsProblem([]), null);
  assert.equal(refsProblem([f('a.png'), f('b.jpg', 'image/jpeg'), f('c.webp', 'image/webp')]), null);
  assert.match(refsProblem([1, 2, 3, 4, 5].map(i => f(i + '.png'))), /4 枚まで/);
  assert.match(refsProblem([f('big.png', 'image/png', 9 * 1024 * 1024)]), /big\.png が大きすぎる/);
  assert.match(refsProblem([f('a.gif', 'image/gif')]), /a\.gif は PNG/);
  assert.deepEqual(Object.keys(REQUEST_STATE), ['waiting', 'working', 'done', 'declined']);
});

// CLI: 保管場所(CHARASTA_LIBRARY)のファイルを直に読み書きする。サーバーは要らない
const cli = (lib, ...args) => exec(process.execPath, [path.join(root, 'scripts', 'stage-requests.mjs'), ...args], {env: {...process.env, CHARASTA_LIBRARY: lib}});

test('CLI: list、show、start、done(シーンを確かめる)、decline。--json で機械が読める形', async () => {
  const lib = await tempDir(), stages = await stageDir();
  const a = await createStageRequest(lib, {label: '浜辺', description: '昼の砂浜'}, new Date('2026-11-09T01:00:00Z'));
  await addStageRef(lib, a.id, {name: 'sea.png', data: PNG});
  const b = await createStageRequest(lib, {label: '宇宙', description: '無重力'}, new Date('2026-11-09T02:00:00Z'));

  const list = JSON.parse((await cli(lib, 'list', '--json')).stdout);
  assert.deepEqual(list.map(r => [r.id, r.state]), [[a.id, 'waiting'], [b.id, 'waiting']], '対応待ちを古い順');
  assert.equal(list[0].refs[0].path, path.join(lib, 'stage-requests', a.id, 'ref-1.png'), '参考の絵はファイルの場所で渡す');
  assert.match((await cli(lib, 'list')).stdout, /浜辺/);
  const shown = JSON.parse((await cli(lib, 'show', a.id, '--json')).stdout);
  assert.equal(shown.description, '昼の砂浜');

  assert.equal(JSON.parse((await cli(lib, 'start', a.id, '--json')).stdout).state, 'working');
  await assert.rejects(cli(lib, 'done', a.id, '--stage', 'cave', '--reply', 'x', '--stage-studio', stages), e => /サムネイル/.test(e.stderr));
  await assert.rejects(cli(lib, 'done', a.id, '--stage', 'mountain', '--reply', 'x', '--stage-studio', stages), e => /catalog\.json/.test(e.stderr));
  await assert.rejects(cli(lib, 'done', a.id, '--reply', 'x', '--stage-studio', stages), e => /--stage/.test(e.stderr));
  const done = JSON.parse((await cli(lib, 'done', a.id, '--stage', 'beach', '--reply', '浜辺を作った', '--stage-studio', stages, '--json')).stdout);
  assert.deepEqual([done.state, done.stageId, done.reply], ['done', 'beach', '浜辺を作った']);

  await assert.rejects(cli(lib, 'decline', b.id), e => /--reply/.test(e.stderr));
  assert.equal(JSON.parse((await cli(lib, 'decline', b.id, '--reply', '無重力は描けない', '--json')).stdout).state, 'declined');
  assert.deepEqual(JSON.parse((await cli(lib, 'list', '--json')).stdout), [], '片付いたものは出さない');
  assert.equal(JSON.parse((await cli(lib, 'list', '--all', '--json')).stdout).length, 2);
  await assert.rejects(cli(lib, 'show', 'nope'), e => e.code === 1 && /無い/.test(e.stderr));
  await assert.rejects(cli(lib, 'fly'), e => e.code === 2);
});
