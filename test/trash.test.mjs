// ごみ箱(lib/trash.mjs、server.mjs の削除と戻す API): キャラ・バージョン・セリフ・撮った動画・モーションを trash/ へ移し、戻し、完全に消す。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Library, writeJson} from '../lib/library.mjs';
import {Trash} from '../lib/trash.mjs';
import {tempDir, fakeGlb, startServer, FAKE_ENV, SAMPLE_VRMA} from './helpers.mjs';

const exists = f => fs.access(f).then(() => true, () => false);
const call = async (base, method, url, body) => {
  const r = await fetch(base + url, {method, headers: body === undefined ? {} : {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: r.status, body: await r.json().catch(() => null)};
};

// c1(バージョン v1・v2・v3 の 3 つ、v3 が最新、セリフ a、撮った動画 s1、表情づくり st1 が v2 を作った)とモーション m1(c1 の v2 に合わせたもの)、m2
async function seed(extra = {}) {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c1', name: 'キャラ1', voice: 'grok:eve'});
  for (const v of ['v1', 'v2', 'v3']) await lib.importVersion({charId: 'c1', id: v, data: fakeGlb({v}), latest: true});
  for (const v of ['v1', 'v2', 'v3']) await fs.writeFile(path.join(lib.dir, 'characters/c1/versions', v, 'thumb.png'), 'png-' + v);
  await lib.importLine({charId: 'c1', id: 'a', text: 'あ', data: Buffer.from('audio-a'), ext: '.mp3'});
  await fs.mkdir(path.join(lib.dir, 'characters/c1/lines/a/videos'));
  await fs.writeFile(path.join(lib.dir, 'characters/c1/lines/a/videos/v2-face.mp4'), 'mp4');
  const shoot = path.join(lib.dir, 'characters/c1/shoots/s1');
  await fs.mkdir(shoot, {recursive: true});
  await fs.writeFile(path.join(shoot, 'video.mp4'), 'video'); await fs.writeFile(path.join(shoot, 'poster.jpg'), 'poster');
  await writeJson(path.join(shoot, 'shoot.json'), {id: 's1', charId: 'c1', verId: 'v2', motionId: 'm2', motionLabel: 'ダンス', lineId: 'a', lineText: 'あ', aspect: '9:16', seconds: 2, createdAt: '2026-10-30T00:00:00Z'});
  await fs.mkdir(path.join(lib.dir, 'studio/c1/st1'), {recursive: true});
  await writeJson(path.join(lib.dir, 'studio/c1/st1/work.json'), {id: 'st1', charId: 'c1', versions: [{verId: 'v2'}], prototypes: [], steps: {}});
  const data = await fs.readFile(SAMPLE_VRMA);
  await lib.importMotion({id: 'm1', data, license: {holder: 'h', summary: 's'}, fittedTo: {charId: 'c1', charName: 'キャラ1', verId: 'v2'}});
  await lib.importMotion({id: 'm2', data, license: {holder: 'h', summary: 's'}});
  const active = [];
  return {lib, trash: new Trash(lib, {active: async () => active, ...extra}), active};
}
const ids = list => list.map(x => x.id);

test('キャラをごみ箱へ移す: バージョン・セリフ・撮った動画・表情づくりごと移り、trash.json が残る。戻すと一覧とサムネイルが元どおり', async () => {
  const {lib, trash} = await seed();
  const before = await lib.listCharacters();
  const item = await trash.move('character', {charId: 'c1'});
  assert.equal(item.kind, 'character'); assert.equal(item.id, 'c1'); assert.equal(item.charId, 'c1'); assert.equal(item.label, 'キャラ1');
  assert.deepEqual(item.paths, ['characters/c1', 'studio/c1']);
  assert.ok(item.sizeBytes > 0); assert.ok(!isNaN(Date.parse(item.trashedAt)));
  assert.deepEqual(await lib.listCharacters(), []);
  assert.equal(await exists(path.join(lib.dir, 'studio/c1')), false);
  const rec = JSON.parse(await fs.readFile(path.join(lib.dir, 'trash', item.trashId, 'trash.json'), 'utf8'));
  assert.deepEqual([rec.kind, rec.id, rec.charId, rec.label], ['character', 'c1', 'c1', 'キャラ1']);
  // 合わせたモーションは残り、一覧が壊れない
  assert.deepEqual(ids(await lib.listMotions()), ['m1', 'm2']);
  assert.equal((await lib.listMotions())[0].fittedTo.charId, 'c1');

  const list = await trash.list();
  assert.equal(list.count, 1); assert.equal(list.items[0].trashId, item.trashId); assert.equal(list.items[0].restorable, true);
  assert.equal(list.totalBytes, list.items[0].sizeBytes);

  await trash.restore(item.trashId);
  assert.deepEqual(await lib.listCharacters(), before);   // 最新バージョンとサムネイルの URL まで同じ
  assert.equal((await lib.listCharacters())[0].latest.thumb, '/lib/characters/c1/versions/v3/thumb.png');
  assert.equal(await fs.readFile(path.join(lib.dir, 'studio/c1/st1/work.json'), 'utf8').then(t => JSON.parse(t).id), 'st1');
  assert.equal((await trash.list()).count, 0); assert.equal(await exists(path.join(lib.dir, 'trash', item.trashId)), false);
});

test('バージョンを消す: 最新バージョンを消すと残りの最新の並びのバージョンに latest が移り、戻すと latest も戻る。参照は壊れない', async () => {
  const {lib, trash} = await seed();
  assert.equal((await lib.getCharacterJson('c1')).latestVersion, 'v3');
  const item = await trash.move('version', {charId: 'c1', id: 'v3'});
  assert.equal(item.meta.wasLatest, true); assert.equal(item.meta.movedTo, 'v2');
  assert.equal((await lib.getCharacterJson('c1')).latestVersion, 'v2');
  assert.deepEqual(ids((await lib.getCharacter('c1')).versions), ['v1', 'v2']);
  assert.equal((await lib.listCharacters())[0].latest.id, 'v2');
  // v2 が最新になったので、v2 を消すと v1 へ移る。消したバージョンを参照する撮った動画・セリフの動画・表情づくり・モーションは残る
  const v2 = await trash.move('version', {charId: 'c1', id: 'v2'});
  assert.equal(v2.meta.movedTo, 'v1');
  const c = await lib.getCharacter('c1');
  assert.equal(c.latestVersion, 'v1'); assert.equal(c.shoots[0].verId, 'v2'); assert.equal(c.lines[0].videos[0].verId, 'v2');
  assert.equal((await lib.listMotions()).find(m => m.id === 'm1').fittedTo.verId, 'v2');
  // バージョンが 1 つになったら断る
  await assert.rejects(trash.move('version', {charId: 'c1', id: 'v1'}), {code: 'last-version', message: /キャラごと消す/});
  assert.deepEqual(ids((await lib.getCharacter('c1')).versions), ['v1']);

  await trash.restore(v2.trashId);   // v2 を戻すと、最新も v2 に戻る(v1 のまま変えられていないので)
  assert.equal((await lib.getCharacterJson('c1')).latestVersion, 'v2');
  await trash.restore(item.trashId);   // v3 は、移した先の v2 がまだ最新なので v3 に戻る
  assert.equal((await lib.getCharacterJson('c1')).latestVersion, 'v3');
  assert.deepEqual(ids((await lib.getCharacter('c1')).versions), ['v1', 'v2', 'v3']);
  assert.equal((await lib.getCharacter('c1')).versions[2].thumb, '/lib/characters/c1/versions/v3/thumb.png');
});

test('バージョンの order: 消したあとに取り込んでも、残っているバージョンと重ならない', async () => {
  const {lib, trash} = await seed();
  await trash.move('version', {charId: 'c1', id: 'v1'}); await trash.move('version', {charId: 'c1', id: 'v2'});
  const v4 = await lib.importVersion({charId: 'c1', id: 'v4', data: fakeGlb({v: 4})});
  assert.deepEqual((await lib.getCharacter('c1')).versions.map(v => [v.id, v.order]), [['v3', 3], ['v4', 4]]);
  assert.equal(v4.order, 4);
});

test('最新でないバージョンを消すと latest は動かない', async () => {
  const {lib, trash} = await seed();
  const item = await trash.move('version', {charId: 'c1', id: 'v1'});
  assert.equal(item.meta.wasLatest, false); assert.equal(item.meta.movedTo, null);
  assert.equal((await lib.getCharacterJson('c1')).latestVersion, 'v3');
  await trash.restore(item.trashId);
  assert.equal((await lib.getCharacterJson('c1')).latestVersion, 'v3');
});

test('モーション・撮った動画・セリフを移して戻す。戻す先に同じ ID があれば断り、何も動かさない', async () => {
  const {lib, trash} = await seed();
  const m = await trash.move('motion', {id: 'm2'});
  assert.deepEqual(ids(await lib.listMotions()), ['m1']);
  const s = await trash.move('shoot', {charId: 'c1', id: 's1'});
  assert.deepEqual((await lib.getCharacter('c1')).shoots, []);
  assert.equal(await fs.readFile(path.join(lib.dir, 'trash', s.trashId, 'files/characters/c1/shoots/s1/video.mp4'), 'utf8'), 'video');
  const l = await trash.move('line', {charId: 'c1', id: 'a'});
  assert.deepEqual((await lib.getCharacter('c1')).lines, []);

  await lib.importMotion({id: 'm2', data: await fs.readFile(SAMPLE_VRMA), license: {holder: 'h', summary: 's'}});   // 同じ ID を作り直した
  await assert.rejects(trash.restore(m.trashId), {code: 'exists'});
  assert.equal((await trash.list()).count, 3);   // 断ったときはごみ箱のまま
  await trash.restore(s.trashId); await trash.restore(l.trashId);
  const c = await lib.getCharacter('c1');
  assert.equal(c.shoots[0].url, '/lib/characters/c1/shoots/s1/video.mp4'); assert.equal(c.shoots[0].posterUrl, '/lib/characters/c1/shoots/s1/poster.jpg');
  assert.equal(c.lines[0].id, 'a'); assert.equal(c.lines[0].videos.length, 1);
  await fs.rm(path.join(lib.dir, 'motions/m2'), {recursive: true});
  await trash.restore(m.trashId);
  assert.deepEqual(ids(await lib.listMotions()), ['m1', 'm2']);
});

test('キャラが無いとき、そのキャラのバージョン・セリフ・撮った動画は戻せない。キャラを先に戻せば戻せる', async () => {
  const {lib, trash} = await seed();
  const v = await trash.move('version', {charId: 'c1', id: 'v1'});
  const ch = await trash.move('character', {charId: 'c1'});
  await assert.rejects(trash.restore(v.trashId), {code: 'not-found', message: /先にキャラを戻す/});
  await trash.restore(ch.trashId); await trash.restore(v.trashId);
  assert.deepEqual(ids((await lib.getCharacter('c1')).versions), ['v1', 'v2', 'v3']);
  // 同じ ID のキャラを作り直してあれば、キャラは戻せない
  const again = await trash.move('character', {charId: 'c1'});
  await lib.createCharacter({id: 'c1', name: '別人'});
  await assert.rejects(trash.restore(again.trashId), {code: 'exists'});
  assert.equal((await lib.getCharacterJson('c1')).name, '別人');
});

test('影響の一覧: バージョンを使う撮った動画・セリフの動画・表情づくり・合わせたモーションの数と、latest の移り先', async () => {
  const {trash} = await seed();
  const v2 = await trash.impact('version', {charId: 'c1', id: 'v2'});
  assert.deepEqual(Object.fromEntries(v2.effects.map(e => [e.key, e.count])), {shoots: 1, lineVideos: 1, studios: 1, fitted: 1});
  assert.equal(v2.refusal, null); assert.ok(v2.sizeBytes > 0);
  const v3 = await trash.impact('version', {charId: 'c1', id: 'v3'});
  assert.deepEqual(v3.effects.map(e => e.key), ['latest']); assert.match(v3.effects[0].text, /v2/);
  const ch = await trash.impact('character', {charId: 'c1'});
  assert.deepEqual(Object.fromEntries(ch.effects.map(e => [e.key, e.count])), {versions: 3, lines: 1, shoots: 1, studios: 1, fitted: 1});
  assert.equal((await trash.impact('motion', {id: 'm2'})).effects[0].count, 1);   // m2 で撮った動画
  assert.equal((await trash.impact('motion', {id: 'm1'})).effects.length, 0);
  assert.equal((await trash.impact('line', {charId: 'c1', id: 'a'})).effects.find(e => e.key === 'shoots').count, 1);
  assert.deepEqual((await trash.impact('shoot', {charId: 'c1', id: 's1'})).effects, []);
  // 何も動かしていない
  assert.equal((await trash.list()).count, 0);
});

test('バージョンが 1 つしか無いキャラのバージョンは、影響の一覧に断る理由が出て、移せない', async () => {
  const {lib, trash} = await seed();
  await lib.createCharacter({id: 'c2', name: 'キャラ2'}); await lib.importVersion({charId: 'c2', id: 'only', data: fakeGlb({o: 1})});
  const i = await trash.impact('version', {charId: 'c2', id: 'only'});
  assert.equal(i.refusal.code, 'last-version');
  await assert.rejects(trash.move('version', {charId: 'c2', id: 'only'}), {code: 'last-version'});
  assert.equal((await lib.getCharacter('c2')).versions.length, 1);
});

test('順番待ちか実行中のジョブが対象を使っているときは断る', async () => {
  const {lib, trash, active} = await seed();
  const job = (id, input) => ({id, state: 'queued', input});
  const cases = [
    [job('j1', {charId: 'c1', verId: 'v2'}), 'version', {charId: 'c1', id: 'v2'}],
    [job('j2', {charId: 'c1', studioId: 'st1'}), 'character', {charId: 'c1'}],
    [job('j3', {charId: 'c1', lineId: 'a'}), 'line', {charId: 'c1', id: 'a'}],
    [job('j4', {charId: 'c1', verId: 'v1', motionId: 'm2'}), 'motion', {id: 'm2'}],
  ];
  for (const [j, kind, ref] of cases) {
    active.splice(0, active.length, j);
    const i = await trash.impact(kind, ref);
    assert.equal(i.refusal.code, 'busy', kind); assert.match(i.refusal.message, new RegExp(j.id));
    await assert.rejects(trash.move(kind, ref), {code: 'busy'}, kind);
  }
  // 別のバージョン・別のモーションを使うジョブは関係ない
  active.splice(0, active.length, job('j5', {charId: 'c1', verId: 'v1', motionId: 'm1'}));
  assert.equal((await trash.impact('version', {charId: 'c1', id: 'v2'})).refusal, null);
  assert.equal((await trash.impact('motion', {id: 'm2'})).refusal, null);
  const moved = await trash.move('version', {charId: 'c1', id: 'v2'});
  assert.equal(moved.id, 'v2');
  assert.equal(await exists(path.join(lib.dir, 'characters/c1/versions/v2')), false);
});

test('パスを越える指定は拒否し、何も動かさない', async () => {
  const {lib, trash} = await seed();
  for (const bad of ['..', '../x', 'a/b', 'a\\b', '', 'v1/../../..', 'V1']) {
    await assert.rejects(trash.move('version', {charId: 'c1', id: bad}), {code: /^(bad-id|outside)$/}, bad);
    await assert.rejects(trash.move('character', {charId: bad}), {code: /^(bad-id|outside)$/}, bad);
    await assert.rejects(trash.move('motion', {id: bad}), {code: /^(bad-id|outside)$/}, bad);
    await assert.rejects(trash.move('shoot', {charId: 'c1', id: bad}), {code: /^(bad-id|outside)$/}, bad);
    await assert.rejects(trash.move('line', {charId: bad, id: 'a'}), {code: /^(bad-id|outside)$/}, bad);
  }
  for (const bad of ['..', '../x', '.', 'a/b', '..\\x', '', '%2e%2e']) {
    await assert.rejects(trash.restore(bad), {code: /^(bad-id|outside)$/}, bad);
    await assert.rejects(trash.purge(bad), {code: /^(bad-id|outside)$/}, bad);
  }
  await assert.rejects(trash.move('nothing', {id: 'x'}), {code: 'bad-input'});
  assert.equal((await lib.listCharacters()).length, 1);
  // 書き換えられた trash.json の元のパスが、保管場所の外や別の場所を指していても戻さない
  const item = await trash.move('motion', {id: 'm2'});
  const rec = path.join(lib.dir, 'trash', item.trashId, 'trash.json'), orig = JSON.parse(await fs.readFile(rec, 'utf8'));
  for (const paths of [['../outside'], ['motions/../../outside'], ['jobs/x'], ['/etc/x'], ['trash/y']]) {
    await writeJson(rec, {...orig, paths});
    await assert.rejects(trash.restore(item.trashId), {code: /^(bad-input|outside)$/}, paths[0]);
  }
  await writeJson(rec, orig);
  await trash.restore(item.trashId);
});

test('完全に消す・空にする。この仕組みより前の項目(trash.json なし)は一覧に出て、戻せないが消せる', async () => {
  const {lib, trash} = await seed();
  const old = path.join(lib.dir, 'trash', '2026-10-01T00-00-00-000Z-c9-old');   // 前の形のセリフ。中身が直に入っている
  await fs.mkdir(old, {recursive: true}); await fs.writeFile(path.join(old, 'audio.mp3'), 'xxxx');
  const a = await trash.move('motion', {id: 'm2'}), b = await trash.move('shoot', {charId: 'c1', id: 's1'});
  const list = await trash.list();
  assert.equal(list.count, 3);
  const legacy = list.items.find(x => x.kind === 'other');
  assert.equal(legacy.restorable, false); assert.equal(legacy.sizeBytes, 4); assert.equal(legacy.label, '2026-10-01T00-00-00-000Z-c9-old');
  await assert.rejects(trash.restore(legacy.trashId), {code: 'bad-input'});
  await trash.purge(a.trashId);
  assert.equal(await exists(path.join(lib.dir, 'trash', a.trashId)), false);
  await assert.rejects(trash.purge(a.trashId), {code: 'not-found'});
  await assert.rejects(trash.restore(a.trashId), {code: 'not-found'});
  assert.deepEqual(await trash.empty(), {purged: 2});
  assert.equal((await trash.list()).count, 0);
  assert.equal(await exists(path.join(lib.dir, 'characters/c1/versions/v1')), true);   // 空にしても、ごみ箱の外は消えない
  assert.equal(b.kind, 'shoot');
});

test('API: DELETE と impact、GET /api/trash、restore、DELETE /api/trash/<id>、DELETE /api/trash。パス越えは 400 / 404', async () => {
  const s = await startServer({env: FAKE_ENV});
  try {
    const L = new Library(s.libraryDir);
    await L.createCharacter({id: 'c1', name: 'キャラ1'});
    for (const v of ['v1', 'v2']) await L.importVersion({charId: 'c1', id: v, data: fakeGlb({v}), latest: true});
    await L.importMotion({id: 'm1', data: await fs.readFile(SAMPLE_VRMA), license: {holder: 'h', summary: 's'}});

    const imp = await call(s.base, 'GET', '/api/characters/c1/versions/v2/impact');
    assert.equal(imp.status, 200); assert.equal(imp.body.refusal, null); assert.match(imp.body.effects[0].text, /v1/);
    assert.equal((await call(s.base, 'GET', '/api/motions/m1/impact')).status, 200);
    assert.equal((await call(s.base, 'POST', '/api/motions/m1/impact', {})).status, 405);
    assert.equal((await call(s.base, 'GET', '/api/characters/c1/versions/v2')).status, 405);

    const del = await call(s.base, 'DELETE', '/api/characters/c1/versions/v2');
    assert.equal(del.status, 200); assert.equal(del.body.ok, true); assert.match(del.body.trashed, /^trash\/.+-version-c1-v2$/);
    assert.equal((await call(s.base, 'GET', '/api/characters/c1')).body.latestVersion, 'v1');
    const last = await call(s.base, 'DELETE', '/api/characters/c1/versions/v1');
    assert.equal(last.status, 409); assert.equal(last.body.code, 'last-version'); assert.match(last.body.error, /キャラごと/);
    assert.equal((await call(s.base, 'DELETE', '/api/characters/c1/versions/nope')).status, 404);
    assert.equal((await call(s.base, 'DELETE', '/api/motions/m1')).status, 200);
    assert.deepEqual((await call(s.base, 'GET', '/api/motions')).body, []);

    const list = (await call(s.base, 'GET', '/api/trash')).body;
    assert.equal(list.count, 2); assert.ok(list.totalBytes > 0);
    const ver = list.items.find(x => x.kind === 'version'), mot = list.items.find(x => x.kind === 'motion');
    assert.deepEqual([ver.id, ver.charId, ver.label], ['v2', 'c1', 'キャラ1 v2']);
    const back = await call(s.base, 'POST', `/api/trash/${ver.trashId}/restore`);
    assert.equal(back.status, 200); assert.equal(back.body.item.id, 'v2');
    assert.equal((await call(s.base, 'POST', `/api/trash/${ver.trashId}/restore`)).status, 404);
    assert.equal((await call(s.base, 'GET', `/api/trash/${mot.trashId}/restore`)).status, 405);
    assert.equal((await call(s.base, 'GET', `/api/trash/${mot.trashId}`)).status, 405);
    assert.equal((await call(s.base, 'DELETE', `/api/trash/${mot.trashId}`)).status, 200);
    assert.equal((await call(s.base, 'GET', '/api/trash')).body.count, 0);
    // 戻す先に同じ ID があれば 409
    const again = await call(s.base, 'DELETE', '/api/characters/c1/versions/v1');
    assert.equal(again.status, 200);
    await L.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({v: 'again'})});
    const conflict = await call(s.base, 'POST', `/api/trash/${again.body.item.trashId}/restore`);
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'exists');
    assert.equal((await call(s.base, 'DELETE', '/api/trash')).body.purged, 1);

    // パスを越える指定
    for (const url of ['/api/characters/c1/versions/..%2F..%2Fx', '/api/characters/..%2Fc1', '/api/motions/..%2F..%2Fcharacters%2Fc1', '/api/characters/c1/shoots/..%2Fx', '/api/characters/c1/lines/%2e%2e%2Fx']) {
      const r = await call(s.base, 'DELETE', url); assert.ok([400, 404].includes(r.status), url + ' ' + r.status);
      assert.ok((await call(s.base, 'GET', url + '/impact')).status >= 400, url);
    }
    for (const url of ['/api/trash/..%2F..%2Fcharacters%2Fc1', '/api/trash/..%2Fcharacters', '/api/trash/%2e%2e%5Ccharacters']) {
      for (const [m, u] of [['DELETE', url], ['POST', url + '/restore']]) {
        const r = await call(s.base, m, u); assert.ok([400, 404].includes(r.status), m + ' ' + u + ' ' + r.status);
      }
    }
    assert.equal((await call(s.base, 'GET', '/api/characters/c1')).status, 200);
    assert.equal(await exists(path.join(s.libraryDir, 'characters/c1/character.json')), true);
    // trash/ は配らない
    assert.equal((await fetch(s.base + '/lib/trash/x')).status, 404);
  } finally { await s.close(); }
});

