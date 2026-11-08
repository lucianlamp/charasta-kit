// モーションをつなぐ道具 tools/compose。Blender、Kimodo、MotionBricks は呼ばない(python と numpy は要る)。
import test from 'node:test';
import {findPython} from '../lib/platform.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {tempDir, SAMPLE_VRMA} from './helpers.mjs';

const run = promisify(execFile), root = path.resolve(import.meta.dirname, '..');

test('中間形式、骨の対応表、FBX の移し替え、継ぎ目、許諾、計画から 1 本を作る(test/compose_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'compose_check.py')], {encoding: 'utf8'});
  assert.match(out, /OK/);
});

test('handFrame palm: 基準の姿勢の手のねじれを手のひらの向きで戻し、手以外の補正は変えない(test/palm_frame_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'palm_frame_check.py')], {encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1'}});
  assert.match(out, /palm frame ok/);
});

test('ExMR の仕上げ: 先頭の別カットの検出と置き換え、接地の区間、平滑(test/exmr_polish_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'exmr_polish_check.py')], {encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1'}});
  assert.match(out, /OK exmr polish/);
});

test('両手の握りを両腕で解く: 腕の違う体のねじれ、肘の向きの連続、届かないコマ(test/grip_arms_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'grip_arms_check.py')], {encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1'}});
  assert.match(out, /OK/);
});

test('武器を主に解く: 速い回転の時刻、握りの固定、地面と体から離す、物理の値(test/weapon_solve_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'weapon_solve_check.py')], {encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1'}});
  assert.match(out, /OK/);
});

test('体に合わせる直し: 手のめり込みの時間の処理と、VRM の首の長さ(test/body_fix_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'body_fix_check.py')], {encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1'}});
  assert.match(out, /"ok": true/);
});

test('首の範囲: 上限に収め、首と頭へ分け、腕は変えない(test/neck_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'neck_check.py')], {encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1'}});
  assert.match(out, /OK/);
});

test('指: 関節の軸へ移し、範囲へ収め、手と腕は変えない(test/fingers_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'fingers_check.py')], {encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1'}});
  assert.match(out, /OK/);
});

test('import-motion.mjs: 生成の記録と足の接地を一緒に取り込む', async () => {
  const lib = await tempDir(), work = await tempDir('charasta-src-');
  const file = (name, value) => { const f = path.join(work, name); return fs.writeFile(f, JSON.stringify(value)).then(() => f); };
  const lic = await file('lic.json', {holder: 'H', summary: 'S', redistribution: false});
  const gen = await file('gen.json', {tool: 'motion-compose'}), con = await file('con.json', {fps: 30, order: [], frames: [[1, 1, 0, 0]]});
  await run(process.execPath, [path.join(root, 'scripts/import-motion.mjs'), '--id', 'c-1', '--src', SAMPLE_VRMA, '--license-json', lic, '--generated-json', gen, '--contacts-json', con], {env: {...process.env, CHARASTA_LIBRARY: lib}});
  const m = JSON.parse(await fs.readFile(path.join(lib, 'motions/c-1/motion.json'), 'utf8'));
  assert.equal(m.generated.tool, 'motion-compose'); assert.equal(m.contacts, 'contacts.json');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(lib, 'motions/c-1/contacts.json'), 'utf8')).frames, [[1, 1, 0, 0]]);
});
