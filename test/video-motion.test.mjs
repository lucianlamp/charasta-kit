// 動画からモーションを作るジョブ video-motion。CHARASTA_FAKE_VRMA_PIPELINE で vrma-pipeline と Blender と yt-dlp を呼ばずに動かす(ffmpeg と python と numpy は要る)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Library} from '../lib/library.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {convertArgs, cutArgs, videoMotionTimeoutMs, videoMotionInput, videoMotionOptions, sam3dReady, VIDEO_ENGINES} from '../lib/video-motion.mjs';
import {limitOf, videoTerms} from '../lib/terms.mjs';
import {venvPython, rgbmocapPython} from '../lib/platform.mjs';
import {tempDir, startServer, fakeGlb} from './helpers.mjs';

const FAKE = {CHARASTA_FAKE_VRMA_PIPELINE: '1'};
const RIGHTS = '自分で撮った試しの動画';

async function addChar(lib, id = 'c1', ver = 'v1') {
  await lib.createCharacter({id, name: 'キャラ' + id});
  await lib.importVersion({charId: id, id: ver, label: '試し', data: fakeGlb(), latest: true});
}

async function setup(t, env = FAKE, tools = {}) {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const lib = new Library(dir);
  await addChar(lib);
  return {lib, q: new JobQueue({lib, env, tools})};
}

const url = 'https://example.com/v.mp4';
const body = extra => ({type: 'video-motion', charId: 'c1', url, rights: RIGHTS, ...extra});