test('API: 実行中のジョブが使うバージョン・キャラは 409 で断る。使っていないバージョンは消せ、ジョブが終われば消せる', async () => {
  const s = await startServer({env: {...FAKE_ENV, CHARASTA_FAKE_CAPTURE: 'hang', CHARASTA_SHOOT_TIMEOUT_MS: '700'}});
  try {
    const L = new Library(s.libraryDir);
    await L.createCharacter({id: 'c1', name: 'キャラ1'});
    for (const v of ['v1', 'v2', 'v3']) await L.importVersion({charId: 'c1', id: v, data: fakeGlb({v})});
    const job = await call(s.base, 'POST', '/api/jobs', {type: 'shoot', charId: 'c1', verId: 'v2', seconds: 1});
    assert.equal(job.status, 201);
    const r = await call(s.base, 'DELETE', '/api/characters/c1/versions/v2');
    assert.equal(r.status, 409); assert.equal(r.body.code, 'busy'); assert.match(r.body.error, new RegExp(job.body.id));
    assert.equal((await call(s.base, 'DELETE', '/api/characters/c1')).status, 409);
    assert.equal((await call(s.base, 'GET', '/api/characters/c1/versions/v2/impact')).body.refusal.code, 'busy');
    assert.equal((await call(s.base, 'DELETE', '/api/characters/c1/versions/v1')).status, 200);   // 使われていないバージョンは消せる
    await s.server.jobs.whenIdle();   // ジョブは時間の上限で failed になって終わる
    assert.equal((await call(s.base, 'GET', '/api/jobs/' + job.body.id)).body.state, 'failed');
    const done = await call(s.base, 'DELETE', '/api/characters/c1/versions/v2');   // 終わったので、残りの v2・v3 のうち v2 を消せる
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual((await call(s.base, 'GET', '/api/characters/c1')).body.versions.map(v => v.id), ['v3']);
  } finally { await s.close(); }
});

