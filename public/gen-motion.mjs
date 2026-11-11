// モーションを作る画面の MotionBricks の条件の区間の部品と、MotionBricks で作った動きの確認の中身(docs/motionbricks.md)。
// 区間が 1 つなら motion-gen ジョブを積み、2 つ以上ならレシピの motionbricks の区間になる(public/recipe-motion.mjs)。結果は確認のモーダル(public/motion-review.mjs)で見てから取り込む。
import {h, send} from './dom.mjs';

const sec = v => Number(v).toFixed(1) + ' 秒';

// 条件の入力。o は GET /api/motion-gen。conditions() は motion-gen とレシピの区間に共通の条件、name() は一覧に出す短い名前、onChange は値が変わったとき
export function genFields(o, onChange = () => {}) {
  const opts = (table, sel) => Object.entries(table).map(([k, v]) => h('option', {value: k, selected: k === sel}, typeof v === 'string' ? v : v.label));
  const slider = (label, attrs, text) => {
    const input = h('input', {type: 'range', 'aria-label': label, ...attrs}), out = h('span', {class: 'mono value'});
    const show = () => { out.textContent = text(Number(input.value)); };
    input.addEventListener('input', () => { show(); onChange(); }); show();
    return {input, show, el: h('label', {}, h('span', {class: 'slider-head'}, h('span', {}, label), out), input)};
  };
  const kind = h('select', {'aria-label': '種類'}, opts(o.kinds, 'forward'));
  const speed = slider('速さ', {step: '0.01'}, v => v.toFixed(2) + ' m/s');
  const turn = slider('曲がる角度', {step: '15', min: String(o.turn[0]), max: String(o.turn[1]), value: '0'}, v => v === 0 ? 'まっすぐ' : `${v > 0 ? '左' : '右'}へ ${Math.abs(v)} 度`);
  const seconds = slider('長さ', {step: '0.5', min: String(o.seconds[0]), max: String(o.seconds[1]), value: '6'}, v => v + ' 秒');
  const action = h('select', {'aria-label': '途中の動作'}, opts(o.actions, 'none'));
  const direction = h('select', {'aria-label': '進む向き'}, opts(o.directions, 'forward'));
  const ending = h('select', {'aria-label': '終わり方'}, opts(o.endings, 'stop'));
  const rootSel = h('select', {'aria-label': '移動'}, opts(o.roots, 'keep'));
  const speedHint = h('span', {class: 'muted'});
  const dirLabel = h('label', {}, '進む向き（体の向きに対して）', direction);
  const actLabel = h('label', {}, `途中の動作（長さ ${o.actionMinSeconds} 秒以上）`, action);
  const sync = () => {
    const k = o.kinds[kind.value], s = speed.input;
    s.min = k.min; s.max = k.max;
    if (s.dataset.kind !== kind.value) { s.value = k.default; s.dataset.kind = kind.value; }
    speed.show();
    speedHint.textContent = `${k.min}〜${k.max}、標準 ${k.default}${k.note ? '。' + k.note : ''}`;
    dirLabel.hidden = !k.directions; actLabel.hidden = kind.value !== 'forward';
  };
  kind.onchange = () => { sync(); onChange(); };
  for (const el of [action, direction, ending, rootSel]) el.addEventListener('change', onChange);
  sync();
  const conditions = () => {
    const k = o.kinds[kind.value];
    return {kind: kind.value, speed: Number(speed.input.value), turn: Number(turn.input.value), seconds: Number(seconds.input.value), ending: ending.value, root: rootSel.value,
      ...(k.directions && {direction: direction.value}), ...(kind.value === 'forward' && {action: action.value})};
  };
  const name = () => `${o.kinds[kind.value].label} ${Number(speed.input.value).toFixed(2)} m/s、${seconds.input.value} 秒`;
  const el = h('div', {class: 'form-stack gen-fields'},
    o.available ? null : h('p', {class: 'err'}, `MotionBricks が見つからない（設定の motionbricksDir: ${o.motionbricksDir ?? 'なし'}）`),
    h('label', {}, '種類', kind), speed.el, speedHint, turn.el, seconds.el, actLabel,
    h('details', {}, h('summary', {}, '細かい条件'), h('div', {class: 'form-stack'}, dirLabel,
      h('label', {}, '終わり方', ending), h('label', {}, '移動（その場はビューアで見やすい）', rootSel))));
  // 下書きに残す値と、読み直したときに戻す(public/motion-create.mjs)
  const save = () => ({kind: kind.value, speed: speed.input.value, turn: turn.input.value, seconds: seconds.input.value, action: action.value, direction: direction.value, ending: ending.value, root: rootSel.value});
  const load = v => {
    if (o.kinds[v.kind]) { kind.value = v.kind; sync(); }
    for (const [el, x] of [[speed.input, v.speed], [turn.input, v.turn], [seconds.input, v.seconds], [action, v.action], [direction, v.direction], [ending, v.ending], [rootSel, v.root]]) if (x != null) el.value = x;
    speed.show(); turn.show(); seconds.show();
  };
  return {el, conditions, name, save, load, available: o.available, seconds: () => Number(seconds.input.value)};
}

// 区間 1 つのとき: motion-gen ジョブを積む
export const queueGen = (fields, label) => send('POST', '/api/jobs', {type: 'motion-gen', ...fields.conditions(), label: label || undefined});

// 確認待ちの結果 1 件を、確認のモーダルの中身にする(public/motion-review.mjs の形)
export function genReview(j) {
  const r = j.result;
  return {id: j.id, kind: 'MotionBricks', label: r.label, motionId: r.motionId, api: `/api/motion-gen/${encodeURIComponent(j.id)}`,
    preview: {id: `gen-${j.id}`, name: r.label, label: `${r.label}（確認中）`, file: r.vrmaUrl, contactsUrl: r.contactsUrl, generated: {root: j.input.root}},
    facts: [['長さ', `${sec(r.durationSec)}、${r.frames} コマ`], ['進んだ距離', `${Number(r.travelM).toFixed(1)} m`]],
    tag: {text: '評価用のみ（動画は公開できない）', warn: true}, terms: r.license?.summary ?? ''};
}
