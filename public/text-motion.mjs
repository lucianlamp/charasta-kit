// 動きの「つくる」の文章の区間の部品と、文章から作った候補の確認の欄(docs/motion-text.md)。
// 文章を英語の説明文に直し、Kimodo で候補を作る。候補はビューアで見て、1 本を選んで取り込む(残りは捨てる)。
import {h, getJSON, send} from './dom.mjs';

const secText = v => Number(v).toFixed(1) + ' 秒';

// 文章の区間の部品(動きの「つくる」、public/recipe-motion.mjs)。o は GET /api/motion-texts。
// 区間が 1 つのときだけ queue(label) で motion-text ジョブを積む(2 つ以上のときは、先に作って確認待ちの結果を区間に使う)
export function textFields(o, onChange = () => {}) {
  const text = h('textarea', {rows: '4', maxlength: String(o.maxText), 'aria-label': 'どんな動き？', placeholder: '例: 剣を両手で持って、右から左へ大きく振る'});
  const seconds = h('input', {type: 'number', step: '0.5', min: '1', max: String(o.maxTotalSec), placeholder: '自動', 'aria-label': '長さ（秒）'});
  const cands = h('select', {'aria-label': '候補の本数'}, ...Array.from({length: o.candidates.max - o.candidates.min + 1}, (_, k) => o.candidates.min + k)
    .map(n => h('option', {value: n, selected: n === o.candidates.default}, `${n} 本`)));
  const root = h('select', {'aria-label': '移動'}, Object.entries(o.roots).map(([k, v]) => h('option', {value: k}, v)));
  text.addEventListener('input', onChange);
  const queue = async label => {
    if (!text.value.trim()) throw new Error('動きの文章を書く');
    return send('POST', '/api/jobs', {type: 'motion-text', text: text.value, seconds: seconds.value || undefined, candidates: Number(cands.value), root: root.value, label: label || undefined});
  };
  const name = () => text.value.trim().replace(/\s+/g, ' ').slice(0, 30) || '（文章を書く）';
  const el = h('div', {class: 'form-stack', id: 'motionTextPanel'},
    o.available ? null : h('p', {class: 'err'}, `Kimodo が見つからない（設定の kimodoDir: ${o.kimodoDir ?? 'なし'}）`),
    h('label', {}, 'どんな動き？', text),
    h('div', {class: 'seg'}, h('label', {}, '長さ（秒。空なら区間ごとに自動）', seconds), h('label', {}, '候補の本数', cands)),
    h('label', {}, '移動', root),
    h('p', {class: 'muted'}, `文章は英語の説明文に直すため、「作る」を押したときだけ Claude（claude -p）に送られる。文章のモデルの読み込みに約 ${o.loadMinutes} 分かかる（読み込み済みなら 30 秒ほど）。`
      + `1 区間は ${o.maxSegmentSec} 秒まで、区間を続けて ${o.maxTotalSec} 秒まで。作った候補は確認の欄で見て、1 本を取り込む。`));
  return {el, queue, name, available: o.available};
}

// 確認待ちのジョブを box に出す。preview(record) は候補をビューアで再生する。changed() は取り込み・捨てるのあとで呼ぶ
export async function showTextReviews(box, {preview, changed}) {
  const {waiting} = await getJSON('/api/motion-texts');
  box.replaceChildren(...waiting.map(j => reviewCard(j, {preview, changed})));
}

function reviewCard(j, {preview, changed}) {
  const r = j.result, id = encodeURIComponent(j.id);
  const label = h('input', {maxlength: '100', value: r.label, 'aria-label': 'ラベル'});
  const motionId = h('input', {value: 'text-' + j.id, 'aria-label': 'モーション ID'});
  const msg = h('span', {class: 'muted'});
  const buttons = [];
  const act = async (fn, busy) => {
    buttons.forEach(b => { b.disabled = true; }); msg.className = 'muted'; msg.textContent = busy;
    try { await fn(); await changed(); }
    catch (e) { msg.className = 'err'; msg.textContent = e.message; buttons.forEach(b => { b.disabled = false; }); }
  };
  const rows = r.candidates.map(c => {
    const see = h('button', {type: 'button', disabled: !preview, onclick: async () => {
      try { await preview({id: `text-${j.id}-${c.n}`, name: `候補 ${c.n}`, label: `${r.label}（候補 ${c.n}）`, file: c.vrmaUrl, contactsUrl: c.contactsUrl, generated: {root: r.root}}); msg.className = 'muted'; msg.textContent = ''; }
      catch (e) { msg.className = 'err'; msg.textContent = '再生できない: ' + e.message; }
    }}, '見る');
    const take = h('button', {type: 'button', class: 'primary', onclick: () => act(() => send('POST', `/api/motion-texts/${id}/import`,
      {n: c.n, label: label.value.trim(), motionId: motionId.value.trim()}), '取り込み中…')}, '取り込む');
    buttons.push(see, take);
    return h('div', {class: 'cand-row', 'data-cand': c.n}, h('span', {}, `候補 ${c.n}`), h('span', {class: 'muted'}, `${secText(c.durationSec)}、進んだ距離 ${c.travelM} m`), see, take);
  });
  const drop = h('button', {type: 'button', onclick: () => act(() => send('POST', `/api/motion-texts/${id}/discard`), '捨てている…')}, '全部捨てる');
  buttons.push(drop);
  return h('section', {class: 'form-stack sep video-review text-review', 'data-review': j.id},
    h('h2', {}, '候補を選んで取り込む'),
    h('div', {class: 'muted'}, '原文: ' + r.text),
    h('details', {}, h('summary', {class: 'muted'}, '英語の説明文（Kimodo に渡したもの）'),
      r.segments.map((s, k) => h('div', {class: 'muted'}, `区間 ${k + 1}（${s.seconds} 秒）: ${s.prompt}`))),
    ...rows,
    r.dropped?.length ? h('div', {class: 'limit warn'}, r.dropped.map(d => `候補 ${d.n} は捨てた: ${d.reason}`).join('。')) : null,
    h('div', {class: 'muted'}, r.licenseSummary ?? ''),
    h('label', {}, 'ラベル', label), h('label', {}, 'モーション ID', motionId),
    h('div', {class: 'seg'}, drop), msg);
}