async function makeVideo(file, seconds = 2) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=30`, '-t', String(seconds), '-pix_fmt', 'yuv420p', file]);
}

test('video-motion ジョブ: URL の動画から確認待ちまで進み、取り込むまでモーションにならない', async t => {
  const {lib, q} = await setup(t);
  const job = await q.enqueue(body({label: '試し', speed: 0.5, trimEnd: 1, unmirror: true}));
  assert.equal(job.state, 'queued'); assert.equal(job.input.verId, 'v1');
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error + '\n' + done.logTail);
  const r = done.result;
  assert.equal(r.review, 'waiting'); assert.equal(r.charName, 'キャラc1'); assert.equal(r.verId, 'v1');
  assert.ok(r.frames === 30 || r.frames === 31, String(r.frames)); assert.ok(r.durationSec > 0.45 && r.durationSec < 0.55, String(r.durationSec));  // 0.5 倍速のスローと読むので、1 秒の 30 コマを元の速さの 0.5 秒に戻す
  assert.equal(r.quality, 'PASS');
  assert.equal((await lib.listMotions()).length, 0);
  assert.ok((await fs.stat(path.join(lib.dir, 'jobs', job.id, 'compare.mp4'))).size > 0);
  const log = await fs.readFile(path.join(lib.dir, 'jobs', job.id + '.log'), 'utf8');
  for (const s of ['動画を取る', '切り出す', 'VRMA を作る', '比較の動画を作る', '利用条件を記録する']) assert.match(log, new RegExp('== ' + s));

  const m = await q.importVideoMotion(job.id, {label: '名前を変えた', motionId: 'my-clip'});
  assert.equal(m.id, 'my-clip'); assert.equal(m.label, '名前を変えた');
  assert.deepEqual(m.fittedTo, {charId: 'c1', charName: 'キャラc1', verId: 'v1'});
  assert.equal(m.generated.tool, 'rgbmocap'); assert.equal(m.generated.options.speed, 0.5); assert.equal(m.generated.job, job.id);
  assert.equal(m.generated.options.engine, 'exmr'); assert.match(m.source.pack, /ExMR/);
  assert.ok(m.license.terms.some(x => /ExMR/.test(x.part) && /非営利/.test(x.license)));   // ExMR と SMPL-X の条件を記録に残す
  assert.equal(m.source.path, url);
  assert.equal(m.license.rightsNote, RIGHTS); assert.equal(m.license.redistribution, false);
  // 権利のメモの文にかかわらず個人利用として記録し、これで撮った動画は公開できない
  assert.deepEqual(limitOf(m), {text: '個人利用のみ', warn: true});
  assert.equal(videoTerms({motion: m}).level, 'no');
  assert.equal((await lib.listMotions())[0].fittedTo.charId, 'c1');
  assert.equal((await q.get(job.id)).result.review, 'imported');
  await assert.rejects(q.importVideoMotion(job.id, {}), {code: 'exists'});   // 2 度は取り込めない
  await assert.rejects(q.discardVideoMotion(job.id), {code: 'exists'});
});

test('video-motion ジョブ: 捨てると作業フォルダは trash/ へ移り、モーションにならない。同じ ID があれば取り込まない', async t => {
  const {lib, q} = await setup(t);
  const a = await q.enqueue(body()), b = await q.enqueue(body());
  await q.whenIdle();
  const j = await q.discardVideoMotion(a.id);
  assert.equal(j.result.review, 'discarded');
  await fs.access(path.join(lib.dir, 'trash', 'video-motion-' + a.id, 'compare.mp4'));
  await assert.rejects(fs.access(path.join(lib.dir, 'jobs', a.id)));
  await q.importVideoMotion(b.id, {motionId: 'same'});
  const c = await q.enqueue(body());
  await q.whenIdle();
  await assert.rejects(q.importVideoMotion(c.id, {motionId: 'same'}), {code: 'exists'});
  assert.equal((await q.get(c.id)).result.review, 'waiting');
});

test('video-motion ジョブ: 失敗は failed で確認に進まず、終わらない変換は時間の上限で止める', async t => {
  const {lib, q} = await setup(t, {CHARASTA_FAKE_VRMA_PIPELINE: 'fail'});
  const j = await q.enqueue(body());
  await q.whenIdle();
  const f = await q.get(j.id);
  assert.equal(f.state, 'failed'); assert.match(f.error, /vrma-pipeline が失敗した/); assert.equal(f.result, null);
  await assert.rejects(q.importVideoMotion(j.id, {}), {code: 'exists'});
  assert.equal((await lib.listMotions()).length, 0);
  const {q: q2} = await setup(t, {CHARASTA_FAKE_VRMA_PIPELINE: 'hang', CHARASTA_VIDEO_MOTION_TIMEOUT_MS: '1500'});
  const started = Date.now(), h = await q2.enqueue(body());
  await q2.whenIdle();
  const g = await q2.get(h.id);
  assert.equal(g.state, 'failed'); assert.match(g.error, /終わらなかったので止めた/);
  assert.ok(Date.now() - started < 30000);
});

test('video-motion ジョブ: パイプラインの場所が無ければ failed にし、受け取った動画を uploads/ に残さない', async t => {
  const {lib, q} = await setup(t, {}, {vrmaPipelineDir: path.join(await tempDir(), 'none')});
  await fs.mkdir(path.join(lib.dir, 'uploads'));
  await fs.writeFile(path.join(lib.dir, 'uploads', 'a.mp4'), 'x');
  const j = await q.enqueue(body({url: undefined, upload: 'a.mp4', fileName: 'a.mp4'}));
  await q.whenIdle();
  const f = await q.get(j.id);
  assert.equal(f.state, 'failed'); assert.match(f.error, /vrma-pipeline の場所が無い/);
  assert.deepEqual(await fs.readdir(path.join(lib.dir, 'uploads')), []);
});

test('順番待ちのままサーバーが止まった動画は、次の起動で failed にして消す', async t => {
  const {lib} = await setup(t);
  await fs.mkdir(path.join(lib.dir, 'uploads')); await fs.mkdir(path.join(lib.dir, 'jobs'), {recursive: true});
  await fs.writeFile(path.join(lib.dir, 'uploads', 'b.mp4'), 'x');
  await fs.writeFile(path.join(lib.dir, 'jobs', 'jold.json'), JSON.stringify({id: 'jold', type: 'video-motion', state: 'queued', input: {upload: 'b.mp4'}, createdAt: 'x'}));
  const q = new JobQueue({lib, env: FAKE});
  assert.equal((await q.get('jold')).state, 'failed');
  assert.deepEqual(await fs.readdir(path.join(lib.dir, 'uploads')), []);
});

test('video-motion の入力の確かめ: 権利のメモは必須、URL は http か https、切り出しの範囲', async t => {
  const {q} = await setup(t);
  const bad = async (extra, code = 'bad-input') => assert.rejects(q.enqueue(body(extra)), {code}, JSON.stringify(extra));
  await bad({rights: ''}); await bad({rights: '   '}); await bad({rights: 'あ'.repeat(501)}); await bad({rights: 5});
  await bad({url: ''}); await bad({url: 'file:///C:/x.mp4'}); await bad({url: 'javascript:alert(1)'}); await bad({url: 'not a url'});
  await bad({speed: 0}); await bad({speed: 9}); await bad({speed: 'fast'}); await bad({speed: ['1']});
  await bad({trimStart: -1}); await bad({trimStart: 2, trimEnd: 2}); await bad({crop: '100:100'}); await bad({crop: 'a:b:c:d'}); await bad({unmirror: 'yes'});
  const mp = {engine: 'mediapipe'};
  await bad({...mp, depthOpt: 'off'}); await bad({...mp, grip: -1}); await bad({...mp, grip: 101}); await bad({...mp, grip: 22, depthOpt: false});
  await bad({engine: 'openpose'}); await bad({engine: 'exmr', grip: 22}); await bad({engine: 'exmr', depthOpt: false});   // 奥行き最適化と両手の間隔は mediapipe だけ
  await bad({handBodyFix: 'yes'}); await bad({...mp, handBodyFix: true});   // 手のめり込みの直しは exmr だけ
  await bad({upload: 'x.mp4'});               // url と両方は不可
  await bad({url: undefined});                // どちらも無いのも不可
  await bad({url: undefined, upload: '../x.mp4'}); await bad({url: undefined, upload: 'x.exe'});
  await bad({label: 'あ'.repeat(101)});
  await bad({charId: 'none'}, 'not-found'); await bad({verId: 'none'}, 'not-found');
  const ok = await q.enqueue(body({speed: '0.6', trimStart: '1.5', trimEnd: '', crop: ' 640:720:10:0 ', unmirror: false}));
  assert.equal(ok.input.speed, 0.6); assert.equal(ok.input.trimStart, 1.5); assert.equal(ok.input.trimEnd, null); assert.equal(ok.input.crop, '640:720:10:0');
  assert.equal(ok.input.label, 'example.com'); assert.equal(ok.input.depthOpt, true); assert.equal(ok.input.grip, 0);
  assert.equal(ok.input.engine, 'exmr');   // 既定は RGB MoCap の ExMR
  assert.equal(ok.input.handBodyFix, false);
  assert.equal((await q.enqueue(body({handBodyFix: true}))).input.handBodyFix, true);
  const off = await q.enqueue(body({...mp, depthOpt: false})), held = await q.enqueue(body({...mp, grip: '22'}));
  assert.equal(off.input.engine, 'mediapipe');
  // engine を書かずに mediapipe だけの条件を書いた前からの呼び出しは mediapipe
  const legacy = await q.enqueue(body({depthOpt: false})), legacyGrip = await q.enqueue(body({grip: 22}));
  assert.equal(legacy.input.engine, 'mediapipe'); assert.equal(legacyGrip.input.engine, 'mediapipe');
  assert.equal(off.input.depthOpt, false); assert.equal(held.input.grip, 22);
  await q.whenIdle();
});

test('RGB MoCap が無ければ engine の既定は mediapipe で、exmr を書くと断る', async t => {
  const {q} = await setup(t, {}, {rgbmocapDir: path.join(await tempDir(), 'none'), vrmaPipelineDir: path.join(await tempDir(), 'none')});
  assert.equal(q.exmrAvailable(), false);
  await assert.rejects(q.enqueue(body({engine: 'exmr'})), {code: 'bad-input'});
  const j = await q.enqueue(body());
  assert.equal(j.input.engine, 'mediapipe');
  await q.whenIdle();
});

test('変換の引数: 既定は奥行き最適化あり、切るときと両手の間隔を渡す', () => {
  const base = ['-X', 'utf8', 'batch_convert.py', '--input', 'i', '--output', 'o', '--vrm', 'm'];
  assert.deepEqual(convertArgs({inDir: 'i', outDir: 'o', model: 'm'}), [...base, '--depth-opt', 'on']);
  assert.deepEqual(convertArgs({inDir: 'i', outDir: 'o', model: 'm', depthOpt: false}), [...base, '--depth-opt', 'off']);
  assert.deepEqual(convertArgs({inDir: 'i', outDir: 'o', model: 'm', grip: 22}), [...base, '--depth-opt', 'on', '--grip', '22']);
});

test('切り出しの ffmpeg の引数: 切り抜き、ミラー解除、速さ、開始と終了', () => {
  const a = cutArgs({input: 'in.mp4', out: 'o.mp4', fps: '60/1', speed: 0.5, trimStart: 5.6, trimEnd: 10.5, crop: '640:720:0:0', unmirror: true});
  assert.deepEqual(a.slice(a.indexOf('-ss'), a.indexOf('-i') + 2), ['-ss', '5.6', '-to', '10.5', '-i', 'in.mp4']);
  assert.equal(a[a.indexOf('-vf') + 1], 'crop=640:720:0:0,hflip,setpts=0.5*PTS');
  assert.equal(a[a.indexOf('-r') + 1], '60000/500');
  const b = cutArgs({input: 'in.mp4', out: 'o.mp4', fps: '30000/1001', speed: 1, trimStart: 0, trimEnd: null, crop: '', unmirror: false});
  assert.ok(!b.includes('-ss') && !b.includes('-to'));
  assert.equal(b[b.indexOf('-vf') + 1], 'setpts=1*PTS'); assert.equal(b[b.indexOf('-r') + 1], '30000000/1001000');
  assert.equal(videoMotionTimeoutMs(100), 420000); assert.equal(videoMotionTimeoutMs(100, 'mediapipe'), 420000);
  assert.equal(videoMotionTimeoutMs(100, 'exmr'), 2300000);
  assert.equal(videoMotionTimeoutMs(100, 'exmr', true), 2700000);   // 手のめり込みの直しは 1 コマ 4 秒を足す
});

test('API: 手元の動画を送ると積まれ、比較の動画を見て取り込むと /api/motions に出る。動きの情報に対象のキャラが残る', async () => {
  const s = await startServer({env: FAKE, vrmaPipelineDir: path.join(await tempDir(), 'none')});
  try {
    const lib = new Library(s.libraryDir);
    await addChar(lib);
    const opt = await (await fetch(s.base + '/api/video-motions')).json();
    assert.equal(opt.available, true); assert.equal(opt.maxClipSec, 120);
    assert.deepEqual(opt.engines, {exmr: true, sam3d: true, mediapipe: true}); assert.equal(opt.defaultEngine, 'exmr');
    const file = path.join(s.libraryDir, 'clip in.mp4');
    await makeVideo(file);
    const post = (headers, data) => fetch(s.base + '/api/video-motions', {method: 'POST', headers, body: data});
    const params = extra => encodeURIComponent(JSON.stringify({charId: 'c1', rights: RIGHTS, trimEnd: 1, ...extra}));
    const data = await fs.readFile(file);
    const r = await post({'x-filename': encodeURIComponent('踊り.mp4'), 'x-params': params({engine: 'mediapipe', grip: 22})}, data);
    assert.equal(r.status, 201);
    const job = await r.json();
    assert.equal(job.input.fileName, '踊り.mp4'); assert.equal(job.input.label, '踊り'); assert.equal(job.input.grip, 22);
    // 動画を保存する前に断る
    assert.equal((await post({'x-filename': 'a.mp4', 'x-params': params({rights: ''})}, data)).status, 400);
    assert.equal((await post({'x-filename': 'a.exe', 'x-params': params()}, data)).status, 400);
    assert.equal((await post({'x-filename': 'a.mp4', 'x-params': 'x'}, data)).status, 400);
    assert.equal((await post({'x-filename': 'a.mp4', 'x-params': 'null'}, data)).status, 400);
    // 受け取ったあとで積めないときも uploads/ に残さない
    assert.equal((await post({'x-filename': encodeURIComponent('あ'.repeat(201) + '.mp4'), 'x-params': params()}, data)).status, 400);
    assert.equal((await post({'x-filename': 'a.mp4', 'x-params': params({charId: 'none'})}, data)).status, 404);
    await s.server.jobs.whenIdle();
    const done = await (await fetch(`${s.base}/api/jobs/${job.id}`)).json();
    assert.equal(done.state, 'done', done.error + '\n' + done.logTail);
    assert.equal(done.result.frames, 30); assert.equal(done.result.options.grip, 22); assert.equal(done.result.options.depthOpt, true);
    assert.equal(done.result.options.engine, 'mediapipe'); assert.ok(!done.result.license.terms?.some(x => /ExMR/.test(x.part)));
    assert.deepEqual(await fs.readdir(path.join(s.libraryDir, 'uploads')), []);   // 受け取った動画はジョブの作業フォルダへ移る
    const v = await fetch(s.base + done.result.compareUrl);
    assert.equal(v.status, 200); assert.equal(v.headers.get('content-type'), 'video/mp4');
    assert.deepEqual((await (await fetch(s.base + '/api/video-motions')).json()).waiting.map(j => j.id), [job.id]);
    assert.equal((await fetch(`${s.base}/api/video-motions/nojob/compare.mp4`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/video-motions/${job.id}/import`)).status, 405);
    const im = await fetch(`${s.base}/api/video-motions/${job.id}/import`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
    assert.equal(im.status, 201);
    const list = await (await fetch(s.base + '/api/motions')).json();
    assert.deepEqual(list.map(m => m.id), ['video-' + job.id]);
    assert.deepEqual((await (await fetch(s.base + '/api/video-motions')).json()).waiting, []);
    assert.equal(list[0].label, '踊り'); assert.equal(list[0].fittedTo.verId, 'v1'); assert.equal(list[0].limit.warn, true);
    assert.equal((await fetch(s.base + list[0].file)).status, 200);
  } finally { await s.close(); }
});

