// 段階 3b: 依頼・候補・採用(lib/studio.mjs、/api/studio/…/requests、CLI の requests と candidate)と、目の中の範囲(hole_mask.py)。
// Blender・Python のスクリプト・ブラウザは呼ばない(CHARASTA_FAKE_BLENDER、CHARASTA_FAKE_CAPTURE)。hole_mask.py の試しだけ python を呼ぶ。
import test from 'node:test';
import {findPython} from '../lib/platform.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Library} from '../lib/library.mjs';
import {Studio, checkOptions} from '../lib/studio.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {tempDir, fakeCharakuru, startServer, crc32, STUDIO_ENV} from './helpers.mjs';

const exec = promisify(execFile);
// ジョブと同じく Python の出力は UTF-8(sys.exit の日本語の文を読むため)
const py = args => exec(findPython() ?? 'python', args, {env: {...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'}});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

// 小さな PNG(RGBA)。pixel(x, y) -> [r, g, b, a]
function png(w, hgt, pixel = () => [200, 150, 120, 255]) {
  const raw = Buffer.alloc((w * 4 + 1) * hgt);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function setup() {
  const lib = new Library(await tempDir()), app = await fakeCharakuru();
  await lib.createCharacter({id: 'c1', name: 'C1'});
  const studio = new Studio(lib, {charakuruApp: app, env: STUDIO_ENV});
  const q = new JobQueue({lib, studio, env: STUDIO_ENV, tools: {kit: app, patchVrm: 'x', springTune: 'x'}});
  await studio.create({charId: 'c1', id: 's1'});
  return {lib, studio, q, dir: studio.dir('c1', 's1')};
}

test('依頼: 形の検査、番号、未着手で残る', async () => {
  const {studio} = await setup();
  for (const bad of [{step: 'mouth', target: 'drawn/a.png', text: 'x'}, {step: 'face', target: 'face/a.png', text: 'x'}, {step: 'face', target: 'drawn/../a.png', text: 'x'},
    {step: 'face', target: 'drawn/a.jpg', text: 'x'}, {step: 'face', target: 'DRAWN/a.png', text: 'x'}, {step: 'face', target: 'drawn/a.PNG', text: 'x'}, null, {step: 'face', target: 'drawn\\a.png', text: 'x'}, {step: 'face', target: 'drawn/a.png', text: '  '}, {step: 'face', target: 'drawn/a.png', text: 'x'.repeat(2001)}])
    await assert.rejects(studio.createRequest('c1', 's1', bad), {code: 'bad-input'}, JSON.stringify(bad).slice(0, 80));
  const r1 = await studio.createRequest('c1', 's1', {step: 'face', target: 'drawn/neutral.png', text: ' ふだんの口を微笑みに '});
  const r2 = await studio.createRequest('c1', 's1', {step: 'expr', target: 'drawn/expr/happy.png', text: 'happy を描く'});
  assert.deepEqual([r1.id, r1.state, r1.text, r1.candidates], ['r001', '未着手', 'ふだんの口を微笑みに', []]);
  assert.equal(r2.id, 'r002');
  assert.deepEqual((await studio.read('c1', 's1')).requests.map(r => [r.id, r.step, r.target]), [['r001', 'face', 'drawn/neutral.png'], ['r002', 'expr', 'drawn/expr/happy.png']]);
  await assert.rejects(studio.createRequest('c1', 'nope', {step: 'face', target: 'drawn/a.png', text: 'x'}), {code: 'not-found'});
});

test('候補と却下: PNG だけ置ける。全部却下すると未着手に戻り、理由が残る。取り下げたら候補を足せない', async () => {
  const {studio, dir} = await setup();
  await studio.createRequest('c1', 's1', {step: 'face', target: 'drawn/neutral.png', text: '口'});
  await assert.rejects(studio.addCandidate('c1', 's1', 'r001', {data: Buffer.from('not a png')}), {code: 'bad-input'});
  await assert.rejects(studio.addCandidate('c1', 's1', 'r009', {data: png(2, 2)}), {code: 'not-found'});
  const a = png(4, 4), b = png(4, 4, () => [10, 20, 30, 255]);
  const c1 = await studio.addCandidate('c1', 's1', 'r001', {data: a, note: '口角を上げた'});
  const c2 = await studio.addCandidate('c1', 's1', 'r001', {data: b});
  assert.deepEqual([c1.n, c1.file, c1.state, c1.note, c1.sha256], [1, 'candidates/r001/c01.png', '候補', '口角を上げた', sha(a)]);
  assert.equal(c2.file, 'candidates/r001/c02.png');
  assert.deepEqual(await fs.readFile(path.join(dir, c1.file)), a);
  let w = await studio.read('c1', 's1');
  assert.equal(w.requests[0].state, '候補あり');
  await studio.rejectCandidate('c1', 's1', 'r001', 1, {reason: '笑いすぎ'});
  w = await studio.read('c1', 's1');
  assert.equal(w.requests[0].state, '候補あり');   // 候補 2 がまだ決まっていない
  await assert.rejects(studio.rejectCandidate('c1', 's1', 'r001', 1, {}), {code: 'bad-input'});   // もう決まっている
  await studio.rejectCandidate('c1', 's1', 'r001', 2);
  w = await studio.read('c1', 's1');
  assert.equal(w.requests[0].state, '未着手');
  assert.deepEqual(w.requests[0].candidates.map(c => [c.state, c.reason]), [['却下', '笑いすぎ'], ['却下', '']]);
  assert.deepEqual(w.adopted, []);   // 却下では何も替わらない
  await assert.rejects(studio.adoptCandidate('c1', 's1', 'r001', 1), {code: 'bad-input'});
  // 次の候補は番号が続く
  assert.equal((await studio.addCandidate('c1', 's1', 'r001', {data: a})).n, 3);
  await studio.withdrawRequest('c1', 's1', 'r001');
  await assert.rejects(studio.addCandidate('c1', 's1', 'r001', {data: a}), {code: 'bad-input'});
  await assert.rejects(studio.adoptCandidate('c1', 's1', 'r001', 3), {code: 'bad-input'});
});

test('採用: 候補が drawn/ の絵になり、前の絵は trash/ へ。依頼と候補を記録し、その絵を使う組み立ては「古い」になる。ジョブ中は 409', async () => {
  const {studio, q, dir} = await setup();
  await studio.copyInputs('c1', 's1', {project: 'p1'});
  const draw = await tempDir('charasta-draw-'), old = png(4, 4, () => [1, 2, 3, 255]);
  await fs.writeFile(path.join(draw, 'neutral.png'), old);
  await studio.adopt('c1', 's1', {from: path.join(draw, 'neutral.png')});
  await studio.setOptions('c1', 's1', {build: {atlas: {cells: {neutral: 'drawn/neutral.png'}, env: {}}}});
  const run = async type => { const j = await q.enqueue({type, charId: 'c1', studioId: 's1'}); await q.whenIdle(); const r = await q.get(j.id); assert.equal(r.state, 'done', r.error); };
  await run('studio-front');
  await studio.setRects('c1', 's1', {upper: [100, 100, 900, 600]});
  await run('studio-build');
  assert.equal((await studio.status('c1', 's1')).steps.build.stale, false);

  await studio.createRequest('c1', 's1', {step: 'face', target: 'drawn/neutral.png', text: 'ふだんの口を描き直す'});
  const cand = png(4, 4, () => [9, 9, 9, 255]);
  await studio.addCandidate('c1', 's1', 'r001', {data: cand});
  await studio.addCandidate('c1', 's1', 'r001', {data: png(4, 4)});
  // ジョブが順番待ちか実行中なら採用しない
  await studio.update('c1', 's1', w => { w.steps.video = {state: 'queued', jobId: 'jx'}; });
  await assert.rejects(studio.adoptCandidate('c1', 's1', 'r001', 1), {code: 'exists'});
  await studio.update('c1', 's1', w => { delete w.steps.video; });
  // 置いたあとに候補のファイルが変わっていたら採用しない
  await fs.writeFile(path.join(dir, 'candidates/r001/c02.png'), 'x');
  await assert.rejects(studio.adoptCandidate('c1', 's1', 'r001', 2), /置いたときと違う/);

  await studio.adoptCandidate('c1', 's1', 'r001', 1);
  assert.deepEqual(await fs.readFile(path.join(dir, 'drawn/neutral.png')), cand);
  const trashed = (await fs.readdir(path.join(dir, 'trash'))).filter(f => f.endsWith('drawn_neutral.png'));
  assert.equal(trashed.length, 1); assert.deepEqual(await fs.readFile(path.join(dir, 'trash', trashed[0])), old);
  const st = await studio.status('c1', 's1');
  const a = st.adopted.find(x => x.path === 'drawn/neutral.png');
  assert.deepEqual([a.request, a.candidate, a.sha256, a.from], ['r001', 1, sha(cand), 'candidates/r001/c01.png']);
  assert.equal(st.requests[0].state, '採用済み'); assert.equal(st.requests[0].adopted, 1);
  assert.deepEqual(st.requests[0].candidates.map(c => c.state), ['採用', '候補']);
  assert.equal(st.requests[0].candidates[0].url, '/lib/studio/c1/s1/candidates/r001/c01.png');
  assert.equal(st.requests[0].targetUrl, '/lib/studio/c1/s1/drawn/neutral.png');
  assert.equal(st.steps.build.stale, true);
  await assert.rejects(studio.adoptCandidate('c1', 's1', 'r001', 2), {code: 'bad-input'});   // 依頼はもう閉じた
  await assert.rejects(studio.withdrawRequest('c1', 's1', 'r001'), {code: 'bad-input'});
  await run('studio-build');
  assert.equal((await studio.status('c1', 's1')).steps.build.stale, false);
});

test('API と CLI: 画面から依頼 -> CLI で未着手を読む -> CLI で候補を置く(サーバーを通す) -> 画面で却下・採用 -> 組み立て直してバージョンにする', async () => {
  const app = await fakeCharakuru();
  const s = await startServer({env: STUDIO_ENV, charakuruApp: app});
  const call = async (method, url, body) => {
    const r = await fetch(s.base + url, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, body: await r.json().catch(() => null)};
  };
  const cfg = path.join(await tempDir('charasta-cfg-'), 'config.json');
  await fs.writeFile(cfg, JSON.stringify({libraryDir: s.libraryDir, port: Number(new URL(s.base).port), charakuruApp: app}));
  const cli = (...args) => exec(process.execPath, [path.join(root, 'scripts', 'studio.mjs'), ...args], {env: {...process.env, CHARASTA_CONFIG: cfg}}).then(r => JSON.parse(r.stdout));
  try {
    await new Library(s.libraryDir).createCharacter({id: 'c1', name: 'C1'});
    await call('POST', '/api/studio/c1', {id: 's1'});
    await call('POST', '/api/studio/c1/s1/copy', {project: 'p1'});
    const draw = await tempDir('charasta-draw-'); await fs.writeFile(path.join(draw, 'neutral.png'), png(4, 4));
    const studio = new Studio(new Library(s.libraryDir), {env: STUDIO_ENV});
    await studio.adopt('c1', 's1', {from: path.join(draw, 'neutral.png')});
    await call('PATCH', '/api/studio/c1/s1/options', {build: {atlas: {cells: {neutral: 'drawn/neutral.png'}}}});

    assert.equal((await call('POST', '/api/studio/c1/s1/requests', {step: 'face', target: 'drawn/x.txt', text: 'x'})).status, 400);
    let r = await call('POST', '/api/studio/c1/s1/requests', {step: 'face', target: 'drawn/neutral.png', text: 'ふだんの口を描き直す'});
    assert.equal(r.status, 200); assert.equal(r.body.requests[0].state, '未着手');
    let list = await cli('requests');
    assert.deepEqual(list.map(x => [x.charId, x.studioId, x.id, x.target, x.text]), [['c1', 's1', 'r001', 'drawn/neutral.png', 'ふだんの口を描き直す']]);
    assert.equal(list[0].targetFile, path.join(s.libraryDir, 'studio', 'c1', 's1', 'drawn', 'neutral.png'));
    assert.deepEqual(await cli('requests', '--char', 'c1', '--id', 'other'), []);

    const f1 = path.join(draw, 'cand1.png'), f2 = path.join(draw, 'cand2.png');
    await fs.writeFile(f1, png(4, 4, () => [50, 50, 50, 255])); await fs.writeFile(f2, png(4, 4, () => [60, 60, 60, 255]));
    const port = new URL(s.base).port;
    const c = await cli('candidate', '--char', 'c1', '--id', 's1', '--request', 'r001', '--file', f1, '--note', '口角を少し上げた', '--port', port);
    assert.deepEqual([c.n, c.note, c.from], [1, '口角を少し上げた', f1]);
    assert.deepEqual(await cli('requests'), []);   // 候補ありになったので未着手ではない
    await assert.rejects(cli('candidate', '--char', 'c1', '--id', 's1', '--request', 'r001', '--file', path.join(draw, 'neutral.png').replace('.png', '.txt'), '--port', port));
    assert.equal((await fetch(s.base + '/lib/studio/c1/s1/candidates/r001/c01.png')).status, 200);
    assert.equal((await fetch(s.base + '/api/studio/c1/s1/requests/r001/candidates', {method: 'POST', body: 'nope'})).status, 400);

    // 却下(理由つき) -> 未着手に戻り、CLI で理由が読める
    r = await call('POST', '/api/studio/c1/s1/requests/r001/candidates/1/reject', {reason: '口が大きすぎる'});
    assert.equal(r.status, 200); assert.equal(r.body.requests[0].state, '未着手');
    list = await cli('requests');
    assert.deepEqual(list[0].candidates.map(x => [x.n, x.state, x.reason]), [[1, '却下', '口が大きすぎる']]);
    assert.equal(list[0].candidates[0].path, path.join(s.libraryDir, 'studio', 'c1', 's1', 'candidates', 'r001', 'c01.png'));

    // 組み立てて試作 1 -> 次の候補を採用 -> 組み立てが古い -> 組み立て直して試作 2 -> バージョンにする
    await call('POST', '/api/jobs', {type: 'studio-front', charId: 'c1', studioId: 's1'}); await s.server.jobs.whenIdle();
    await call('PUT', '/api/studio/c1/s1/rects', {upper: [100, 100, 900, 600]});
    await call('POST', '/api/jobs', {type: 'studio-build', charId: 'c1', studioId: 's1'}); await s.server.jobs.whenIdle();
    await cli('candidate', '--char', 'c1', '--id', 's1', '--request', 'r001', '--file', f2, '--port', port);
    assert.equal((await call('POST', '/api/studio/c1/s1/requests/r001/candidates/9/adopt')).status, 404);
    r = await call('POST', '/api/studio/c1/s1/requests/r001/candidates/2/adopt');
    assert.equal(r.status, 200); assert.equal(r.body.steps.build.stale, true); assert.equal(r.body.requests[0].state, '採用済み');
    assert.deepEqual(await fs.readFile(path.join(s.libraryDir, 'studio/c1/s1/drawn/neutral.png')), await fs.readFile(f2));
    await call('POST', '/api/jobs', {type: 'studio-build', charId: 'c1', studioId: 's1'}); await s.server.jobs.whenIdle();
    r = await call('GET', '/api/studio/c1/s1');
    assert.equal(r.body.steps.build.stale, false); assert.deepEqual(r.body.prototypes.map(p => p.n), [1, 2]);
    r = await call('POST', '/api/studio/c1/s1/promote', {proto: 2, verId: 'v2-mouth', note: 'ふだんの口を描き直した(依頼 r001 の候補 2)'});
    assert.equal(r.status, 201);
    // 取り下げ、知らない道
    await call('POST', '/api/studio/c1/s1/requests', {step: 'expr', target: 'drawn/expr/happy.png', text: 'happy'});
    assert.equal((await call('POST', '/api/studio/c1/s1/requests/r002/withdraw')).body.requests[1].state, '取り下げ');
    assert.equal((await call('POST', '/api/studio/c1/s1/requests/r002/nope')).status, 404);
    assert.equal((await call('GET', '/api/studio/c1/s1/requests')).status, 404);
  } finally { await s.close(); }
});

test('目の中の範囲: holeGreen は holeMask とどちらか一方。組み立てで区画の座標の hole_upper.png を作って paint_gaze.py に渡す', async () => {
  assert.throws(() => checkOptions({build: {gaze: {holeMask: 'drawn/h.png', holeGreen: {file: 'drawn/g.png', align: 'neutral'}}}}), {code: 'bad-input'});
  assert.throws(() => checkOptions({build: {gaze: {holeGreen: {file: 'drawn/g.png'}}}}), {code: 'bad-input'});
  assert.throws(() => checkOptions({build: {gaze: {holeGreen: {file: 'work/g.png', align: 'neutral'}}}}), {code: 'bad-input'});
  checkOptions({build: {gaze: {holeGreen: {file: 'drawn/hole_green.png', align: 'neutral'}}}});
  const {studio, q, dir} = await setup();
  await studio.copyInputs('c1', 's1', {project: 'p1'});
  const draw = await tempDir('charasta-draw-');
  for (const n of ['neutral.png', 'hole_green.png']) await fs.writeFile(path.join(draw, n), png(4, 4));
  await studio.adopt('c1', 's1', {from: draw, pattern: '*.png'});
  await studio.setOptions('c1', 's1', {build: {atlas: {cells: {neutral: 'drawn/neutral.png'}}, gaze: {env: {}, holeGreen: {file: 'drawn/hole_green.png', align: 'neutral'}}}});
  const run = async type => { const j = await q.enqueue({type, charId: 'c1', studioId: 's1'}); await q.whenIdle(); const r = await q.get(j.id); assert.equal(r.state, 'done', r.error); return r; };
  await run('studio-front');
  await studio.setRects('c1', 's1', {upper: [100, 100, 900, 600]});
  assert.match((await run('studio-build')).logTail, /== 目の中の範囲を区画の座標に移す/);
  assert.ok(await fs.stat(path.join(dir, 'face/hole_upper.png')));
  // 緑塗りの絵を替えると組み立てが古い
  await fs.writeFile(path.join(draw, 'hole_green.png'), png(4, 4, () => [0, 255, 0, 255]));
  await studio.adopt('c1', 's1', {from: path.join(draw, 'hole_green.png')});
  assert.equal((await studio.status('c1', 's1')).steps.build.stale, true);
});

test('hole_mask.py: 緑の画素を位置合わせのとおりに置き、upper の bbox で切り出す(白 = 開いた所)', async () => {
  const F = await tempDir('charasta-hole-');
  // 絵 20x20 の (4..7, 6..9) が緑。倍率 2、位置 (10, 4) で 64x64 の撮影に置き、bbox (8, 0, 40, 40) で切り出す
  await fs.writeFile(path.join(F, 'green.png'), png(20, 20, (x, y) => x >= 4 && x < 8 && y >= 6 && y < 10 ? [0, 255, 0, 255] : [240, 210, 190, 255]));
  await fs.writeFile(path.join(F, 'ref.png'), png(20, 20));
  await fs.writeFile(path.join(F, 'align.json'), JSON.stringify({neutral: [2, 10, 4]}));
  await fs.writeFile(path.join(F, 'regions.json'), JSON.stringify({upper: {bbox: [8, 0, 40, 40]}, size: 64}));
  const out = path.join(F, 'hole.png');
  const {stdout} = await py([path.join(root, 'studio', 'face_atlas', 'hole_mask.py'), F, path.join(F, 'green.png'), 'neutral', out, path.join(F, 'ref.png')]);
  assert.match(stdout, /HOLE .* 32x40 white \d+ green 16/);
  const {stdout: px} = await py(['-c', `from PIL import Image; import numpy as np; a=np.asarray(Image.open(r'${out}')); ys,xs=np.nonzero(a>127); print(a.shape, a.dtype, xs.min(), ys.min(), xs.max(), ys.max(), sorted(set(a.flatten().tolist())))`]);
  // 緑は撮影の (10+8 .. 10+15, 4+12 .. 4+19) = 区画の (10..17, 16..23)
  assert.equal(px.trim(), '(40, 32) uint8 10 16 17 23 [0, 255]');
  await assert.rejects(py([path.join(root, 'studio', 'face_atlas', 'hole_mask.py'), F, path.join(F, 'green.png'), 'nope', out, path.join(F, 'ref.png')]), /align.json に nope が無い/);
  // 位置合わせに使った絵と大きさが違う緑塗りは止める
  await fs.writeFile(path.join(F, 'ref_big.png'), png(24, 20));
  await assert.rejects(py([path.join(root, 'studio', 'face_atlas', 'hole_mask.py'), F, path.join(F, 'green.png'), 'neutral', out, path.join(F, 'ref_big.png')]), /20x20 が、位置合わせに使った絵 .* 24x20 と違う/);
});

test('本文が JSON の null でも 500 にならない(依頼を出す・却下)', async () => {
  const s = await startServer({env: STUDIO_ENV, charakuruApp: await fakeCharakuru()});
  const call = async (method, url, body) => { const r = await fetch(s.base + url, {method, headers: {'content-type': 'application/json'}, body}); return {status: r.status, body: await r.json().catch(() => null)}; };
  try {
    await new Library(s.libraryDir).createCharacter({id: 'c1', name: 'C1'});
    await call('POST', '/api/studio/c1', JSON.stringify({id: 's1'}));
    assert.equal((await call('POST', '/api/studio/c1/s1/requests', 'null')).status, 400);
    await call('POST', '/api/studio/c1/s1/requests', JSON.stringify({step: 'face', target: 'drawn/neutral.png', text: 'x'}));
    assert.equal((await fetch(s.base + '/api/studio/c1/s1/requests/r001/candidates', {method: 'POST', body: png(4, 4)})).status, 201);
    assert.equal((await call('POST', '/api/studio/c1/s1/requests/r001/candidates/1/reject', 'null')).status, 200);
  } finally { await s.close(); }
});

test('採用の途中で失敗しても drawn/ の絵は残る(.new に写してから置く。失敗したら trash/ から戻し、.new を片付ける)', async () => {
  const {studio, dir} = await setup();
  const draw = await tempDir('charasta-draw-'), old = png(4, 4, () => [1, 2, 3, 255]);
  await fs.writeFile(path.join(draw, 'neutral.png'), old);
  await studio.adopt('c1', 's1', {from: path.join(draw, 'neutral.png')});
  await studio.createRequest('c1', 's1', {step: 'face', target: 'drawn/neutral.png', text: '口'});
  await studio.addCandidate('c1', 's1', 'r001', {data: png(4, 4, () => [9, 9, 9, 255])});
  const trashedCount = async () => (await fs.readdir(path.join(dir, 'trash')).catch(() => [])).filter(f => f.endsWith('drawn_neutral.png')).length;
  const check = async what => {
    assert.deepEqual(await fs.readFile(path.join(dir, 'drawn/neutral.png')), old, what);
    assert.deepEqual(await fs.readdir(path.join(dir, 'drawn')), ['neutral.png'], what);   // .new が残らない
    const w = await studio.read('c1', 's1');
    assert.deepEqual([w.requests[0].state, w.requests[0].candidates[0].state], ['候補あり', '候補'], what);
  };
  const {copyFile, rename} = fs;
  try {
    fs.copyFile = async () => { throw new Error('EBUSY(試し)'); };
    await assert.rejects(studio.adoptCandidate('c1', 's1', 'r001', 1), /EBUSY/);
    assert.equal(await trashedCount(), 0);   // 写せなかったので前の絵を動かしていない
    await check('写すのが失敗');
    fs.copyFile = copyFile;
    fs.rename = async (from, to) => { if (String(from).endsWith('.new')) throw new Error('EPERM(試し)'); return rename(from, to); };
    await assert.rejects(studio.adoptCandidate('c1', 's1', 'r001', 1), /EPERM/);
    assert.equal(await trashedCount(), 0);   // trash/ へ移した前の絵は戻してある(移した先のファイルは残らない)
    await check('置くのが失敗');
  } finally { fs.copyFile = copyFile; fs.rename = rename; }
  await studio.adoptCandidate('c1', 's1', 'r001', 1);   // 失敗のあとも普通に採用できる
  assert.deepEqual(await fs.readdir(path.join(dir, 'drawn')), ['neutral.png']);
  assert.equal(await trashedCount(), 1);
});

test('置いたときと違う候補のファイルは 4xx(LibraryError)', async () => {
  const {studio, dir} = await setup();
  await studio.createRequest('c1', 's1', {step: 'face', target: 'drawn/neutral.png', text: '口'});
  await studio.addCandidate('c1', 's1', 'r001', {data: png(4, 4)});
  await fs.writeFile(path.join(dir, 'candidates/r001/c01.png'), 'x');
  await assert.rejects(studio.adoptCandidate('c1', 's1', 'r001', 1), {code: 'bad-input', message: /置いたときと違う/});
});

test('同じ絵を替える依頼 2 件: 先に採用した変更を黙って消さない(409)。依頼のあとの adopt でも止まる', async () => {
  const {studio, dir} = await setup();
  const draw = await tempDir('charasta-draw-'), orig = png(4, 4, () => [1, 2, 3, 255]), first = png(4, 4, () => [9, 9, 9, 255]);
  await fs.writeFile(path.join(draw, 'neutral.png'), orig);
  await studio.adopt('c1', 's1', {from: path.join(draw, 'neutral.png')});
  await studio.createRequest('c1', 's1', {step: 'face', target: 'drawn/neutral.png', text: '口'});
  await studio.createRequest('c1', 's1', {step: 'face', target: 'drawn/neutral.png', text: '眉'});
  await studio.addCandidate('c1', 's1', 'r001', {data: first});
  const second = await studio.addCandidate('c1', 's1', 'r002', {data: png(4, 4, () => [7, 7, 7, 255])});
  assert.equal(second.base, sha(orig));   // 候補には、元にした絵の sha256 が残る
  await studio.adoptCandidate('c1', 's1', 'r001', 1);
  // r002 の候補は古い絵を元にしているので採用できない。理由が文に出る。絵は r001 のまま、r002 は候補ありのまま
  await assert.rejects(studio.adoptCandidate('c1', 's1', 'r002', 1), {code: 'exists', message: /drawn\/neutral\.png は依頼 r002 のあとに替わった/});
  assert.deepEqual(await fs.readFile(path.join(dir, 'drawn/neutral.png')), first);
  assert.equal((await studio.read('c1', 's1')).requests[1].state, '候補あり');
  // 採用のあとに r002 へ候補を足すのも断る(取り下げて出し直す)
  await assert.rejects(studio.addCandidate('c1', 's1', 'r002', {data: png(4, 4)}), {code: 'exists'});
  await studio.withdrawRequest('c1', 's1', 'r002');
  await studio.createRequest('c1', 's1', {step: 'face', target: 'drawn/neutral.png', text: '眉(出し直し)'});
  assert.equal((await studio.addCandidate('c1', 's1', 'r003', {data: png(4, 4)})).base, sha(first));

  // 依頼を出したあとに adopt(CLI の adopt と同じ関数)で絵が替わった場合: 置いたあとに替われば採用で止まり、置く前に替われば置く所で止まる
  await studio.createRequest('c1', 's1', {step: 'face', target: 'drawn/neutral.png', text: '鼻'});
  await fs.writeFile(path.join(draw, 'neutral.png'), png(4, 4, () => [5, 5, 5, 255]));
  await studio.adopt('c1', 's1', {from: path.join(draw, 'neutral.png')});
  await assert.rejects(studio.adoptCandidate('c1', 's1', 'r003', 1), {code: 'exists'});   // r003 の候補は adopt の前に置いた
  await assert.rejects(studio.addCandidate('c1', 's1', 'r004', {data: png(4, 4)}), {code: 'exists'});   // r004 は依頼のあとに絵が替わった
  // 絵がまだ無い所の依頼は、無いままなら採用できる
  await studio.createRequest('c1', 's1', {step: 'expr', target: 'drawn/expr/happy.png', text: 'happy'});
  await studio.addCandidate('c1', 's1', 'r005', {data: first});
  await studio.adoptCandidate('c1', 's1', 'r005', 1);
});

// サーバーの代わりに、受けた要求を記録する(CLI がサーバーを通すかを見る)
async function fakeApi(dirOf) {
  const http = await import('node:http'), seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen.push({method: req.method, url: req.url, type: req.headers['content-type']});
    const send = (st, j) => { res.writeHead(st, {'content-type': 'application/json'}); res.end(JSON.stringify(j)); };
    if (req.method === 'GET') return send(200, {dir: dirOf});
    if (req.url.endsWith('/rects')) return send(200, {rects: JSON.parse(body)});
    if (req.url.endsWith('/options')) return send(200, {options: JSON.parse(body)});
    if (req.url.includes('/videos/')) return send(200, {adopted: [{path: 'video/blink.mp4', sha256: 'abc'}]});
    send(201, {n: 1});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {seen, port: server.address().port, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); })};
}

test('CLI: 同じ表情づくりのサーバーが動いていれば rects・options・video は API を通し、adopt は断る。保管場所が違うサーバーなら直接書き、candidate は止める', async () => {
  const lib = new Library(await tempDir()), app = await fakeCharakuru();
  await lib.createCharacter({id: 'c1', name: 'C1'});
  const studio = new Studio(lib, {charakuruApp: app, env: STUDIO_ENV});
  await studio.create({charId: 'c1', id: 's1'});
  const work = studio.dir('c1', 's1'), tmp = await tempDir('charasta-cli-');
  const optsJson = path.join(tmp, 'options.json'), rectsJson = path.join(tmp, 'rects.json'), mp4 = path.join(tmp, 'blink.mp4'), cand = path.join(tmp, 'cand.png');
  await fs.writeFile(rectsJson, JSON.stringify({upper: [1, 2, 3, 4]})); await fs.writeFile(optsJson, JSON.stringify({video: {env: {A: '1'}}}));
  await fs.writeFile(mp4, Buffer.from('....ftypisom')); await fs.writeFile(cand, png(4, 4));
  const cliWith = async (port, ...args) => {
    const cfg = path.join(tmp, `config-${port}.json`);
    await fs.writeFile(cfg, JSON.stringify({libraryDir: lib.dir, port, charakuruApp: app}));
    return exec(process.execPath, [path.join(root, 'scripts', 'studio.mjs'), ...args], {env: {...process.env, CHARASTA_CONFIG: cfg}});
  };
  const same = await fakeApi(work), other = await fakeApi(path.join(tmp, 'other-library', 'studio', 'c1', 's1'));
  const id = ['--char', 'c1', '--id', 's1'], writes = f => f.seen.filter(x => x.method !== 'GET').map(x => [x.method, x.url, x.type]);
  try {
    // 同じ作業場所のサーバー: API を通る(CLI は work.json を書かない)
    await cliWith(same.port, 'rects', ...id, '--json', rectsJson);
    await cliWith(same.port, 'options', ...id, '--json', optsJson);
    const v = JSON.parse((await cliWith(same.port, 'video', ...id, '--name', 'blink', '--src', mp4)).stdout);
    assert.deepEqual(v, [{name: 'blink', file: 'video/blink.mp4', sha256: 'abc'}]);
    assert.deepEqual(writes(same), [['PUT', '/api/studio/c1/s1/rects', 'application/json'], ['PATCH', '/api/studio/c1/s1/options', 'application/json'], ['POST', '/api/studio/c1/s1/videos/blink', 'video/mp4']]);
    const w = await studio.read('c1', 's1');
    assert.equal(w.rects?.upper, undefined); assert.deepEqual(w.options.video.videos ?? [], []); assert.equal(await fs.readdir(path.join(work, 'video')).then(l => l.length), 0);
    // adopt はサーバーが動いている間は断る
    await assert.rejects(cliWith(same.port, 'adopt', ...id, '--from', cand), /サーバーが動いている間は adopt できない/);
    assert.equal(await fs.readdir(path.join(work, 'drawn')).then(l => l.length), 0);
    // candidate は同じ作業場所のサーバーへ送る
    await cliWith(same.port, 'candidate', ...id, '--request', 'r001', '--file', cand);
    assert.equal(same.seen.at(-1).url, '/api/studio/c1/s1/requests/r001/candidates');

    // 保管場所が違うサーバー: candidate は送らず止める。options・adopt はそのサーバーの管轄ではないので直接書く
    await assert.rejects(cliWith(other.port, 'candidate', ...id, '--request', 'r001', '--file', cand), /サーバーの作業場所.*違う/);
    await cliWith(other.port, 'options', ...id, '--json', optsJson);
    await cliWith(other.port, 'adopt', ...id, '--from', cand);
    assert.deepEqual(writes(other), []);
    assert.deepEqual((await studio.read('c1', 's1')).options.video.env, {A: '1'});
    assert.deepEqual(await fs.readdir(path.join(work, 'drawn')), ['cand.png']);

    // サーバーに届かないとき candidate は止まる
    await assert.rejects(cliWith(1, 'candidate', ...id, '--request', 'r001', '--file', cand), /サーバーに届かない/);
  } finally { await same.close(); await other.close(); }
});

test('paste_area.py: 混ぜる帯の中の差の最大を出し、上限を超えたら出力を書かずに止める', async () => {
  const F = await tempDir('charasta-paste-'), script = path.join(root, 'studio', 'face_atlas', 'paste_area.py'), out = path.join(F, 'out.png');
  await fs.writeFile(path.join(F, 'base.png'), png(40, 40, () => [100, 100, 100, 255]));
  // 四角 (10,10)-(30,30) の外側の縁(帯の中)は 10 だけ違い、真ん中は 200 違う
  await fs.writeFile(path.join(F, 'edit_ok.png'), png(40, 40, (x, y) => x >= 14 && x < 26 && y >= 14 && y < 26 ? [255, 255, 255, 255] : [110, 110, 110, 255]));
  const {stdout} = await py([script, path.join(F, 'base.png'), path.join(F, 'edit_ok.png'), out, '--box', '10,10,30,30', '--feather', 4]);
  assert.match(stdout, /band max diff 10\b/);
  await fs.rm(out);
  // 帯の中に描き直した線がかかる(帯で 100 違う)と止まり、出力は書かない。上限を上げれば通る
  await fs.writeFile(path.join(F, 'edit_bad.png'), png(40, 40, () => [200, 200, 200, 255]));
  await assert.rejects(py([script, path.join(F, 'base.png'), path.join(F, 'edit_bad.png'), out, '--box', '10,10,30,30', '--feather', 4]), /混ぜる帯の中で EDIT と BASE が 100\/255 違う/);
  await assert.rejects(fs.stat(out));
  assert.match((await py([script, path.join(F, 'base.png'), path.join(F, 'edit_bad.png'), out, '--box', '10,10,30,30', '--feather', 4, '--max-band-diff', 100])).stdout, /band max diff 100/);
});
