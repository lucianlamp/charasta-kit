// 本物の撮影の道具を通す試験。CHARASTA_TEST_VRM=<Fcl_ のキーを持つ VRM> のときだけ動く(ブラウザと GPU を使い、数分かかる)。
//   CHARASTA_TEST_VRM=D:/.../own.vrm [CHARASTA_TEST_MOTION=<motion のフォルダ>] node --test test/face-check-real.test.mjs
// index.json の形と絵のファイルを見て、ラベルどおりに違う絵かをバイトの差で確かめる(同じ絵が続いていないこと)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {Library} from '../lib/library.mjs';
import {startServer, fakeCharakuru, tempDir} from './helpers.mjs';

const VRM = process.env.CHARASTA_TEST_VRM, MOTION = process.env.CHARASTA_TEST_MOTION;
const sha = async f => crypto.createHash('sha1').update(await fs.readFile(f)).digest('hex');

test('本物の撮影: keys と motion の index.json と絵', {skip: VRM ? false : 'CHARASTA_TEST_VRM が無い'}, async () => {
  // 撮影の道具は設定を読むので、worktree に config.json が無くても動くよう一時の設定を渡す(ポートは --port で渡る)
  const cfg = path.join(await tempDir(), 'config.json');
  await fs.writeFile(cfg, '{"port": 0}');
  const s = await startServer({charakuruApp: await fakeCharakuru(), env: {CHARASTA_CONFIG: cfg}});
  const call = async (method, url, body) => (await fetch(s.base + url, {method, headers: {'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined})).json();
  const wait = async id => { for (;;) { const j = await call('GET', '/api/jobs/' + id); if (j.state === 'done' || j.state === 'failed') return j; await new Promise(r => setTimeout(r, 1000)); } };
  try {
    const lib = new Library(s.libraryDir);
    await lib.createCharacter({id: 'c1', name: 'C1'});
    await lib.importVersion({charId: 'c1', id: 'v1', label: '', note: 'n', data: await fs.readFile(VRM), sourcePath: VRM});
    const dir = path.join(s.libraryDir, 'characters', 'c1', 'versions', 'v1', 'checks');
    let j = await wait((await call('POST', '/api/jobs', {type: 'face-check', charId: 'c1', verId: 'v1', set: 'keys'})).id);
    assert.equal(j.state, 'done', j.error);
    const keys = JSON.parse(await fs.readFile(path.join(dir, 'keys', 'index.json'), 'utf8'));
    assert.ok(keys.length >= 57);
    const by = k => path.join(dir, 'keys', keys.find(p => p.key === k).file);
    assert.notEqual(await sha(by('Fcl_MTH_A')), await sha(by('Fcl_ALL_Neutral')));
    assert.notEqual(await sha(by('Fcl_EYE_Close')), await sha(by('Fcl_ALL_Neutral')));
    if (MOTION) {
      const id = path.basename(MOTION);
      await fs.cp(MOTION, path.join(s.libraryDir, 'motions', id), {recursive: true});
      j = await wait((await call('POST', '/api/jobs', {type: 'face-check', charId: 'c1', verId: 'v1', set: 'motion', motionId: id})).id);
      assert.equal(j.state, 'done', j.error);
      const m = JSON.parse(await fs.readFile(path.join(dir, 'motion', 'index.json'), 'utf8'));
      assert.equal(m.length, 90);
      for (const p of m) {
        await fs.access(path.join(dir, 'motion', p.file));
        assert.ok(p.camDist > .4 && p.camDist < .75, `${p.name}: カメラが頭に寄っていない(描いたカメラと頭の距離 ${p.camDist} m)`);
        assert.ok(Math.abs(p.camYaw - p.yaw) < 12, `${p.name}: カメラの向きがラベルと違う(${p.camYaw} 度)`);
        if (p.expr !== 'none') assert.ok(p.value > .99, `${p.name}: 表情が出ていない(値 ${p.value})`);
      }
      assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'motion', 'check.json'), 'utf8')).hair.measured, true);
    }
  } finally { await s.close(); }
});