test('API: 動画からモーションを作る本物のジョブ(video-motion)が使うバージョンとキャラは、動いている間は断る', async () => {
  const s = await startServer({env: {CHARASTA_FAKE_VRMA_PIPELINE: 'hang', CHARASTA_VIDEO_MOTION_TIMEOUT_MS: '1500'}});
  try {
    const L = new Library(s.libraryDir);
    await L.createCharacter({id: 'c1', name: 'キャラ1'});
    for (const v of ['v1', 'v2', 'v3']) await L.importVersion({charId: 'c1', id: v, data: fakeGlb({v})});
    const job = await call(s.base, 'POST', '/api/jobs', {type: 'video-motion', charId: 'c1', verId: 'v2', url: 'https://example.com/v.mp4', rights: '試し'});
    assert.equal(job.status, 201, JSON.stringify(job.body));
    assert.equal(job.body.input.verId, 'v2');
    for (const url of ['/api/characters/c1/versions/v2', '/api/characters/c1']) {
      const r = await call(s.base, 'DELETE', url); assert.equal(r.status, 409, url); assert.equal(r.body.code, 'busy', url);
    }
    assert.equal((await call(s.base, 'DELETE', '/api/characters/c1/versions/v1')).status, 200);   // 使っていないバージョンは消せる
    await s.server.jobs.whenIdle();
  } finally { await s.close(); }
});

