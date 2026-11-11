// モーションの画面: 左に一覧(出どころで絞る、利用条件の札)と入口(新しく作る・ファイルから・確認待ちの結果を見比べる)、中央にビューア(iframe)と再生のバー、
// 右に選んでいるモーションの情報と操作(これで撮る、これを元に作る、削除)(docs/screens.md)。作るのは別の画面(public/motion-create.mjs)、確認と取り込みはモーダル。
import {h, getJSON} from './dom.mjs';
import {enc, limitTag, pendingRow, viewerFrame, viewerReady, viewerHref, watchJobs} from './shared.mjs';
import {loadWaiting, openReviews} from './motion-review.mjs';
import {startFrom} from './recipe-motion.mjs';
import {rememberShootMotion} from './shoot.mjs';
import {moveToTrash} from './confirm.mjs';
import {attachScrub} from './scrub.mjs';
import {WEAPONS} from './weapon.mjs';
import {formDialog} from './dialog.mjs';

const GROUPS = [['all', 'すべて'], ['gen', '作った'], ['pack', 'VRoid'], ['other', 'そのほか']];
const groupOf = m => m.generated ? 'gen' : /VRoid/i.test(m.source?.pack ?? '') ? 'pack' : 'other';
const LICENSE_KEY = 'charasta.lastLicense';
function lastLicense() { try { return JSON.parse(localStorage.getItem(LICENSE_KEY)) || {}; } catch { return {}; } }
const duration = m => typeof m.durationSec === 'number' ? m.durationSec.toFixed(1) + 's' : '';
const nameOf = m => m.label || m.name || m.id;
// 動画から作ったモーションは、作ったときの体を出す。ほかのキャラに当てているときは注意の色にする
// 合わせたキャラやバージョンを消してあっても、記録の名前のまま出して「削除済み」と添える(ずれるので注意の色)
const fitNote = (m, char, ov) => {
  const f = m.fittedTo;
  if (!f) return null;
  const gone = !ov.chars.some(c => c.id === f.charId) ? '、キャラは削除済み' : f.charId === char?.id && !char.versions?.some(v => v.id === f.verId) ? '、バージョンは削除済み' : '';
  return {text: `${f.charName} 用（${f.verId}${gone}）`, warn: !!gone || (!!char && f.charId !== char.id)};
};
// 作る画面の URL(#motions/<キャラ>[/<バージョン>]/new)
export const createHref = (char, verId) => `#motions/${enc(char.id)}${verId ? '/' + enc(verId) : ''}/new`;

