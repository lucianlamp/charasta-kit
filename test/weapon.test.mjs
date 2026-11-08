// ビューアの武器の握り(public/weapon.mjs)。休めの姿勢の手の位置を組み立てて、柄の向きと拳の穴の位置を確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import {WEAPONS, handGrip, weaponParts} from '../public/weapon.mjs';

// T ポーズの手。正面は +Z、手のひらは下。sign: 左手 +1(+X へ伸びる)、右手 -1
function hand(sign) {
  const row = z => ({Proximal: [sign * 0.1, 0, z], Intermediate: [sign * 0.13, 0, z], Distal: [sign * 0.15, 0, z]});
  return {hand: [0, 0, 0], lowerArm: [-sign * 0.25, 0, 0], fingers: {Index: row(0.03), Middle: row(0.01), Ring: row(-0.01), Little: row(-0.03)}};
}

test('柄は小指から人差し指へ向き、拳の穴は手のひらの下にある', () => {
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    const g = handGrip(hand(sign), side);
    assert.ok(g.axis[2] > 0.9, `${side}: 柄は親指の側(前)へ向く ${g.axis}`);
    assert.ok(g.center[1] < -0.01, `${side}: 穴は手のひらの下 ${g.center}`);
    assert.ok(sign * g.center[0] > 0.08 && sign * g.center[0] < 0.16, `${side}: 穴は指の付け根のあたり ${g.center}`);
    assert.ok(Math.abs(g.axis[0] * g.lie[0] + g.axis[1] * g.lie[1] + g.axis[2] * g.lie[2]) < 1e-9, 'lie は柄に直交する');
    assert.ok(sign * g.lie[0] > 0.9, `${side}: 拳は指の方へ寄る`);
  }
});

test('指の骨が無い体でも握りが決まる', () => {
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    const g = handGrip({hand: [0, 0, 0], lowerArm: [-sign * 0.25, 0, 0], fingers: {}}, side);
    assert.ok(g.axis[2] > 0.9, `${side}: 柄は前へ向く ${g.axis}`);
    assert.ok(g.center[1] < 0);
  }
});

test('弓は左手で持ち、矢は右手の指の向きへ伸びる', () => {
  const [bow, arrow, ...more] = weaponParts('bow', {left: hand(1), right: hand(-1)});
  assert.equal(more.length, 0);
  assert.equal(bow.hand, 'left'); assert.equal(arrow.hand, 'right');
  assert.ok(bow.axis[2] > 0.9, `弓は前後へ ${bow.axis}`);
  assert.ok(arrow.axis[0] < -0.9, `矢は右手の指の向きへ ${arrow.axis}`);
  assert.equal(weaponParts('none', {}).length, 0);
  assert.equal(weaponParts('sword', {left: hand(1), right: hand(-1)}).length, 1);
});

test('武器は持つ手が決まっていて、握る位置は全長の中にある', () => {
  for (const [id, w] of Object.entries(WEAPONS)) {
    if (id === 'none') continue;
    assert.ok(['left', 'right'].includes(w.hand), id);
    assert.ok(w.grip > 0 && w.grip < w.length, id);
  }
});
