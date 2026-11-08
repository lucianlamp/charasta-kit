import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pidPath, writePidFile, removePidFile} from '../lib/pidfile.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'charasta-pid-'));

test('server.pid: 起動で書き、前の番号は上書きする', () => {
  const d = tmp();
  fs.writeFileSync(pidPath(d), '111\n');
  writePidFile(d, 222);
  assert.equal(fs.readFileSync(pidPath(d), 'utf8').trim(), '222');
});

test('server.pid: 終わるときは自分の番号のときだけ消す', () => {
  const d = tmp();
  writePidFile(d, 333);
  removePidFile(d, 444);
  assert.ok(fs.existsSync(pidPath(d)), '別のサーバーの番号は消さない');
  removePidFile(d, 333);
  assert.ok(!fs.existsSync(pidPath(d)));
  removePidFile(d, 333);   // 無くても落ちない
});
