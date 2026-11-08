// 再生のバーのつまみ(public/scrub.mjs)。ブラウザの代わりに EventTarget の偽物で、握る、動かす、離すの順を確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import {attachScrub} from '../public/scrub.mjs';

function setup({hold = false, withWindow = true} = {}) {
  const range = Object.assign(new EventTarget(), {value: '0'});
  const seeks = [], shown = [];
  const v = {hold, seek: t => seeks.push([t, v.hold])};
  const win = new EventTarget();
  if (withWindow) globalThis.addEventListener = (t, f, o) => win.addEventListener(t, f, o);
  const scrub = attachScrub(range, () => v, t => shown.push(t));
  const fire = (target, type, value) => { if (value !== undefined) range.value = String(value); target.dispatchEvent(new Event(type)); };
  return {range, v, win, scrub, seeks, shown, fire};
}

test('動かす間は止めて、その時刻へ置き、時刻の表示を直す。離したら再生へ戻す', () => {
  const {range, v, scrub, seeks, shown, fire} = setup();
  fire(range, 'pointerdown');
  assert.equal(v.hold, true); assert.equal(scrub.held, true); assert.equal(scrub.playing, true);
  fire(range, 'input', 3.5); fire(range, 'input', 7.25);
  assert.deepEqual(seeks, [[3.5, true], [7.25, true]]);
  assert.deepEqual(shown, [3.5, 7.25]);
  fire(range, 'change');
  assert.equal(v.hold, false); assert.equal(scrub.held, false);
});

test('止めていたときは、離したあとも止めたまま', () => {
  const {range, v, scrub, fire} = setup({hold: true});
  fire(range, 'pointerdown'); fire(range, 'input', 2);
  assert.equal(scrub.playing, false);
  fire(range, 'pointerup');
  assert.equal(v.hold, true);
});

test('pointerdown が来なくても、最初の input で握り、change で離す(iPhone の Safari 対策)', () => {
  const {range, v, scrub, seeks, fire} = setup();
  fire(range, 'input', 5);
  assert.equal(v.hold, true); assert.equal(scrub.held, true);
  assert.deepEqual(seeks, [[5, true]]);
  fire(range, 'change');
  assert.equal(v.hold, false);
});

test('縦に流れて touchcancel や pointercancel になっても、止めたままにならない', () => {
  for (const type of ['touchcancel', 'pointercancel']) {
    const {range, v, fire} = setup();
    fire(range, 'touchstart'); fire(range, 'input', 4);
    assert.equal(v.hold, true);
    fire(range, type);
    assert.equal(v.hold, false, type);
  }
});

test('つまみの外で指を離しても(window の pointerup)戻す。二重に離しても壊れない', () => {
  const {range, v, win, fire} = setup();
  fire(range, 'pointerdown'); fire(range, 'input', 1);
  fire(win, 'pointerup');
  assert.equal(v.hold, false);
  fire(range, 'change'); fire(range, 'blur');
  assert.equal(v.hold, false);
});

test('ビューアがまだ無いときは何も握らない', () => {
  const range = Object.assign(new EventTarget(), {value: '1'});
  const shown = [];
  const scrub = attachScrub(range, () => null, t => shown.push(t));
  range.dispatchEvent(new Event('pointerdown')); range.dispatchEvent(new Event('input'));
  assert.equal(scrub.held, false); assert.deepEqual(shown, [1]);
});
