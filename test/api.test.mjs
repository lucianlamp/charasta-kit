import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Library} from '../lib/library.mjs';
import {startServer, fakeGlb, SAMPLE_VRMA} from './helpers.mjs';

const getJson = async (url, init) => { const r = await fetch(url, init); return {status: r.status, body: await r.json().catch(() => null)}; };

test('空の保管場所: 一覧は空、画面のファイルが無くても落ちない', async () => {
  const s = await startServer();
  try {
    assert.deepEqual(await getJson(s.base + '/api/characters'), {status: 200, body: []});
    assert.deepEqual(await getJson(s.base + '/api/motions'), {status: 200, body: []});
    assert.equal((await fetch(s.base + '/api/characters/nope')).status, 404);
    assert.equal((await fetch(s.base + '/api/characters/..%2Fx')).status, 400);
    const r = await fetch(s.base + '/viewer?char=a'); assert.ok([200, 404].includes(r.status));
    await fetch(s.base + '/');
  } finally { await s.close(); }
});

test('キャラの一覧と詳細の形、/lib/ の配信と Range', async () => {
  const s = await startServer();
  try {
    const lib = new Library(s.libraryDir);
    await lib.createCharacter({id: 'chara4', name: 'キャラ4', note: 'メモ', voice: 'grok:eve'});
    const glb = fakeGlb({n: 1});
    await lib.importVersion({charId: 'chara4', id: 'v1', label: 'L1', data: glb});
    await lib.importVersion({charId: 'chara4', id: 'v2', label: 'L2', data: fakeGlb({n: 2}), latest: true});
    await fs.writeFile(path.join(s.libraryDir, 'characters/chara4/versions/v2/thumb.png'), 'png');
    await lib.importLine({charId: 'chara4', id: 'hello', text: 'こんにちは', data: Buffer.from('0123456789'), ext: '.mp3'});

    const list = (await getJson(s.base + '/api/characters')).body;
    assert.deepEqual(list, [{id: 'chara4', name: 'キャラ4', note: 'メモ', style: null,
      latest: {id: 'v2', label: 'L2', thumb: '/lib/characters/chara4/versions/v2/thumb.png'}, versionCount: 2, lineCount: 1}]);

    const d = (await getJson(s.base + '/api/characters/chara4')).body;
    assert.equal(d.id, 'chara4'); assert.equal(d.latestVersion, 'v2');
    assert.deepEqual(d.versions.map(v => [v.id, v.order]), [['v1', 1], ['v2', 2]]);
    assert.equal(d.versions[0].model, '/lib/characters/chara4/versions/v1/model.vrm');
    assert.equal(d.versions[0].thumb, null);
    assert.equal(d.versions[1].thumb, '/lib/characters/chara4/versions/v2/thumb.png');
    assert.equal(d.lines[0].audioUrl, '/lib/characters/chara4/lines/hello/audio.mp3');
    assert.equal(d.lines[0].text, 'こんにちは');

    const model = await fetch(s.base + d.versions[0].model);
    assert.equal(model.status, 200); assert.equal(model.headers.get('content-type'), 'model/gltf-binary');
    assert.deepEqual(Buffer.from(await model.arrayBuffer()), glb);
    const part = await fetch(s.base + d.lines[0].audioUrl, {headers: {Range: 'bytes=2-4'}});
    assert.equal(part.status, 206); assert.equal(await part.text(), '234');

    // パスの外へ出るものは 404
    for (const p of ['/lib/../config.json', '/lib/%2e%2e/x', '/lib/..%2f..%2fx', '/lib/characters/%2e%2e%2f%2e%2e%2fsecret', '/lib/..%5c..%5cx', '/vendor/../server.mjs', '/app/..%2fserver.mjs']) {
      const r = await fetch(s.base + p); assert.equal(r.status, 404, p);
    }
    assert.equal((await fetch(s.base + '/lib/characters/chara4/nothing.txt')).status, 404);
    assert.equal((await fetch(s.base + '/lib/characters/chara4')).status, 404); // フォルダ
  } finally { await s.close(); }
});

test('POST /api/motions: VRMA を取り込み、一覧に出て、同じ名前は 409', async () => {
  const s = await startServer();
  try {
    const body = await fs.readFile(SAMPLE_VRMA);
    const license = {holder: 'ピクシブ株式会社', summary: '改変可', redistribution: false};
    const headers = {'x-filename': 'VRMA_02.vrma', 'x-license': encodeURIComponent(JSON.stringify(license)), 'content-type': 'application/octet-stream'};
    const r = await getJson(s.base + '/api/motions', {method: 'POST', headers, body});
    assert.equal(r.status, 201);
    assert.equal(r.body.id, 'vrma-02'); assert.equal(r.body.name, 'VRMA_02');
    assert.deepEqual(r.body.license, license);
    assert.ok(r.body.durationSec > 1); assert.ok(r.body.bones.includes('hips')); assert.equal(r.body.usesShoulder, true);
    assert.equal(r.body.sha256.length, 64);
    assert.deepEqual(await fs.readFile(path.join(s.libraryDir, 'motions/vrma-02/motion.vrma')), body);

    const list = (await getJson(s.base + '/api/motions')).body;
    assert.equal(list.length, 1); assert.equal(list[0].file, '/lib/motions/vrma-02/motion.vrma');
    const file = await fetch(s.base + list[0].file);
    assert.equal(file.status, 200);

    assert.equal((await getJson(s.base + '/api/motions', {method: 'POST', headers, body})).status, 409);
    // 生の JSON のヘッダも受ける。壊れた VRMA は 400
    const bad = await getJson(s.base + '/api/motions', {method: 'POST', headers: {'x-filename': 'bad.vrma', 'x-license': JSON.stringify({holder: 'H'})}, body: Buffer.from('garbage-garbage-garbage')});
    assert.equal(bad.status, 400);
    await assert.rejects(fs.access(path.join(s.libraryDir, 'motions/bad')));
    assert.equal((await getJson(s.base + '/api/motions', {method: 'POST', headers: {'x-license': '{}'}, body})).status, 400);
    assert.equal((await getJson(s.base + '/api/motions', {method: 'POST', headers: {'x-filename': 'a.vrma', 'x-license': '{oops'}, body})).status, 400);
  } finally { await s.close(); }
});

test('Host と Origin が他サイトのリクエストは拒否する', async () => {
  const s = await startServer();
  try {
    const r = await fetch(s.base + '/api/characters', {headers: {Origin: 'http://evil.example'}});
    assert.equal(r.status, 403);
  } finally { await s.close(); }
});
