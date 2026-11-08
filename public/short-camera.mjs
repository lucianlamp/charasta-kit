// ショートのカメラを「誰を撮る / 距離 / 角度と動き」の 3 つの軸で選ぶ。対応表はデザイン案 Main.dc.html の COMBOS(docs/ui.md の「ショート」)。
//   26 のカメラは lib/short.mjs の SHORT_CAMERAS。動画の種類: talk は立って話す、walk は歩く 1 テイク(short.take)、creature は枝の生き物がいる歩くテイク(take.creature)、dance はダンス MV(style が dance。stage-studio の lib/shots.py の FLOW のカメラ)
//   DOM は構図の絵(cameraSketch)を呼んだときだけ使う(テストが読み込める)

export const CAMERA_COMBOS = [
  {id: 'talk_close', who: '決まった人', dist: '寄り', move: '正面', kinds: ['talk']},
  {id: 'talk_bust', who: '決まった人', dist: '胸から上', move: '正面', kinds: ['talk']},
  {id: 'talk_wide', who: '決まった人', dist: '全身', move: '正面', kinds: ['talk']},
  {id: 'orbit', who: '決まった人', dist: '胸から上', move: '回り込む', kinds: ['talk', 'dance']},
  {id: 'wide_push', who: '決まった人', dist: '全身', move: '寄っていく', kinds: ['talk', 'dance']},
  {id: 'low_feet', who: '決まった人', dist: '全身', move: '下から', kinds: ['talk', 'dance']},
  {id: 'face_who', who: '話す人', dist: '大写し', move: '正面', kinds: ['talk']},
  {id: 'close_who', who: '話す人', dist: '寄り', move: '正面', kinds: ['talk']},
  {id: 'bust_who', who: '話す人', dist: '胸から上', move: '正面', kinds: ['talk']},
  {id: 'over_shoulder', who: '話す人', dist: '胸から上', move: '肩越し', kinds: ['talk']},
  {id: 'two_shot', who: '2 人', dist: '引き', move: '正面', kinds: ['talk']},
  {id: 'pull_back', who: '2 人', dist: '引き', move: '引いていく', kinds: ['talk']},
  {id: 'prop_close', who: '手紙', dist: '寄り', move: '正面', kinds: ['talk'], need: '手紙を持つカットだけ'},
  {id: 'prop_line', who: '手紙', dist: '大写し', move: '正面', kinds: ['talk'], need: '手紙を持つカットだけ'},
  {id: 'front_walk', who: '2 人', dist: '全身', move: '正面', kinds: ['walk', 'creature']},
  {id: 'side_walk', who: '2 人', dist: '全身', move: '横', kinds: ['walk', 'creature']},
  {id: 'back_walk', who: '2 人', dist: '全身', move: '後ろ', kinds: ['walk', 'creature']},
  {id: 'diag_walk', who: '2 人', dist: '全身', move: '斜め前', kinds: ['walk', 'creature']},
  {id: 'walk_close', who: '話す人', dist: '胸から上', move: '正面', kinds: ['walk', 'creature']},
  {id: 'crow_close', who: '生き物', dist: '寄り', move: '回り込む', kinds: ['creature']},
  {id: 'crow_takeoff', who: '2 人', dist: '引き', move: '見上げる', kinds: ['creature']},
  // ダンス MV のカメラ(stage-studio の lib/shots.py の shot_*)。wide_push、orbit、low_feet は上にある
  {id: 'close', who: '決まった人', dist: '寄り', move: '正面', kinds: ['dance']},
  {id: 'crane_up', who: '決まった人', dist: '引き', move: '上がっていく', kinds: ['dance']},
  {id: 'crane_down', who: '決まった人', dist: '引き', move: '下がっていく', kinds: ['dance']},
  {id: 'side_track', who: '決まった人', dist: '全身', move: '並走する', kinds: ['dance']},
  {id: 'high_top', who: '決まった人', dist: '引き', move: '真上から', kinds: ['dance']},
];
export const CAMERA_AXES = [
  {key: 'who', label: '誰を撮る', values: ['話す人', '決まった人', '2 人', '生き物', '手紙']},
  {key: 'dist', label: '距離', values: ['大写し', '寄り', '胸から上', '全身', '引き']},
  {key: 'move', label: '角度と動き', values: ['正面', '斜め前', '横', '後ろ', '肩越し', '下から', '見上げる', '寄っていく', '引いていく', '回り込む', '上がっていく', '下がっていく', '並走する', '真上から']},
];
export const KIND_LABEL = {talk: '立って話す', walk: '歩く 1 テイク', creature: '歩く 1 テイク · 枝の生き物あり', dance: 'ダンス MV'};
const KIND_NAME = {talk: '立って話す動画', walk: '歩く 1 テイク', creature: '枝の生き物がいる動画', dance: 'ダンス MV'};

// ショートの動画の種類
export const shortKind = short => (short.style === 'dance' ? 'dance' : short.take ? (short.take.creature ? 'creature' : 'walk') : 'talk');
// その種類で使えるカメラの ID
export const camerasFor = kind => CAMERA_COMBOS.filter(c => c.kinds.includes(kind)).map(c => c.id);
export const comboOf = id => CAMERA_COMBOS.find(c => c.id === id) ?? null;
export const cameraLabel = id => { const c = comboOf(id); return c ? `${c.who} · ${c.dist} · ${c.move}` : id; };

