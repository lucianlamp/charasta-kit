// 表情(docs/expression-studio.md、docs/screens.md): 左に工程、真ん中に選んだ工程の中身、右にできている表情と新しい依頼。
// 確かめとバージョンにするは仕上げの画面(public/finish.mjs)にある。#studio/<キャラ>/<ID>/<工程> で工程を直接開ける。
import {h, getJSON, send, elapsedText} from './dom.mjs';
import {AGENT, enc, mb, when} from './shared.mjs';
import {missingNote} from './capabilities.mjs';
import {confirmDialog} from './confirm.mjs';

const STATE = {none: '未実行', queued: '待ち', running: '実行中', done: '完了', failed: '失敗'};
const REQ_STEP = {face: '3 顔の絵', expr: '6 表情の絵'};
const REQ_OPEN = r => r.state === '未着手' || r.state === '候補あり';
const JOB = {front: 'studio-front', build: 'studio-build', video: 'studio-video'};
const EXPRESSIONS = ['blink', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh'];
// 工程の並び [鍵, 番号, 名前]。3 と 6 は依頼の工程で、状態は依頼の数で出す
const ROWS = [['copy', '1', '材料をコピー'], ['front', '2', '正面を撮る'], ['req:face', '3', '顔の絵'], ['rects', '4', '区画の範囲'], ['build', '5', '組み立て'],
  ['req:expr', '6', '表情の絵'], ['video', '7', '中割り']];
const FACE_LABEL = {neutral: 'ふだん', happy: '笑顔', angry: '怒り', surprised: '驚き', sad: '悲しみ', relaxed: '安らぎ', blink: 'まばたき'};
const api = (c, id, rest = '') => `/api/studio/${enc(c)}/${enc(id)}${rest}`;
const short = s => s ? s.slice(0, 10) : '';
let timer = null;

// 表情づくりを始める欄(一覧の画面と、工程の左の欄で使う)
function startForm(charId, stageHref) {
  const id = h('input', {placeholder: '例: rebuild-v4（空なら自動）', 'aria-label': '表情づくりの ID'});
  const note = h('input', {placeholder: '例: 口を微笑みに描き直す', 'aria-label': 'メモ'});
  const msg = h('span', {class: 'muted'}), go = h('button', {class: 'primary'}, '表情づくりを始める');
  go.onclick = async () => {
    go.disabled = true; msg.className = 'muted'; msg.textContent = '作っている…';
    try { const w = await send('POST', `/api/studio/${enc(charId)}`, {id: id.value.trim() || undefined, note: note.value.trim()}); location.hash = `#studio/${enc(charId)}/${enc(w.id)}`; }
    catch (e) { msg.className = 'err'; msg.textContent = '作れない: ' + e.message; go.disabled = false; }
  };
  return h('div', {class: 'form-stack'}, h('label', {}, 'メモ', note), go, msg, h('details', {}, h('summary', {}, '詳しい設定'), h('label', {}, 'ID', id)));
}

// このキャラに表情づくりが無いとき
export async function showStudioStart({main, ov, char}) {
  if (!char) { main.replaceChildren(h('div', {class: 'empty page-empty'}, 'キャラがまだない。')); return; }
  main.replaceChildren(h('div', {class: 'narrow'}, h('h1', {}, '表情づくり'),
    h('p', {class: 'lead'}, char.studios.length ? '新しい表情づくりを始める。' : `${char.name} の表情づくりはまだない。`), missingNote(ov, ['expressionStudio'], '表情づくりに要る道具が未設定'), h('section', {class: 'card-box'}, startForm(char.id)), h('p', {}, h('a', {href: `#face/${enc(char.id)}`}, 'バージョンの顔を確認する'))));
}

export async function showStudio({main, char, alive, jobsChanged}, id, stepArg) {
  clearTimeout(timer);
  const charId = char.id;
  const [projects, list] = await Promise.all([getJSON('/api/charakuru/projects').catch(() => []), getJSON(`/api/studio/${enc(charId)}`)]);
  let st = await getJSON(api(charId, id));
  const firstStep = () => st.requests.some(r => r.state === '候補あり') ? 'req:' + st.requests.find(r => r.state === '候補あり').step
    : st.requests.some(r => r.state === '未着手') ? 'req:' + st.requests.find(r => r.state === '未着手').step : 'req:face';
  let selected = ROWS.some(r => r[0] === stepArg) ? stepArg : firstStep();
  const left = h('div', {class: 'step-list'}), center = h('div', {class: 'stack'}), right = h('div', {class: 'stack'});
  const rects = rectEditor(() => st, async next => { st = await send('PUT', api(charId, id, '/rects'), next); render(); });
  const reload = async () => { st = await getJSON(api(charId, id)); render(); };

  // 動いている工程か進行中の依頼がある間は 3 秒ごとに読み直す(Claude が CLI で置いた候補も画面に出る)。
  // 入力欄に書いている間は作り直さない(フォーカスと変換中の文字が消えるため)。値は drafts に残る
  function poll() {
    clearTimeout(timer);
    if (!alive()) return;
    const busy = Object.values(st.steps).some(s => s.state === 'queued' || s.state === 'running');
    if (busy || st.requests.some(REQ_OPEN)) timer = setTimeout(async () => {
      if (!alive()) return;
      const typing = document.activeElement?.matches?.('input, textarea, select');
      try { const next = await getJSON(api(charId, id)); if (!typing && (busy || JSON.stringify(next) !== JSON.stringify(st))) { st = next; render(); return; } } catch { /* 次の読み直しで取り戻す */ }
      poll();
    }, 3000);
  }
  const drafts = {};
  const draft = (key, el) => { if (drafts[key] != null) el.value = drafts[key]; el.addEventListener('input', () => { drafts[key] = el.value; }); return el; };
  const startJob = async (step, extra = {}, msg) => {
    try { await send('POST', '/api/jobs', {type: JOB[step], charId, studioId: id, ...extra}); jobsChanged(); await reload(); }
    catch (e) { msg.className = 'err'; msg.textContent = '始められない: ' + e.message; }
  };

  // ---- 左: 工程の一覧 ----
  function stepState(key) {
    if (key.startsWith('req:')) {
      const reqs = st.requests.filter(r => r.step === key.slice(4));
      return reqs.some(r => r.state === '候補あり') ? '判断待ち' : reqs.some(r => r.state === '未着手') ? `${AGENT.name} 待ち` : reqs.some(r => r.state === '採用済み') ? '完了' : '依頼なし';
    }
    const s = st.steps[key];
    if (s.state === 'done' && (s.stale || s.sourceChanged || s.upstreamStale)) return '古い';
    if (key === 'video' && s.state === 'none') return '手で置く';
    return STATE[s.state] || s.state;
  }
  const STATE_CLASS = {古い: 'warn', 失敗: 'warn', 判断待ち: 'act', 実行中: 'run', 待ち: 'run'};
  function stepButton([key, n, label]) {
    const text = stepState(key), body = [h('span', {class: 'mono n'}, n), h('span', {class: 'grow'}, label), h('span', {class: 'state ' + (STATE_CLASS[text] ?? '')}, text)];
    return h('button', {type: 'button', class: 'step-btn', 'aria-current': key === selected ? 'step' : null, 'data-step': key,
      onclick: () => { selected = key; render(); history.replaceState(null, '', `#studio/${enc(charId)}/${enc(id)}/${enc(key)}`); scrollTo(0, 0); }}, body);
  }

  // ---- 真ん中: 工程ごとの中身 ----
  function stepPanel(step) {
    const s = st.steps[step], msg = h('span', {class: 'muted'});
    const tags = [];
    if (s.stale) tags.push(h('span', {class: 'tag no'}, '入力が変わった。もう一度動かす'));
    if (s.upstreamStale) tags.push(h('span', {class: 'tag no'}, '前の工程が変わった。もう一度動かす'));
    if (s.sourceChanged) tags.push(h('span', {class: 'tag no'}, 'きゃらくる側が変わった'));
    const busy = s.state === 'queued' || s.state === 'running';
    let action = null;
    if (JOB[step]) {
      action = h('button', {class: s.state === 'done' && !s.stale ? '' : 'primary'}, s.state === 'done' ? 'もう一度' : '動かす');
      action.disabled = busy;
      action.onclick = async () => { action.disabled = true; await startJob(step, {}, msg); action.disabled = false; };
    }
    const detail = [];
    if (s.at) detail.push(when(s.at));
    if (s.job && (busy || s.job.state === 'failed')) detail.push(s.job.step, elapsedText(s.job));
    else if (s.job?.startedAt) detail.push('かかった時間 ' + elapsedText(s.job));
    if (step === 'build' || step === 'video') { const p = [...st.prototypes].reverse().find(p => p.step === step); if (p) detail.push(`試作 ${p.n}`); }
    return h('section', {class: 'card-box step-panel', 'data-step': step, 'data-state': s.state},
      h('div', {class: 'page-head'}, h('h2', {}, ROWS.find(r => r[0] === step).slice(1).join(' ')), h('span', {class: 'tag state ' + s.state}, STATE[s.state] || s.state), ...tags, action),
      detail.filter(Boolean).length ? h('div', {class: 'muted'}, detail.filter(Boolean).join('・')) : null,
      s.error ? h('div', {class: 'err'}, s.error) : null, msg);
  }

  function requestsBlock(step) {
    const mine = [...st.requests].reverse().filter(r => r.step === step);
    const open = mine.filter(REQ_OPEN), closed = mine.filter(r => !REQ_OPEN(r));
    return [
      open.length ? null : h('div', {class: 'empty small'}, '進行中の依頼はない。'),
      ...open.map(requestBox),
      closed.length ? h('details', {}, h('summary', {}, `済んだ依頼（${closed.length}）`), ...closed.map(requestBox)) : null,
      adoptedBlock()];
  }

  function requestBox(r) {
    const msg = h('span', {class: 'muted'});
    const act = async (fn, busyText) => { msg.className = 'muted'; msg.textContent = busyText; try { st = await fn(); render(); } catch (e) { msg.className = 'err'; msg.textContent = e.message; } };
    const cur = st.adopted.find(a => a.path === r.target);
    const now = h('figure', {class: 'candidate current'},
      h('a', {href: r.targetUrl, target: '_blank', title: r.target}, h('img', {src: r.targetUrl + (cur ? '?v=' + cur.sha256.slice(0, 8) : ''), alt: '今の絵', onerror: e => { e.target.replaceWith(h('div', {class: 'empty small'}, 'まだない')); }})),
      h('figcaption', {}, r.state === '採用済み' ? '今の絵（採用した候補）' : '今の絵'));
    const cands = r.candidates.map(c => {
      const pending = r.state === '候補あり' && c.state === '候補';
      const reason = pending ? draft(`${r.id}:${c.n}`, h('input', {'aria-label': `候補 ${c.n} の却下の理由`})) : null;
      const adopt = pending ? h('button', {class: 'primary'}, '採用') : null, reject = pending ? h('button', {}, '却下') : null;
      if (adopt) adopt.onclick = async () => { if (await confirmDialog({title: `候補 ${c.n} を採用`, body: [h('p', {}, `${r.target} を替える。前の絵はごみ箱へ移す。使う工程は「古い」になる。`)], confirm: '採用する'}))
        act(() => send('POST', api(charId, id, `/requests/${enc(r.id)}/candidates/${c.n}/adopt`)), '採用している…'); };
      if (reject) reject.onclick = () => act(() => { delete drafts[`${r.id}:${c.n}`]; return send('POST', api(charId, id, `/requests/${enc(r.id)}/candidates/${c.n}/reject`), {reason: reason.value.trim()}); }, '却下している…');
      return h('figure', {class: 'candidate' + (pending ? ' pending' : ''), 'data-state': c.state},
        h('a', {href: c.url, target: '_blank'}, h('img', {src: c.url, loading: 'lazy', alt: `候補 ${c.n}`})),
        h('figcaption', {}, `候補 ${c.n}`, ' ', c.state !== '候補' ? h('span', {class: 'tag' + (c.state === '採用' ? ' yes' : ' no')}, c.state) : null),
        c.note ? h('div', {class: 'muted'}, c.note) : null,
        c.reason ? h('div', {class: 'muted'}, '却下の理由: ' + c.reason) : null,
        pending ? h('div', {class: 'pair'}, adopt, reject) : null,
        pending ? h('label', {class: 'small-label'}, '却下の理由（次の候補で読む）', reason) : null);
    });
    const withdraw = REQ_OPEN(r) ? h('button', {class: 'danger'}, '取り下げる') : null;
    if (withdraw) withdraw.onclick = async () => { if (await confirmDialog({title: `依頼 ${r.id} を取り下げる`, confirm: '取り下げる'})) act(() => send('POST', api(charId, id, `/requests/${enc(r.id)}/withdraw`)), '取り下げている…'); };
    const wait = r.state !== '未着手' ? '' : r.candidates.length ? `（全部却下した。${AGENT.ga}次の候補を作る）` : `（${AGENT.wo}待っている。${AGENT.ni}「きゃらすたの依頼を進めて」と言う）`;
    return h('section', {class: 'request', 'data-request': r.id, 'data-state': r.state},
      h('div', {class: 'page-head'}, h('h2', {}, `依頼 ${r.id}`), h('code', {}, r.target),
        h('span', {class: 'chip ' + (r.state === '候補あり' ? 'act' : '')}, r.state), withdraw),
      h('p', {class: 'lead'}, r.text),
      h('div', {class: 'muted'}, `${when(r.createdAt)}・候補 ${r.candidates.length} 枚${wait}`),
      h('div', {class: 'candidates'}, now, ...cands), msg);
  }

  function inputsBlock() {
    const sel = h('select', {'aria-label': 'きゃらくるのプロジェクト'}, projects.map(p => h('option', {value: p.id, disabled: !p.hasBlend},
      `${p.name || p.id}（${p.id.slice(0, 8)}${p.blendModified ? '・' + when(p.blendModified) : ''}${p.hasBlend ? '' : '・character.blend なし'}）`)));
    if (st.source?.project) sel.value = st.source.project;
    const msg = h('span', {class: 'muted'}), go = h('button', {class: st.inputs.length ? '' : 'primary'}, st.inputs.length ? 'コピーし直す' : 'コピーする');
    go.onclick = async () => {
      go.disabled = true; msg.className = 'muted'; msg.textContent = 'コピー中…（.blend が読む画像を Blender で調べる）';
      try { st = await send('POST', api(charId, id, '/copy'), {project: sel.value}); render(); }
      catch (e) { msg.className = 'err'; msg.textContent = 'コピーできない: ' + e.message; go.disabled = false; }
    };
    return h('section', {class: 'card-box', id: 'inputsBox'}, h('h2', {}, '材料（きゃらくるは読むだけ）'),
      st.source ? h('div', {class: 'muted'}, '取り込み元: ' + (st.source.type === 'charakuru' ? `きゃらくる ${st.source.project}` : `表情づくり ${st.source.studio}`)) : null,
      st.inputs.length ? h('div', {class: 'files'}, st.inputs.map(f => h('div', {}, h('code', {}, 'inputs/' + f.name), ` ${mb(f.size)}・sha256 ${short(f.sha256)}`))) : null,
      h('div', {class: 'actions'}, sel, go, msg));
  }

  function adoptedBlock() {
    const pics = st.adopted.filter(a => /\.png$/i.test(a.path)), groups = {};
    for (const a of pics) (groups[a.path.split('/').slice(0, -1).join('/')] ??= []).push(a);
    return h('details', {class: 'card-box'}, h('summary', {}, `採用した絵（${pics.length}）`),
      h('div', {class: 'muted'}, '依頼の候補を採用すると替わる。今ある絵のフォルダは CLI（node scripts/studio.mjs adopt）でも取り込める。'),
      ...Object.entries(groups).map(([dir, list]) => h('details', {open: list.length <= 12},
        h('summary', {}, `${dir}/（${list.length}）`),
        h('div', {class: 'thumbs'}, list.map(a => h('a', {href: a.url, target: '_blank', title: `${a.path}\n取り込み元: ${a.from}\nsha256 ${a.sha256}`},
          h('img', {src: a.url + '?v=' + a.sha256.slice(0, 8), loading: 'lazy', alt: a.path}), h('span', {}, a.path.split('/').pop() + (a.request ? `（${a.request} 候補 ${a.candidate}）` : ''))))))));
  }

  function videoBlock() {
    const vids = st.adopted.filter(a => /\.mp4$/i.test(a.path));
    const name = h('select', {'aria-label': '表情'}, EXPRESSIONS.map(n => h('option', {value: n}, n)));
    const file = h('input', {type: 'file', accept: 'video/mp4,.mp4', 'aria-label': 'mp4'}), msg = h('span', {class: 'muted'});
    const go = h('button', {}, '動画を置く');
    go.onclick = async () => {
      if (!file.files[0]) { msg.className = 'err'; msg.textContent = 'mp4 を選ぶ'; return; }
      go.disabled = true; msg.className = 'muted'; msg.textContent = '送っている…';
      try {
        const r = await fetch(api(charId, id, '/videos/' + enc(name.value)), {method: 'POST', body: file.files[0], headers: {'content-type': 'video/mp4'}});
        const j = await r.json(); if (!r.ok) throw Error(j.error); st = j; render();
      } catch (e) { msg.className = 'err'; msg.textContent = '置けない: ' + e.message; go.disabled = false; }
    };
    return h('section', {class: 'card-box'}, h('h2', {}, `中割りの動画（手で置く mp4、${vids.length} 本）`),
      h('div', {class: 'muted'}, vids.map(v => v.path.split('/').pop()).join('、') || 'まだない。動画が無い表情は二値（中割りなし）で入る。'),
      h('div', {class: 'actions'}, name, file, go, msg));
  }

  function protoBlock() {
    const rows = [...st.prototypes].reverse().map(p => h('div', {class: 'row proto'},
      h('div', {class: 'top'}, h('span', {class: 'title'}, `試作 ${p.n}`), h('span', {class: 'tag'}, p.step === 'video' ? '中割りあり' : '組み立て'),
        p.springTune ? h('span', {class: 'tag'}, '揺れ骨を整えた') : null, h('span', {class: 'muted'}, `${when(p.at)}・${mb(p.size)}・sha256 ${short(p.sha256)}`)),
      h('div', {class: 'actions'}, h('a', {class: 'button', href: `/viewer?${new URLSearchParams({char: charId, studio: id, ver: 'proto-' + p.n})}`, target: '_blank'}, 'ビューアで見る'),
        h('a', {class: 'button', href: `#finish/${enc(charId)}/${enc(id)}`}, '仕上げへ'), h('a', {href: p.url, download: `${charId}-${id}-proto${p.n}.vrm`}, 'ダウンロード'))));
    return h('section', {class: 'stack'}, h('h2', {}, '試作'), rows.length ? rows : h('div', {class: 'empty small'}, '試作はまだない（組み立てで作る）'));
  }

  function frontBlock() {
    const img = st.files['face/with_hair.png'];
    return img ? h('section', {class: 'card-box'}, h('h2', {}, '正面の撮影'), h('img', {class: 'front-shot', src: img + '?t=' + enc(st.steps.front.at ?? ''), alt: '正面の撮影'})) : null;
  }

  function centerBlocks() {
    if (selected.startsWith('req:')) return requestsBlock(selected.slice(4));
    if (selected === 'copy') return [stepPanel('copy'), inputsBlock()];
    if (selected === 'front') return [stepPanel('front'), frontBlock()];
    if (selected === 'rects') return [stepPanel('rects'), h('section', {class: 'card-box', id: 'rectsBox'}, h('h2', {}, '区画の範囲（目・眉と口）'), rects.el())];
    if (selected === 'build') return [stepPanel('build'), protoBlock(),
      h('details', {class: 'card-box'}, h('summary', {}, '詳しい設定（開発用）'), h('p', {class: 'muted'}, 'スクリプトの引数。node scripts/studio.mjs options で変える。'), h('pre', {class: 'json'}, JSON.stringify(st.options, null, 1)))];
    return [stepPanel('video'), videoBlock(), protoBlock()];
  }

  // ---- 右: できている表情と新しい依頼 ----
  function facesBlock() {
    const last = st.checks.at(-1), faces = (last?.images ?? []).filter(i => i.kind === 'expr' && i.yaw === 0 && FACE_LABEL[i.expr]);
    return h('section', {class: 'stack'}, h('h2', {}, 'できている表情'),
      faces.length ? [h('div', {class: 'faces'}, faces.map(i => h('figure', {}, h('img', {src: i.url, alt: FACE_LABEL[i.expr], loading: 'lazy'}), h('figcaption', {}, FACE_LABEL[i.expr])))),
        h('div', {class: 'muted'}, `試作 ${last.proto} の確認用の撮影`)]
        : h('div', {class: 'muted'}, '確認用の撮影がまだない（仕上げで撮る）。'));
  }

  // 依頼は開いている工程(3 か 6)に出す
  function newRequest(step) {
    const known = [...new Set([...st.adopted.map(a => a.path).filter(p => /\.png$/i.test(p)), ...EXPRESSIONS.map(e => `drawn/expr/${e}.png`)])].sort();
    const targets = h('datalist', {id: 'requestTargets'}, known.map(p => h('option', {value: p})));
    const target = draft('new:target', h('input', {list: 'requestTargets', placeholder: '例: drawn/neutral_nocheek.png', 'aria-label': '替える絵'}));
    const text = draft('new:text', h('textarea', {rows: 3, placeholder: '例: ふだんの口を、口角をもう少し上げた閉じた微笑みに描き直す', 'aria-label': '依頼の文'}));
    const msg = h('span', {class: 'muted'}), go = h('button', {class: 'outline'}, '依頼を出す');
    go.onclick = async () => {
      go.disabled = true; msg.className = 'muted'; msg.textContent = '出している…';
      try {
        st = await send('POST', api(charId, id, '/requests'), {step, target: target.value.trim(), text: text.value.trim()});
        delete drafts['new:target']; delete drafts['new:text']; render();
      } catch (e) { msg.className = 'err'; msg.textContent = '出せない: ' + e.message; go.disabled = false; }
    };
    return h('section', {class: 'form-stack', id: 'requestsBox'}, h('h2', {}, `新しい依頼（${REQ_STEP[step]}）`),
      h('label', {}, '替える絵（drawn/ の下）', target, targets), h('label', {}, '依頼の文', text), go, msg,
      h('p', {class: 'muted'}, `依頼を出したら、${AGENT.ni}「きゃらすたの依頼を進めて」と言う。採用か却下は人が決める（${AGENT.name}は採用しない）。`));
  }

  function render() {
    left.replaceChildren(...ROWS.map(stepButton), h('a', {class: 'step-btn', href: `#finish/${enc(charId)}/${enc(id)}`}, h('span', {class: 'mono n'}, '8'), h('span', {class: 'grow'}, '確認とバージョンとして保存（仕上げ）')));
    center.replaceChildren(...centerBlocks().flat().filter(Boolean));
    right.replaceChildren(...[facesBlock(), selected.startsWith('req:') ? newRequest(selected.slice(4)) : null].filter(Boolean));
    poll();
  }

  const switcher = h('select', {'aria-label': '表情づくり', onchange: e => { location.hash = `#studio/${enc(charId)}/${enc(e.target.value)}`; }},
    list.map(s => h('option', {value: s.id}, [s.id, when(s.createdAt), s.prototypes ? `試作 ${s.prototypes}` : null, ...s.versions.map(v => 'バージョン ' + v)].filter(Boolean).join('・'))));
  switcher.value = id;
  main.replaceChildren(h('div', {class: 'work'},
    h('aside', {class: 'pane pane-left pane-steps', 'aria-label': '工程'},
      h('h1', {}, '表情づくり'), list.length > 1 ? switcher : null, st.note ? h('div', {class: 'muted'}, st.note) : null, left,
      h('details', {}, h('summary', {}, '新しい表情づくり'), startForm(charId)), h('a', {class: 'step-btn', href: `#face/${enc(charId)}`}, h('span', {class: 'grow'}, 'バージョンの顔を確認する'))),
    h('section', {class: 'center page-body'}, center),
    h('aside', {class: 'pane pane-right', 'aria-label': '表情の一覧と依頼'}, right)));
  render();
}

// ---- 区画の範囲の編集: 正面の撮影の上で四角を動かす(四角の中を引くと移動、右下の角を引くと大きさ)。座標は撮影の画素 ----
function rectEditor(getSt, save) {
  let regions = null, key = null, root = null;
  const norm = r => r ? (Array.isArray(r[0]) ? r.map(x => [...x]) : [[...r]]) : [];
  const fromSt = () => { const st = getSt(); regions = {upper: norm(st.rects?.upper), mouth: norm(st.rects?.mouth)}; key = JSON.stringify(st.rects); };
  let shown = null;   // 作り直しは、保存した範囲か正面の撮影が変わったときだけ(読み直しのたびに作ると、引いている途中の四角が止まる)
  function el() {
    const st = getSt(), now = JSON.stringify([st.rects, st.steps.front.at, st.steps.rects.stale]);
    if (root && shown === now) return root;
    shown = now;
    if (key !== JSON.stringify(st.rects) || !regions) fromSt();
    const img = st.files['face/with_hair.png'], size = st.cam?.size ?? 2048;
    if (!img) return h('div', {class: 'empty small'}, '先に「正面を撮る」を動かす（範囲は正面の撮影の上で決める）。');
    if (!regions.upper.length) regions.upper = [[Math.round(size * 0.2), Math.round(size * 0.3), Math.round(size * 0.8), Math.round(size * 0.6)]];
    const pct = v => (v / size * 100) + '%';
    const wrap = h('div', {class: 'rect-editor'}), pic = h('img', {src: img + '?t=' + encodeURIComponent(st.steps.front.at ?? ''), alt: '正面の撮影', draggable: 'false'});
    const nums = h('div', {class: 'rect-nums'}), msg = h('span', {class: 'muted'});
    wrap.append(pic);
    // 位置合わせした絵を重ねる(組み立てで neutral の区画に使う絵。align.json の倍率と位置で置く)
    const cell = st.options.build?.atlas?.cells?.neutral, drawing = st.adopted.find(a => a.path === cell);
    const over = h('img', {class: 'overlay', alt: '位置合わせした絵', draggable: 'false'}), show = h('input', {type: 'checkbox', checked: true});
    show.onchange = () => { over.hidden = !show.checked; };
    if (drawing && st.files['face/align.json']) getJSON(st.files['face/align.json']).then(al => {
      const a = al[drawing.path.split('/').pop().replace(/\.png$/i, '')]; if (!a) return;
      over.onload = () => Object.assign(over.style, {left: pct(a[1]), top: pct(a[2]), width: pct(over.naturalWidth * a[0])});
      over.src = drawing.url; wrap.insertBefore(over, pic.nextSibling);
    }).catch(() => {});
    const boxes = [];
    const place = (b, r) => Object.assign(b.style, {left: pct(r[0]), top: pct(r[1]), width: pct(r[2] - r[0]), height: pct(r[3] - r[1])});
    const draw = () => {
      boxes.forEach(b => b.remove()); boxes.length = 0;
      for (const [k, list] of Object.entries(regions)) list.forEach((r, i) => {
        const b = h('div', {class: 'rect ' + k}, h('span', {class: 'name'}, k === 'upper' ? '目・眉' : `口${list.length > 1 ? i + 1 : ''}`), h('div', {class: 'handle'}));
        place(b, r); wrap.append(b); boxes.push(b);
        b.onpointerdown = e => {
          e.preventDefault(); b.setPointerCapture(e.pointerId);
          const resize = e.target.classList.contains('handle'), start = [...r], x0 = e.clientX, y0 = e.clientY, k2 = size / wrap.clientWidth;
          b.onpointermove = m => {
            const dx = Math.round((m.clientX - x0) * k2), dy = Math.round((m.clientY - y0) * k2);
            if (resize) { r[2] = Math.min(size, Math.max(start[0] + 8, start[2] + dx)); r[3] = Math.min(size, Math.max(start[1] + 8, start[3] + dy)); }
            else { const w = start[2] - start[0], hh = start[3] - start[1]; r[0] = Math.min(size - w, Math.max(0, start[0] + dx)); r[1] = Math.min(size - hh, Math.max(0, start[1] + dy)); r[2] = r[0] + w; r[3] = r[1] + hh; }
            place(b, r); fillNums();
          };
          b.onpointerup = () => { b.onpointermove = null; };
        };
      });
      fillNums();
    };
    const fillNums = () => nums.replaceChildren(...Object.entries(regions).flatMap(([k, list]) => list.map((r, i) => h('div', {class: 'rect-row ' + k},
      h('span', {}, k === 'upper' ? '目・眉' : `口${list.length > 1 ? i + 1 : ''}`),
      ...r.map((v, j) => { const inp = h('input', {type: 'number', value: v, min: 0, max: size, step: 1, 'aria-label': `${k} ${i + 1} ${['x0', 'y0', 'x1', 'y1'][j]}`});
        inp.onchange = () => { r[j] = Math.round(Number(inp.value)); draw(); }; return inp; }),
      k === 'mouth' ? h('button', {class: 'danger', onclick: () => { list.splice(i, 1); draw(); }}, '消す') : null))));
    const add = h('button', {}, '口の四角を追加');
    add.onclick = () => { const last = regions.mouth.at(-1) ?? [Math.round(size * 0.42), Math.round(size * 0.63), Math.round(size * 0.58), Math.round(size * 0.77)]; regions.mouth.push(last.map((v, j) => v + (j % 2 ? 20 : 0))); draw(); };
    const reset = h('button', {}, '保存した形に戻す'); reset.onclick = () => { fromSt(); const old = root; shown = null; root = null; old.replaceWith(el()); };
    const go = h('button', {class: 'primary'}, '保存');
    go.onclick = async () => {
      go.disabled = true; msg.className = 'muted'; msg.textContent = '保存中…';
      const one = l => l.length === 1 ? l[0] : l;
      try { await save({upper: one(regions.upper), ...(regions.mouth.length ? {mouth: one(regions.mouth)} : {})}); }
      catch (e) { msg.className = 'err'; msg.textContent = '保存できない: ' + e.message; go.disabled = false; }
    };
    draw();
    root = h('div', {}, h('div', {class: 'muted'}, `四角の中を引くと動き、右下の角を引くと大きさが変わる。座標は正面の撮影（${size}×${size}）の画素。描いた線がすべて余裕をもって入るように取る。`),
      drawing ? h('label', {class: 'check'}, show, `位置合わせした絵（${drawing.path}）を重ねる`) : null,
      wrap, nums, h('div', {class: 'actions'}, add, reset, go, msg),
      st.steps.rects.stale ? h('div', {class: 'err'}, '正面の撮影が変わった。範囲を見直して保存し直す。') : null);
    return root;
  }
  return {el};
}
