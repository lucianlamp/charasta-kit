import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {tempDir, fakeGlb, makeZip, SAMPLE_VRMA} from './helpers.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = (lib, script, ...args) => run(process.execPath, [path.join(root, 'scripts', script), ...args], {env: {...process.env, CHARASTA_LIBRARY: lib}});

test('CLI: キャラ作成、バージョン(--src と --src-charakit)、モーション、セリフ、同じ ID で止まる', async () => {
  const lib = await tempDir(), work = await tempDir('charasta-src-');
  const vrm = path.join(work, 'a.vrm'), audio = path.join(work, 'hello.mp3'), charakit = path.join(work, 'p.charakit');
  const inner = fakeGlb({inner: 1});
  await fs.writeFile(vrm, fakeGlb({a: 1})); await fs.writeFile(audio, 'mp3'); await fs.writeFile(charakit, makeZip({'documents/vrm/x.vrm': inner}));
  await fs.writeFile(path.join(work, 'lic.json'), JSON.stringify({holder: 'H', summary: 'S', redistribution: false}));
  await fs.writeFile(path.join(work, 'expr.json'), JSON.stringify([{from: 0.1, to: 0.4, expression: 'happy'}]));

  await cli(lib, 'new-character.mjs', '--id', 'chara4', '--name', 'キャラ4', '--note', 'n', '--voice', 'grok:eve', '--style', 'standard');
  await cli(lib, 'new-character.mjs', '--id', 'chara2', '--name', 'キャラ2', '--style', 'chibi');
  await assert.rejects(cli(lib, 'new-character.mjs', '--id', 'chara9', '--name', 'x'), /--style/);
  await cli(lib, 'import-version.mjs', '--char', 'chara4', '--id', 'v1', '--label', 'L', '--note', 'N', '--src', vrm, '--latest');
  await cli(lib, 'import-version.mjs', '--char', 'chara2', '--id', 'v1-shapekeys', '--src-charakit', charakit, '--member', 'documents/vrm/x.vrm', '--charakuru-project', 'proj-1');
  await cli(lib, 'import-motion.mjs', '--id', 'vrma-02', '--label', '挨拶', '--name', 'VRMA_02', '--src', SAMPLE_VRMA, '--license-json', path.join(work, 'lic.json'), '--expressions-json', path.join(work, 'expr.json'));
  await cli(lib, 'import-line.mjs', '--char', 'chara4', '--id', 'hello', '--text', 'こんにちは', '--voice', 'grok:eve', '--src', audio);

  const v = JSON.parse(await fs.readFile(path.join(lib, 'characters/chara2/versions/v1-shapekeys/version.json'), 'utf8'));
  assert.equal(v.charakuruProject, undefined); assert.equal(v.source.charakuruProject, 'proj-1');
  assert.deepEqual(await fs.readFile(path.join(lib, 'characters/chara2/versions/v1-shapekeys/model.vrm')), inner);
  const m = JSON.parse(await fs.readFile(path.join(lib, 'motions/vrma-02/motion.json'), 'utf8'));
  assert.equal(m.expressions[0].expression, 'happy'); assert.ok(m.durationSec > 1);

  await assert.rejects(cli(lib, 'import-version.mjs', '--char', 'chara4', '--id', 'v1', '--src', vrm), e => /exists/.test(e.stderr) && e.code === 1);
  await assert.rejects(cli(lib, 'new-character.mjs', '--id', 'chara4', '--name', 'x', '--style', 'standard'), /exists/);
  await assert.rejects(cli(lib, 'import-version.mjs', '--char', '../x', '--id', 'v9', '--src', vrm), /bad-id/);
  await assert.rejects(cli(lib, 'import-version.mjs', '--char', 'chara4', '--id', 'v9'), e => e.code === 2);
});
