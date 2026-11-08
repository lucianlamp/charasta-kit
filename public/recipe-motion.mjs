// 動きの「モーションを足す」の「つくる」の札と、つないだ結果の確認の欄(docs/motion-compose.md の「画面からつなぐ」、docs/screens.md)。
// 区間を並べて 1 本にする。区間の種類は、保管場所のモーション、確認待ちの結果(文章の候補、動画、MotionBricks)、MotionBricks の条件、文章(Kimodo)、動画。
// 区間が 1 つなら、その種類の単体のジョブ(motion-gen、motion-text、video-motion)を積む。2 つ以上なら motion-recipe を積み、区間の間を MotionBricks(か補間)でつなぐ。
// 文章と動画の区間は 2 つ以上のときには使えない(先にその区間だけで作り、確認待ちの結果を区間にする)。結果はどれも確認の欄で見てから取り込む。
// キット(kit。docs/edition.md)は文章(Kimodo)の区間を出さない。MotionBricks が無いときは MotionBricks の条件の区間も出さず、つなぎの MotionBricks も選べなくして補間にする。
import {h, getJSON, send} from './dom.mjs';
import {genFields, queueGen} from './gen-motion.mjs';
import {textFields} from './text-motion.mjs';
import {videoFields} from './video-motion.mjs';
import {missingNote} from './capabilities.mjs';

const sec = v => Number(v).toFixed(1) + ' 秒';
const nameOf = m => m.label || m.name || m.id;
// 区間の種類。pick は一覧から選ぶもの、alone は 1 つのときだけ使えるもの
const TYPES = [['text', '文章（Kimodo）'], ['motionbricks', 'MotionBricks の条件'], ['video', '動画'], ['motion', '保管場所のモーション'], ['job', '確認待ちの結果（取り込む前）']];
const TYPE_NAME = Object.fromEntries(TYPES);
const PICK = new Set(['motion', 'job']), ALONE = new Set(['text', 'video']);
const GO = {text: '文章から作る', video: '動画から作る', motionbricks: 'MotionBricks で作る'};