export async function showMotion({main, ov, char, verId, alive, jobsChanged, stageHref}) {
  let motions = await getJSON('/api/motions'), filter = 'all', picked = motions[0]?.id ?? null;
  const kit = ov.edition === 'kit';
  const count = h('span', {class: 'mono muted'}), chips = h('div', {class: 'chips', role: 'group', 'aria-label': '取り込み元で絞る'}), listBox = h('div', {class: 'motion-list'});
  const pendingBox = h('div', {class: 'pending-list'}), info = h('aside', {class: 'pane pane-right motion-detail', 'aria-label': '選んでいるモーション'});
  const reviewSlot = h('div', {class: 'review-slot'});
  const frame = char && verId ? viewerFrame(char.id, verId, picked ? {motion: picked} : {}) : null;
  const caption = h('div', {class: 'stage-caption'});
  const setCaption = () => {
    const m = motions.find(x => x.id === picked), fit = m && fitNote(m, char, ov);
    // 選んだモーションは一覧で分かるので、ここは注意があるときだけ出す
    caption.textContent = m && char && fit?.warn ? `${fit.text}に作ったモーションなので、手足の位置がずれる` : '';
  };

  async function pick(id) {
    picked = id; renderList(); renderInfo(); setCaption();
    if (!frame) return;
    (await viewerReady(frame)).play(id).catch(e => { caption.textContent = '再生できない: ' + e.message; });
  }
  function renderList() {
    count.textContent = motions.length;
    chips.replaceChildren(...GROUPS.filter(([k]) => k === 'all' || motions.some(m => groupOf(m) === k)).map(([k, label]) =>
      h('button', {type: 'button', class: 'chip-btn', 'aria-pressed': String(filter === k), onclick: () => { filter = k; renderList(); }}, label)));
    const rows = motions.filter(m => filter === 'all' || groupOf(m) === filter);
    listBox.replaceChildren(...(rows.length ? rows.map(m => motionRow(m, m.id === picked, pick, char, ov)) : [h('div', {class: 'empty small'}, 'モーションがまだない。「新しく作る」か「ファイルから」で足す。')]));
  }
  function renderInfo() {
    const m = motions.find(x => x.id === picked);
    info.replaceChildren(...(m ? motionInfo(m, char, ov, {
      shootHref: char ? stageHref('model', char) : null, rememberShoot: () => rememberShootMotion(m.id),
      createHref: char ? createHref(char, verId) : null, startFrom: () => startFrom(m), remove: () => remove(m)}) : [h('p', {class: 'muted'}, 'モーションを選ぶと、ここに情報と操作が出る。')]));
  }
  // 選んでいるモーションをごみ箱へ移す。一覧を読み直し、先頭を選び直す
  async function remove(m) {
    if (!await moveToTrash({kind: 'motion', id: m.id}, nameOf(m))) return;
    await refreshMotions();
    if (motions[0]) await pick(motions[0].id);
    else { picked = null; renderList(); renderInfo(); setCaption(); }
  }
  // ビューアがまだ読み込み中なら、読み込みが済むときに新しい一覧を読むので待たない
  const refreshMotions = async () => { motions = await getJSON('/api/motions'); renderList(); renderInfo(); await frame?.contentWindow?.viewer?.reloadMotions?.(); };

  // 確認待ちの結果: 件数つきのボタンでモーダルを開く。1 件も無いときはボタンを出さない
  let waiting = [];
  const refreshWaiting = async () => {
    waiting = await loadWaiting({kit});
    reviewSlot.replaceChildren(...(waiting.length ? [h('button', {type: 'button', class: 'review-open', onclick: openReview},
      h('span', {class: 'review-badge mono'}, String(waiting.length)), h('span', {class: 'grow'}, '確認待ちの結果を見比べる'), h('span', {'aria-hidden': 'true'}, '›'))] : []));
    return waiting;
  };
  const openReview = () => openReviews({waiting, char, verId, createHref: char ? createHref(char, verId) : '#motions',
    changed: async () => { await refreshMotions(); await watcher.poll(); jobsChanged(); return refreshWaiting(); }, onClose: refreshWaiting});
  const watcher = watchJobs({filter: j => j.type === 'motion-gen' || j.type === 'video-motion' || j.type === 'motion-text' || j.type === 'motion-recipe', alive, onJobs: jobs => pendingBox.replaceChildren(...jobs.map(pendingRow)), onDone: async () => {
    await refreshMotions();
    await refreshWaiting();
    jobsChanged();
  }});

  const center = h('section', {class: 'center', 'aria-label': 'ビューア'},
    h('div', {class: 'stage'}, frame ?? h('div', {class: 'empty'}, 'このキャラにはバージョンがまだない。つくるの画面で取り込む。')));
  if (frame) center.append(playBar(frame, alive, weaponPick(frame), toggles(frame), fullButton(center)),
    h('div', {class: 'stage-foot'}, caption, h('a', {class: 'link', href: viewerHref(char.id, verId), target: '_blank'}, '全部の操作があるビューアを開く')));
  const work = h('div', {class: 'work motion-work'},
    h('aside', {class: 'pane pane-left', 'aria-label': 'モーションの一覧'},
      h('div', {class: 'motion-head'}, h('div', {class: 'pane-head'}, h('h1', {}, 'モーション'), count),
        h('div', {class: 'motion-entry'}, char ? h('a', {class: 'button primary', href: createHref(char, verId)}, '新しく作る') : null,
          h('button', {type: 'button', class: 'outline', onclick: () => openImport(refreshMotions)}, 'ファイルから')),
        reviewSlot, pendingBox),
      h('div', {class: 'motion-browse'}, chips, listBox)),
    center, info);
  renderList(); renderInfo(); setCaption();
  main.replaceChildren(work);
  await watcher.poll();
  await refreshWaiting();
}

function motionRow(m, on, pick, char, ov) {
  const limit = m.limit, fit = fitNote(m, char, ov);
  return h('div', {class: 'motion-item' + (on ? ' on' : '')},
    h('button', {type: 'button', 'aria-pressed': String(on), 'data-name': m.id, onclick: () => pick(m.id)},
      h('span', {class: 'motion-top'}, h('span', {class: 'motion-name'}, nameOf(m)), h('span', {class: 'mono muted'}, duration(m))),
      limitTag(m) ? h('span', {class: limit.warn ? 'limit warn' : 'limit'}, limit.text) : null,
      fit ? h('span', {class: fit.warn ? 'limit warn' : 'limit'}, fit.text) : null));
}

