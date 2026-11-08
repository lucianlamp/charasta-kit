// 動き: モーションの一覧(出どころで絞る、利用条件の札)、真ん中のビューア(iframe)と再生のバー、モーションを足す(つくる・ファイル)(docs/screens.md)。
import {h, getJSON} from './dom.mjs';
import {pendingRow, viewerFrame, viewerReady, viewerHref, watchJobs} from './shared.mjs';
import {showReviews} from './video-motion.mjs';
import {showTextReviews} from './text-motion.mjs';
import {showGenReviews} from './gen-motion.mjs';
import {recipePanel, showRecipeReviews} from './recipe-motion.mjs';
import {moveToTrash} from './confirm.mjs';
import {attachScrub} from './scrub.mjs';
import {WEAPONS} from './weapon.mjs';

const GROUPS = [['all', 'すべて'], ['gen', '作った'], ['pack', 'VRoid'], ['other', 'そのほか']];
const groupOf = m => m.generated ? 'gen' : /VRoid/i.test(m.source?.pack ?? '') ? 'pack' : 'other';
const LICENSE_KEY = 'charasta.lastLicense';
function lastLicense() { try { return JSON.parse(localStorage.getItem(LICENSE_KEY)) || {}; } catch { return {}; } }
const duration = m => typeof m.durationSec === 'number' ? m.durationSec.toFixed(1) + 's' : '';
// 動画から作ったモーションは、作ったときの体を出す。ほかのキャラに当てているときは注意の色にする
// 合わせたキャラや版を消してあっても、記録の名前のまま出して「削除済み」と添える(ずれるので注意の色)
const fitNote = (m, char, ov) => {
  const f = m.fittedTo;
  if (!f) return null;
  const gone = !ov.chars.some(c => c.id === f.charId) ? '、キャラは削除済み' : f.charId === char?.id && !char.versions?.some(v => v.id === f.verId) ? '、版は削除済み' : '';
  return {text: `${f.charName} 用（${f.verId}${gone}）`, warn: !!gone || (!!char && f.charId !== char.id)};
};

export async function showMotion({main, ov, char, verId, alive, jobsChanged}) {
  let motions = await getJSON('/api/motions'), filter = 'all', picked = motions[0]?.id ?? null;
  const count = h('span', {class: 'mono muted'}), chips = h('div', {class: 'chips', role: 'group', 'aria-label': '出どころで絞る'}), listBox = h('div', {class: 'motion-list'});
  const pendingBox = h('div', {class: 'pending-list'});
  const frame = char && verId ? viewerFrame(char.id, verId, picked ? {motion: picked} : {}) : null;
  const caption = h('div', {class: 'stage-caption'});
  const setCaption = () => {
    const m = motions.find(x => x.id === picked), fit = m && fitNote(m, char, ov);
    // 選んだモーションは一覧で分かるので、ここは注意があるときだけ出す
    caption.textContent = m && char && fit?.warn ? `${fit.text}に作った動きなので、手足の位置がずれる` : '';
  };

  async function pick(id) {
    picked = id; renderList(); setCaption();
    if (!frame) return;
    (await viewerReady(frame)).play(id).catch(e => { caption.textContent = '再生できない: ' + e.message; });
  }
  function renderList() {
    count.textContent = motions.length;
    chips.replaceChildren(...GROUPS.filter(([k]) => k === 'all' || motions.some(m => groupOf(m) === k)).map(([k, label]) =>
      h('button', {type: 'button', class: 'chip-btn', 'aria-pressed': String(filter === k), onclick: () => { filter = k; renderList(); }}, label)));
    const rows = motions.filter(m => filter === 'all' || groupOf(m) === filter);
    listBox.replaceChildren(...(rows.length ? rows.map(m => motionRow(m, m.id === picked, pick, char, ov, remove)) : [h('div', {class: 'empty small'}, 'モーションがまだない。「モーションを足す」から作る。')]));
  }
  // 選んでいるモーションをごみ箱へ移す。一覧を読み直し、先頭を選び直す
  async function remove(m) {
    if (!await moveToTrash({kind: 'motion', id: m.id}, m.label || m.name || m.id)) return;
    await refreshMotions();
    if (motions[0]) await pick(motions[0].id);
    else { picked = null; renderList(); setCaption(); }
  }
  renderList(); setCaption();
  // ビューアがまだ読み込み中なら、読み込みが済むときに新しい一覧を読むので待たない
  const refreshMotions = async () => { motions = await getJSON('/api/motions'); renderList(); await frame?.contentWindow?.viewer?.reloadMotions?.(); };

  const reviewBox = h('div', {class: 'stack'});
  const reviewed = async () => { await refreshMotions(); await refreshReviews(); await watcher.poll(); jobsChanged(); };
  // 文章から作った候補は、保管場所に入れる前にビューアで再生する(今のキャラに当てる)
  const previewCandidate = frame ? async rec => { caption.textContent = ''; await (await viewerReady(frame)).playCandidate(rec); } : null;
  const textReviewBox = h('div', {class: 'stack'}), genReviewBox = h('div', {class: 'stack'}), recipeReviewBox = h('div', {class: 'stack'});
  let recipeSources = null;   // 「つくる」の区間に使える確認待ちの結果。確認の欄を読み直すたびに替える
  const refreshReviews = async () => {
    await showReviews(reviewBox, reviewed); await showTextReviews(textReviewBox, {preview: previewCandidate, changed: reviewed});
    await showGenReviews(genReviewBox, {preview: previewCandidate, changed: reviewed});
    recipeSources = await showRecipeReviews(recipeReviewBox, {preview: previewCandidate, changed: reviewed});
  };
  const watcher = watchJobs({filter: j => j.type === 'motion-gen' || j.type === 'video-motion' || j.type === 'motion-text' || j.type === 'motion-recipe', alive, onJobs: jobs => pendingBox.replaceChildren(...jobs.map(pendingRow)), onDone: async () => {
    await refreshMotions();
    await refreshReviews();
    jobsChanged();
  }});
  const queued = job => { watcher.queued(job); jobsChanged(); };

  const center = h('section', {class: 'center', 'aria-label': 'ビューア'},
    h('div', {class: 'stage'}, frame ?? h('div', {class: 'empty'}, 'このキャラには版がまだない。つくるの画面で取り込む。')));
  if (frame) center.append(playBar(frame, alive, weaponPick(frame), toggles(frame), fullButton(center)),
    h('div', {class: 'stage-foot'}, caption, h('a', {class: 'link', href: viewerHref(char.id, verId), target: '_blank'}, '全部の操作があるビューアを開く')));
  // スマホは右の欄を畳み、このボタンで一覧の上に開く
  center.append(h('button', {type: 'button', class: 'primary phone-add', onclick: () => work.classList.toggle('add-open')}, 'モーションを足す'));
  const work = h('div', {class: 'work motion-work'},
    h('aside', {class: 'pane pane-left', 'aria-label': 'モーションの一覧'},
      h('div', {class: 'pane-head'}, h('h1', {}, 'モーション'), count), chips, pendingBox, listBox),
    center,
    h('aside', {class: 'pane pane-right', 'aria-label': 'モーションを足す'}, reviewBox, textReviewBox, genReviewBox, recipeReviewBox,
      addPanel([['つくる', await recipePanel({motions: () => motions, sources: () => recipeSources, queued, char, verId})], ['ファイル', importForm(refreshMotions)]])));
  main.replaceChildren(work);
  await watcher.poll();
  await refreshReviews();
}

