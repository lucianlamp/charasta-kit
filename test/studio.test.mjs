// 表情づくり(lib/studio.mjs): work.json、材料のコピー(元は読むだけ)、採用した絵、区画の範囲、古いかどうか、版にする。
// Blender と Python のスクリプトは呼ばない(CHARASTA_FAKE_BLENDER)。ブラウザでも撮らない(CHARASTA_FAKE_CAPTURE)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {Library} from '../lib/library.mjs';
import {Studio, STEPS, checkRects, checkOptions} from '../lib/studio.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {shiftAlign} from '../lib/studio-jobs.mjs';
import {tempDir, fakeCharakuru, STUDIO_ENV} from './helpers.mjs';

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

// フォルダの中身の指紋(ファイル名、大きさ、更新時刻、sha256)
async function snapshot(dir) {
  const out = {};
  for (const d of await fs.readdir(dir, {withFileTypes: true, recursive: true})) {
    if (!d.isFile()) continue;
    const f = path.join(d.parentPath ?? d.path, d.name), st = await fs.stat(f);
    out[path.relative(dir, f)] = [st.size, st.mtimeMs, sha(await fs.readFile(f))];
  }
  return out;
}

async function setup() {
  const lib = new Library(await tempDir()), app = await fakeCharakuru();
  await lib.createCharacter({id: 'c1', name: 'C1'});
  const studio = new Studio(lib, {charakuruApp: app, env: STUDIO_ENV});
  const q = new JobQueue({lib, studio, env: STUDIO_ENV, tools: {kit: app, patchVrm: 'x', springTune: 'x'}});
  return {lib, app, studio, q};
}
const drawDir = async () => {
  const d = await tempDir('charasta-draw-');
  for (const n of ['neutral.png', 'neutral_bald.png', 'note.txt']) await fs.writeFile(path.join(d, n), n + crypto.randomBytes(8).toString('hex'));
  return d;
};

test('作る: work.json の形と作業場所のフォルダ。同じ ID は止まり、キャラが無ければ断る', async () => {
  const {lib, studio} = await setup();
  const w = await studio.create({charId: 'c1', id: 's1', note: 'メモ'});
  assert.deepEqual(Object.keys(w).sort(), ['adopted', 'charId', 'checks', 'createdAt', 'id', 'inputs', 'note', 'options', 'prototypes', 'rects', 'requests', 'source', 'steps', 'versions'].sort());
  assert.deepEqual(Object.keys(w.options), ['front', 'build', 'video', 'springTune']);
  const dir = path.join(lib.dir, 'studio', 'c1', 's1');
  for (const d of ['inputs', 'face', 'candidates', 'drawn', 'video', 'out', 'checks', 'work']) assert.ok((await fs.stat(path.join(dir, d))).isDirectory(), d);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'work.json'), 'utf8')).note, 'メモ');
  await assert.rejects(studio.create({charId: 'c1', id: 's1'}), {code: 'exists'});
  await assert.rejects(studio.create({charId: 'zz', id: 's2'}), {code: 'not-found'});
  await assert.rejects(studio.create({charId: 'c1', id: '../x'}), {code: 'bad-id'});
  const auto = await studio.create({charId: 'c1'});
  assert.match(auto.id, /^s\d{8}-[0-9a-f]{4}$/);
  assert.deepEqual((await studio.list('c1')).map(s => s.id).sort(), [auto.id, 's1'].sort());
  const st = await studio.status('c1', 's1');
  assert.deepEqual(Object.keys(st.steps), STEPS);
  assert.ok(STEPS.every(s => st.steps[s].state === 'none' && st.steps[s].stale === false));
});

