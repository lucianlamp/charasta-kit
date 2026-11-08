// 実機の Kimodo で、歩く文章が実際に進む動きになることを確かめる(VRMA の hips の道のりと太ももの振れ)。
// 既定ではスキップする。環境変数 CHARASTA_REAL_KIMODO=1 のときだけ動く。エンコーダは CHARASTA_KIMODO_ENCODER(既定 stream。埋め込みは一時フォルダに覚える)。
//   CHARASTA_REAL_KIMODO=1 node --test test/motion-text-real.test.mjs
//   CHARASTA_KIMODO_DIR(Kimodo のリポジトリ。必須)、CHARASTA_HF_CACHE(省くと既定の置き場)、CHARASTA_PYTHON(vrma_stats.py を動かす python)
// RAM の空きが ramNeed(lib/motion-text.mjs)未満なら、読み込まずにスキップする。英語への変換(claude)は通さず、英語の区間を直接渡す。
import test from 'node:test';
import {findPython} from '../lib/platform.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {root} from '../lib/config.mjs';
import {KimodoWorker} from '../lib/kimodo-worker.mjs';
import {ramNeed} from '../lib/motion-text.mjs';
import {tempDir} from './helpers.mjs';

const REAL = process.env.CHARASTA_REAL_KIMODO === '1' && !!process.env.CHARASTA_KIMODO_DIR;
const stats = file => JSON.parse(execFileSync(findPython() ?? 'python', [path.join(root, 'tools', 'vrma_stats.py'), file], {encoding: 'utf8'}));

test('実機の Kimodo: 歩く文章は、単体でも複数区間でも hips が進み、太ももが振れる', {skip: !REAL && 'CHARASTA_REAL_KIMODO=1 と CHARASTA_KIMODO_DIR のときだけ動く'}, async t => {
  const free = os.freemem() / 2 ** 30, need = ramNeed(process.env, false);
  if (free < need) return t.skip(`RAM の空きが ${free.toFixed(1)} GB しかない（${need} GB 要る）`);
  const dir = await tempDir('charasta-real-');
  const w = new KimodoWorker({kimodoDir: process.env.CHARASTA_KIMODO_DIR, hfCacheDir: process.env.CHARASTA_HF_CACHE,
    pidFile: path.join(dir, 'kimodo-worker.json'), encoder: process.env.CHARASTA_KIMODO_ENCODER || 'stream', embedDir: path.join(dir, 'embeddings'), idleMs: 0, log: () => {}});
  t.after(async () => { await w.close({final: true}); await fs.rm(dir, {recursive: true, force: true}); });
  const t0 = Date.now();
  await w.ensureLoaded();
  t.diagnostic(`読み込み ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);

  const cases = [
    ['単体', [{prompt: 'A person walks forward at a steady pace.', seconds: 5}], 3.0],
    ['複数区間（手を振る → 歩く）', [{prompt: 'A person stands and waves one hand side to side in front of the body.', seconds: 3},
      {prompt: 'A person walks forward at a steady pace.', seconds: 6}], 2.0],
  ];
  for (const [name, segments, minPath] of cases) {
    const out = path.join(dir, name);
    const t1 = Date.now();
    const r = await w.request('generate', {segments, seeds: [8516, 8517, 8518], root: 'keep', outDir: out}, {timeoutMs: 10 * 60 * 1000});
    t.diagnostic(`${name}: 生成 ${((Date.now() - t1) / 1000).toFixed(0)} 秒、候補 ${r.candidates.length} 本`);
    const walked = [];
    for (const c of r.candidates) {
      const s = stats(path.join(out, String(c.n), 'motion.vrma'));
      t.diagnostic(`${name} 候補 ${c.n}（seed ${c.seed}）: hips の道のり ${s.hipsPathM} m、直線 ${s.hipsStraightM} m、太ももの振れ ${s.legSwingDeg} 度、最大角 左 ${s.maxAngleDeg.leftUpperLeg} 右 ${s.maxAngleDeg.rightUpperLeg}`);
      assert.ok(s.hipsY[1] <= 2, 'hips が 2 m を超えない');
      if (s.hipsPathM >= minPath && s.legSwingDeg >= 20) walked.push(c.n);
    }
    // 候補は seed で出来が揺れるので、全部ではなく少なくとも 2 本が歩いていること
    assert.ok(walked.length >= 2, `${name}: 歩いた候補は ${walked.length}/${r.candidates.length} 本（道のり ${minPath} m 以上、太ももの振れ 20 度以上）`);
  }
});