// モーションを足す: 作り方の切り替えで 1 枚だけ見せる。切り替えても書きかけは消えない
function addPanel(tabs) {
  const show = i => { btns.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i))); tabs.forEach(([, panel], j) => { panel.hidden = j !== i; }); };
  const btns = tabs.map(([label], i) => h('button', {type: 'button', class: 'seg-btn', onclick: () => show(i)}, label));
  show(0);
  return h('section', {class: 'form-stack add-form', 'aria-labelledby': 'addh'}, h('h2', {id: 'addh'}, 'モーションを足す'),
    h('div', {class: 'seg three two', role: 'group', 'aria-label': '作り方'}, btns), tabs.map(([, panel]) => panel));
}

function motionRow(m, on, pick, char, ov, remove) {
  const limit = m.limit, g = m.generated, fit = fitNote(m, char, ov);
  return h('div', {class: 'motion-item' + (on ? ' on' : '')},
    h('button', {type: 'button', 'aria-pressed': String(on), 'data-name': m.id, onclick: () => pick(m.id)},
      h('span', {class: 'motion-top'}, h('span', {class: 'motion-name'}, m.label || m.name || m.id), h('span', {class: 'mono muted'}, duration(m))),
      h('span', {class: limit.warn ? 'limit warn' : 'limit'}, limit.text),
      fit ? h('span', {class: fit.warn ? 'limit warn' : 'limit'}, fit.text) : null),
    on ? h('details', {class: 'motion-info'}, h('summary', {}, 'このモーションの情報'),
      h('div', {class: 'muted'}, [m.id, m.usesShoulder ? '肩を動かす' : '肩は動かさない', (m.expressions || []).length ? '表情 ' + m.expressions.map(e => e.expression).join('・') : null].filter(Boolean).join('・')),
      m.license ? h('div', {class: 'muted'}, [m.license.holder, m.license.summary].filter(Boolean).join('：')) : null,
      m.source?.pack ? h('div', {class: 'muted'}, '出どころ: ' + m.source.pack) : null,
      g?.tool === 'vrma-pipeline' ? h('div', {class: 'muted'}, `動画から変換: ${g.model}、${g.frames} コマ（${g.fps} fps）、判定 ${g.quality ?? '不明'}、ジョブ ${g.job}`)
        : g?.tool === 'motion-compose' ? h('div', {class: 'muted'}, `つないだ: ${(g.segments ?? []).map(s => s.motionRecord?.id ?? s.label).join(' + ')}、${g.frames} コマ（${g.fps} fps）${g.job ? `、ジョブ ${g.job}` : ''}`)
        : g ? h('div', {class: 'muted'}, `生成: ${g.model || g.tool}、${g.frames} コマ（${g.fps} fps）、進んだ距離 ${g.travelM} m、ジョブ ${g.job}`) : null,
      m.license?.rightsNote ? h('div', {class: 'muted'}, '権利のメモ: ' + m.license.rightsNote) : null,
      (m.license?.terms ?? []).filter(t => t.clips?.length).map(t => h('details', {},
        h('summary', {class: 'muted'}, `${t.part}: ${t.license}（${t.clips.length} 本）`),
        h('div', {class: 'muted'}, t.clips.join('、'))))) : null,
    on ? h('button', {type: 'button', class: 'quiet', onclick: () => remove(m)}, 'このモーションを削除') : null);
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
function fullButton(center) {
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
function toggles(frame) {
  const toggle = (text, title, key) => {
    const b = h('button', {type: 'button', class: 'toggle', 'aria-pressed': 'true', title}, text);
    b.onclick = async () => { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); (await viewerReady(frame))[key] = on; };
    return b;
  };
  return h('div', {class: 'stage-toggles'}, toggle('追従', 'カメラをキャラについていかせる', 'follow'), toggle('足を留める', '接地中の足を床に留める', 'footIK'));
}

// 手に持たせる武器。ビューアの window.viewer.weapon を切り替える。狭い画面でも隠さない(追従などの切り替えは隠れる)
function weaponPick(frame) {
  const pick = h('select', {class: 'weapon-pick', 'aria-label': '武器', title: '手に持たせる武器(見た目だけ)'}, Object.entries(WEAPONS).map(([id, w]) => h('option', {value: id}, id === 'none' ? '武器なし' : w.label)));
  pick.onchange = async () => { (await viewerReady(frame)).weapon = pick.value; };
  return pick;
}

// 再生のバー: 再生と停止、位置の表示と移動。extra はバーの右端に並べる
function playBar(frame, alive, ...extra) {
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

function importForm(imported) {
  const last = lastLicense();
  const file = h('input', {type: 'file', accept: '.vrma', hidden: true});
  const holder = h('input', {placeholder: '例: ピクシブ株式会社', value: last.holder || ''});
  const summary = h('input', {placeholder: '例: 改変可。取り出せる状態での二次配布は禁止', value: last.summary || ''});
  const redist = h('input', {type: 'checkbox'}); redist.checked = !!last.redistribution;
  const msg = h('span', {id: 'importMsg', class: 'muted'}), chosen = h('span', {class: 'muted'}, 'まだ選んでいない');
  let picked = null;
  const drop = h('div', {class: 'drop', tabindex: '0', role: 'button'}, 'VRMA をここに落とすか、押して選ぶ');
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
  const go = h('button', {class: 'primary big'}, '取り込む');
  go.onclick = async () => {
    if (!picked) { msg.className = 'err'; msg.textContent = '先に VRMA を選ぶ'; return; }
    if (!holder.value.trim() || !summary.value.trim()) { msg.className = 'err'; msg.textContent = '権利者と要約を入れる'; return; }
    const license = {holder: holder.value.trim(), summary: summary.value.trim(), redistribution: redist.checked};
    try { localStorage.setItem(LICENSE_KEY, JSON.stringify(license)); } catch { /* 次の入力の手間が増えるだけ */ }
    go.disabled = true; msg.className = 'muted'; msg.textContent = '取り込み中…';
    try {
      // ヘッダには ASCII しか入らないので、ファイル名と利用条件は encodeURIComponent してから送る(サーバーは decodeURIComponent で戻す)
      const r = await fetch('/api/motions', {method: 'POST', body: picked, headers: {
        'content-type': 'model/gltf-binary', 'x-filename': encodeURIComponent(picked.name), 'x-license': encodeURIComponent(JSON.stringify(license))}});
      const text = await r.text();
      if (!r.ok) throw Error(`${r.status} ${text}`);
      const m = JSON.parse(text);
      await imported();
      msg.textContent = `取り込んだ: ${m.id}（${m.name || picked.name}）`;
    } catch (e) { msg.className = 'err'; msg.textContent = '取り込みに失敗: ' + e.message; }
    go.disabled = false;
  };
  return h('div', {class: 'form-stack', id: 'import'}, drop, file, chosen,
    h('label', {}, '権利者', holder), h('label', {}, '利用条件の要約', summary),
    h('label', {class: 'check'}, redist, '二次配布してよい'), go, msg);
}