test('材料のコピー: きゃらくる側は読むだけ(中身・更新時刻・ファイルの数が変わらない)、sha256 を記録し、元が変わったら分かる', async () => {
  const {lib, app, studio} = await setup();
  await studio.create({charId: 'c1', id: 's1'});
  const projects = await studio.listProjects();
  assert.deepEqual(projects.map(p => [p.id, p.name, p.hasBlend, p.hasReview]), [['p1', 'キャラ1 の体', true, true]]);
  const before = await snapshot(app);
  const w = await studio.copyInputs('c1', 's1', {project: 'p1'});
  assert.deepEqual(await snapshot(app), before);
  assert.deepEqual(w.source, {type: 'charakuru', project: 'p1', dir: path.join(app, 'projects', 'p1')});
  assert.deepEqual(w.inputs.map(f => f.name), ['character.blend', 'review.vrm']);
  for (const f of w.inputs) {
    const src = await fs.readFile(path.join(app, 'projects', 'p1', 'work', f.name));
    assert.equal(f.sha256, sha(src));
    assert.equal(sha(await fs.readFile(path.join(lib.dir, 'studio', 'c1', 's1', 'inputs', f.name))), f.sha256);
  }
  assert.equal(w.steps.copy.state, 'done');
  let st = await studio.status('c1', 's1');
  assert.equal(st.steps.copy.sourceChanged, undefined);
  // 前の表情づくりからも写せる
  await studio.create({charId: 'c1', id: 's2'});
  const w2 = await studio.copyInputs('c1', 's2', {fromStudio: 's1'});
  assert.deepEqual(w2.source, {type: 'studio', studio: 's1'}); assert.deepEqual(w2.inputs.map(f => f.sha256), w.inputs.map(f => f.sha256));
  // きゃらくる側が変わったら「元が変わった」(このテストの一時フォルダなので書き換えてよい)
  await fs.appendFile(path.join(app, 'projects', 'p1', 'work', 'character.blend'), 'x');
  st = await studio.status('c1', 's1');
  assert.equal(st.steps.copy.sourceChanged, true);
  await assert.rejects(studio.copyInputs('c1', 's1', {fromStudio: 's1'}), {code: 'bad-input'});   // 自分自身から
  // コピーし直すと前の材料は trash/ へ
  await studio.copyInputs('c1', 's1', {project: 'p1'});
  assert.ok((await fs.readdir(path.join(lib.dir, 'studio', 'c1', 's1', 'trash'))).some(n => n.endsWith('-inputs')));
  await assert.rejects(studio.copyInputs('c1', 's1', {}), {code: 'bad-input'});
  await assert.rejects(studio.copyInputs('c1', 's1', {project: 'nope'}), {code: 'not-found'});
  await assert.rejects(studio.copyInputs('c1', 's1', {project: '../x'}), {code: 'bad-id'});
});

test('採用した絵: フォルダから型に合うものをコピーし sha256 と出どころを記録。差し替えると前の絵は trash/ へ', async () => {
  const {lib, studio} = await setup();
  await studio.create({charId: 'c1', id: 's1'});
  const d = await drawDir();
  const r = await studio.adopt('c1', 's1', {from: d, pattern: '*.png', note: 'キャラの顔'});
  assert.deepEqual(r.adopted, ['drawn/neutral.png', 'drawn/neutral_bald.png']);
  await studio.adopt('c1', 's1', {from: path.join(d, 'neutral.png'), to: 'sub'});
  let w = await studio.read('c1', 's1');
  assert.deepEqual(w.adopted.map(a => a.path).sort(), ['drawn/neutral.png', 'drawn/neutral_bald.png', 'drawn/sub/neutral.png']);
  const a = w.adopted.find(a => a.path === 'drawn/neutral.png');
  assert.equal(a.sha256, sha(await fs.readFile(path.join(d, 'neutral.png')))); assert.equal(a.from, path.join(d, 'neutral.png'));
  assert.equal(a.request, null); assert.equal(a.candidate, null); assert.equal(a.note, 'キャラの顔');
  await fs.writeFile(path.join(d, 'neutral.png'), 'new');
  await studio.adopt('c1', 's1', {from: path.join(d, 'neutral.png')});
  w = await studio.read('c1', 's1');
  assert.equal(w.adopted.filter(x => x.path === 'drawn/neutral.png').length, 1);
  assert.equal(w.adopted.find(x => x.path === 'drawn/neutral.png').sha256, sha(Buffer.from('new')));
  assert.equal((await fs.readdir(path.join(lib.dir, 'studio', 'c1', 's1', 'trash'))).length, 1);
  await assert.rejects(studio.adopt('c1', 's1', {from: d, pattern: '*.jpg'}), {code: 'not-found'});
  await assert.rejects(studio.adopt('c1', 's1', {from: d, to: '../../x'}), {code: 'outside'});
});

