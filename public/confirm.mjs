// 確認の枠(<dialog>)と、ごみ箱へ移す操作。alert / confirm は使わない。
// moveToTrash は影響の一覧(GET .../impact)を箇条書きで見せ、「ごみ箱へ移す」で DELETE を送る(docs/characters.md の「ごみ箱」)。
import {h, getJSON, send} from './dom.mjs';
import {enc} from './shared.mjs';

const SVG = 'http://www.w3.org/2000/svg';
// ごみ箱の形のアイコン。名前は aria-label を付けるボタン側で持つ
export function trashIcon() {
  const svg = document.createElementNS(SVG, 'svg'), path = document.createElementNS(SVG, 'path');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  path.setAttribute('d', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6');
  for (const [k, v] of Object.entries({fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'})) path.setAttribute(k, v);
  svg.append(path);
  return svg;
}

// 確認の枠を出す。「やめる」か Esc で null、確定で run() の結果(無ければ true)を返す。run が失敗したら枠の中に理由を出して開いたままにする。
// check を渡すと、そのチェックを入れるまで確定のボタンを押せない。disabled は最初から押せない。tone は確定のボタンの色(消さない操作は primary)
// setup を渡すと {setDisabled} を渡して呼ぶ。枠の中の選択に合わせて確定のボタンを押せる・押せないにする
export function confirmDialog({title, body = [], confirm, cancel = 'やめる', check = null, disabled = false, tone = 'confirm', setup, run}) {
  return new Promise(resolve => {
    const titleId = 'dlg' + Math.random().toString(36).slice(2, 8);
    const err = h('div', {class: 'err', role: 'alert'}), no = h('button', {type: 'button'}, cancel), ok = h('button', {type: 'button', class: tone}, confirm);
    const box = check ? h('input', {type: 'checkbox'}) : null;
    const sync = () => { ok.disabled = disabled || (box ? !box.checked : false); };
    let busy = false;
    const dlg = h('dialog', {class: 'dialog', 'aria-labelledby': titleId}, h('h2', {id: titleId}, title), ...body,
      box ? h('label', {class: 'check'}, box, check) : null, err, h('div', {class: 'dialog-actions'}, no, ok));
    const done = value => { dlg.close(); dlg.remove(); resolve(value); };
    box?.addEventListener('change', sync);
    dlg.addEventListener('cancel', e => { e.preventDefault(); if (!busy) done(null); });
    no.onclick = () => done(null);
    ok.onclick = async () => {
      busy = true; ok.disabled = no.disabled = true; err.textContent = '';
      try { done((await run?.()) ?? true); }
      catch (e) { err.textContent = e.message; busy = false; no.disabled = false; sync(); }
    };
    setup?.({setDisabled: on => { disabled = on; if (!busy) sync(); }});
    sync();
    document.body.append(dlg);
    dlg.showModal();
    no.focus();
  });
}

const API = t => t.kind === 'short' ? `/api/shorts/${enc(t.id)}` : t.kind === 'motion' ? `/api/motions/${enc(t.id)}` : t.kind === 'character' ? `/api/characters/${enc(t.charId)}`
  : `/api/characters/${enc(t.charId)}/${{version: 'versions', line: 'lines', shoot: 'shoots'}[t.kind]}/${enc(t.id)}`;

// t: {kind: character|version|line|shoot|motion|short, charId, id}。移したら DELETE の結果、やめたら null。
// opts.before: 確定を押した直後、移す前に呼ぶ(再生中の動画を放すなど)。opts.onFail: 移せなかったときに呼ぶ
export async function moveToTrash(t, name, {before, onFail} = {}) {
  let impact;
  try { impact = await getJSON(API(t) + '/impact'); } catch (e) { impact = {effects: [], refusal: {message: '影響を調べられない: ' + e.message}}; }
  return confirmDialog({
    title: `「${name}」を削除`,
    body: [impact.effects.length ? h('ul', {}, impact.effects.map(x => h('li', {}, x.text))) : null,
      impact.refusal ? h('p', {class: 'err'}, impact.refusal.message) : h('p', {}, 'ごみ箱から戻せる。')],
    confirm: 'ごみ箱へ移す', disabled: !!impact.refusal,
    run: async () => { before?.(); try { return await send('DELETE', API(t)); } catch (e) { onFail?.(); throw e; } },
  });
}
