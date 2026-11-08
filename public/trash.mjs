// ごみ箱の画面(#trash): 移したものの一覧、戻す、完全に消す、空にする(docs/screens.md)。
import {h, getJSON, send} from './dom.mjs';
import {enc, when} from './shared.mjs';
import {confirmDialog} from './confirm.mjs';

const KIND = {character: 'キャラ', version: '版', line: 'セリフ', shoot: '撮った動画', motion: 'モーション', short: 'ショート', 'video-motion': '確認待ちの動画', 'text-motion': '確認待ちの文章からの動き', 'motion-gen': '確認待ちの MotionBricks の動き', other: '旧形式'};
export const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

export async function showTrash({main}) {
  const list = h('div', {class: 'trash-list'}), summary = h('div', {class: 'muted'}), msg = h('div', {class: 'muted', role: 'status'});
  const emptyBtn = h('button', {type: 'button', class: 'quiet'}, 'ごみ箱を空にする');
  let data = {items: [], count: 0, totalBytes: 0};

  // 完全に消す前の確認。「戻せないことを確かめた」のチェックを入れるまで押せない
  const purge = (title, text, run) => confirmDialog({title, body: [h('p', {}, text)], check: '戻せないことを確かめた', confirm: '完全に消す', run});

  function row(it) {
    const note = h('span', {class: 'err'});
    const restore = h('button', {type: 'button', disabled: !it.restorable, title: it.restorable ? null : '旧形式で、元の場所の記録が無いので戻せない'}, '戻す');
    restore.onclick = async () => {
      restore.disabled = true; note.textContent = '';
      try { await send('POST', `/api/trash/${enc(it.trashId)}/restore`); msg.textContent = `戻した: ${it.label}`; await load(); }
      catch (e) { note.textContent = '戻せない: ' + e.message; restore.disabled = false; }
    };
    const gone = h('button', {type: 'button', class: 'quiet', 'aria-label': `${it.label} を完全に消す`}, '完全に消す');
    gone.onclick = async () => {
      if (await purge(`「${it.label}」を完全に消す`, 'ごみ箱から消すと、もう戻せない。', () => send('DELETE', `/api/trash/${enc(it.trashId)}`))) { msg.textContent = `完全に消した: ${it.label}`; await load(); }
    };
    return h('div', {class: 'trash-row', 'data-trash': it.trashId},
      h('span', {class: 'tag'}, KIND[it.kind] ?? it.kind),
      h('div', {class: 'trash-name'}, it.label, it.charName && it.kind !== 'character' ? h('span', {class: 'muted'}, '　' + it.charName) : null, note),
      h('span', {class: 'muted'}, `${fmtSize(it.sizeBytes)}・${when(it.trashedAt)}`),
      h('div', {class: 'trash-actions'}, restore, gone));
  }

  function render() {
    summary.textContent = data.count ? `${data.count} 件、合計 ${fmtSize(data.totalBytes)}` : '';
    emptyBtn.hidden = !data.count;
    list.replaceChildren(...(data.count ? data.items.map(row) : [h('div', {class: 'empty small'}, 'ごみ箱は空')]));
  }
  async function load() { data = await getJSON('/api/trash'); render(); }

  emptyBtn.onclick = async () => {
    if (await purge('ごみ箱を空にする', `${data.count} 件（${fmtSize(data.totalBytes)}）を全部消す。もう戻せない。`, () => send('DELETE', '/api/trash'))) { msg.textContent = 'ごみ箱を空にした'; await load(); }
  };
  main.replaceChildren(h('div', {class: 'trash-page'},
    h('div', {class: 'page-head'}, h('h1', {}, 'ごみ箱'), emptyBtn),
    h('p', {class: 'muted'}, '消したものはここに移してある。戻すと元の場所に戻る。'), summary, msg, list));
  await load();
}