test('パイプラインの場所が無く、試しの動きでもなければ available は false', async () => {
  const s = await startServer({vrmaPipelineDir: path.join(await tempDir(), 'none')});
  try { assert.equal((await (await fetch(s.base + '/api/video-motions')).json()).available, false); } finally { await s.close(); }
});

// SAM 3D Body の 4 つの場所に見立てた空のファイルとフォルダ(中身は読まない)
async function fakeSam3d() {
  const d = await tempDir();
  const sam3dPython = path.join(d, 'python.exe'), sam3dCkptDir = path.join(d, 'ckpt'), sam3dSrc = path.join(d, 'sam'), dinov3Src = path.join(d, 'dino');
  await fs.mkdir(sam3dCkptDir); await fs.mkdir(path.join(sam3dSrc, 'sam_3d_body'), {recursive: true}); await fs.mkdir(dinov3Src);
  await fs.writeFile(sam3dPython, ''); await fs.writeFile(path.join(sam3dCkptDir, 'model.ckpt'), ''); await fs.writeFile(path.join(dinov3Src, 'hubconf.py'), '');
  return {dir: d, cfg: {sam3dPython, sam3dCkptDir, sam3dSrc, dinov3Src}};
}

test('sam3d: 4 つの場所がそろったときだけ使える', async t => {
  const {dir, cfg} = await fakeSam3d();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  assert.equal(sam3dReady(cfg), true);
  assert.equal(sam3dReady({}), false); assert.equal(sam3dReady(), false);
  assert.equal(sam3dReady({...cfg, sam3dPython: path.join(dir, 'none.exe')}), false);
  assert.equal(sam3dReady({...cfg, sam3dCkptDir: dir}), false);   // model.ckpt が無い
  assert.equal(sam3dReady({...cfg, sam3dSrc: dir}), false);       // sam_3d_body が無い
  assert.equal(sam3dReady({...cfg, dinov3Src: dir}), false);      // hubconf.py が無い
  for (const k of Object.keys(cfg)) assert.equal(sam3dReady({...cfg, [k]: undefined}), false, k);
});

