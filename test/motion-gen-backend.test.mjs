// MotionBricks の推論の選び方(設定の motionbricksBackend。TensorRT か ONNX Runtime)。docs/motionbricks.md の「推論」。
// 本物の MotionBricks で ONNX Runtime を確かめるテストは、環境変数 CHARASTA_REAL_MOTIONBRICKS に MotionBricks の場所を渡したときだけ動く:
//   CHARASTA_REAL_MOTIONBRICKS=<MotionBricks のリポジトリ> node --test test/motion-gen-backend.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {findPython} from '../lib/platform.mjs';
import {loadConfig, root} from '../lib/config.mjs';
import {Library} from '../lib/library.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {MB_BACKENDS, ONNXRUNTIME_DEFAULT, expectedBackend, mbBackend, mbEnv, mbUvArgs} from '../lib/motion-gen.mjs';
import {tempDir, startServer} from './helpers.mjs';

const ENGINE_PY = path.join(root, 'tools', 'mb_onnx_engine.py');

test('uv の引数: trt は MotionBricks の環境のまま、auto と onnx は onnxruntime を --with で足す(版は設定で替えられる)', () => {
  assert.deepEqual(mbUvArgs('D:/mb', {motionbricksBackend: 'trt'}), ['run', '--project', 'D:/mb', '--no-sync', 'python']);
  for (const b of [undefined, 'auto', 'onnx']) assert.deepEqual(mbUvArgs('D:/mb', {motionbricksBackend: b}), ['run', '--project', 'D:/mb', '--no-sync', '--with', ONNXRUNTIME_DEFAULT, 'python'], String(b));
  assert.deepEqual(mbUvArgs('D:/mb', {motionbricksOnnxRuntime: 'onnxruntime-directml==1.24.0'}).slice(4, 6), ['--with', 'onnxruntime-directml==1.24.0']);
  assert.throws(() => mbUvArgs('D:/mb', {motionbricksBackend: 'cuda'}), /motionbricksBackend/);
});

test('つなぐ(compose.py)に渡す環境変数と、使える機能の一覧に出す推論の見込み', () => {
  assert.deepEqual(mbEnv({}), {CHARASTA_MB_BACKEND: 'auto'});
  assert.deepEqual(mbEnv({motionbricksBackend: 'onnx', motionbricksOnnxRuntime: 'onnxruntime==1.29.0'}), {CHARASTA_MB_BACKEND: 'onnx', CHARASTA_MB_ONNXRUNTIME: 'onnxruntime==1.29.0'});
  assert.equal(expectedBackend('auto', {nvidia: true}), 'tensorrt');
  assert.equal(expectedBackend('auto', {nvidia: false}), 'onnxruntime');
  assert.equal(expectedBackend('onnx', {nvidia: true}), 'onnxruntime');
  assert.equal(expectedBackend('trt', {nvidia: false}), 'tensorrt');
  assert.equal(expectedBackend('trt', {fake: true}), 'fake');
  assert.equal(mbBackend(undefined), 'auto');
});

test('設定: motionbricksBackend の既定は auto で、知らない値は読み込みで断る', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  assert.equal(loadConfig(dir, {}).motionbricksBackend, 'auto');
  assert.equal(loadConfig(dir, {}).motionbricksOnnxRuntime, null);
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({motionbricksBackend: 'onnx'}));
  assert.equal(loadConfig(dir, {}).motionbricksBackend, 'onnx');
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({motionbricksBackend: 'gpu'}));
  assert.throws(() => loadConfig(dir, {}), /motionbricksBackend/);
});

test('Node と Python で、選べる推論と onnxruntime の既定の版が同じ', () => {
  const py = fsSync.readFileSync(ENGINE_PY, 'utf8');
  assert.equal(/^ONNXRUNTIME_DEFAULT = "([^"]+)"/m.exec(py)?.[1], ONNXRUNTIME_DEFAULT);
  assert.deepEqual(JSON.parse(/^BACKENDS = \(([^)]*)\)/m.exec(py)[1].replace(/^/, '[').replace(/$/, ']')), MB_BACKENDS);
});

test('tools/mb_onnx_engine.py: 推論の選び方、uv の引数、実行先、tensorrt が無いときの空のモジュール(test/mb_onnx_engine_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'mb_onnx_engine_check.py')], {encoding: 'utf8'});
  assert.match(out, /^OK /m);
});

test('motion-gen ジョブ: 設定の推論を --backend で渡し、generated.json に条件と使った推論が残る', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const lib = new Library(dir);
  const q = new JobQueue({lib, env: {CHARASTA_FAKE_MOTIONBRICKS: '1'}, tools: {motionbricksBackend: 'onnx'}});
  const job = await q.enqueue({type: 'motion-gen', kind: 'forward', seconds: 1, motionId: 'mb-onnx'});
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error + '\n' + done.logTail);
  await q.importGenMotion(job.id, {});
  const m = await lib.getMotion('mb-onnx');
  assert.equal(m.generated.options.backend, 'onnx');
  assert.equal(m.generated.backend, 'fake', '試しの動きは推論を使わない');

  const bad = new JobQueue({lib, env: {CHARASTA_FAKE_MOTIONBRICKS: '1'}, tools: {motionbricksBackend: 'gpu'}});
  const b = await bad.enqueue({type: 'motion-gen', kind: 'forward', seconds: 1, motionId: 'mb-bad'});
  await bad.whenIdle();
  const failed = await bad.get(b.id);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /motionbricksBackend/);
});

test('GET /api/capabilities: MotionBricks の項目に、どの推論で動く見込みかが載る', async t => {
  const mb = await tempDir();
  const s = await startServer({motionbricksDir: mb, motionbricksBackend: 'onnx'});
  t.after(async () => { await s.close(); await fs.rm(mb, {recursive: true, force: true}); });
  const caps = await (await fetch(s.base + '/api/capabilities')).json();
  assert.deepEqual(caps.motionbricks, {available: true, setting: 'motionbricksDir', backend: 'onnxruntime'});
});

const REAL = process.env.CHARASTA_REAL_MOTIONBRICKS;
test('本物の MotionBricks: CUDA を隠しても auto が ONNX Runtime(CPU)を選んで歩きを作る', {skip: !REAL && 'CHARASTA_REAL_MOTIONBRICKS に MotionBricks の場所を渡したときだけ動く', timeout: 15 * 60 * 1000}, async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const info = path.join(dir, 'info.json');
  execFileSync('uv', [...mbUvArgs(REAL, {motionbricksBackend: 'auto'}), path.join(root, 'tools', 'motionbricks_gen.py'), '--motionbricks', REAL, '--backend', 'auto',
    '--out', path.join(dir, 'motion.vrma'), '--info', info, '--contacts', path.join(dir, 'contacts.json'), '--kind', 'forward', '--speed', '2.3', '--seconds', '3'],
  {cwd: REAL, env: {...process.env, CUDA_VISIBLE_DEVICES: '-1', PYTHONUTF8: '1'}, stdio: 'pipe'});
  const r = JSON.parse(await fs.readFile(info, 'utf8'));
  assert.equal(r.backend, 'onnxruntime');
  assert.deepEqual(r.providers, ['CPUExecutionProvider']);
  assert.ok(r.frames > 60, `コマ数 ${r.frames}`);
  assert.ok(r.travelM > 3, `進んだ距離 ${r.travelM}`);
  assert.ok(r.tokens.length >= 2 && r.tokens.every(n => n >= 6 && n <= 16), JSON.stringify(r.tokens));
});