// 札。motions() は今のモーションの一覧、sources() は確認待ちの結果の一覧(GET /api/motion-recipes の sources。null なら開いたときの値)を返す関数。
// char と verId は動画の区間が体を合わせる版。queued(job) はジョブを積めたときに呼ぶ
export async function recipePanel({motions, sources = () => null, queued, char = null, verId = null, kit = false, ov = null}) {
  const [o, gen, text, video] = await Promise.all(['/api/motion-recipes', '/api/motion-gen', kit ? null : '/api/motion-texts', '/api/video-motions'].map(u => u && getJSON(u)));
  const types = TYPES.filter(([k]) => !kit || (k !== 'text' && (k !== 'motionbricks' || o.motionbricks)));   // キットは文章を出さず、MotionBricks が無ければ条件の区間も出さない
  let rows = [];   // [{type, key?, seg?, name, fields?, nameEl?, start, end, speed, bridge}]。seg は一覧から選んだ区間の出どころ、fields は条件の部品、bridge はその区間の前のつなぎの秒
  // 一覧から選べるもの。key は motion:<ID> か job:<ジョブ>:<候補の番号>
  const items = () => [
    ...motions().map(m => ({key: `motion:${m.id}`, name: nameOf(m), durationSec: m.durationSec, limit: m.limit, license: m.license, seg: {source: 'motion', motion: m.id}})),
    ...(sources() ?? o.sources).map(s => ({key: `job:${s.job}:${s.n ?? ''}`, name: s.name, kind: s.kind, durationSec: s.durationSec, limit: s.limit, license: s.license,
      seg: {source: 'job', job: s.job, ...(s.n != null && {n: s.n})}}))];
  const find = key => items().find(x => x.key === key);
  const type = h('select', {'aria-label': '区間の種類'}, types.map(([k, v]) => h('option', {value: k}, v)));
  const picker = h('select', {'aria-label': '足すモーション'});
  const option = (x, keep) => h('option', {value: x.key, selected: x.key === keep}, `${x.name}（${sec(x.durationSec)}、${x.limit.text}）`);
  const fillPicker = () => {
    const keep = picker.value, all = items().filter(x => type.value === 'job' ? x.kind : !x.kind);
    picker.replaceChildren(...(all.length ? all.map(x => option(type.value === 'job' ? {...x, name: `${x.kind}: ${x.name}`} : x, keep))
      : [h('option', {value: ''}, type.value === 'job' ? '確認待ちの結果は無い' : 'モーションが無い')]));
    picker.hidden = !PICK.has(type.value);
  };
  type.onchange = fillPicker;
  // 一覧を読み直したあとも新しいモーションと結果を選べるように、開くときに作り直す。並べた区間も描き直し、無くなった結果を知らせる
  picker.addEventListener('focus', () => { fillPicker(); render(); });
  fillPicker();
  const method = h('select', {'aria-label': 'つなぎの作り方'}, Object.entries(o.bridgeMethods).map(([k, v]) => {
    const off = kit && k === 'motionbricks' && !o.motionbricks;   // キットで MotionBricks が無いときは補間だけ
    return h('option', {value: k, selected: k === o.defaultBridge.method, disabled: off}, off ? `${v}（設定が無いので使えない）` : v);
  }));
  const label = h('input', {maxlength: '100', placeholder: '空なら区間の名前から作る', 'aria-label': 'ラベル'});
  const list = h('div', {class: 'stack recipe-list'}), notes = h('div', {class: 'stack-small'});
  const msg = h('span', {class: 'muted'});
  const go = h('button', {type: 'button', class: 'primary big'}, 'つなぐ');
  const joinOnly = h('label', {}, 'つなぎの作り方', method);
  method.onchange = () => render();

  // 区間を 1 つ足す。条件の部品は区間ごとに作り、並べ替えても書きかけを残す
  const changed = r => () => { if (r.nameEl) r.nameEl.textContent = r.fields.name(); renderNotes(); };
  function addRow(t) {
    const r = {type: t, start: '', end: '', speed: '1', bridge: String(o.defaultBridge.seconds)};
    if (PICK.has(t)) {
      const x = find(picker.value);
      if (!x) { msg.className = 'err'; msg.textContent = '一覧から選ぶ'; return; }
      Object.assign(r, {key: x.key, seg: x.seg, name: x.name});
    } else {
      const onChange = changed(r);
      r.fields = t === 'text' ? textFields(text, onChange) : t === 'video' ? videoFields({char, verId, o: video}, onChange) : genFields(gen, onChange);
    }
    if (rows.length >= o.maxSegments) { msg.className = 'err'; msg.textContent = `区間は ${o.maxSegments} 本まで`; return; }
    msg.textContent = '';
    rows.push(r); render();
  }
  const add = h('button', {type: 'button', onclick: () => addRow(type.value)}, '足す');

  const num = (value, attrs, label, set) => {
    const input = h('input', {type: 'number', value, 'aria-label': label, ...attrs});
    input.oninput = () => { set(input.value); renderNotes(); };
    return input;
  };
  function render() {
    list.replaceChildren(...rows.flatMap((r, k) => {
      const m = r.key ? find(r.key) : null;   // 取り込んだか捨てた確認待ちの結果は無くなる
      const move = d => { const [x] = rows.splice(k, 1); rows.splice(k + d, 0, x); render(); };
      const limit = r.type === 'motionbricks' ? {text: '評価用のみ', warn: true} : m?.limit;
      r.nameEl = h('span', {class: 'motion-name'}, r.fields ? r.fields.name() : r.seg.source === 'job' ? `${m?.kind ?? '確認待ち'}: ${r.name}` : r.name);
      const nums = k2 => [h('label', {}, '開始の秒', num(r.start, {step: '0.1', min: '0', placeholder: '0'}, `${k2} 番の開始の秒`, v => { r.start = v; })),
        h('label', {}, '終了の秒', num(r.end, {step: '0.1', min: '0', placeholder: '最後'}, `${k2} 番の終了の秒`, v => { r.end = v; }))];
      const seg = h('div', {class: 'recipe-row', 'data-seg': k + 1, 'data-type': r.type},
        h('div', {class: 'recipe-head'}, h('span', {class: 'mono'}, `${k + 1}.`), r.nameEl,
          h('span', {class: 'mono muted'}, r.fields ? '' : m ? sec(m.durationSec) : '無い')),
        // 条件で作る区間は、種類を操作の行に出す(狭い欄で見出しの名前を削らないため)
        h('div', {class: 'recipe-ctrl'}, h('span', {class: limit?.warn ? 'limit warn' : 'limit'}, [r.fields ? TYPE_NAME[r.type] : null, limit?.text].filter(Boolean).join('・')),
          h('button', {type: 'button', class: 'quiet', 'aria-label': `${k + 1} 番を上へ`, disabled: k === 0, onclick: () => move(-1)}, '↑'),
          h('button', {type: 'button', class: 'quiet', 'aria-label': `${k + 1} 番を下へ`, disabled: k === rows.length - 1, onclick: () => move(1)}, '↓'),
          h('button', {type: 'button', class: 'quiet', 'aria-label': `${k + 1} 番を外す`, onclick: () => { rows.splice(k, 1); render(); }}, '外す')),
        r.fields ? r.fields.el : null,
        // 切り出しは並べてつなぐときだけ使う。MotionBricks の速さは条件の速さ(m/s)なので、再生の速さは無い
        r.type === 'motionbricks' && rows.length > 1 ? h('div', {class: 'seg recipe-nums two'}, nums(k + 1)) : null,
        PICK.has(r.type) ? h('div', {class: 'seg recipe-nums'}, nums(k + 1),
          h('label', {}, '速さ', num(r.speed, {step: '0.05', min: String(o.speed[0]), max: String(o.speed[1])}, `${k + 1} 番の速さ`, v => { r.speed = v; }))) : null);
      if (k === 0) return [seg];
      const gap = h('label', {class: 'recipe-bridge'}, `つなぎ（秒。0 でつながない）`,
        num(r.bridge, {step: '0.1', min: String(o.bridgeSeconds[0]), max: String(o.bridgeSeconds[1])}, `${k} 番と ${k + 1} 番のつなぎの秒`, v => { r.bridge = v; }));
      return [gap, seg];
    }));
    if (!rows.length) list.append(h('div', {class: 'empty small'}, '区間の種類を選んで「足す」。1 つなら作り、2 つ以上なら上から順につなぐ。'));
    renderNotes();
  }
  // 先に出す注意: 評価用・個人利用の区間が入ると全体がその条件になる。MotionBricks のつなぎは二次配布不可。範囲の外の長さは補間になる。
  // 文章と動画の区間は 2 つ以上のときに使えない。ボタンの文言も区間の数と種類で変える
  function renderNotes() {
    const out = [], many = rows.length > 1, ms = rows.filter(r => r.key).map(r => find(r.key)).filter(Boolean), gone = rows.filter(r => r.key && !find(r.key));
    const gens = rows.filter(r => r.type === 'motionbricks'), alone = rows.filter(r => ALONE.has(r.type));
    joinOnly.style.display = many ? '' : 'none';   // label は form-stack の display が hidden に勝つので style で隠す
    go.textContent = many ? 'つなぐ' : rows.length === 1 ? GO[rows[0].type] ?? 'つなぐ' : 'つなぐ';
    go.disabled = (rows.length === 1 && rows[0].fields && !rows[0].fields.available) || (many && alone.length > 0);
    if (rows.length === 1 && PICK.has(rows[0].type)) out.push(h('p', {class: 'muted'}, '1 つだけではつなげない。もう 1 つ区間を足す。'));
    if (many && alone.length) out.push(h('p', {class: 'err'}, `${alone.map(r => `${rows.indexOf(r) + 1} 番（${TYPE_NAME[r.type]}）`).join('、')}は、2 つ以上並べるときには使えない。`
      + '先にその区間だけで作り（ほかの区間を外して「作る」）、確認の欄に出た結果を「確認待ちの結果」として足す。'));
    if (!many) { notes.replaceChildren(...out); return; }
    const evals = [...ms.filter(m => m.license?.evaluationOnly).map(m => m.name), ...gens.map(r => r.fields.name())];
    const warns = ms.filter(m => m.limit.warn && !m.license?.evaluationOnly);
    if (gone.length) out.push(h('p', {class: 'err'}, `${gone.map(r => r.name).join('、')} は一覧から無くなった（取り込んだか捨てた）。外して、取り込んだならそのモーションを足す。`));
    if (evals.length) out.push(h('div', {class: 'limit warn'}, `評価用のみの区間（${[...new Set(evals)].join('、')}）が入るので、つないだモーション全体が評価用のみになる。動画は公開できない。`));
    if (warns.length) out.push(h('div', {class: 'limit warn'}, `${[...new Set(warns.map(m => `${m.name}（${m.limit.text}）`))].join('、')} が入るので、全体もその条件になる。`));
    if (ms.some(m => m.kind)) out.push(h('div', {class: 'muted'}, '確認待ちの結果は、つないでも取り込んだことにはならない。元の確認の欄は残る。つなぐジョブが待っているか動いている間は、その結果を捨てられない。'));
    const gaps = rows.slice(1).map(r => Number(r.bridge));
    if (method.value === 'motionbricks' && gaps.some(s => s > 0)) {
      out.push(h('div', {class: 'muted'}, 'つなぎは MotionBricks のモデル（NVIDIA Open Model Agreement）で作るので、全体は二次配布 不可になる。見本の動きは使わないので、つなぎだけでは評価用にならない。'));
      const [lo, hi] = o.motionbricksSeconds, out_ = gaps.map((s, k) => [s, k + 1]).filter(([s]) => s > 0 && (s < lo || s > hi));
      if (out_.length) out.push(h('div', {class: 'muted'}, `${out_.map(([, k]) => `${k} 番と ${k + 1} 番`).join('、')}のつなぎは ${lo.toFixed(2)}〜${hi.toFixed(2)} 秒の外なので補間になる。`));
    }
    if (!o.motionbricks && (gens.length || (method.value === 'motionbricks' && gaps.some(s => s > 0))))
      out.push(h('p', {class: 'err'}, `MotionBricks が見つからない（設定の motionbricksDir: ${o.motionbricksDir ?? 'なし'}）。このままでは失敗するので、MotionBricks の条件の区間を外し、つなぎ方を「補間」に変えて積む。`));
    notes.replaceChildren(...out);
  }
  // 区間 1 つは単体のジョブ、2 つ以上はレシピ
  const queueOne = r => r.type === 'motionbricks' ? queueGen(r.fields, label.value.trim()) : r.fields.queue(label.value.trim());
  function recipeBody() {
    const segments = rows.map((r, k) => {
      const trim = r.start !== '' || r.end !== '' ? {trim: [Number(r.start || 0), r.end === '' ? null : Number(r.end)]} : {};
      const bridge = k > 0 ? {bridge: {seconds: Number(r.bridge), method: method.value}} : {};
      if (r.type === 'motionbricks') return {source: 'motionbricks', ...r.fields.conditions(), ...trim, ...bridge};
      return {...r.seg, ...trim, ...(Number(r.speed) !== 1 ? {speed: Number(r.speed)} : {}), ...bridge};
    });
    return {type: 'motion-recipe', segments, bridge: {seconds: o.defaultBridge.seconds, method: method.value}, label: label.value.trim() || undefined};
  }
  go.onclick = async () => {
    if (!rows.length) { msg.className = 'err'; msg.textContent = '区間を足す'; return; }
    if (rows.length === 1 && PICK.has(rows[0].type)) { msg.className = 'err'; msg.textContent = `区間を ${o.minSegments} つ以上並べる`; return; }
    go.disabled = true; msg.className = 'muted'; msg.textContent = rows[0].type === 'video' && rows.length === 1 ? '動画を送っている…' : '送っている…';
    try {
      const job = rows.length === 1 ? await queueOne(rows[0]) : await send('POST', '/api/jobs', recipeBody());
      msg.textContent = `積んだ: ${job.input.label}`;
      queued(job);
    } catch (e) { msg.className = 'err'; msg.textContent = '積めない: ' + e.message; }
    renderNotes();
  };
  addRow(kit ? 'video' : 'text');   // 開いたときは区間を 1 つ置く(作者の版は文章で、今までの「文章」の札と同じ入口。キットは動画)
  return h('div', {class: 'form-stack', id: 'motionRecipePanel'},
    h('div', {class: 'recipe-pick'}, h('div', {class: 'stack-small'}, type, picker), add), list,
    kit && !o.motionbricks ? missingNote(ov, ['motionbricks'], 'MotionBricks が無いので、つなぎは補間になり、MotionBricks の条件の区間は使えない') : null,
    joinOnly, notes,
    h('label', {}, 'ラベル（100 文字まで）', label), go, msg,
    h('p', {class: 'muted'}, `区間を上から順に並べる（${o.maxSegments} 本まで）。1 つなら、その区間だけを作って確認の欄に出す。2 つ以上なら、区間の終わりの向きと位置に次の区間を置き、間を作って 1 本にする。`
      + '結果は確認の欄で再生してから取り込む。元のモーションは変えない。'));
}

