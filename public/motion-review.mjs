// 確認待ちの結果を見比べるモーダル(<dialog>。docs/screens.md の「モーション」)。結果を 1 件ずつタブで選び、元の動画とキャラに当てた結果を大きく出す。
// 中身は種類ごとのモジュールが同じ形で作る(videoReview、textReview、genReview、recipeReview):
//   {id, kind, label, motionId, api, media?, preview?, facts: [[名前, 値, 注意?]], tag?, terms?, termsLabel?, rightsNote?, info?, importBody?, discardText?}
//   media は比較の動画など見せる要素。無ければ preview(VRMA の記録)をモーダルの中のビューアで今のキャラに当てて再生する。
import {h, getJSON, send} from './dom.mjs';
import {viewerFrame, viewerReady} from './shared.mjs';
import {dialogId, showDialog} from './dialog.mjs';
import {videoReview} from './video-motion.mjs';
import {textReview} from './text-motion.mjs';
import {genReview} from './gen-motion.mjs';
import {recipeReview} from './recipe-motion.mjs';

// 確認待ちのジョブを読む。返すのは [{job, kind, build(ctx)}]。文章(Kimodo)は作者の版だけ(docs/edition.md)
export async function loadWaiting({kit}) {
  const lists = await Promise.all([['/api/video-motions', '動画', videoReview], kit ? null : ['/api/motion-texts', '文章', textReview], ['/api/motion-gen', 'MotionBricks', genReview], ['/api/motion-recipes', 'つないだ', recipeReview]]
    .filter(Boolean).map(async ([url, kind, build]) => (await getJSON(url)).waiting.map(job => ({job, kind, build: ctx => build(job, ctx)}))));
  return lists.flat();
}