// 作ったモーションの作り方。generated.tool は vrma-pipeline・rgbmocap・sam3d(動画)、motion-compose、Kimodo、MotionBricks。どれでもなければ取り込み元の名前
const VIDEO_TOOLS = new Set(['vrma-pipeline', 'rgbmocap', 'sam3d']);
const originKind = g => !g ? null : VIDEO_TOOLS.has(g.tool) ? 'video' : g.tool === 'motion-compose' ? 'compose' : g.tool === 'Kimodo' ? 'text' : /MotionBricks/i.test(`${g.tool} ${g.model}`) ? 'gen' : null;
const originOf = m => ({video: '動画から作った', compose: 'つないで作った', text: '文章から作った', gen: 'MotionBricks で作った'})[originKind(m.generated)] ?? m.source?.pack ?? 'ファイルから取り込んだ';
// 値の無い項目は出さない(undefined を文字にしない)
const parts = items => items.filter(([, v]) => v != null && v !== '').map(([k, v]) => k ? `${k} ${v}` : v).join('、');
function generatedNote(g) {
  if (!g) return null;
  const kind = originKind(g), frames = g.frames != null ? `${g.frames} コマ${g.fps != null ? `（${g.fps} fps）` : ''}` : null, job = g.job != null ? `ジョブ ${g.job}` : null;
  if (kind === 'video') return h('div', {class: 'muted'}, '動画から変換: ' + parts([[null, g.model], [null, frames], ['判定', g.quality], [null, job]]));
  if (kind === 'compose') return h('div', {class: 'muted'}, 'つないだ: ' + parts([[null, (g.segments ?? []).map(s => s.motionRecord?.id ?? s.label).join(' + ')], [null, frames], [null, job]]));
  return h('div', {class: 'muted'}, '生成: ' + parts([[null, g.model || g.tool], [null, frames], ['進んだ距離', g.travelM != null ? g.travelM + ' m' : null], [null, job]]));
}

// 右の欄: 選んでいるモーションの情報(長さ、取り込み元、利用条件、合わせた体と、細かい記録)と操作
function motionInfo(m, char, ov, act) {
  const g = m.generated, fit = fitNote(m, char, ov);
  const source = originOf(m);
  const facts = [['長さ', [typeof m.durationSec === 'number' ? m.durationSec.toFixed(1) + ' 秒' : '不明', g?.frames ? `${g.frames} コマ` : null].filter(Boolean).join('・')],
    ['取り込み元', source], ['利用条件', m.limit?.text ?? '不明', m.limit?.warn], fit ? ['合わせた体', fit.text, fit.warn] : null].filter(Boolean);
  return [h('div', {class: 'muted'}, '選んでいるモーション'), h('h2', {class: 'motion-title'}, nameOf(m)),
    h('dl', {class: 'facts'}, facts.flatMap(([k, v, warn]) => [h('dt', {}, k), h('dd', {class: warn ? 'warn' : ''}, v)])),
    h('details', {class: 'motion-info'}, h('summary', {}, 'このモーションの情報'),
      h('div', {class: 'muted'}, [m.id, m.usesShoulder ? '肩を動かす' : '肩は動かさない', (m.expressions || []).length ? '表情 ' + m.expressions.map(e => e.expression).join('・') : null].filter(Boolean).join('・')),
      m.license ? h('div', {class: 'muted'}, [m.license.holder, m.license.summary].filter(Boolean).join('：')) : null,
      m.source?.pack ? h('div', {class: 'muted'}, '取り込み元: ' + m.source.pack) : null,
      generatedNote(g),
      m.license?.rightsNote ? h('div', {class: 'muted'}, '権利のメモ: ' + m.license.rightsNote) : null,
      (m.license?.terms ?? []).filter(t => t.clips?.length).map(t => h('details', {},
        h('summary', {class: 'muted'}, `${t.part}: ${t.license}（${t.clips.length} 本）`),
        h('div', {class: 'muted'}, t.clips.join('、'))))),
    h('div', {class: 'stack-small motion-acts'},
      act.shootHref ? h('a', {class: 'button primary', href: act.shootHref, onclick: act.rememberShoot}, 'これで撮る（完成モデルへ）') : null,
      act.createHref ? h('a', {class: 'button outline', href: act.createHref, onclick: act.startFrom}, 'これを元に作る') : null),
    h('button', {type: 'button', class: 'quiet danger motion-remove', onclick: act.remove}, 'このモーションを削除')];
}