// 確認待ちのジョブを box に出す。preview(record) はつないだ VRMA をビューアで再生する。changed() は取り込み・捨てるのあとで呼ぶ。
// 返すのは区間に使える確認待ちの結果(札の sources())
export async function showRecipeReviews(box, {preview, changed}) {
  const {waiting, sources} = await getJSON('/api/motion-recipes');
  box.replaceChildren(...waiting.map(j => reviewCard(j, {preview, changed})));
  return sources;
}

function reviewCard(j, {preview, changed}) {
  const r = j.result, id = encodeURIComponent(j.id), rep = r.report;
  const label = h('input', {maxlength: '100', value: r.label, 'aria-label': 'ラベル'});
  const motionId = h('input', {value: 'compose-' + j.id, 'aria-label': 'モーション ID'});
  const msg = h('span', {class: 'muted'});
  const act = async (fn, busy) => {
    buttons.forEach(b => { b.disabled = true; }); msg.className = 'muted'; msg.textContent = busy;
    try { await fn(); await changed(); }
    catch (e) { msg.className = 'err'; msg.textContent = e.message; buttons.forEach(b => { b.disabled = false; }); }
  };
  const see = h('button', {type: 'button', disabled: !preview, onclick: async () => {
    try { await preview({id: `recipe-${j.id}`, name: r.label, label: `${r.label}（確認中）`, file: r.vrmaUrl, contactsUrl: r.contactsUrl, generated: {root: 'keep'}}); msg.className = 'muted'; msg.textContent = ''; }
    catch (e) { msg.className = 'err'; msg.textContent = '再生できない: ' + e.message; }
  }}, '見る');
  const take = h('button', {type: 'button', class: 'primary', onclick: () => act(() => send('POST', `/api/motion-recipes/${id}/import`, {label: label.value.trim(), motionId: motionId.value.trim()}), '取り込み中…')}, '取り込む');
  const drop = h('button', {type: 'button', onclick: () => act(() => send('POST', `/api/motion-recipes/${id}/discard`), '捨てている…')}, '捨てる');
  const buttons = [see, take, drop];
  const far = rep.elsewhereP99 ?? {};
  // 継ぎ目の速さは、継ぎ目から離れたコマの 99 パーセンタイルと比べて読む(check.py)
  const seamRows = (rep.seams ?? []).map(s => h('tr', {class: s.speedMaxMps > far.speedMps || s.speedChangeMaxMps > far.speedChangeMps ? 'warn' : ''},
    h('td', {class: 'mono'}, `${s.frame}`, h('br'), sec(s.frame / 30)), h('td', {class: 'mono'}, String(s.speedMaxMps), h('br'), h('span', {class: 'muted'}, s.joint)), h('td', {class: 'mono'}, String(s.speedChangeMaxMps))));
  const slide = rep.footSlide?.all;
  return h('section', {class: 'form-stack sep video-review recipe-review', 'data-review': j.id},
    h('h2', {}, 'つないだ動きを確かめて取り込む'),
    h('div', {class: 'muted'}, `${r.segments.map((s, k) => `${k + 1}. ${s.name}`).join(' / ')}。${sec(r.durationSec)}、${r.frames} コマ${r.fake ? '（試しの動き）' : ''}`),
    h('div', {class: 'muted'}, 'つなぎ: ' + (r.bridges.map(b => `${b.method === 'motionbricks' ? 'MotionBricks' : b.method === 'interpolate' ? '補間' : 'なし'} ${b.seconds} 秒${b.reason ? `（${b.reason}）` : ''}`).join('、') || 'なし')),
    h('div', {class: 'seg'}, see),
    h('table', {class: 'seam-table'}, h('caption', {class: 'muted'}, `継ぎ目（離れたコマの 99 パーセンタイル: 速さ ${far.speedMps} m/s、変化 ${far.speedChangeMps} m/s。超えた行は注意の色）`),
      h('thead', {}, h('tr', {}, h('th', {}, '継ぎ目'), h('th', {}, '速さの最大 m/s'), h('th', {}, '1 コマの変化 m/s'))), h('tbody', {}, seamRows)),
    slide ? h('div', {class: 'muted'}, `足の滑り（接地のコマ）: 平均 ${slide.meanCmPerSec} cm/s、95% ${slide.p95CmPerSec} cm/s（${slide.contactFrames} コマ）`) : null,
    rep.handInBody ? h('div', {class: rep.handInBody.frames ? 'limit warn' : 'muted'}, `手か肘が胴に入るコマ: ${rep.handInBody.frames}`) : null,
    h('details', {}, h('summary', {class: 'muted'}, '部分ごとの値'),
      (rep.footSlide?.spans ?? []).map((s, k) => h('div', {class: 'muted'}, `${s.label}: 足の滑り 平均 ${s.meanCmPerSec} cm/s、hips の高さ ${rep.hipsHeight?.[k]?.minM}〜${rep.hipsHeight?.[k]?.maxM} m`))),
    h('div', {class: r.license?.evaluationOnly || !r.license?.redistribution ? 'limit warn' : 'limit'}, r.license?.evaluationOnly ? '評価用のみ（動画は公開できない）' : r.license?.redistribution ? '二次配布 可' : '二次配布 不可'),
    h('details', {}, h('summary', {class: 'muted'}, '利用条件の全文（区間とつなぎの条件をまとめたもの）'), h('div', {class: 'muted'}, r.license?.summary ?? '')),
    h('label', {}, 'ラベル', label), h('label', {}, 'モーション ID', motionId),
    h('div', {class: 'seg'}, take, drop), msg);
}
