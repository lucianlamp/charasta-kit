// バージョンの検査(lib/chibi-check.mjs、lib/version-check.mjs、GET /api/characters/<キャラ>/versions/<バージョン>/check): チビの項目、スタイルごとの分岐、キャッシュの無効化
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chibiCheck, imageSize, measureGlb, summaryOf} from '../lib/chibi-check.mjs';
import {versionCheck, CHECK_FILE} from '../lib/version-check.mjs';
import {Library} from '../lib/library.mjs';
import {startServer, tempDir} from './helpers.mjs';

const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
// JPEG: SOI、長さのある APP1(EXIF 相当の詰め物)、SOF0
const jpeg = (w, h) => { const app = Buffer.alloc(2 + 2 + 300); app.writeUInt16BE(0xffe1, 0); app.writeUInt16BE(302, 2); const sof = Buffer.alloc(19); sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); return Buffer.concat([Buffer.from([0xff, 0xd8]), app, sof]); };

// 画像の本体の先頭だけ(IHDR など)を持つ glb。images: [{name, data}]。extra は JSON に足す
function glb({images = [], tris = 3000, materials = 2, extra = {}} = {}) {
  let bin = Buffer.alloc(0); const bufferViews = [];
  for (const im of images) { bufferViews.push({buffer: 0, byteOffset: bin.length, byteLength: im.data.length}); bin = Buffer.concat([bin, im.data, Buffer.alloc((4 - im.data.length % 4) % 4)]); }
  const js = {asset: {version: '2.0'}, accessors: [{count: tris * 3}], bufferViews, buffers: [{byteLength: bin.length}],
    images: images.map((im, i) => ({name: im.name, mimeType: 'image/png', bufferView: i})),
    materials: Array.from({length: materials}, (_, i) => ({name: 'M' + i})),
    nodes: [{name: 'Face', mesh: 0}], meshes: [{name: 'Face', primitives: [{attributes: {POSITION: 0}, indices: 0, material: 0}]}], ...extra};
  const j = Buffer.from(JSON.stringify(js)), jp = Buffer.concat([j, Buffer.alloc((4 - j.length % 4) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jp.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(jp.length, 0x4e4f534a), jp, ch(bin.length, 0x004e4942), bin]);
}
const faceAtlasImages = (side = 4096) => [{name: 'FaceAtlas_main', data: png(side, side)}, {name: 'body', data: png(2048, 2048)}];

async function measure(buf) {
  const dir = await tempDir('chibi-m-'), f = path.join(dir, 'm.vrm');
  await fs.writeFile(f, buf);
  try { return await measureGlb(f); } finally { await fs.rm(dir, {recursive: true, force: true}); }
}
const level = (items, id) => items.find(i => i.id === id).level;

test('画像の大きさ: PNG と JPEG(EXIF の後ろの SOF)を先頭から読む。読めなければ null', () => {
  assert.deepEqual(imageSize(png(4096, 2048)), [4096, 2048]);
  assert.deepEqual(imageSize(jpeg(1024, 512)), [1024, 512]);
  assert.equal(imageSize(Buffer.from('RIFFxxxxWEBP')), null);
  assert.equal(imageSize(Buffer.alloc(3)), null);
});

test('チビの検査: 軽量版があり、三角形が目安以内で、画像が上限以内で、顔テクスチャなら全部 ok(材質の数は目安が無いので unknown)', async () => {
  const model = await measure(glb({images: [{name: 'FaceAtlas_main', data: png(8192, 4096)}, {name: 'body', data: png(4096, 4096)}], tris: 16000, materials: 5, extra: {nodes: [{name: 'Face_layers'}, {name: 'Face', mesh: 0}]}}));
  const lite = await measure(glb({images: faceAtlasImages(4096), tris: 16000, materials: 5, extra: {nodes: [{name: 'Face_layers'}, {name: 'Face', mesh: 0}]}}));
  const items = chibiCheck(model, lite);
  assert.deepEqual(items.map(i => i.id), ['lite', 'triangles', 'materials', 'textures', 'expression']);
  assert.deepEqual(items.map(i => i.level), ['ok', 'ok', 'unknown', 'ok', 'ok']);
  assert.match(items.find(i => i.id === 'materials').detail, /^5 個/);
  assert.match(items.find(i => i.id === 'triangles').detail, /^16000$/);
  const tex = items.find(i => i.id === 'textures').detail;   // 軽量版との差が読める
  assert.match(tex, /model\.vrm は 2 枚、最大 8192 px/);
  assert.match(tex, /model-lite\.vrm は 2 枚、最大 4096 px/);
  assert.deepEqual(summaryOf(items), {ok: 4, warn: 0, ng: 0, unknown: 1, total: 5});
});

test('チビの検査: 軽量版が無ければ warn で作り方を出し、画像は model.vrm を上限と比べる', async () => {
  const model = await measure(glb({images: [{name: 'body', data: png(4096, 4096)}], tris: 9000}));
  const items = chibiCheck(model, null);
  assert.equal(level(items, 'lite'), 'warn');
  assert.match(items.find(i => i.id === 'lite').detail, /tools\/make_lite\.py/);
  assert.equal(level(items, 'textures'), 'warn');
  assert.match(items.find(i => i.id === 'textures').detail, /body 4096×4096/);
});

test('チビの検査: 軽量版の画像の上限は元の大きさで決まる(元が 4096 以下なら 2048、4096 超なら 4096)', async () => {
  const model = await measure(glb({images: [{name: 'a', data: png(4096, 4096)}, {name: 'b', data: png(6000, 3000)}]}));
  const ok = await measure(glb({images: [{name: 'a', data: png(2048, 2048)}, {name: 'b', data: png(4096, 2048)}]}));
  const bad = await measure(glb({images: [{name: 'a', data: png(4096, 4096)}, {name: 'b', data: png(4096, 2048)}]}));
  assert.equal(level(chibiCheck(model, ok), 'textures'), 'ok');
  assert.equal(level(chibiCheck(model, bad), 'textures'), 'warn');
  assert.equal(level(chibiCheck(model, await measure(glb({images: [{name: 'a', data: png(2048, 2048)}]}))), 'textures'), 'unknown');   // 画像の数が違う
});

test('チビの検査: 三角形が 1.8 万を超えると warn。顔の手がかりが無ければ unknown、Fcl_ のキーなら warn', async () => {
  const items = chibiCheck(await measure(glb({images: [{name: 'a', data: png(512, 512)}], tris: 18001})), null);
  assert.equal(level(items, 'triangles'), 'warn');
  assert.equal(level(items, 'expression'), 'unknown');
  assert.equal(chibiCheck(await measure(glb({images: [{name: 'a', data: png(512, 512)}], tris: 18000})), null).find(i => i.id === 'triangles').level, 'ok');
  const keyed = chibiCheck(await measure(glb({images: [{name: 'a', data: png(512, 512)}], extra: {meshes: [{name: 'Face', primitives: [{attributes: {POSITION: 0}, indices: 0}], extras: {targetNames: ['Fcl_ALL_Joy']}}]}})), null);
  assert.equal(level(keyed, 'expression'), 'warn');
  assert.match(keyed.find(i => i.id === 'expression').detail, /チビは顔テクスチャ/);
  const kitKeyed = chibiCheck(await measure(glb({images: [{name: 'a', data: png(512, 512)}], extra: {meshes: [{name: 'Face', primitives: [{attributes: {POSITION: 0}, indices: 0}], extras: {targetNames: ['Fcl_ALL_Joy']}}]}})), null, {chibi: 'チビ体型'});
  assert.match(kitKeyed.find(i => i.id === 'expression').detail, /チビ体型は顔テクスチャ/, 'キットはスタイルの名前を版の種類の名前にする');
});

test('チビの検査: 画像の大きさを読めないときは textures を unknown にする', async () => {
  const items = chibiCheck(await measure(glb({images: [{name: 'a', data: Buffer.from('RIFFxxxxWEBPVP8 ')}]})), null);
  assert.equal(level(items, 'textures'), 'unknown');
});

// ---- API とキャッシュ ----
async function setup() {
  const s = await startServer(), lib = new Library(s.libraryDir);
  await lib.createCharacter({id: 'cb', name: 'チビ', style: 'chibi'});
  await lib.createCharacter({id: 'st', name: 'スタンダード', style: 'standard'});
  await lib.createCharacter({id: 'un', name: '未設定'});
  await lib.createCharacter({id: 'cr', name: '生き物', style: 'creature'});
  const vrm = glb({images: faceAtlasImages(2048), tris: 5000, extra: {nodes: [{name: 'Face_layers'}, {name: 'Face', mesh: 0}]}});
  for (const c of ['cb', 'st', 'un']) await lib.importVersion({charId: c, id: 'v1', data: vrm, latest: true});
  const dir = path.join(s.libraryDir, 'characters', 'cr', 'versions', 'v1');
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, 'version.json'), JSON.stringify({id: 'v1', charId: 'cr', kind: 'creature', order: 1}));
  const get = async p => { const r = await fetch(s.base + p); return {status: r.status, body: await r.json()}; };
  return {...s, lib, vrm, get, dirOf: c => lib.versionDir(c, 'v1')};
}