test('sam3d: GET /api/video-motions の engines と既定。パイプラインが無ければ使えない。既定の変換にならない', async t => {
  const {dir, cfg} = await fakeSam3d();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const pipe = await tempDir(), rgb = path.join(await tempDir(), 'none');
  t.after(() => fs.rm(pipe, {recursive: true, force: true}));
  await fs.mkdir(path.dirname(venvPython(pipe)), {recursive: true});
  await fs.writeFile(venvPython(pipe), '');
  const o = await videoMotionOptions(pipe, {}, rgb, cfg);
  assert.deepEqual(o.engines, {exmr: false, sam3d: true, mediapipe: true}); assert.equal(o.defaultEngine, 'mediapipe');
  assert.equal((await videoMotionOptions(pipe, {}, rgb, {})).engines.sam3d, false);
  assert.equal((await videoMotionOptions(path.join(pipe, 'none'), {}, rgb, cfg)).engines.sam3d, false);   // vrma-pipeline が無い
  assert.equal((await videoMotionOptions(null, FAKE, null, {})).engines.sam3d, true, '試しの動きでは使える');
  // exmr も使える環境でも、既定は exmr のまま(sam3d にならない)
  const rgbOk = await tempDir();
  t.after(() => fs.rm(rgbOk, {recursive: true, force: true}));
  await fs.mkdir(path.dirname(rgbmocapPython(rgbOk)), {recursive: true}); await fs.writeFile(rgbmocapPython(rgbOk), '');
  assert.equal((await videoMotionOptions(pipe, {}, rgbOk, cfg)).defaultEngine, 'exmr');
  assert.ok(VIDEO_ENGINES.includes('sam3d'));
});

