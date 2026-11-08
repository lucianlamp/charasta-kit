// 持ち運び: 設定の既定(作者の機械の場所を持たない)、OS ごとの場所探し、使える機能の一覧、自作の VRMA の fixture。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../lib/config.mjs';
import {bashPath, defaultLibraryDir, exe, findBlender, isWin, venvPython} from '../lib/platform.mjs';
import {parseVrma} from '../lib/vrma.mjs';
import {buildVrma} from './fixtures/make-vrma.mjs';
import {SAMPLE_VRMA, startServer, tempDir} from './helpers.mjs';

test('設定の既定: config.json が無ければ外の道具は未設定(null)で、保管場所は OS 標準のデータ置き場', async () => {
  const dir = await tempDir(), env = {LOCALAPPDATA: 'C:/Users/x/AppData/Local'};
  const c = loadConfig(dir, env);
  for (const k of ['motionbricksDir', 'kimodoDir', 'vrmaPipelineDir', 'rgbmocapDir', 'stageStudioDir', 'voicevoxDir', 'hyperframesCli', 'charakuruApp', 'figureImageGen']) assert.equal(c[k], null, k);
  assert.equal(c.port, 8870);
  assert.equal(c.libraryDir, path.resolve(defaultLibraryDir(env)));
  assert.doesNotMatch(JSON.stringify(c), /ytvar|D:\/work/);
});

test('設定: config.json の値が既定に勝ち、null と空の文字列は未設定に戻す。キットの root の stage-studio は既定の stageStudioDir', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({port: 9001, kimodoDir: '/k', motionbricksDir: null, voicevoxDir: '', libraryDir: path.join(dir, 'lib')}));
  const c = loadConfig(dir, {});
  assert.equal(c.port, 9001); assert.equal(c.kimodoDir, '/k'); assert.equal(c.motionbricksDir, null); assert.equal(c.voicevoxDir, null); assert.equal(c.stageStudioDir, null);
  await fs.mkdir(path.join(dir, 'stage-studio'));
  assert.equal(loadConfig(dir, {}).stageStudioDir, path.join(dir, 'stage-studio'));
});

test('設定: CHARASTA_CONFIG のファイルを読み、無ければ例外', async () => {
  const dir = await tempDir(), file = path.join(dir, 'c.json');
  await fs.writeFile(file, JSON.stringify({port: 1234}));
  assert.equal(loadConfig(dir, {CHARASTA_CONFIG: file}).port, 1234);
  assert.throws(() => loadConfig(dir, {CHARASTA_CONFIG: path.join(dir, 'none.json')}), /CHARASTA_CONFIG/);
});

test('platform: venvPython と exe は OS に合わせ、Blender は環境変数、設定の順', () => {
  assert.equal(venvPython('/p'), path.join('/p', '.venv', ...(isWin ? ['Scripts', 'python.exe'] : ['bin', 'python'])));
  assert.equal(exe('run'), isWin ? 'run.exe' : 'run');
  assert.equal(findBlender('/cfg/blender', {CHARASTA_BLENDER: '/env/blender'}), '/env/blender');
  assert.equal(findBlender('/cfg/blender', {}), '/cfg/blender');
  assert.equal(bashPath({gitBash: 'C:/Git/bin/bash.exe'}), isWin ? 'C:/Git/bin/bash.exe' : '/bin/bash');
});

test('自作の VRMA の fixture: 毎回同じバイト列で、コミットしたファイルと一致し、長さと骨が取れる', async () => {
  const a = buildVrma();
  assert.ok(a.equals(buildVrma()));
  assert.ok(a.equals(await fs.readFile(SAMPLE_VRMA)), 'node test/fixtures/make-vrma.mjs で作り直す');
  const m = parseVrma(a);
  assert.ok(m.durationSec > 1); assert.ok(['hips', 'head', 'leftUpperArm', 'rightHand'].every(b => m.bones.includes(b)));
});

test('GET /api/capabilities: 未設定の機能は available: false で設定のキーを返し、overview にも同じものが載る', async t => {
  const s = await startServer({env: {CHARASTA_FAKE_VOICEVOX: '1'}});
  t.after(() => s.close());
  const caps = await (await fetch(s.base + '/api/capabilities')).json();
  for (const k of ['motionbricks', 'kimodo', 'videoMotion', 'stageStudio', 'hyperframes', 'charakuru']) { assert.equal(caps[k].available, false, k); assert.ok(caps[k].setting, k); }
  assert.equal(caps.voicevox.available, true);
  const ov = await (await fetch(s.base + '/api/overview')).json();
  assert.deepEqual(ov.capabilities, caps);
});