test('API: スタイルごとに検査が分かれる(チビはチビの検査、スタンダードは VRoid 形式、生き物と未設定は検査なし)', async () => {
  const t = await setup();
  try {
    const cb = await t.get('/api/characters/cb/versions/v1/check');
    assert.equal(cb.status, 200);
    assert.equal(cb.body.style, 'chibi'); assert.equal(cb.body.applicable, true); assert.equal(cb.body.cached, false);
    assert.deepEqual(cb.body.items.map(i => i.id), ['lite', 'triangles', 'materials', 'textures', 'expression']);
    assert.equal(cb.body.items.find(i => i.id === 'expression').level, 'ok');
    assert.equal(cb.body.summary.total, 5);
    const st = await t.get('/api/characters/st/versions/v1/check');
    assert.equal(st.body.style, 'standard'); assert.equal(st.body.applicable, true);
    assert.ok(st.body.items.some(i => i.id === 'fcl-keys') && st.body.items.some(i => i.id === 'triangles'));   // checkVroid の項目
    assert.ok(st.body.items.every(i => ['ok', 'warn', 'ng'].includes(i.level)));
    assert.equal(st.body.summary.total, st.body.items.length);
    const cr = await t.get('/api/characters/cr/versions/v1/check');
    assert.equal(cr.status, 200); assert.equal(cr.body.applicable, false); assert.equal(cr.body.style, 'creature'); assert.match(cr.body.reason, /生き物/); assert.deepEqual(cr.body.items, []);
    const un = await t.get('/api/characters/un/versions/v1/check');
    assert.equal(un.body.applicable, false); assert.equal(un.body.style, null); assert.match(un.body.reason, /未設定/);
    assert.equal((await t.get('/api/characters/cb/versions/nope/check')).status, 404);
    assert.equal((await t.get('/api/characters/nope/versions/v1/check')).status, 404);
    assert.equal((await fetch(t.base + '/api/characters/cb/versions/v1/check', {method: 'POST'})).status >= 400, true);
  } finally { await t.close(); }
});