test('sam3d: 入力の確かめ。使えるときだけ受け付け、mediapipe だけの条件と手のめり込みの直しは断る。engine を省いても sam3d にならない', () => {
  const lib = null, input = {charId: 'c1', verId: 'v1'}, b = extra => ({url, rights: RIGHTS, ...extra});
  const v = (extra, avail = {}) => videoMotionInput(lib, input, b(extra), {exmrAvailable: true, sam3dAvailable: true, ...avail});
  assert.equal(v({engine: 'sam3d'}).engine, 'sam3d');
  assert.throws(() => v({engine: 'sam3d'}, {sam3dAvailable: false}), {code: 'bad-input'});
  assert.throws(() => videoMotionInput(lib, input, b({engine: 'sam3d'})), {code: 'bad-input'});   // sam3dAvailable を渡さなければ使えない扱い
  assert.throws(() => v({engine: 'sam3d', depthOpt: false}), {code: 'bad-input'});
  assert.throws(() => v({engine: 'sam3d', grip: 22}), {code: 'bad-input'});
  assert.throws(() => v({engine: 'sam3d', handBodyFix: true}), {code: 'bad-input'});
  assert.equal(v({engine: 'sam3d', unmirror: true, speed: 0.5, trimEnd: 3}).unmirror, true);
  assert.equal(v({}).engine, 'exmr'); assert.equal(v({}, {exmrAvailable: false}).engine, 'mediapipe');
  assert.equal(v({depthOpt: false}).engine, 'mediapipe');
  assert.equal(videoMotionInput(lib, input, b({}), {exmrAvailable: false, sam3dAvailable: true}).engine, 'mediapipe', 'sam3d が使えても既定にしない');
});

