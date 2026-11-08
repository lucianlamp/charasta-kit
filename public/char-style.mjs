// キャラのスタイル(スタンダード、チビ、生き物)の名前、決まること、ライブラリのタブの絞り込みと数(docs/char-style.md、docs/creature.md、docs/ui.md)。
// 生き物の動きの名前、動きの表の行、ショートから使う書き方の見本もここに置く。
// 絞り込みと数は DOM を使わない(テストが読み込める)。札と選ぶボタンは呼ばれたときだけ DOM を使う。
import {h} from './dom.mjs';

export const STYLE_IDS = ['standard', 'chibi', 'creature'];
export const VRM_STYLES = ['standard', 'chibi'];

// band: ライブラリのタブの下の 1 行。points: 新しいキャラの大きなボタンの短い行。steps: 「このスタイルで決まること」
export const CHAR_STYLES = {
  standard: {
    label: 'スタンダード',
    band: [['表情', 'シェイプキー(Fcl の 57 キー)'], ['形式', 'VRoid 形式の検査']],
    points: ['表情はシェイプキー', 'VRoid 形式で検査'],
    steps: [['作り方', 'きゃらくる(Tripo Studio)で rig と表情まで'], ['表情', 'キットの表情を kit_fcl で Fcl の 57 キーへ'], ['仕上げ', 'VRoid 形式への変換、輪郭線 0.8 mm、検査']],
  },
  chibi: {
    label: 'チビ',
    band: [['表情', '画像(顔テクスチャのコマ)'], ['形式', '軽い版と三角形の数']],
    points: ['表情は顔テクスチャの画像', '軽い版と三角形の数で検査'],
    steps: [['作り方', 'きゃらくる(Tripo Studio)で rig まで'], ['表情', '表情スタジオで image_gen の絵を顔テクスチャに'], ['仕上げ', '軽い版、三角形の数の検査']],
  },
  creature: {
    label: '生き物',
    band: [['形式', 'Blender(骨と動き)']],
    points: ['Blender の骨と動き', '表情は無く、動きの Action を使う'],
    steps: [['作り方', 'Blender で骨と動きを作り、scripts/import-creature.mjs で取り込む'], ['表情', 'なし(動きの Action を使う)']],
  },
};
export const UNSET_LABEL = 'スタイル未設定';
export const RESTYLE_WARNING = 'スタイルを変えると、表情を作り直すことになる';

// ライブラリのタブ。all は未設定のキャラも含む
export const STYLE_TABS = [['standard', 'スタンダード'], ['chibi', 'チビ'], ['creature', '生き物'], ['all', 'すべて']];
export const TAB_KEY = 'charasta.styleTab';

export const styleOf = c => (STYLE_IDS.includes(c?.style) ? c.style : null);
export const styleLabel = s => CHAR_STYLES[s]?.label ?? UNSET_LABEL;

// 生き物のキャラか。一覧(overview)は kind、キャラ 1 体の記録は style で分かる
export const isCreature = c => c?.kind === 'creature' || c?.style === 'creature';
// 生き物を除いたキャラ(出演者や MV を選ぶ欄)。順番は元のまま
export const vrmChars = chars => chars.filter(c => !isCreature(c));

// タブごとの数。{standard, chibi, creature, all}。未設定は all にだけ数える
export function styleTabCounts(chars) {
  const n = {standard: 0, chibi: 0, creature: 0, all: chars.length};
  for (const c of chars) { const s = styleOf(c); if (s) n[s]++; }
  return n;
}

// タブで絞ったキャラ。順番は元のまま
export const filterByStyleTab = (chars, tab) => (tab === 'all' ? [...chars] : chars.filter(c => styleOf(c) === tab));

// 最初に開くタブ。覚えていたタブがあればそれ。無い(か壊れている)ときは、スタンダードのキャラがいればスタンダード、いなければすべて
export function pickStyleTab(stored, counts) {
  if (STYLE_TABS.some(([k]) => k === stored)) return stored;
  return counts.standard > 0 ? 'standard' : 'all';
}