test('スタンダード: 手本が保管場所に無ければ、その旨を返して項目は空', async () => {
  const t = await setup();
  try {
    const r = await versionCheck(t.lib, 'st', 'v1', {referenceFile: path.join(t.libraryDir, 'no-such-reference.json')});
    assert.equal(r.applicable, true); assert.match(r.unavailable, /手本が保管場所に無い/); assert.deepEqual(r.items, []);
  } finally { await t.close(); }
});

test('キャッシュ: 同じファイルなら読み直さず、model.vrm か model-lite.vrm が変わると捨てる', async () => {
  const t = await setup();
  try {
    const dir = t.dirOf('cb'), p = '/api/characters/cb/versions/v1/check';
    const first = (await t.get(p)).body;
    assert.equal(first.cached, false);
    assert.ok((await fs.stat(path.join(dir, CHECK_FILE))).isFile());
    const again = (await t.get(p)).body;
    assert.equal(again.cached, true); assert.equal(again.checkedAt, first.checkedAt); assert.deepEqual(again.items, first.items);
    // 軽量版を足す: lite の項目が ok になる
    await fs.writeFile(path.join(dir, 'model-lite.vrm'), glb({images: faceAtlasImages(2048), tris: 5000}));
    const withLite = (await t.get(p)).body;
    assert.equal(withLite.cached, false); assert.equal(withLite.items.find(i => i.id === 'lite').level, 'ok');
    assert.equal((await t.get(p)).body.cached, true);
    // model.vrm を置き換える(大きさが変わる): 三角形が 5000 から 20000 になり warn
    await fs.writeFile(path.join(dir, 'model.vrm'), glb({images: faceAtlasImages(2048), tris: 20000, extra: {nodes: [{name: 'Face_layers'}, {name: 'Face', mesh: 0}]}}));
    const changed = (await t.get(p)).body;
    assert.equal(changed.cached, false); assert.equal(changed.items.find(i => i.id === 'triangles').level, 'warn');
    // 大きさが同じでも更新時刻が変われば捨てる
    const f = path.join(dir, 'model.vrm'), st = await fs.stat(f);
    await fs.utimes(f, st.atime, new Date(st.mtimeMs + 5000));
    assert.equal((await t.get(p)).body.cached, false);
  } finally { await t.close(); }
});