test('区画の範囲: 形の検査と保存。正面を撮る前は断る', async () => {
  assert.deepEqual(checkRects({upper: [370, 631, 1690, 1271], mouth: [[860, 1290, 1200, 1591], [925, 1591, 1100, 1618]]}),
    {upper: [370, 631, 1690, 1271], mouth: [[860, 1290, 1200, 1591], [925, 1591, 1100, 1618]]});
  assert.deepEqual(checkRects({upper: [[0, 0, 100, 100]]}), {upper: [0, 0, 100, 100]});
  for (const bad of [null, [], {}, {mouth: [0, 0, 10, 10]}, {upper: [0, 0, 10]}, {upper: [0, 0, 10.5, 20]}, {upper: [10, 10, 5, 50]},
    {upper: [0, 0, 3000, 100]}, {upper: [-1, 0, 100, 100]}, {upper: [0, 0, 100, 100], eyes: [0, 0, 10, 10]}, {upper: Array(9).fill([0, 0, 100, 100])}]) {
    assert.throws(() => checkRects(bad), {code: 'bad-input'}, JSON.stringify(bad));
  }
  const {studio} = await setup();
  await studio.create({charId: 'c1', id: 's1'});
  await assert.rejects(studio.setRects('c1', 's1', {upper: [0, 0, 100, 100]}), /正面を撮る/);
});

test('位置合わせのずらし: あごを直して撮り直したカメラの中心の差だけ動かす(キャラ4: 10.9 画素下)', () => {
  const pre = {center: [0.0017025619745254517, 1.3600064516067505], ortho_scale: 0.22729928612709047, size: 2048};
  const front = {...pre, center: [0.0017025619745254517, 1.361219882965088]};
  const [[s, tx, ty]] = Object.values(shiftAlign({neutral: [1.6283185840707965, 8, 8]}, pre, front));
  assert.equal(s, 1.6283185840707965); assert.equal(tx, 8); assert.ok(Math.abs(ty - 18.933) < 0.001, ty);
  const [[s2, tx2, ty2]] = Object.values(shiftAlign({n: [1, 0, 0]}, pre, {...pre, ortho_scale: pre.ortho_scale / 2}));   // 倍率 2 倍: 中心のまわりに広がる
  assert.equal(s2, 2); assert.equal(tx2, -1024); assert.equal(ty2, -1024);
});

test('古いかどうか: 採用した絵・区画・設定を変えると、それを使う工程だけが古くなり、後の工程は「前が古い」になる', async () => {
  const {studio, q} = await setup();
  await studio.create({charId: 'c1', id: 's1'});
  await studio.copyInputs('c1', 's1', {project: 'p1'});
  const d = await drawDir();
  await studio.adopt('c1', 's1', {from: d, pattern: '*.png'});
  await studio.setOptions('c1', 's1', {front: {align: ['drawn/neutral.png']}, build: {atlas: {cells: {neutral: 'drawn/neutral_bald.png'}, env: {}}}});
  const run = async type => { const j = await q.enqueue({type, charId: 'c1', studioId: 's1'}); await q.whenIdle(); const r = await q.get(j.id); assert.equal(r.state, 'done', r.error); return r; };
  await run('studio-front');
  await studio.setRects('c1', 's1', {upper: [100, 100, 900, 600]});
  await run('studio-build');
  let st = await studio.status('c1', 's1', id => q.peek(id));
  assert.deepEqual(['front', 'rects', 'build'].map(s => [st.steps[s].state, st.steps[s].stale]), [['done', false], ['done', false], ['done', false]]);
  assert.equal(st.steps.build.job.state, 'done');
  // build だけが使う絵を差し替える -> build だけ古い
  await fs.writeFile(path.join(d, 'neutral_bald.png'), 'changed'); await studio.adopt('c1', 's1', {from: path.join(d, 'neutral_bald.png')});
  st = await studio.status('c1', 's1');
  assert.deepEqual(['front', 'build'].map(s => st.steps[s].stale), [false, true]);
  await run('studio-build');
  assert.equal((await studio.status('c1', 's1')).steps.build.stale, false);
  // front が使う絵を差し替える -> front が古く、後の工程は前が古い
  await fs.writeFile(path.join(d, 'neutral.png'), 'changed'); await studio.adopt('c1', 's1', {from: path.join(d, 'neutral.png')});
  st = await studio.status('c1', 's1');
  assert.equal(st.steps.front.stale, true); assert.equal(st.steps.build.upstreamStale, true); assert.equal(st.steps.build.stale, false);
  // 区画を変える -> build が古い。設定を変える -> build が古い
  await run('studio-front');
  await studio.setRects('c1', 's1', {upper: [100, 100, 900, 700]});
  assert.equal((await studio.status('c1', 's1')).steps.build.stale, true);
  await run('studio-build');
  await studio.setOptions('c1', 's1', {build: {gaze: {env: {MIRROR_TOL: '6'}, holeMask: null}}});
  assert.equal((await studio.status('c1', 's1')).steps.build.stale, true);
  // 撮影のカメラが変わる -> 区画の範囲が古い
  const cam = path.join(studio.dir('c1', 's1'), 'face', 'cam.json');
  await fs.writeFile(cam, JSON.stringify({center: [0, 1.5], ortho_scale: 0.3, size: 2048}));
  assert.equal((await studio.status('c1', 's1')).steps.rects.stale, true);
});

