// URL を持たないモーダル(<dialog>)の共通の部分。取り込みのモーダル(motion.mjs)、確認のモーダル(motion-review.mjs)、完成モデルとつくるの小さなモーダルが使う。
// 決まり: document.body に付ける。Esc と × で閉じる。画面を移ったら(hashchange)閉じる。処理中(busy() が true)は Esc で閉じない。閉じたら取り除く。
import {h} from './dom.mjs';

export const dialogId = prefix => prefix + Math.random().toString(36).slice(2, 8);

// × のボタン。押すと自分を含む <dialog> を閉じる。処理中は呼ぶ側が disabled にする
export const closeButton = (cls = 'quiet') => h('button', {type: 'button', class: cls, 'aria-label': '閉じる', onclick: e => e.currentTarget.closest('dialog')?.close()}, '×');

// 作った <dialog> を開く。onClose は閉じて取り除いたあとに呼ぶ
export function showDialog(dlg, {busy = () => false, onClose} = {}) {
  dlg.addEventListener('cancel', e => { if (busy()) e.preventDefault(); });
  const onHash = () => dlg.close();
  window.addEventListener('hashchange', onHash);
  dlg.addEventListener('close', () => { window.removeEventListener('hashchange', onHash); dlg.remove(); onClose?.(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// 見出しと × と中身だけの小さなモーダル(スマホでは画面いっぱい)。返すのは {dlg, x}
export function formDialog({title, body = [], cls = '', busy, onClose}) {
  const titleId = dialogId('fd'), x = closeButton();
  const dlg = h('dialog', {class: `dialog form-dialog ${cls}`.trim(), 'aria-labelledby': titleId},
    h('div', {class: 'dialog-head'}, h('h2', {id: titleId}, title), x), ...body);
  showDialog(dlg, {busy, onClose});
  return {dlg, x};
}