test('API: 途中で止めた動画の読み込みがファイルを開いたままにせず、その撮った動画をごみ箱へ移せる', async () => {
  const s = await startServer({env: FAKE_ENV});
  try {
    const L = new Library(s.libraryDir);
    await L.createCharacter({id: 'c1', name: 'キャラ1'});
    await L.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({v: 1})});
    const dir = path.join(s.libraryDir, 'characters/c1/shoots/s1');
    await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(path.join(dir, 'video.mp4'), Buffer.alloc(32 * 1024 * 1024)); await fs.writeFile(path.join(dir, 'poster.jpg'), 'p');
    await writeJson(path.join(dir, 'shoot.json'), {id: 's1', charId: 'c1', verId: 'v1', aspect: '9:16', createdAt: '2026-10-30T00:00:00Z'});
    const ac = new AbortController(), res = await fetch(s.base + '/lib/characters/c1/shoots/s1/video.mp4', {signal: ac.signal});
    await res.body.getReader().read();   // 先頭だけ読んで、残りを読まずにやめる
    ac.abort();
    const r = await call(s.base, 'DELETE', '/api/characters/c1/shoots/s1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await exists(dir), false);
  } finally { await s.close(); }
});

// ---- 途中の失敗と巻き戻し(rename に失敗を差し込む) ----
const failOn = (...calls) => { let n = 0; return async (from, to) => { n++; if (calls.includes(n)) throw new Error('差し込んだ失敗'); return fs.rename(from, to); }; };
const inTrash = (lib, item, rel) => exists(path.join(lib.dir, 'trash', item, 'files', rel));