test('sam3d: 使えないときジョブを積めず、使えるときは積める', async t => {
  const {dir, cfg} = await fakeSam3d();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const none = await setup(t, {}, {rgbmocapDir: path.join(dir, 'none'), vrmaPipelineDir: path.join(dir, 'none')});
  assert.equal(none.q.sam3dAvailable(), false);
  await assert.rejects(none.q.enqueue(body({engine: 'sam3d'})), {code: 'bad-input'});
  await assert.rejects(none.q.checkVideoMotion({charId: 'c1', url, rights: RIGHTS, engine: 'sam3d'}), {code: 'bad-input'});
  const ok = await setup(t, {}, {...cfg, rgbmocapDir: path.join(dir, 'none'), vrmaPipelineDir: path.join(dir, 'none')});
  assert.equal(ok.q.sam3dAvailable(), true);
  assert.equal((await ok.q.enqueue(body())).input.engine, 'mediapipe', 'RGB MoCap が無いので既定は mediapipe。sam3d にならない');
  const j = await ok.q.enqueue(body({engine: 'sam3d'}));
  assert.equal(j.input.engine, 'sam3d');
  await ok.q.whenIdle();   // 場所が無いパイプラインなので、ジョブは失敗で終わる(積めることだけを確かめる)
});

test('sam3d: 試しの動きで取り込むまで通り、記録に SAM License、DINOv3、MHR の条件と利用者が確かめることが残る', async t => {
  const {q} = await setup(t);
  const job = await q.enqueue(body({engine: 'sam3d'}));
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error + '\n' + done.logTail);
  assert.equal(done.result.options.engine, 'sam3d'); assert.equal(done.result.license.redistribution, false);
  const parts = done.result.license.terms.map(x => x.part + ' ' + x.license).join('\n');
  assert.match(parts, /SAM License/); assert.match(parts, /DINOv3 License/); assert.match(parts, /MHR[\s\S]*Apache-2\.0/); assert.match(parts, /ゲート付き/);
  assert.ok(done.result.license.terms.some(x => x.part === '利用者が確認すること' && /重みを取った自分の承認/.test(x.license) && /動画の権利/.test(x.license)));
  assert.ok(!done.result.license.terms.some(x => /ExMR|非営利の利用に限る/.test(x.license)), 'ExMR の条件は混ぜない');
  const m = await q.importVideoMotion(job.id, {motionId: 'sam-clip'});
  assert.equal(m.generated.tool, 'sam3d'); assert.match(m.generated.model, /SAM 3D Body/); assert.match(m.source.pack, /SAM 3D Body/);
  assert.equal(limitOf(m).warn, true);
});

test('sam3d: 時間の上限は 600 秒 + 1 コマ 4 秒', () => {
  assert.equal(videoMotionTimeoutMs(100, 'sam3d'), 1000000);
  assert.equal(videoMotionTimeoutMs(0, 'sam3d'), 600000);
  assert.equal(videoMotionTimeoutMs(100, 'exmr'), 2300000);   // 既存の式は変わらない
});