// モーダルを開く。waiting は loadWaiting の結果、changed() は取り込み・捨てるのあとで呼び、新しい確認待ちを返す。createHref は「作り直す」の行き先
export function openReviews({waiting, char, verId, changed, createHref, onClose = () => {}}) {
  let items = waiting, index = 0, frame = null, busy = false, shown = 0;
  const titleId = dialogId('rv');
  const tabs = h('div', {class: 'review-tabs', role: 'tablist', 'aria-label': '確認待ちの結果'});
  const count = h('span', {class: 'mono muted review-count'});
  const prev = h('button', {type: 'button', class: 'quiet', 'aria-label': '前の結果', onclick: () => show(index - 1)}, '‹');
  const next = h('button', {type: 'button', class: 'quiet', 'aria-label': '次の結果', onclick: () => show(index + 1)}, '›');
  const close = h('button', {type: 'button', class: 'quiet review-close', 'aria-label': '閉じる', onclick: () => dlg.close()}, '×');
  const media = h('div', {class: 'review-media'}), side = h('aside', {class: 'review-side form-stack', 'aria-label': '結果の情報と操作'});
  const slot = h('div', {class: 'review-slot-media'}), stage = h('div', {class: 'review-stage'}), stageNote = h('p', {class: 'muted'});
  media.append(slot, stage, stageNote);
  const dlg = h('dialog', {class: 'dialog review-dialog', 'aria-labelledby': titleId},
    h('div', {class: 'review-head'}, h('h2', {id: titleId}, '確認待ちの結果'), tabs, h('div', {class: 'review-nav'}, prev, count, next), close),
    h('div', {class: 'review-body'}, media, side));

  // VRMA の結果はモーダルの中のビューアで再生する。ビューアは要るときに 1 つだけ作る
  async function play(record) {
    if (!char || !verId) { stageNote.textContent = 'このキャラにはバージョンが無いので、当てて再生できない。'; return; }
    if (!frame) { frame = viewerFrame(char.id, verId); stage.append(frame); }
    const mine = ++shown;
    stageNote.textContent = '';
    try { const v = await viewerReady(frame); if (mine === shown) await v.playCandidate(record); }
    catch (e) { stageNote.textContent = '再生できない: ' + e.message; }
  }
  const ctx = {preview: play};

  function show(k) {
    if (!items.length) { dlg.close(); return; }
    index = (k + items.length) % items.length;
    const spec = items[index].build(ctx);
    tabs.replaceChildren(...items.map((x, i) => h('button', {type: 'button', role: 'tab', class: 'review-tab', 'aria-selected': String(i === index), onclick: () => show(i)},
      `${x.job.result?.label ?? x.job.id}（${x.kind}）`)));
    count.textContent = `${index + 1} / ${items.length}`;
    prev.disabled = next.disabled = items.length < 2;
    // 見せるもの: 比較の動画か、ビューア
    // ビューアは DOM から外すと読み直しになるので、置いたまま隠す
    for (const v of media.querySelectorAll('video')) v.pause();
    slot.replaceChildren(...(spec.media ? [spec.media] : []));
    slot.hidden = !spec.media; stage.hidden = !!spec.media; stageNote.textContent = '';
    if (spec.media) shown++;
    else if (spec.preview) play(spec.preview); else stageNote.textContent = '再生できる結果が無い。';
    renderSide(spec);
  }

  function renderSide(spec) {
    const label = h('input', {maxlength: '100', value: spec.label ?? '', 'aria-label': 'ラベル'});
    const motionId = h('input', {value: spec.motionId ?? '', 'aria-label': 'モーション ID'});
    const msg = h('p', {class: 'muted', role: 'status'});
    const take = h('button', {type: 'button', class: 'primary big'}, '取り込んで次へ');
    const drop = h('button', {type: 'button'}, spec.discardText ?? '捨てる');
    const redo = h('a', {class: 'button', href: createHref, 'aria-disabled': String(busy), onclick: e => { if (busy) e.preventDefault(); else dlg.close(); }}, '作り直す');
    const act = async (path, body, doing) => {
      busy = true; take.disabled = drop.disabled = close.disabled = true; redo.setAttribute('aria-disabled', 'true'); msg.className = 'muted'; msg.textContent = doing;
      try {
        await send('POST', `${spec.api}/${path}`, body);
        items = await changed();
        busy = false; close.disabled = false;
        show(Math.min(index, items.length - 1));
      } catch (e) { busy = false; msg.className = 'err'; msg.textContent = e.message; take.disabled = drop.disabled = close.disabled = false; redo.setAttribute('aria-disabled', 'false'); }
    };
    take.onclick = () => act('import', {label: label.value.trim(), motionId: motionId.value.trim(), ...spec.importBody?.()}, '取り込み中…');
    drop.onclick = () => act('discard', undefined, '捨てている…');
    side.replaceChildren(...[
      h('dl', {class: 'facts'}, spec.facts.flatMap(([k, v, warn]) => [h('dt', {}, k), h('dd', {class: warn ? 'warn' : ''}, v)])),
      spec.tag?.text ? h('div', {class: spec.tag.warn ? 'limit warn' : 'limit'}, spec.tag.text) : null,
      spec.terms ? h('details', {}, h('summary', {class: 'muted'}, spec.termsLabel ?? '利用条件の全文'), h('div', {class: 'muted'}, spec.terms)) : null,
      ...(spec.info ?? []),
      h('label', {}, 'ラベル', label),
      h('details', {class: 'review-more'}, h('summary', {}, `詳しい設定（モーション ID${spec.rightsNote != null ? '、権利のメモ' : ''}）`),
        h('div', {class: 'form-stack'}, h('label', {}, 'モーション ID', motionId), spec.rightsNote != null ? h('div', {class: 'muted'}, '権利のメモ: ' + spec.rightsNote) : null)),
      take, h('div', {class: 'seg'}, redo, drop), msg].filter(Boolean));   // replaceChildren は null を文字の null にする
  }

  // 開いたまま戻るなどで画面を移ったら、モーダルも中のビューアも閉じて取り除く(showDialog)
  showDialog(dlg, {busy: () => busy, onClose});
  show(0);
  close.focus();
  return dlg;
}
