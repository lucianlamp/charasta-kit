import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingAsks, resolveAsk} from '../lib/short-asks.mjs';

const short = () => ({id: 's1', title: 'カラス', ask: '全体にテンポを上げて', askedAt: '2026-11-04T10:00:00.000Z', cuts: [
  {who: '凛', text: 'A', camera: 'front_walk', ok: true, ask: 'もっと寄って', askedAt: '2026-11-04T09:00:00.000Z'},
  {who: 'ひより', text: 'B', camera: 'side_walk', ask: '書きかけ'},   // askedAt が無いのはまだ頼んでいない
  {who: '', text: '', camera: 'crow_close', ok: true}]});

test('対応待ちだけを、頼んだ順に並べる', () => {
  const asks = pendingAsks(short());
  assert.deepEqual(asks.map(a => a.cut), [1, null]);
  assert.equal(asks[0].now.camera, 'front_walk');
  assert.equal(asks[1].ask, '全体にテンポを上げて');
});

test('片付けると返事が残り、頼みごとと確認が外れる', () => {
  const s = short(), now = new Date('2026-11-04T11:00:00Z');
  const next = resolveAsk(s, {cut: 1, reply: 'カメラを話す人の寄りにした', now});
  assert.equal(next.cuts[0].reply, 'カメラを話す人の寄りにした');
  assert.equal(next.cuts[0].repliedAt, '2026-11-04T11:00:00.000Z');
  assert.equal(next.cuts[0].ask, undefined); assert.equal(next.cuts[0].askedAt, undefined); assert.equal(next.cuts[0].ok, undefined);
  assert.equal(next.cuts[2].ok, true, 'ほかのカットの確認は残す');
  assert.equal(s.cuts[0].ask, 'もっと寄って', '元のショートは変えない');
  const whole = resolveAsk(next, {reply: '声を 1.1 倍にした', now});
  assert.equal(whole.ask, undefined); assert.equal(whole.reply, '声を 1.1 倍にした');
  assert.deepEqual(pendingAsks(whole), []);
});

test('対応待ちでないもの、返事の無いものは断る', () => {
  assert.throws(() => resolveAsk(short(), {cut: 2, reply: 'x'}), /対応待ちではない/);
  assert.throws(() => resolveAsk(short(), {cut: 9, reply: 'x'}), /カット 9 が無い/);
  assert.throws(() => resolveAsk(short(), {cut: 1, reply: ' '}), /返事/);
});