// 生き物の動きの名前。rest と fly は日本語、clips は名前のまま。creature は overview の chars[].creature か版の creature
export const REST_LABEL = '止まる', FLY_LABEL = '羽ばたく';
export function motionNames(creature) {
  if (!creature) return [];
  const clips = creature.clipNames ?? Object.keys(creature.clips ?? {});
  return [...(creature.rest ? [REST_LABEL] : []), ...(creature.fly ? [FLY_LABEL] : []), ...clips];
}
// 「動き: 止まる、羽ばたく、down、tilt…」。max を超えた分は「…」。動きが無ければ null
export function motionSummary(creature, max = 4) {
  const names = motionNames(creature);
  if (!names.length) return null;
  return `動き: ${names.slice(0, max).join('、')}${names.length > max ? '…' : ''}`;
}
// 動きの表の行 {key, name, action, start, end}。rest、fly、clips の順。形の崩れた値は飛ばす
export function motionRows(creature) {
  if (!creature) return [];
  const row = (key, name, v) => (Array.isArray(v) && v.length === 3 ? [{key, name, action: String(v[0]), start: v[1], end: v[2]}] : []);
  return [...row('rest', REST_LABEL, creature.rest), ...row('fly', FLY_LABEL, creature.fly),
    ...Object.entries(creature.clips ?? {}).flatMap(([k, v]) => row(`clips.${k}`, k, v))];
}
// ショートの take.creature に書く参照の見本(docs/creature.md の新しい書き方)。path は [x, y, z] を 3 つ
export const takeCreatureExample = charId => JSON.stringify({charId, perch: 0, path: [[0, 0, 0], [1, 0.5, 0], [2, 1, 0]]});

// タブの下の 1 行の文。すべては出さないので null。生き物は、chars にいる生き物の動きの名前を重ねずに足す(6 つまで)
export function bandText(tab, chars = []) {
  const style = CHAR_STYLES[tab];
  if (!style) return null;
  const parts = style.band.map(([k, v]) => `${k}: ${v}`);
  if (tab === 'creature') {
    const names = [...new Set(chars.filter(isCreature).flatMap(c => motionNames(c.creature)))];
    if (names.length) parts.push(`動き: ${names.slice(0, 6).join('、')}${names.length > 6 ? ' など' : ''}`);
  }
  return parts.join(' / ');
}

// スタイルを変えるときに選べるもの。版があるキャラは、生き物とそれ以外のあいだを移れない(サーバーも断る)
export function restyleChoices(style, hasVersions) {
  if (!hasVersions) return [...STYLE_IDS];
  return style === 'creature' ? [] : [...VRM_STYLES];
}

// 覚えたタブの読み書き。localStorage が使えなくても動く
export function loadStyleTab() { try { return localStorage.getItem(TAB_KEY); } catch { return null; } }
export function saveStyleTab(tab) { try { localStorage.setItem(TAB_KEY, tab); } catch { /* 次に開いたとき既定のタブになるだけ */ } }

// スタイルの札(カードとプロフィール)。色は CSS の data-style で決める
export const styleChip = s => h('span', {class: 'style-chip', 'data-style': styleOf({style: s}) ?? 'none'}, styleLabel(s));

// 大きな選ぶボタン。current: 今選んでいるもの(null 可)。onPick(s) を呼ぶ。ids: 出すスタイル(既定は 3 つ)。返すのは {box, set(s)}
export function styleChoices(current, onPick, ids = STYLE_IDS) {
  const box = h('div', {class: 'style-choices'});
  const set = s => box.replaceChildren(...ids.map(k => h('button', {type: 'button', class: 'choice style-choice', 'data-style': k, 'aria-pressed': String(k === s), onclick: () => { set(k); onPick(k); }},
    h('span', {class: 'choice-name'}, CHAR_STYLES[k].label), ...CHAR_STYLES[k].points.map(p => h('span', {class: 'muted'}, p)))));
  set(current);
  return {box, set};
}

// 「このスタイルで決まること」の箱。選ぶ前は案内の文を出す
export function styleStepsBox() {
  const body = h('div', {class: 'style-steps-body'});
  const box = h('div', {class: 'style-steps', 'aria-live': 'polite'}, h('h3', {}, 'このスタイルで決まること'), body);
  const set = s => body.replaceChildren(CHAR_STYLES[s]
    ? h('dl', {}, CHAR_STYLES[s].steps.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))
    : h('p', {class: 'muted'}, 'スタイルを選ぶと、ここに出る。選ぶまで「作り始める」は押せない。'));
  set(null);
  return {box, set};
}
