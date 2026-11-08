// 本物の版での書き出し。保管場所に nurse/v12-slim と chara3/v4-merged-face が無ければ飛ばす(face-check-real と同じ扱い)。
// 保管場所は読むだけで、書き出しは一時の保管場所へ写したものに対して行う。python(numpy と PIL)が要る。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {parseGlb} from '../lib/glb.mjs';
import {motionPose} from '../lib/vrma.mjs';
import {Library} from '../lib/library.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {tempDir} from './helpers.mjs';

// 実際のキャラとモーションが入った保管場所(環境変数 CHARASTA_REAL_LIBRARY。読むだけ)。無ければ飛ばす
const REAL = process.env.CHARASTA_REAL_LIBRARY || '';
const NEED = ['characters/nurse/versions/v12-slim/model.vrm', 'characters/chara3/versions/v4-merged-face/model.vrm', 'motions/knight-attack1/motion.vrma'];
const skip = REAL && NEED.every(f => fsSync.existsSync(path.join(REAL, f))) ? false : '保管場所に nurse/v12-slim か chara3/v4-merged-face か knight-attack1 が無い';

async function exportOf(char, ver, motions = []) {
  const dir = await tempDir('charasta-game-real-');
  for (const f of ['character.json', `versions/${ver}/model.vrm`, `versions/${ver}/version.json`]) {
    await fs.mkdir(path.dirname(path.join(dir, 'characters', char, f)), {recursive: true});
    await fs.copyFile(path.join(REAL, 'characters', char, f), path.join(dir, 'characters', char, f));
  }
  for (const m of motions) await fs.cp(path.join(REAL, 'motions', m), path.join(dir, 'motions', m), {recursive: true});
  const q = new JobQueue({lib: new Library(dir)});
  const job = await q.enqueue({type: 'game-export', charId: char, verId: ver, motions});
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error);
  const base = path.join(dir, 'characters', char, 'versions', ver, 'game'), [id] = await fs.readdir(base);
  return {dir, out: path.join(base, id), rec: JSON.parse(await fs.readFile(path.join(base, id, 'export.json'), 'utf8'))};
}

test('nurse/v12-slim: 三角形 20,000 以下、primitive 5 以下、表情と揺れものはそのまま、skirt は 1.5/0.6/0.3、authors は missing、その場の knight-attack1', {skip, timeout: 300000}, async () => {
  const {dir, out, rec} = await exportOf('nurse', 'v12-slim', ['knight-attack1']);
  try {
    assert.ok(rec.measure.after.triangles <= 20000, rec.measure.after.triangles);
    assert.ok(rec.measure.after.primitives <= 5);
    assert.equal(rec.measure.after.expressions, rec.measure.before.expressions);
    assert.deepEqual(rec.checks, {expressions: true, springJoints: true});
    const sb = parseGlb(await fs.readFile(path.join(out, 'model-game.vrm'))).json.extensions.VRMC_springBone.springs;
    for (const s of sb.filter(s => /skirt/i.test(s.name))) for (const j of s.joints) assert.deepEqual([j.stiffness, j.dragForce, j.gravityPower].map(v => Math.round(v * 100) / 100), [1.5, 0.6, 0.3]);
    assert.ok(sb.some(s => /hair/i.test(s.name)));
    assert.deepEqual(rec.steps.meta.missing, ['authors']);
    assert.ok(!JSON.stringify(parseGlb(await fs.readFile(path.join(out, 'model-game.vrm'))).json.extensions.VRMC_vrm.meta).includes('__CHARAKIT_REVIEW__'));
    const src = await fs.readFile(path.join(REAL, 'motions/knight-attack1/motion.vrma')), now = await fs.readFile(path.join(out, 'motions/knight-attack1.vrma'));
    assert.ok(motionPose(src).travel > 0.1);
    assert.ok(motionPose(now).travel < 1e-4);
    assert.ok(Math.abs(rec.motions[0].vertical - 0.1458) < 0.01);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('chara3/v4-merged-face: 三角形 40,000 以下、primitive 10、表情と揺れものはそのまま、authors は model の LUCIAN', {skip, timeout: 300000}, async () => {
  const {dir, out, rec} = await exportOf('chara3', 'v4-merged-face');
  try {
    assert.ok(rec.measure.after.triangles <= 40000, rec.measure.after.triangles);
    assert.equal(rec.measure.after.primitives, 10);
    assert.equal(rec.measure.after.expressions, rec.measure.before.expressions);
    assert.deepEqual(rec.checks, {expressions: true, springJoints: true});
    assert.deepEqual(rec.steps.meta.values.authors, ['LUCIAN']);
    assert.equal(rec.steps.meta.sources.authors, 'model');
    assert.deepEqual(rec.steps.meta.missing, []);
    assert.ok((await fs.stat(path.join(out, 'model-game.vrm'))).size < rec.measure.before.bytes);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
