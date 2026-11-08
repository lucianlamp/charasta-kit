import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {parseVrma} from '../lib/vrma.mjs';
import {fakeGlb, SAMPLE_VRMA} from './helpers.mjs';

test('自作の VRMA(test/fixtures/sample.vrma)から長さと骨が取れる', async () => {
  const m = parseVrma(await fs.readFile(SAMPLE_VRMA));
  assert.ok(m.durationSec > 1 && m.durationSec < 60, String(m.durationSec));
  for (const b of ['hips', 'spine', 'head', 'leftUpperArm', 'rightHand']) assert.ok(m.bones.includes(b), b);
  assert.equal(m.usesShoulder, true);
});

test('VRMA でない glb は拒否する', () => {
  assert.throws(() => parseVrma(Buffer.from('xxxx')), /glb/);
  assert.throws(() => parseVrma(fakeGlb()), /アニメーション/);
  assert.throws(() => parseVrma(fakeGlb({animations: [{samplers: [], channels: []}]})), /humanBones/);
});

test('チャンネルの対象になっていない骨は含めず、肩が無ければ usesShoulder は false', () => {
  const glb = fakeGlb({
    accessors: [{max: [2.5], count: 3, componentType: 5126, type: 'SCALAR'}],
    animations: [{samplers: [{input: 0, output: 0}], channels: [{sampler: 0, target: {node: 1, path: 'rotation'}}]}],
    extensions: {VRMC_vrm_animation: {humanoid: {humanBones: {hips: {node: 0}, head: {node: 1}, leftShoulder: {node: 2}}}}},
  });
  const m = parseVrma(glb);
  assert.deepEqual(m, {durationSec: 2.5, bones: ['head'], usesShoulder: false});
});
