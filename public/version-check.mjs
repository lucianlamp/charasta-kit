// 版の検査の欄(キャラのページ、docs/character-style.md)。GET /api/characters/<キャラ>/versions/<版>/check を開いたときに読み、項目と状態を並べる。
// スタンダードは VRoid 形式の検査、チビは軽い版と三角形などの検査。生き物とスタイル未設定は検査なしの理由だけを出す。
import {h, getJSON} from './dom.mjs';
import {enc} from './shared.mjs';

export const LEVEL_TEXT = {ok: 'ok', warn: 'warn', ng: 'ng', unknown: '分からない'};
const LEVEL_CLASS = {ok: 'yes', warn: 'no', ng: 'no', unknown: ''};

// 結果の要約の 1 行: 「ok 3 / warn 1 / 分からない 1」。0 の状態は出さない
export function summaryText(s) {
  return ['ok', 'warn', 'ng', 'unknown'].filter(k => s?.[k]).map(k => `${LEVEL_TEXT[k]} ${s[k]}`).join(' / ') || '項目なし';
}

export function checkPanel(c, ver) {
  const body = h('div', {class: 'stack-small'}, h('p', {class: 'muted', role: 'status'}, '検査を読んでいる…'));
  const head = h('summary', {}, '検査');
  const box = h('details', {class: 'check-box', open: ''}, head, body);
  getJSON(`/api/characters/${enc(c.id)}/versions/${enc(ver.id)}/check`).then(r => {
    if (!r.applicable) { body.replaceChildren(h('p', {class: 'muted'}, r.reason)); return; }
    head.textContent = `検査(${r.unavailable ? '手本なし' : summaryText(r.summary)})`;
    body.replaceChildren(
      ...(r.unavailable ? [h('p', {class: 'err'}, r.unavailable)] : []),
      h('ul', {class: 'check-list'}, r.items.map(i => h('li', {class: 'check-row', 'data-level': i.level},
        h('span', {class: `tag ${LEVEL_CLASS[i.level] ?? ''}`}, LEVEL_TEXT[i.level] ?? i.level),
        h('span', {class: 'check-text'}, h('span', {}, i.label), h('span', {class: 'muted'}, i.detail))))),
      h('p', {class: 'muted'}, `${r.cached ? '前の結果を使った' : '今測った'}(${r.checkedAt ? new Date(r.checkedAt).toLocaleString('ja-JP') : ''})`));
  }, e => body.replaceChildren(h('p', {class: 'err'}, '検査を読めない: ' + e.message)));
  return box;
}
