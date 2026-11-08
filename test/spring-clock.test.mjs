// 揺れ骨の刻みの計算(public/spring-clock.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import {springParts, SPRING_DT, SPRING_MAX, GAP_DT} from '../public/spring-clock.mjs';

const sum = (parts, k) => parts.reduce((a, p) => a + p[k], 0);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} と ${b}`);

test('dt 1/60: 揺れ 1 歩だけで、余りの回は無い', () => {
  const r = springParts(1 / 60);
  assert.deepEqual(r.parts, [{dt: SPRING_DT, spring: SPRING_DT}]);
  assert.equal(r.rest, 0);
});

test('dt 1/30: 1/60 が 2 歩で、撮影の刻みは等分されない', () => {
  const r = springParts(1 / 30);
  assert.equal(r.parts.length, 2);
  assert.ok(r.parts.every(p => p.spring === SPRING_DT));
  assert.equal(r.rest, 0);
});

test('dt 1/144: 揺れを進めないコマはモーションだけ進め、積もると 1 歩進む', () => {
  let rest = 0, steps = 0;
  for (let i = 0; i < 144; i++) {
    const r = springParts(1 / 144, rest);
    near(sum(r.parts, 'dt'), 1 / 144);
    assert.ok(r.parts.length <= 2);
    steps += r.parts.filter(p => p.spring).length; rest = r.rest;
  }
  assert.ok(Math.abs(steps - 60) <= 1, `1 秒で ${steps} 歩`);
});

test('dt 0: モーションの回を 1 回だけ返し、揺れは進めない', () => {
  assert.deepEqual(springParts(0, 0.005).parts, [{dt: 0, spring: 0}]);
  assert.equal(springParts(0, 0.005).rest, 0.005);
});

test('揺らぎのある dt: モーションの合計は dt の合計に、揺れの歩数は時間に合う', () => {
  const list = [.017, .033, .05, .021, .0667, .012, .04, .05, .033, .017];
  let rest = 0, steps = 0, total = 0;
  for (let i = 0; i < 300; i++) {
    const dt = list[i % list.length], r = springParts(dt, rest);
    near(sum(r.parts, 'dt'), dt);
    assert.ok(r.parts.filter(p => p.spring).length <= SPRING_MAX);
    assert.ok(r.parts.length <= SPRING_MAX + 1);
    assert.ok(r.parts.every(p => p.dt >= 0));
    steps += sum(r.parts, 'spring') / SPRING_DT; rest = r.rest; total += dt;
  }
  near(steps * SPRING_DT + rest, total);
});

test('残りが 0 でない開始: 最初の回は次の切れ目までで、揺れは 1/60 のまま', () => {
  const r = springParts(1 / 60, 0.01);
  near(r.parts[0].dt, SPRING_DT - 0.01);
  assert.equal(r.parts[0].spring, SPRING_DT);
  assert.equal(r.parts.length, 2);
  near(r.parts[1].dt, 0.01); assert.equal(r.parts[1].spring, 0);
  near(r.rest, 0.01);
});

test('上限を超える dt は等分し、残りを持ち越さない', () => {
  const r = springParts(0.1);
  assert.equal(r.parts.length, SPRING_MAX);
  for (const p of r.parts) { near(p.dt, 0.1 / SPRING_MAX); near(p.spring, 0.1 / SPRING_MAX); }
  assert.equal(r.rest, 0); assert.equal(r.gap, false);
});

test('上限を超える dt: 残りの秒も揺れの等分に入れる', () => {
  const r = springParts(0.1, 0.01);
  near(sum(r.parts, 'dt'), 0.1); near(sum(r.parts, 'spring'), 0.11);
});

test('dt 1/20 は上限の中で 1/60 の刻みのまま', () => {
  const r = springParts(1 / 20);
  assert.equal(r.parts.length, 3);
  assert.ok(r.parts.every(p => p.spring === SPRING_DT));
});

test('0.25 を超える dt: 最初の 1 回は戻す印、続くコマは戻さず等分する', () => {
  const a = springParts(GAP_DT + 0.01, 0.01);
  assert.equal(a.gap, true);
  assert.deepEqual(a.parts, [{dt: GAP_DT + 0.01, spring: 0}]);
  assert.equal(a.rest, 0);
  const b = springParts(0.4, a.rest, a.inGap);
  assert.equal(b.gap, false); assert.equal(b.parts.length, SPRING_MAX); assert.equal(b.inGap, true);
  const c = springParts(1 / 60, b.rest, b.inGap);
  assert.equal(c.inGap, false);
  assert.equal(springParts(0.4, c.rest, c.inGap).gap, true);
});

test('ちょうど 0.25 は戻さない', () => { assert.equal(springParts(GAP_DT).gap, false); });
