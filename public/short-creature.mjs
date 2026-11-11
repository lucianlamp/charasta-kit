// 歩く 1 テイクのショートに出す生き物(take.creature。docs/creature.md の「画面」)。選ぶ欄、選んだときの take.creature、カットの「生き物の動き」が選べるか。
//   DOM は creaturePanel を呼んだときだけ使う(テストが読み込める)
import {h} from './dom.mjs';
import {isCreature} from './char-style.mjs';

// カットの始めに生き物がすること(lib/short.mjs の CREATURE_CUES と同じ順)
export const CREATURE_CUES = ['tilt', 'down', 'stare', 'takeoff'];
export const CUE_LABEL = {tilt: '首をかしげる（tilt）', down: '下を見る（down）', stare: 'じっと見る（stare）', takeoff: '鳴いて飛び立つ（takeoff）'};
// 選んだときの既定の止まり木と飛ぶ道。公園の並木道で撮ったカラスのショート(smvyu9mx3)の値。path は枝から先のベジェの残りの 3 点
export const DEFAULT_PERCH = 0;
export const DEFAULT_PATH = [[2.6, 12.8, 3.2], [1.2, 10.6, 1.3], [-4, 9.8, 1.7]];

const isPath = p => Array.isArray(p) && p.length === 3 && p.every(q => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite));
// none: 生き物なし、ref: キャラを参照する書き方、legacy: 前の書き方(blend のパスと全部の値)
export const creatureMode = c => (!c || typeof c !== 'object' ? 'none' : 'charId' in c ? 'ref' : 'legacy');

// 生き物のキャラを選んだときの take.creature。charId が空なら undefined(なし)。
// 同じキャラの参照はそのまま返す。ほかは {charId, perch, path} にして、今の perch と path(と flight)を保つ。前の書き方はここで初めて参照に置き換わる
export function pickCreature(now, charId) {
  if (!charId) return undefined;
  if (creatureMode(now) === 'ref' && now.charId === charId) return now;
  return {charId, perch: Number.isInteger(now?.perch) && now.perch >= 0 ? now.perch : DEFAULT_PERCH, path: isPath(now?.path) ? now.path : DEFAULT_PATH,
    ...(Number.isFinite(now?.flight) ? {flight: now.flight} : {})};
}

// カットの動きを照らす spec。前の書き方は take.creature そのもの、参照はそのキャラの最新バージョンの動き(overview の chars[].creature)
export function cueSpec(c, chars = []) {
  const mode = creatureMode(c);
  return mode === 'legacy' ? c : mode === 'ref' ? chars.find(x => x.id === c.charId)?.creature ?? null : null;
}
// その動きに足りないもの(lib/creature.mjs の checkCues と同じ決まり。takeoff は clips.caw と fly)
export function cueLacks(spec, cue) {
  if (!spec) return [];
  if (cue === 'takeoff') return [...(spec.clips?.caw ? [] : ['clips.caw']), ...(spec.fly ? [] : ['fly'])];
  return spec.clips?.[cue] ? [] : [`clips.${cue}`];
}
// カットの「生き物の動き」の選択肢 [{id, label, lacks}]。spec が分からないときは足りないものを出さない(サーバーが撮る前に確かめる)
export const cueOptions = spec => CREATURE_CUES.map(id => ({id, label: CUE_LABEL[id], lacks: cueLacks(spec, id)}));

// 生き物のキャラの一覧(最新バージョンがあるものだけ)
export const creatureChars = chars => chars.filter(c => isCreature(c) && c.latest);
const fileName = p => String(p ?? '').split(/[\\/]/).pop();

// 左の列の「生き物」の欄。take は s.take(書き換える)。onChange() は値を変えたあとに呼ぶ
export function creaturePanel(take, chars, onChange) {
  const box = h('div', {class: 'form-stack se-creature'});
  const set = c => { if (c) take.creature = c; else delete take.creature; onChange(); render(); };
  function render() {
    const c = take.creature, mode = creatureMode(c), list = creatureChars(chars);
    const choice = (on, name, note, pic, onclick) => h('button', {type: 'button', class: 'choice se-creature-choice', 'aria-pressed': String(on), onclick},
      pic ? h('img', {src: pic, alt: '', class: 'se-creature-pic'}) : h('span', {class: 'se-creature-pic none', 'aria-hidden': 'true'}),
      h('span', {class: 'se-item-text'}, h('span', {class: 'choice-name'}, name), note ? h('span', {class: 'muted'}, note) : null));
    const items = [
      choice(mode === 'none', 'なし', '人だけで歩く', null, () => { if (mode !== 'none') set(undefined); }),
      ...list.map(x => choice(mode === 'ref' && c.charId === x.id, x.name, x.id, x.thumb, () => set(pickCreature(c, x.id)))),
    ];
    // 前の書き方は選べる項目に無いので、押された状態の行を足して何を指しているかを出す
    if (mode === 'legacy') items.splice(1, 0, choice(true, '前の書き方', `${fileName(c.blend) || 'blend なし'} を直接指す。キャラを選ぶと参照に置き換える`, null, () => {}));
    // 参照しているキャラが一覧に無い(消した、生き物でなくなった)ときも、押された状態で出す
    if (mode === 'ref' && !list.some(x => x.id === c.charId)) items.splice(1, 0, choice(true, c.charId, '一覧に無いキャラ。保存できないので選び直す', null, () => {}));
    const fields = [];
    if (mode === 'ref') {
      const perch = h('input', {type: 'number', min: '0', max: '99', step: '1', value: String(c.perch ?? DEFAULT_PERCH), 'aria-label': '止まり木の番号'});
      perch.onchange = () => { const v = Number(perch.value); if (!Number.isInteger(v) || v < 0 || v > 99) { perch.value = String(c.perch); return; } c.perch = v; onChange(); };
      const ver = chars.find(x => x.id === c.charId)?.latest;
      fields.push(h('label', {}, '止まり木の番号（0 から。公園の並木道は 0〜2）', perch),
        h('p', {class: 'muted'}, `バージョン: ${c.verId ?? `最新${ver ? `（${ver.label || ver.id}）` : ''}`}。飛ぶ道（path）は今の値のまま保存する`));
    }
    if (!list.length && mode === 'none') fields.push(h('p', {class: 'muted'}, '生き物のキャラが無い。ライブラリで生き物のキャラを作り、scripts/import-creature.mjs でバージョンを取り込む'));
    box.replaceChildren(h('div', {class: 'se-creature-list', role: 'group', 'aria-label': '生き物'}, items), ...fields);
  }
  render();
  return box;
}