test('移す途中で失敗しても、巻き戻せれば元のまま。項目も残さない', async () => {
  const {lib} = await seed();
  const trash = new Trash(lib, null, {rename: failOn(2)});   // 2 か所目(studio/c1)の移動が失敗
  await assert.rejects(trash.move('character', {charId: 'c1'}), /差し込んだ失敗/);
  assert.equal(await exists(path.join(lib.dir, 'characters/c1/character.json')), true);
  assert.equal(await exists(path.join(lib.dir, 'studio/c1/st1/work.json')), true);
  assert.equal((await new Trash(lib).list()).count, 0);
});

test('移す途中の失敗で、巻き戻しも失敗したら、移った分をごみ箱に残して paths に記録する。続きは「戻す」で戻せる', async () => {
  const {lib} = await seed();
  const trash = new Trash(lib, null, {rename: failOn(2, 3)});   // 2 か所目が失敗し、1 か所目を戻す rename も失敗
  await assert.rejects(trash.move('character', {charId: 'c1'}), {code: 'busy', message: /戻せなかった/});
  const list = (await new Trash(lib).list()).items;
  assert.equal(list.length, 1); assert.deepEqual(list[0].paths, ['characters/c1']); assert.equal(list[0].restorable, true);
  assert.equal(await inTrash(lib, list[0].trashId, 'characters/c1/character.json'), true);   // キャラのデータは失われていない
  assert.equal(await exists(path.join(lib.dir, 'studio/c1/st1/work.json')), true);
  await new Trash(lib).restore(list[0].trashId);
  assert.equal((await lib.listCharacters()).length, 1); assert.equal((await new Trash(lib).list()).count, 0);
});

