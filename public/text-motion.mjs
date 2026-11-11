// モーションを作る画面の文章の区間の部品と、文章から作った候補の確認のモーダルの中身(docs/motion-text.md)。
// 文章を英語の説明文に直し、Kimodo で候補を作る。候補はビューアで見て、1 本を選んで取り込む(残りは捨てる)。
import {h, send} from './dom.mjs';

const secText = v => Number(v).toFixed(1) + ' 秒';

// 文章の区間の部品(モーションを作る画面、public/recipe-motion.mjs)。o は GET /api/motion-texts。
// 区間が 1 つのときだけ queue(label) で motion-text ジョブを積む(2 つ以上のときは、先に作って確認待ちの結果を区間に使う)
export function textFields(o, onChange = () => {}) {
  const text = h('textarea', {rows: '4', maxlength: String(o.maxText), 'aria-label': 'どんなモーション？', placeholder: '例: 剣を両手で持って、右から左へ大きく振る'});
  const seconds = h('input', {type: 'number', step: '0.5', min: '1', max: String(o.maxTotalSec), placeholder: '自動', 'aria-label': '長さ（秒）'});
  const cands = h('select', {'aria-label': '候補の本数'}, ...Array.from({length: o.candidates.max - o.candidates.min + 1}, (_, k) => o.candidates.min + k)
    .map(n => h('option', {value: n, selected: n === o.candidates.default}, `${n} 本`)));
  const root = h('select', {'aria-label': '移動'}, Object.entries(o.roots).map(([k, v]) => h('option', {value: k}, v)));
  text.addEventListener('input', onChange);
  const queue = async label => {
    if (!text.value.trim()) throw new Error('モーションの文章を書く');
    return send('POST', '/api/jobs', {type: 'motion-text', text: text.value, seconds: seconds.value || undefined, candidates: Number(cands.value), root: root.value, label: label || undefined});
  };
  const name = () => text.value.trim().replace(/\s+/g, ' ').slice(0, 30) || '（文章を書く）';
  const el = h('div', {class: 'form-stack', id: 'motionTextPanel'},
    o.available ? null : h('p', {class: 'err'}, `Kimodo が見つからない（設定の kimodoDir: ${o.kimodoDir ?? 'なし'}）`),
    h('label', {}, 'どんなモーション？', text),
    h('div', {class: 'seg'}, h('label', {}, '長さ（秒。空なら区間ごとに自動）', seconds), h('label', {}, '候補の本数', cands)),
    h('label', {}, '移動', root),
    h('p', {class: 'muted'}, `文章は英語の説明文に直すため、「作る」を押したときだけ Claude（claude -p）に送られる。文章のモデルの読み込みに約 ${o.loadMinutes} 分かかる（読み込み済みなら 30 秒ほど）。`
      + `1 区間は ${o.maxSegmentSec} 秒まで、区間を続けて ${o.maxTotalSec} 秒まで。作った候補は確認待ちの結果を見比べて、1 本を取り込む。`));
  // 下書きに残す値と、読み直したときに戻す(public/motion-create.mjs)
  const save = () => ({text: text.value, seconds: seconds.value, candidates: cands.value, root: root.value});
  const load = v => { for (const [el, x] of [[text, v.text], [seconds, v.seconds], [cands, v.candidates], [root, v.root]]) if (x != null) el.value = x; };
  return {el, queue, name, save, load, available: o.available, seconds: () => seconds.value === '' ? null : Number(seconds.value)};
}

// 確認待ちの結果 1 件を、確認のモーダルの中身にする(public/motion-review.mjs の形)。preview(record) は候補をモーダルのビューアで再生する。
// 取り込むのは選んだ候補 1 本(importBody の n)。「全部捨てる」は候補を全部捨てる
export function textReview(j, {preview}) {
  const r = j.result, group = 'cand-' + j.id;
  const record = c => ({id: `text-${j.id}-${c.n}`, name: `候補 ${c.n}`, label: `${r.label}（候補 ${c.n}）`, file: c.vrmaUrl, contactsUrl: c.contactsUrl, generated: {root: r.root}});
  const radios = r.candidates.map((c, k) => h('input', {type: 'radio', name: group, value: String(c.n), checked: k === 0, 'aria-label': `候補 ${c.n} を取り込む`}));
  const rows = r.candidates.map((c, k) => {
    radios[k].onchange = () => preview(record(c));
    return h('div', {class: 'cand-row', 'data-cand': c.n},
      h('label', {class: 'check'}, radios[k], `候補 ${c.n}`), h('span', {class: 'muted'}, `${secText(c.durationSec)}、進んだ距離 ${c.travelM} m`),
      h('button', {type: 'button', onclick: () => { radios[k].checked = true; preview(record(c)); }}, '見る'));
  });
  return {id: j.id, kind: '文章', label: r.label, motionId: 'text-' + j.id, api: `/api/motion-texts/${encodeURIComponent(j.id)}`,
    preview: r.candidates[0] ? record(r.candidates[0]) : null,
    facts: [['長さ', secText(r.durationSec)], ['候補', `${r.candidates.length} 本`]],
    info: [h('div', {class: 'muted'}, '原文: ' + r.text),
      h('details', {}, h('summary', {class: 'muted'}, '英語の説明文（Kimodo に渡したもの）'),
        r.segments.map((s, k) => h('div', {class: 'muted'}, `区間 ${k + 1}（${s.seconds} 秒）: ${s.prompt}`))),
      h('fieldset', {class: 'stack-small'}, h('legend', {}, '取り込む候補（残りは捨てる）'), rows),
      r.dropped?.length ? h('div', {class: 'limit warn'}, r.dropped.map(d => `候補 ${d.n} は捨てた: ${d.reason}`).join('。')) : null],
    terms: r.licenseSummary ?? '', discardText: '全部捨てる',
    importBody: () => ({n: Number(radios.find(x => x.checked)?.value ?? r.candidates[0]?.n)})};
}
