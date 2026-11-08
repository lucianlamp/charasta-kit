// キャラのスタイルのタブの絞り込みと数、最初に開くタブ、タブの下の 1 行、生き物の動きの名前と表(public/char-style.mjs)。docs/char-style.md、docs/creature.md
import test from 'node:test';
import assert from 'node:assert/strict';
import {CHAR_STYLES, STYLE_TABS, bandText, filterByStyleTab, isCreature, motionNames, motionRows, motionSummary, pickStyleTab, restyleChoices, styleLabel, styleOf, styleTabCounts, takeCreatureExample, vrmChars} from '../public/char-style.mjs';

const CROW = {rest: ['perch', 1, 1], fly: ['fly', 1, 24], clips: {down: ['perch', 96, 135], tilt: ['perch', 100, 160], stare: ['perch', 120, 192], caw: ['perch', 182, 186]},
  clipNames: ['down', 'tilt', 'stare', 'caw'], scale: 0.4, drop: 0, fps: 24, yaw: 0};
const chars = [{id: 'a', style: 'standard'}, {id: 'b', style: 'chibi'}, {id: 'c', style: null}, {id: 'd', style: 'standard'}, {id: 'e'}, {id: 'f', style: 'weird'},
  {id: 'crow', style: 'creature', kind: 'creature', creature: CROW}, {id: 'cat', style: 'creature', kind: 'creature', creature: null}];

test('数: 3 つのスタイルを数え、未設定(null、無い、知らない値)は「すべて」にだけ数える', () => {
  assert.deepEqual(styleTabCounts(chars), {standard: 2, chibi: 1, creature: 2, all: 8});
  assert.deepEqual(styleTabCounts([]), {standard: 0, chibi: 0, creature: 0, all: 0});
});

test('絞り込み: タブのスタイルだけを元の順で。「すべて」は未設定も含む。元の配列は変えない', () => {
  assert.deepEqual(filterByStyleTab(chars, 'standard').map(c => c.id), ['a', 'd']);
  assert.deepEqual(filterByStyleTab(chars, 'chibi').map(c => c.id), ['b']);
  assert.deepEqual(filterByStyleTab(chars, 'creature').map(c => c.id), ['crow', 'cat']);
  const all = filterByStyleTab(chars, 'all');
  assert.deepEqual(all.map(c => c.id), ['a', 'b', 'c', 'd', 'e', 'f', 'crow', 'cat']);
  assert.notEqual(all, chars);
  assert.equal(chars.length, 8);
});