test('記録を先に書く: 移す途中で止まった項目(記録に paths、files/ には一部だけ)も、残っている分だけ戻せる', async () => {
  const {lib} = await seed();
  const trash = new Trash(lib);
  const item = await trash.move('character', {charId: 'c1'});
  // 途中で止まった状態を作る: studio/c1 を元の場所へ戻したまま、記録は 2 か所のまま
  await fs.rename(path.join(lib.dir, 'trash', item.trashId, 'files/studio/c1'), path.join(lib.dir, 'studio/c1'));
  await trash.restore(item.trashId);
  assert.equal((await lib.listCharacters()).length, 1); assert.equal(await exists(path.join(lib.dir, 'studio/c1/st1/work.json')), true);
  assert.equal((await trash.list()).count, 0);
  // 全部元の場所にあるのに項目だけ残っていたときは、項目だけ消える
  const again = await trash.move('motion', {id: 'm2'});
  await fs.rename(path.join(lib.dir, 'trash', again.trashId, 'files/motions/m2'), path.join(lib.dir, 'motions/m2'));
  await trash.restore(again.trashId);
  assert.equal((await trash.list()).count, 0); assert.ok(await lib.motionExists('m2'));
});

test('戻す途中で失敗したら、巻き戻せれば全部ごみ箱のまま。巻き戻しも失敗したら、戻せた分は元の場所に出たまま残りをごみ箱に残し、続きを戻せる', async () => {
  const {lib} = await seed();
  const item = await new Trash(lib).move('character', {charId: 'c1'});
  await assert.rejects(new Trash(lib, null, {rename: failOn(2)}).restore(item.trashId), /差し込んだ失敗/);
  assert.equal(await inTrash(lib, item.trashId, 'characters/c1/character.json'), true);   // 巻き戻せた
  assert.deepEqual((await new Trash(lib).list()).items[0].paths, ['characters/c1', 'studio/c1']);
  await assert.rejects(new Trash(lib, null, {rename: failOn(2, 3)}).restore(item.trashId), {code: 'busy', message: /残りはごみ箱に残してある/});
  assert.equal(await exists(path.join(lib.dir, 'characters/c1/character.json')), true);   // 1 か所目は元の場所へ戻ったまま
  assert.deepEqual((await new Trash(lib).list()).items[0].paths, ['studio/c1']);
  await new Trash(lib).restore(item.trashId);   // 半分戻った状態からの続き
  assert.equal(await exists(path.join(lib.dir, 'studio/c1/st1/work.json')), true); assert.equal((await new Trash(lib).list()).count, 0);
});

// ---- リンクをたどらない ----
test('完全に消す・空にするは、junction と symlink をたどらず、リンクの先(ごみ箱の外)を消さない', async () => {
  const {lib, trash} = await seed();
  const outside = await tempDir('charasta-outside-');
  await fs.writeFile(path.join(outside, 'keep.txt'), 'だいじ'); await fs.mkdir(path.join(outside, 'sub')); await fs.writeFile(path.join(outside, 'sub/keep2.txt'), 'x');
  const a = await trash.move('motion', {id: 'm2'}), b = await trash.move('shoot', {charId: 'c1', id: 's1'});
  // 移したフォルダの中にリンクを置く(junction は管理者でなくても作れる。ほかの OS では symlink になる)
  await fs.symlink(outside, path.join(lib.dir, 'trash', a.trashId, 'files/motions/m2/link-junction'), 'junction');
  await fs.symlink(outside, path.join(lib.dir, 'trash', b.trashId, 'files/characters/c1/shoots/s1/link-dir'), 'dir').catch(() => {});   // symlink は権限が無いと作れない環境がある
  await fs.symlink(path.join(outside, 'keep.txt'), path.join(lib.dir, 'trash', b.trashId, 'files/characters/c1/shoots/s1/link-file'), 'file').catch(() => {});
  assert.ok((await trash.list()).totalBytes > 0);   // 一覧の大きさもリンク先を数えない(数えるとリンク先の中を読みに行く)
  await trash.purge(a.trashId);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'だいじ'); assert.equal(await exists(path.join(outside, 'sub/keep2.txt')), true);
  assert.deepEqual(await trash.empty(), {purged: 1});
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'だいじ'); assert.equal(await exists(path.join(outside, 'sub/keep2.txt')), true);
  assert.equal((await trash.list()).count, 0);
});