test('ジョブが待ちか実行中の間は変えない(409)。再起動で止まったジョブの工程は失敗になる。古い試作を撮った確かめは古い', async () => {
  const {lib, studio, q} = await setup();
  await studio.create({charId: 'c1', id: 's1'});
  await studio.copyInputs('c1', 's1', {project: 'p1'});
  await studio.update('c1', 's1', w => { w.steps.front = {state: 'running', jobId: 'jgone'}; });
  const d = await drawDir();
  for (const f of [() => studio.setOptions('c1', 's1', {springTune: null}), () => studio.adopt('c1', 's1', {from: d, pattern: '*.png'}),
    () => studio.copyInputs('c1', 's1', {project: 'p1'}), () => studio.addVideo('c1', 's1', {name: 'blink', data: Buffer.from('....ftyp....')}),
    () => studio.setRects('c1', 's1', {upper: [0, 0, 100, 100]})]) await assert.rejects(f(), {code: 'exists'});
  // サーバーが止まったときの残り: jobs/jgone.json が running のまま
  await fs.mkdir(path.join(lib.dir, 'jobs'), {recursive: true});
  await fs.writeFile(path.join(lib.dir, 'jobs', 'jgone.json'), JSON.stringify({id: 'jgone', type: 'studio-front', state: 'running', input: {charId: 'c1', studioId: 's1'}, createdAt: '2026-10-30T00:00:00Z'}));
  const q2 = new JobQueue({lib, studio, env: STUDIO_ENV, tools: {}});
  await q2.ready;
  const w = await studio.read('c1', 's1');
  assert.equal(w.steps.front.state, 'failed'); assert.equal(w.steps.front.error, 'サーバーが止まった');
  await studio.adopt('c1', 's1', {from: d, pattern: '*.png'});   // もう変えられる
  // 試作 2 つ。古い方を撮った確かめは「古い」、新しい方なら古くない
  await studio.setOptions('c1', 's1', {front: {align: []}});
  for (const t of ['studio-front']) { await q.enqueue({type: t, charId: 'c1', studioId: 's1'}); await q.whenIdle(); }
  await studio.setRects('c1', 's1', {upper: [100, 100, 900, 600]});
  for (let i = 0; i < 2; i++) { await q.enqueue({type: 'studio-build', charId: 'c1', studioId: 's1'}); await q.whenIdle(); }
  await q.enqueue({type: 'studio-checks', charId: 'c1', studioId: 's1', proto: 1}); await q.whenIdle();
  assert.equal((await studio.status('c1', 's1')).steps.checks.stale, true);
  await q.enqueue({type: 'studio-checks', charId: 'c1', studioId: 's1', proto: 2}); await q.whenIdle();
  assert.equal((await studio.status('c1', 's1')).steps.checks.stale, false);
});