const SVG = 'http://www.w3.org/2000/svg';
function icon(d, attrs) {
  const svg = document.createElementNS(SVG, 'svg'), path = document.createElementNS(SVG, 'path');
  for (const [k, v] of Object.entries({viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true'})) svg.setAttribute(k, v);
  path.setAttribute('d', d);
  for (const [k, v] of Object.entries(attrs)) path.setAttribute(k, v);
  svg.append(path);
  return svg;
}

// 全画面。iPhone の Safari は動画以外の requestFullscreen が無いので、class で画面いっぱいに広げ、使えるところでは本物の全画面にも入る
export function fullButton(center) {
  const b = h('button', {type: 'button', class: 'toggle icon', 'aria-pressed': 'false', 'aria-label': '全画面'}, icon('M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4', {fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5'}));
  const show = on => { center.classList.toggle('full', on); b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? '全画面を閉じる' : '全画面'); };
  b.onclick = () => {
    const on = !center.classList.contains('full');
    show(on);
    if (on) center.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen();
  };
  // Esc で閉じたときはボタンの表示も戻す
  center.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) show(false); });
  return b;
}

// カメラ追従と足の IK。ビューアの window.viewer.follow / footIK を切り替える
export function toggles(frame) {
  const toggle = (text, title, key) => {
    const b = h('button', {type: 'button', class: 'toggle', 'aria-pressed': 'true', title}, text);
    b.onclick = async () => { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); (await viewerReady(frame))[key] = on; };
    return b;
  };
  return h('div', {class: 'stage-toggles'}, toggle('追従', 'カメラをキャラについていかせる', 'follow'), toggle('足を留める', '接地中の足を床に留める', 'footIK'));
}

// 手に持たせる武器。ビューアの window.viewer.weapon を切り替える。狭い画面でも隠さない(追従などの切り替えは隠れる)
export function weaponPick(frame) {
  const pick = h('select', {class: 'weapon-pick', 'aria-label': '武器', title: '手に持たせる武器（見た目だけ）'}, Object.entries(WEAPONS).map(([id, w]) => h('option', {value: id}, id === 'none' ? '武器なし' : w.label)));
  pick.onchange = async () => { (await viewerReady(frame)).weapon = pick.value; };
  return pick;
}

// 再生のバー: 再生と停止、位置の表示と移動。extra はバーの右端に並べる
export function playBar(frame, alive, ...extra) {
  const PLAY = 'M4 2.5v11l9-5.5z', PAUSE = 'M4 2.5h3v11H4zM9 2.5h3v11H9z';
  const svg = icon(PAUSE, {fill: 'currentColor'}), path = svg.firstChild;
  const btn = h('button', {type: 'button', class: 'play-btn primary', 'aria-label': '止める'}, svg);
  const now = h('span', {class: 'mono'}, '0.0 秒'), end = h('span', {class: 'mono'}, '0.0 秒');
  const range = h('input', {type: 'range', min: '0', max: '1', step: 'any', value: '0', 'aria-label': '再生の位置'});
  btn.onclick = async () => { const v = await viewerReady(frame); v.hold = !v.hold; };
  const fmt = t => t.toFixed(1) + ' 秒';
  const viewer = () => { const v = frame.contentWindow?.viewer; return v?.vrm ? v : null; };
  const scrub = attachScrub(range, viewer, t => { now.textContent = fmt(t); });
  const tick = () => {
    if (!alive()) return;
    const v = viewer();
    if (v?.duration) {
      if (Number(range.max) !== v.duration) { range.max = v.duration; end.textContent = fmt(v.duration); }
      // つまみを握っている間は、つまみの位置も時刻の表示もユーザーの操作が決める(再生の位置で上書きすると、つまみが戻される)
      if (!scrub.held) { range.value = v.time; now.textContent = fmt(v.time); }
      const hold = scrub.held ? !scrub.playing : v.hold;
      path.setAttribute('d', hold ? PLAY : PAUSE); btn.setAttribute('aria-label', hold ? '再生' : '止める');
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return h('div', {class: 'play-bar', 'aria-label': '再生'}, btn, h('div', {class: 'play-track'}, now, range, end), extra);
}

// ファイルから取り込むモーダル。VRMA を落とすか選び、ラベルと利用条件(権利者、要約、二次配布)を入れて POST /api/motions で取り込む(docs/motions.md)
function openImport(imported) {
  const last = lastLicense();
  const file = h('input', {type: 'file', accept: '.vrma', hidden: true});
  const label = h('input', {maxlength: '100', placeholder: '例: 手を振って歩く（空ならファイル名）'});
  const holder = h('input', {placeholder: '例: ピクシブ株式会社', value: last.holder || ''});
  const summary = h('input', {placeholder: '例: 改変可。取り出せる状態での二次配布は禁止', value: last.summary || ''});
  const redist = h('input', {type: 'checkbox'}); redist.checked = !!last.redistribution;
  const msg = h('p', {id: 'importMsg', class: 'muted', role: 'status'}), chosen = h('span', {class: 'muted'}, 'まだ選んでいない');
  let picked = null, busy = false;
  const drop = h('div', {class: 'drop', tabindex: '0', role: 'button'}, 'VRMA を選ぶか、ここへ置く');
  const pickFile = f => {
    if (!f) return;
    if (!/\.vrma$/i.test(f.name)) { msg.className = 'err'; msg.textContent = '.vrma のファイルを選ぶ'; return; }
    picked = f; chosen.textContent = `${f.name}（${(f.size / 1024).toFixed(0)} KB）`; msg.className = 'muted'; msg.textContent = '';
  };
  drop.onclick = () => file.click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); pickFile(e.dataTransfer.files[0]); };
  file.onchange = () => pickFile(file.files[0]);
  const no = h('button', {type: 'button', onclick: e => e.currentTarget.closest('dialog').close()}, 'やめる');
  const go = h('button', {type: 'button', class: 'primary'}, '取り込む');
  let x = null;   // × はモーダルを作るとき(formDialog)にできる
  go.onclick = async () => {
    if (!picked) { msg.className = 'err'; msg.textContent = '先に VRMA を選ぶ'; return; }
    if (!holder.value.trim() || !summary.value.trim()) { msg.className = 'err'; msg.textContent = '権利者と要約を入れる'; return; }
    const license = {holder: holder.value.trim(), summary: summary.value.trim(), redistribution: redist.checked};
    try { localStorage.setItem(LICENSE_KEY, JSON.stringify(license)); } catch { /* 次の入力の手間が増えるだけ */ }
    busy = true; go.disabled = no.disabled = x.disabled = true; msg.className = 'muted'; msg.textContent = '取り込み中…';
    try {
      // ヘッダには ASCII しか入らないので、ファイル名とラベルと利用条件は encodeURIComponent してから送る(サーバーは decodeURIComponent で戻す)
      const r = await fetch('/api/motions', {method: 'POST', body: picked, headers: {'content-type': 'model/gltf-binary', 'x-filename': encodeURIComponent(picked.name),
        ...(label.value.trim() && {'x-label': encodeURIComponent(label.value.trim())}), 'x-license': encodeURIComponent(JSON.stringify(license))}});
      const text = await r.text();
      if (!r.ok) throw Error(`${r.status} ${text}`);
      const m = JSON.parse(text);
      await imported();
      msg.className = 'muted'; msg.textContent = `取り込んだ: ${m.id}（${nameOf(m)}）。続けて別のファイルも取り込める。`;
      picked = null; file.value = ''; label.value = ''; chosen.textContent = 'まだ選んでいない';
    } catch (e) { msg.className = 'err'; msg.textContent = '取り込みに失敗: ' + e.message; }
    busy = false; go.disabled = no.disabled = x.disabled = false;
  };
  ({x} = formDialog({title: 'ファイルから取り込む', cls: 'import-dialog', busy: () => busy, body: [
    h('div', {class: 'form-stack', id: 'import'}, drop, file, chosen, h('label', {}, 'ラベル', label),
      h('fieldset', {class: 'form-stack'}, h('legend', {}, '利用条件'), h('label', {}, '権利者', holder), h('label', {}, '利用条件の要約', summary),
        h('label', {class: 'check'}, redist, '二次配布してよい'))),
    msg, h('div', {class: 'dialog-actions'}, no, go)]}));
  drop.focus();
}