test('Node の fs.rm は junction をたどらず、リンクそのものだけを消す', async () => {
  const target = await tempDir('charasta-target-'), holder = await tempDir('charasta-holder-');
  await fs.writeFile(path.join(target, 'a.txt'), 'a');
  await fs.symlink(target, path.join(holder, 'j'), 'junction');
  await fs.rm(holder, {recursive: true, force: true});
  assert.equal(await exists(holder), false); assert.equal(await fs.readFile(path.join(target, 'a.txt'), 'utf8'), 'a');
});

// ---- 記録の改ざん・別のキャラ・使用中 ----
test('paths のバックスラッシュ・別の場所は拒否する。元の場所は kind・charId・id から作る', async () => {
  const {lib, trash} = await seed();
  const item = await trash.move('version', {charId: 'c1', id: 'v1'});
  const rec = path.join(lib.dir, 'trash', item.trashId, 'trash.json'), orig = JSON.parse(await fs.readFile(rec, 'utf8'));
  for (const paths of [['characters\\c1\\versions\\v1'], ['characters/c1/versions/v2'], ['characters/c2/versions/v1'], ['characters/c1/versions/v1/../v2'], ['characters/c1/versions/v1/'], ['motions/m1']]) {
    await writeJson(rec, {...orig, paths});
    await assert.rejects(trash.restore(item.trashId), {code: 'bad-input'}, paths[0]);
  }
  await writeJson(rec, {...orig, id: '..'});
  await assert.rejects(trash.restore(item.trashId), {code: /^(bad-id|outside)$/});
  await writeJson(rec, {...orig, kind: 'nothing'});
  await assert.rejects(trash.restore(item.trashId), {code: 'bad-input'});
  assert.equal(await exists(path.join(lib.dir, 'trash', item.trashId, 'files/characters/c1/versions/v1/model.vrm')), true);
  await writeJson(rec, orig);
  await trash.restore(item.trashId);
  assert.ok(await lib.versionExists('c1', 'v1'));
});

test('消した場所はファイルの中の id ではなく、確かめ済みの ID で決める(character.json の id が違っても別の場所を動かさない)', async () => {
  const {lib, trash} = await seed();
  await lib.createCharacter({id: 'c2', name: 'キャラ2'});
  await lib.importVersion({charId: 'c2', id: 'w1', data: fakeGlb({w: 1})});
  const file = path.join(lib.dir, 'characters/c2/character.json'), ch = JSON.parse(await fs.readFile(file, 'utf8'));
  await writeJson(file, {...ch, id: 'c1'});   // 壊れた記録: id が別のキャラを指している
  const item = await trash.move('character', {charId: 'c2'});
  assert.equal(item.id, 'c2'); assert.deepEqual(item.paths, ['characters/c2']);
  assert.equal(await exists(path.join(lib.dir, 'characters/c1/character.json')), true);   // c1 は動かない
  assert.equal(await exists(path.join(lib.dir, 'characters/c2')), false);
});

test('同じ ID で作り直した別のキャラへは、バージョン・セリフ・撮った動画を戻せない', async () => {
  const {lib, trash} = await seed();
  const v = await trash.move('version', {charId: 'c1', id: 'v1'}), l = await trash.move('line', {charId: 'c1', id: 'a'}), s = await trash.move('shoot', {charId: 'c1', id: 's1'});
  assert.ok(v.meta.charCreatedAt);
  await trash.move('character', {charId: 'c1'});
  await new Promise(r => setTimeout(r, 5));   // createdAt が変わるように
  await lib.createCharacter({id: 'c1', name: '別人'});
  for (const item of [v, l, s]) await assert.rejects(trash.restore(item.trashId), {code: 'exists', message: /別のもの/}, item.kind);
  assert.deepEqual((await lib.getCharacter('c1')).versions, []);
  assert.equal((await trash.list()).count, 4);
});

test('戻すバージョンの order が今の最新より大きければ、最新に戻す(v3、v2 の順に消して、同じ順に戻しても v3 になる)', async () => {
  const {lib, trash} = await seed();
  const v3 = await trash.move('version', {charId: 'c1', id: 'v3'}), v2 = await trash.move('version', {charId: 'c1', id: 'v2'});
  assert.equal((await lib.getCharacterJson('c1')).latestVersion, 'v1');
  await trash.restore(v3.trashId); assert.equal((await lib.getCharacterJson('c1')).latestVersion, 'v3');
  await trash.restore(v2.trashId); assert.equal((await lib.getCharacterJson('c1')).latestVersion, 'v3');   // v2 は v3 より古いので最新は動かない
  // 最新でなかったバージョンは、order が大きくても最新にしない
  const old = await trash.move('version', {charId: 'c1', id: 'v1'});
  await lib.updateCharacter('c1', {latestVersion: 'v2'});
  await trash.restore(old.trashId);
  assert.equal((await lib.getCharacterJson('c1')).latestVersion, 'v2');
});