// 1 つの軸を value に変えたとき、その種類で使えて、ほかの軸がなるべく今のままのカメラ。無ければ null
export function chooseCamera(nowId, key, value, kind) {
  const now = comboOf(nowId) ?? {};
  const score = c => CAMERA_AXES.reduce((n, a) => n + (a.key !== key && c[a.key] === now[a.key] ? 1 : 0), 0);
  let best = null;
  for (const c of CAMERA_COMBOS) if (c[key] === value && c.kinds.includes(kind) && (!best || score(c) > score(best))) best = c;
  return best;
}

// 画面の軸のボタンの中身。off は押せない値で、why はその理由(押せる値では、そのカメラの条件)
export function cameraAxes(nowId, kind) {
  const now = comboOf(nowId) ?? {};
  // ダンス MV だけの値(上がっていく、など)は、ほかの動画の種類のボタンには出さない
  const shown = (a, v) => kind === 'dance' || CAMERA_COMBOS.some(x => x[a.key] === v && x.kinds.some(k => k !== 'dance'));
  const axes = CAMERA_AXES.map(a => ({key: a.key, label: a.label, items: a.values.filter(v => shown(a, v)).map(value => {
    const pick = chooseCamera(nowId, a.key, value, kind), off = !pick;
    const why = off ? (CAMERA_COMBOS.some(x => x[a.key] === value) ? `${KIND_NAME[kind]}では使えない` : 'このカメラは無い') : pick.need ?? '';
    return {value, on: now[a.key] === value, off, why, camera: pick?.id ?? null};
  })}));
  const off = CAMERA_AXES.flatMap(a => a.values.filter(v => shown(a, v) && !CAMERA_COMBOS.some(x => x[a.key] === v && x.kinds.includes(kind))));
  const usable = now.kinds?.includes(kind);
  return {axes, offNote: off.length ? `薄い選択肢(${off.join('、')})は${KIND_NAME[kind]}では使えない` : '',
    hint: usable ? now.need ?? '' : `${KIND_NAME[kind]}では使えないカメラ。軸から選び直す`};
}

// 構図の絵(120x160)。人の形と、距離の枠
const FRAME = {'大写し': [40, 26, 40, 34], '寄り': [32, 20, 56, 60], '胸から上': [26, 16, 68, 86], '全身': [18, 10, 84, 146], '引き': [6, 4, 108, 154]};
const SHAPES = {
  pair: [['circle', {cx: 42, cy: 44, r: 12}], ['path', {d: 'M24 150 L28 70 Q42 58 56 70 L60 150 Z'}], ['circle', {cx: 80, cy: 46, r: 12}], ['path', {d: 'M62 150 L66 72 Q80 60 94 72 L98 150 Z'}]],
  single: [['circle', {cx: 60, cy: 42, r: 15}], ['path', {d: 'M36 150 L40 68 Q60 54 80 68 L84 150 Z'}]],
  bird: [['path', {d: 'M10 100 L110 86', stroke: '#6E7786', 'stroke-width': 5, 'stroke-linecap': 'round', fill: 'none'}], ['ellipse', {cx: 62, cy: 76, rx: 20, ry: 13}], ['circle', {cx: 80, cy: 64, r: 8}], ['path', {d: 'M87 64 L98 67 L87 69 Z'}]],
  letter: [['rect', {x: 30, y: 50, width: 60, height: 76, rx: 3, fill: '#C3C9D3'}], ['path', {d: 'M38 66 H82 M38 78 H82 M38 90 H72 M38 104 H80', stroke: '#0B0D10', 'stroke-width': 4, fill: 'none'}]],
};
const shapeOf = who => (who === '2 人' ? 'pair' : who === '生き物' ? 'bird' : who === '手紙' ? 'letter' : 'single');
export function cameraSketch(id, {width = 66, height = 88} = {}) {
  const c = comboOf(id), ns = 'http://www.w3.org/2000/svg', el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
  const svg = el('svg', {width, height, viewBox: '0 0 120 160', role: 'img', 'aria-label': `構図: ${cameraLabel(id)}`, class: 'cam-sketch'});
  if (!c) return svg;
  for (const [tag, attrs] of SHAPES[shapeOf(c.who)]) svg.append(el(tag, {fill: '#6E7786', ...attrs}));
  const [x, y, w, hgt] = FRAME[c.dist];
  svg.append(el('rect', {x, y, width: w, height: hgt, fill: 'none', stroke: '#D4F25A', 'stroke-width': 4, rx: 4}));
  return svg;
}
// ダンス MV で選べるカメラ(拍から割ると stage-studio の FLOW の順で入る)
export const DANCE_CAMERAS = camerasFor('dance');
// ビューアで確かめるときの写す範囲
export const cameraFraming = id => { const d = comboOf(id)?.dist; return d === '大写し' || d === '寄り' ? 'face' : d === '全身' || d === '引き' ? 'full' : 'upper'; };