test('版にする: 試作を版として取り込み(sha256 が同じ)、表情づくりに記録する。変えたことの文が要る', async () => {
  const {lib, studio, q} = await setup();
  await studio.create({charId: 'c1', id: 's1'});
  await studio.copyInputs('c1', 's1', {project: 'p1'});
  await studio.adopt('c1', 's1', {from: await drawDir(), pattern: '*.png'});
  await studio.setOptions('c1', 's1', {springTune: ['--auto-hit', 'hair_*[1:]=0.08']});
  await q.enqueue({type: 'studio-front', charId: 'c1', studioId: 's1'}); await q.whenIdle();
  await studio.setRects('c1', 's1', {upper: [100, 100, 900, 600]});
  await q.enqueue({type: 'studio-build', charId: 'c1', studioId: 's1'}); await q.whenIdle();
  const w = await studio.read('c1', 's1');
  assert.equal(w.prototypes.length, 1);
  assert.deepEqual(w.prototypes[0].springTune, ['--auto-hit', 'hair_*[1:]=0.08']);
  await assert.rejects(studio.promote('c1', 's1', {proto: 1, verId: 'v1'}), {code: 'bad-input'});
  await assert.rejects(studio.promote('c1', 's1', {proto: 9, verId: 'v1', note: 'n'}), {code: 'not-found'});
  const r = await studio.promote('c1', 's1', {proto: 1, verId: 'v1-studio', label: '作り直し', note: '表情づくり s1 から', latest: true});
  assert.equal(r.version.sha256, w.prototypes[0].sha256);
  assert.equal(r.version.source.path, path.join(studio.dir('c1', 's1'), 'out', '001', 'model.vrm'));
  assert.equal(r.version.source.charakuruProject, 'p1');
  assert.equal((await lib.getCharacterJson('c1')).latestVersion, 'v1-studio');
  const w2 = await studio.read('c1', 's1');
  assert.deepEqual(w2.versions.map(v => [v.verId, v.proto]), [['v1-studio', 1]]); assert.equal(w2.steps.promote.state, 'done');
  await assert.rejects(studio.promote('c1', 's1', {proto: 1, verId: 'v1-studio', note: 'n'}), {code: 'exists'});
});

test('ジョブの確かめで落ちても工程が queued のまま残らない(以後の設定変更が 409 にならない)。再起動で、残っていた queued も failed になる', async () => {
  const {lib, studio, q} = await setup();
  const raw = async () => JSON.parse(await fs.readFile(path.join(studio.dir('c1', 's1'), 'work.json'), 'utf8')).steps;
  await studio.create({charId: 'c1', id: 's1'});
  await studio.copyInputs('c1', 's1', {project: 'p1'});
  await q.enqueue({type: 'studio-front', charId: 'c1', studioId: 's1'}); await q.whenIdle();
  await studio.setRects('c1', 's1', {upper: [100, 100, 900, 600]});
  // 正面を失敗させる(チークを焼く元の .blend が無い)。続けて積んだ組み立ては「前の工程が終わっていない」で落ちる
  await studio.setOptions('c1', 's1', {front: {cheek: {overlay: 'drawn/cheek.png', align: 'neutral'}}});
  await fs.rm(path.join(studio.dir('c1', 's1'), 'inputs', 'character.blend'));
  const f = await q.enqueue({type: 'studio-front', charId: 'c1', studioId: 's1'}), b = await q.enqueue({type: 'studio-build', charId: 'c1', studioId: 's1'});
  await q.whenIdle();
  assert.equal((await q.get(b.id)).state, 'failed'); assert.match((await q.get(b.id)).error, /前の工程/);
  let steps = await raw();
  assert.deepEqual([steps.front.state, steps.front.jobId], ['failed', f.id]);
  assert.deepEqual([steps.build.state, steps.build.jobId], ['failed', b.id]);
  await studio.setOptions('c1', 's1', {front: {cheek: null}});   // 409 にならない

  // 前のサーバーのバグで queued が残った work.json(ジョブは failed)を、起動時に直す。別のジョブの工程には触らない
  await studio.update('c1', 's1', w => { w.steps.build = {state: 'queued', jobId: b.id}; w.steps.video = {state: 'queued', jobId: 'jother'}; });
  const q2 = new JobQueue({lib, studio, env: STUDIO_ENV, tools: {}});
  await q2.ready;
  steps = await raw();
  assert.equal(steps.build.state, 'failed'); assert.equal(steps.build.jobId, b.id);
  assert.equal(steps.video.state, 'queued');
  q2.close();
});