test('生き物かどうか: 一覧は kind、キャラ 1 体は style で分かる。VRM の欄からは外す', () => {
  assert.equal(isCreature({kind: 'creature'}), true);
  assert.equal(isCreature({style: 'creature'}), true);
  assert.equal(isCreature({kind: 'vrm', style: 'standard'}), false);
  assert.equal(isCreature(null), false);
  assert.deepEqual(vrmChars(chars).map(c => c.id), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('最初のタブ: 覚えたタブを使う。無い・壊れているときはスタンダードがいればスタンダード、いなければすべて', () => {
  const counts = styleTabCounts(chars);
  assert.equal(pickStyleTab('chibi', counts), 'chibi');
  assert.equal(pickStyleTab('creature', counts), 'creature');
  assert.equal(pickStyleTab('all', counts), 'all');
  assert.equal(pickStyleTab(null, counts), 'standard');
  assert.equal(pickStyleTab('vtuber', counts), 'standard');
  assert.equal(pickStyleTab(null, styleTabCounts([{id: 'x', style: null}])), 'all');
  assert.equal(pickStyleTab(null, styleTabCounts([{id: 'crow', style: 'creature'}])), 'all');
  assert.equal(pickStyleTab('chibi', styleTabCounts([])), 'chibi');   // 0 体のタブでも、選んだものは守る
});

test('タブの下の 1 行: スタイルのタブは決まること、生き物は動きの名前を重ねずに足す、「すべて」は出さない', () => {
  assert.equal(bandText('standard'), '表情: シェイプキー(Fcl の 57 キー) / 形式: VRoid 形式の検査');
  assert.equal(bandText('chibi'), '表情: 画像(顔テクスチャのコマ) / 形式: 軽い版と三角形の数');
  assert.equal(bandText('creature'), '形式: Blender(骨と動き)');
  assert.equal(bandText('creature', chars), '形式: Blender(骨と動き) / 動き: 止まる、羽ばたく、down、tilt、stare、caw');
  const owl = {id: 'owl', kind: 'creature', creature: {rest: ['idle', 1, 1], clipNames: ['down', 'hoot']}};
  assert.equal(bandText('creature', [...chars, owl]), '形式: Blender(骨と動き) / 動き: 止まる、羽ばたく、down、tilt、stare、caw など');
  assert.equal(bandText('standard', chars), '表情: シェイプキー(Fcl の 57 キー) / 形式: VRoid 形式の検査');
  assert.equal(bandText('all', chars), null);
});

test('生き物の動き: 名前、カードの 1 行、表の行', () => {
  assert.deepEqual(motionNames(CROW), ['止まる', '羽ばたく', 'down', 'tilt', 'stare', 'caw']);
  assert.deepEqual(motionNames({rest: ['perch', 1, 1], clips: {down: ['perch', 1, 2]}}), ['止まる', 'down']);   // clipNames が無ければ clips の鍵
  assert.deepEqual(motionNames(null), []);
  assert.equal(motionSummary(CROW), '動き: 止まる、羽ばたく、down、tilt…');
  assert.equal(motionSummary({rest: ['perch', 1, 1]}), '動き: 止まる');
  assert.equal(motionSummary(null), null);
  const rows = motionRows(CROW);
  assert.deepEqual(rows.map(r => r.key), ['rest', 'fly', 'clips.down', 'clips.tilt', 'clips.stare', 'clips.caw']);
  assert.deepEqual(rows[2], {key: 'clips.down', name: 'down', action: 'perch', start: 96, end: 135});
  assert.deepEqual(motionRows({rest: ['perch', 1, 1], fly: null, clips: {bad: ['x', 1]}}).map(r => r.key), ['rest']);
  assert.deepEqual(motionRows(null), []);
});

test('ショートで使う書き方の見本: charId、perch、path([x, y, z] を 3 つ)', () => {
  const ref = JSON.parse(takeCreatureExample('crow'));
  assert.equal(ref.charId, 'crow');
  assert.equal(ref.perch, 0);
  assert.equal(ref.path.length, 3);
  assert.ok(ref.path.every(p => p.length === 3 && p.every(Number.isFinite)));
  assert.deepEqual(Object.keys(ref), ['charId', 'perch', 'path']);
});

test('スタイルを変えるときの候補: 版があると生き物とそれ以外のあいだは移れない', () => {
  assert.deepEqual(restyleChoices('standard', false), ['standard', 'chibi', 'creature']);
  assert.deepEqual(restyleChoices('creature', false), ['standard', 'chibi', 'creature']);
  assert.deepEqual(restyleChoices('standard', true), ['standard', 'chibi']);
  assert.deepEqual(restyleChoices(null, true), ['standard', 'chibi']);
  assert.deepEqual(restyleChoices('creature', true), []);
});

test('名前: タブの順と札。用途の言葉と、人型、デフォルメの語は使わない', () => {
  assert.deepEqual(STYLE_TABS.map(([k]) => k), ['standard', 'chibi', 'creature', 'all']);
  assert.equal(styleLabel('standard'), 'スタンダード');
  assert.equal(styleLabel('chibi'), 'チビ');
  assert.equal(styleLabel('creature'), '生き物');
  assert.equal(styleLabel(null), 'スタイル未設定');
  assert.equal(styleOf({style: 'weird'}), null);
  assert.equal(styleOf(undefined), null);
  assert.deepEqual(CHAR_STYLES.creature.steps, [['作り方', 'Blender で骨と動きを作り、scripts/import-creature.mjs で取り込む'], ['表情', 'なし(動きの Action を使う)']]);
  const text = JSON.stringify([CHAR_STYLES, STYLE_TABS]);
  for (const w of ['VTuber', '動画', 'ゲーム', '人型', 'デフォルメ']) assert.ok(!text.includes(w), w);
});