test('表情づくりの工程が動いている(ジョブでない材料のコピーや CLI の実行も)キャラは消せない', async () => {
  const {lib, trash} = await seed();
  const work = path.join(lib.dir, 'studio/c1/st1/work.json'), w = JSON.parse(await fs.readFile(work, 'utf8'));
  await writeJson(work, {...w, steps: {copy: {state: 'running', pid: process.pid}}});   // 生きているプロセスの材料のコピー
  const i = await trash.impact('character', {charId: 'c1'});
  assert.equal(i.refusal.code, 'busy'); assert.match(i.refusal.message, /表情づくり st1\(copy\)/);
  await assert.rejects(trash.move('character', {charId: 'c1'}), {code: 'busy'});
  await writeJson(work, {...w, steps: {copy: {state: 'running', pid: 2 ** 30}}});   // 止まったプロセスの跡は使用中にしない
  assert.equal((await trash.impact('character', {charId: 'c1'})).refusal, null);
  await writeJson(work, {...w, steps: {build: {state: 'queued'}}});
  assert.equal((await trash.impact('character', {charId: 'c1'})).refusal.code, 'busy');
  await writeJson(work, {...w, steps: {build: {state: 'done'}}});
  assert.ok(await trash.move('character', {charId: 'c1'}));
});

test('API: 他サイトの Origin からの DELETE(/api/trash、キャラ、バージョン)は 403 で、何も消えない', async () => {
  const s = await startServer({env: FAKE_ENV});
  try {
    const L = new Library(s.libraryDir);
    await L.createCharacter({id: 'c1', name: 'キャラ1'});
    for (const v of ['v1', 'v2']) await L.importVersion({charId: 'c1', id: v, data: fakeGlb({v})});
    const del = await call(s.base, 'DELETE', '/api/characters/c1/versions/v2');
    const evil = (method, url) => fetch(s.base + url, {method, headers: {Origin: 'http://evil.example'}}).then(r => r.status);
    assert.equal(await evil('DELETE', '/api/trash'), 403);
    assert.equal(await evil('DELETE', '/api/trash/' + del.body.item.trashId), 403);
    assert.equal(await evil('POST', `/api/trash/${del.body.item.trashId}/restore`), 403);
    assert.equal(await evil('DELETE', '/api/characters/c1'), 403);
    assert.equal(await evil('DELETE', '/api/characters/c1/versions/v1'), 403);
    assert.equal((await call(s.base, 'GET', '/api/trash')).body.count, 1);
    assert.equal((await call(s.base, 'GET', '/api/characters/c1')).status, 200);
  } finally { await s.close(); }
});

test('API: セリフの音声や動画を途中で止めた読み込みが残っていても、そのセリフをごみ箱へ移せる', async () => {
  const s = await startServer({env: FAKE_ENV});
  try {
    const L = new Library(s.libraryDir);
    await L.createCharacter({id: 'c1', name: 'キャラ1'});
    await L.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({v: 1})});
    await L.importLine({charId: 'c1', id: 'a', text: 'あ', data: Buffer.alloc(8 * 1024 * 1024), ext: '.mp3'});
    await fs.mkdir(path.join(s.libraryDir, 'characters/c1/lines/a/videos'));
    await fs.writeFile(path.join(s.libraryDir, 'characters/c1/lines/a/videos/v1-face.mp4'), Buffer.alloc(32 * 1024 * 1024));
    for (const url of ['/lib/characters/c1/lines/a/audio.mp3', '/lib/characters/c1/lines/a/videos/v1-face.mp4']) {
      const ac = new AbortController(), res = await fetch(s.base + url, {signal: ac.signal});
      await res.body.getReader().read(); ac.abort();
    }
    const r = await call(s.base, 'DELETE', '/api/characters/c1/lines/a');
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally { await s.close(); }
});

test('生き物を参照するショートのジョブ(take.creature / cast)が動いているあいだは、キャラもバージョンも断る。影響の一覧にショートの件数が出る', async () => {
  const {lib, trash, active} = await seed();
  await lib.createCharacter({id: 'crow', name: 'カラス', style: 'creature'});
  const blend = path.join(lib.dir, 'crow.blend');
  await fs.writeFile(blend, Buffer.concat([Buffer.from('BLENDER-v500'), Buffer.alloc(64, 7)]));
  const spec = {scale: 1, yaw: 0, fps: 24, rest: ['a', 1, 1]};
  await lib.importCreatureVersion({charId: 'crow', id: 'v1', blendFile: blend, spec, latest: true});
  await lib.importCreatureVersion({charId: 'crow', id: 'v2', blendFile: blend, spec});
  await lib.saveShort('s1', {title: 'カラス', style: 'trivia', charId: 'c1', take: {motions: [], mark: [0, 0, 0], creature: {charId: 'crow', verId: 'v2', perch: 0, path: []}}});
  const ci = await trash.impact('character', {charId: 'crow'});
  assert.equal(ci.effects.find(e => e.key === 'shorts').count, 1);
  assert.equal((await trash.impact('version', {charId: 'crow', id: 'v2'})).effects.find(e => e.key === 'shorts').count, 1);
  assert.equal((await trash.impact('version', {charId: 'crow', id: 'v1'})).effects.find(e => e.key === 'shorts'), undefined);
  const job = {id: 'j9', state: 'running', input: {shortId: 's1', short: {take: {creature: {charId: 'crow', verId: 'v2'}}}}};
  active.splice(0, active.length, job);
  for (const [kind, ref] of [['character', {charId: 'crow'}], ['version', {charId: 'crow', id: 'v2'}]]) {
    assert.equal((await trash.impact(kind, ref)).refusal.code, 'busy', kind);
    await assert.rejects(trash.move(kind, ref), {code: 'busy'}, kind);
  }
  assert.equal((await trash.impact('version', {charId: 'crow', id: 'v1'})).refusal, null);
  active.splice(0, active.length, {id: 'j10', state: 'queued', input: {short: {cast: [{charId: 'c1'}]}}});
  assert.equal((await trash.impact('character', {charId: 'c1'})).refusal.code, 'busy');
});