test('材料のコピー: 途中で失敗しても前の材料と work.json が残り、コピー中は工程のジョブを積めない・設定を変えられない', async () => {
  const {studio, q} = await setup();
  await studio.create({charId: 'c1', id: 's1'}); await studio.create({charId: 'c1', id: 's0'});
  await studio.copyInputs('c1', 's1', {project: 'p1'}); await studio.copyInputs('c1', 's0', {project: 'p1'});
  const dir = studio.dir('c1', 's1'), before = await snapshot(path.join(dir, 'inputs')), w0 = await studio.read('c1', 's1');
  // 元(s0)の review.vrm を消す: character.blend のコピーのあとでコピーが落ちる
  await fs.rm(path.join(studio.dir('c1', 's0'), 'inputs', 'review.vrm'));
  await assert.rejects(studio.copyInputs('c1', 's1', {fromStudio: 's0'}), {code: 'ENOENT'});
  assert.deepEqual(await snapshot(path.join(dir, 'inputs')), before);
  assert.equal(await fs.access(path.join(dir, 'inputs.new')).then(() => true, () => false), false);
  const w1 = await studio.read('c1', 's1');
  assert.deepEqual(w1.inputs, w0.inputs); assert.equal(w1.steps.copy.state, 'failed'); assert.ok(w1.steps.copy.error);
  await studio.setOptions('c1', 's1', {springTune: null});   // 失敗のあとも変えられる
  await studio.copyInputs('c1', 's1', {project: 'p1'});
  assert.equal((await studio.read('c1', 's1')).steps.copy.state, 'done');

  // コピー中(動かしているプロセスが生きている)は積めず、設定も変えられない。そのプロセスが死んでいれば止まった残りとして扱う
  await studio.update('c1', 's1', w => { w.steps.copy = {state: 'running', pid: process.pid, at: 'x'}; });
  await assert.rejects(q.enqueue({type: 'studio-front', charId: 'c1', studioId: 's1'}), {code: 'exists'});
  await assert.rejects(studio.setOptions('c1', 's1', {springTune: null}), {code: 'exists'});
  await assert.rejects(studio.copyInputs('c1', 's1', {project: 'p1'}), {code: 'exists'});
  await studio.update('c1', 's1', w => { w.steps.copy.pid = 2 ** 31 - 2; });
  assert.equal((await studio.status('c1', 's1')).steps.copy.state, 'failed');
  await studio.setOptions('c1', 's1', {springTune: null});
});

test('promote の latest は真偽値だけ(文字列 "false" を true にしない)。設定のファイルは drawn/ か video/ の下だけ', async () => {
  const {studio} = await setup();
  await studio.create({charId: 'c1', id: 's1'});
  for (const latest of ['false', 'true', 1, null]) await assert.rejects(studio.promote('c1', 's1', {proto: 1, verId: 'v1', note: 'n', latest}), {code: 'bad-input'}, String(latest));
  await assert.rejects(studio.promote('c1', 's1', {proto: 1, verId: 'v1', note: 'n', latest: false}), {code: 'not-found'});   // 真偽値なら先へ進む

  for (const ok of [{front: {align: ['drawn/a.png'], cheek: {overlay: 'drawn/c.png', align: 'a'}}}, {build: {atlas: {cells: {neutral: 'drawn/n.png'}, overlay: {file: 'drawn/o.png', align: 'a'}}, gaze: {holeMask: 'drawn/h.png'},
    iris: {align: 'a', irises: [{file: 'drawn/i.png', box: [0, 0, 1, 1]}]}}}, {video: {open: 'video/b.mp4', drawn: 'drawn/expr', masks: 'drawn/masks', videos: [{name: 'blink', file: 'video/blink.mp4'}]}}, {video: {open: null}}])
    checkOptions(ok);
  for (const bad of [{front: {align: ['inputs/a.png']}}, {front: {align: 'drawn/a.png'}}, {front: {cheek: {overlay: 'C:/x.png'}}}, {build: {atlas: {cells: {neutral: 'C:/x.png'}}}}, {build: {atlas: {cells: {neutral: 'drawn\\..\\x.png'}}}},
    {build: {atlas: {overlay: {file: '/etc/passwd'}}}}, {build: {gaze: {holeMask: 'work/face.blend'}}}, {build: {iris: {irises: [{file: 'x.png'}]}}}, {video: {open: 'inputs/review.vrm'}}, {video: {masks: 'drawn/../x'}},
    {video: {videos: [{name: 'blink', file: 'drawn/../../x.mp4'}]}}, {video: {videos: [{name: 'blink'}]}}])
    assert.throws(() => checkOptions(bad), {code: 'bad-input'}, JSON.stringify(bad));
});
