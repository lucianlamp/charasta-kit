// 動きの「つくる」の MotionBricks の条件の区間の部品と、MotionBricks で作った動きの確認の欄(docs/motionbricks.md)。
// 区間が 1 つなら motion-gen ジョブを積み、2 つ以上ならレシピの motionbricks の区間になる(public/recipe-motion.mjs)。結果は確認の欄で見てから取り込む。
import {h, getJSON, send} from './dom.mjs';

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
  return {el, conditions, name, available: o.available, seconds: () => Number(seconds.input.value)};
}

// 区間 1 つのとき: motion-gen ジョブを積む
export const queueGen = (fields, label) => send('POST', '/api/jobs', {type: 'motion-gen', ...fields.conditions(), label: label || undefined});

// 確認待ちのジョブを box に出す。preview(record) は VRMA をビューアで再生する。changed() は取り込み・捨てるのあとで呼ぶ
export async function showGenReviews(box, {preview, changed}) {
  const {waiting} = await getJSON('/api/motion-gen');
  box.replaceChildren(...waiting.map(j => reviewCard(j, {preview, changed})));
}

function reviewCard(j, {preview, changed}) {
  const r = j.result, id = encodeURIComponent(j.id);
  const label = h('input', {maxlength: '100', value: r.label, 'aria-label': 'ラベル'});
  const motionId = h('input', {value: r.motionId, 'aria-label': 'モーション ID'});
  const msg = h('span', {class: 'muted'});
  const act = async (fn, busy) => {
    buttons.forEach(b => { b.disabled = true; }); msg.className = 'muted'; msg.textContent = busy;
    try { await fn(); await changed(); }
    catch (e) { msg.className = 'err'; msg.textContent = e.message; buttons.forEach(b => { b.disabled = false; }); }
  };
  const see = h('button', {type: 'button', disabled: !preview, onclick: async () => {
    try { await preview({id: `gen-${j.id}`, name: r.label, label: `${r.label}（確認中）`, file: r.vrmaUrl, contactsUrl: r.contactsUrl, generated: {root: j.input.root}}); msg.className = 'muted'; msg.textContent = ''; }
    catch (e) { msg.className = 'err'; msg.textContent = '再生できない: ' + e.message; }
  }}, '見る');
  const take = h('button', {type: 'button', class: 'primary', onclick: () => act(() => send('POST', `/api/motion-gen/${id}/import`, {label: label.value.trim(), motionId: motionId.value.trim()}), '取り込み中…')}, '取り込む');
  const drop = h('button', {type: 'button', onclick: () => act(() => send('POST', `/api/motion-gen/${id}/discard`), '捨てている…')}, '捨てる');
  const buttons = [see, take, drop];
  return h('section', {class: 'form-stack sep video-review gen-review', 'data-review': j.id},
    h('h2', {}, 'MotionBricks の動きを確かめて取り込む'),
    h('div', {class: 'muted'}, `${r.label}。${sec(r.durationSec)}、${r.frames} コマ、進んだ距離 ${Number(r.travelM).toFixed(1)} m`),
    h('div', {class: 'seg'}, see),
    h('div', {class: 'limit warn'}, '評価用のみ（動画は公開できない）'),
    h('details', {}, h('summary', {class: 'muted'}, '利用条件の全文'), h('div', {class: 'muted'}, r.license?.summary ?? '')),
    h('label', {}, 'ラベル', label), h('label', {}, 'モーション ID', motionId),
    h('div', {class: 'seg'}, take, drop), msg);
}
