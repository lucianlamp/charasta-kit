// モーションを作る画面(public/motion-create.mjs)の区間の並びと設定と、つないだ結果の確認のモーダルの中身(docs/motion-compose.md の「画面からつなぐ」、docs/screens.md)。
// 区間を並べて 1 本にする。区間の種類は、保管場所のモーション、確認待ちの結果(文章の候補、動画、MotionBricks)、MotionBricks の条件、文章(Kimodo)、動画。
// 区間が 1 つなら、その種類の単体のジョブ(motion-gen、motion-text、video-motion)を積む。2 つ以上なら motion-recipe を積み、区間の間を MotionBricks(か補間)でつなぐ。
// 文章と動画の区間は 2 つ以上のときには使えない(先にその区間だけで作り、確認待ちの結果を区間にする)。結果はどれも確認のモーダルで見てから取り込む。
// キット(kit。docs/edition.md)は文章(Kimodo)の区間を出さない。MotionBricks が無いときは MotionBricks の条件の区間も出さず、つなぎの MotionBricks も選べなくして補間にする。
// 並べた区間は下書きとして sessionStorage に残し、画面を離れて戻っても続きから並べられる(手元の動画のファイルだけはブラウザの決まりで残らない)。
import {h, getJSON, send} from './dom.mjs';
import {genFields, queueGen} from './gen-motion.mjs';
import {textFields} from './text-motion.mjs';
import {videoFields} from './video-motion.mjs';
import {missingNote} from './capabilities.mjs';
import {limitTag} from './shared.mjs';

const sec = v => Number(v).toFixed(1) + ' 秒';
const nameOf = m => m.label || m.name || m.id;
// 区間の種類。PICK は一覧から選ぶもの、ALONE は 1 つのときだけ使えるもの。ADD は「区間を追加」のボタンの名前
const TYPES = [['text', '文章（Kimodo）'], ['motionbricks', 'MotionBricks の条件'], ['video', '動画'], ['motion', '保管場所のモーション'], ['job', '確認待ちの結果（取り込む前）']];
const TYPE_NAME = Object.fromEntries(TYPES);
const ADD = {text: '文章', motionbricks: 'MotionBricks の条件', video: '動画', motion: '保管場所から', job: '確認待ちの結果'};
const PICK = new Set(['motion', 'job']), ALONE = new Set(['text', 'video']);
const GO = {text: '文章から作る', video: '動画から作る', motionbricks: 'MotionBricks で作る'};

// ---- 下書き(sessionStorage)。読み書きできない環境では残さないだけ ----
const DRAFT = 'charasta.motionDraft';
function readDraft() { try { return JSON.parse(sessionStorage.getItem(DRAFT)) ?? null; } catch { return null; } }
function writeDraft(d) { try { sessionStorage.setItem(DRAFT, JSON.stringify(d)); } catch { /* 残せなくても、この画面の中では続けられる */ } }
// モーションの画面の「これを元に作る」: 保管場所のモーションを区間 1 に入れる。並べてあった区間はその下に残す
export function startFrom(motion) {
  const d = readDraft() ?? {rows: []};
  // 手を付けていない既定の区間(開いたときに置く空の文章か動画の区間)だけの下書きは捨てる。残すと「つないで作る」が押せず、押すたびに区間が積まれる
  const untouched = r => !r.key && ((r.type === 'text' && !r.state?.text?.trim()) || (r.type === 'video' && !r.state?.url?.trim())) && !r.start && !r.end;
  const kept = (d.rows ?? []).filter(r => !untouched(r));
  d.rows = [{type: 'motion', key: `motion:${motion.id}`, name: nameOf(motion), start: '', end: '', speed: '1', bridge: null}, ...kept];   // 本数の上限は、下書きを戻すときに切る
  d.sel = 0;
  writeDraft(d);
}
// 下書きの key から区間の出どころを戻す(一覧から無くなった区間も、外すまでは並びに残す)
function segOfKey(key) {
  const [kind, a, b] = key.split(':');
  return kind === 'motion' ? {source: 'motion', motion: a} : {source: 'job', job: a, ...(b && {n: Number(b)})};
}

// 区間の並びの部品。motions は今のモーションの一覧。char と verId は動画の区間が体を合わせるバージョン。
// queued(job) はジョブを積めたときに、onSelect(preview) は区間を選んだときに呼ぶ(preview は {motion} か {record} か {note})。
// 返すのは画面に置く部品: list(区間の並び)、adder(区間を追加)、help(並びの下の注意)、settings(選んだ区間の設定)、footer(ラベルと作るボタン)、strip(区間の時間の帯)
export async function recipeEditor({motions, queued, onSelect = () => {}, char = null, verId = null, kit = false, ov = null}) {
  const [o, gen, text, video] = await Promise.all(['/api/motion-recipes', '/api/motion-gen', kit ? null : '/api/motion-texts', '/api/video-motions'].map(u => u && getJSON(u)));
  const types = TYPES.filter(([k]) => !kit || (k !== 'text' && (k !== 'motionbricks' || o.motionbricks)));   // キットは文章を出さず、MotionBricks が無ければ条件の区間も出さない
  let sources = o.sources, rows = [], sel = 0;   // rows: [{type, key?, seg?, name, fields?, start, end, speed, bridge}]。seg は一覧から選んだ区間の出どころ、fields は条件の部品、bridge はその区間の前のつなぎの秒
  // 一覧から選べるもの。key は motion:<ID> か job:<ジョブ>:<候補の番号>
  const items = () => [
    ...motions.map(m => ({key: `motion:${m.id}`, name: nameOf(m), durationSec: m.durationSec, limit: m.limit, license: m.license, motion: m.id, seg: {source: 'motion', motion: m.id}})),
    ...sources.map(s => ({key: `job:${s.job}:${s.n ?? ''}`, name: s.name, kind: s.kind, type: s.type, job: s.job, n: s.n, durationSec: s.durationSec, limit: s.limit, license: s.license,
      seg: {source: 'job', job: s.job, ...(s.n != null && {n: s.n})}}))];
  const find = key => items().find(x => x.key === key);
  const choices = t => items().filter(x => t === 'job' ? x.kind : !x.kind);
  const method = h('select', {'aria-label': 'つなぎの作り方'}, Object.entries(o.bridgeMethods).map(([k, v]) => {
    const off = kit && k === 'motionbricks' && !o.motionbricks;   // キットで MotionBricks が無いときは補間だけ
    return h('option', {value: k, selected: k === o.defaultBridge.method, disabled: off}, off ? `${v}（設定が無いので使えない）` : v);
  }));
  const label = h('input', {maxlength: '100', placeholder: '空なら区間の名前から作る', 'aria-label': 'ラベル'});
  const list = h('ol', {class: 'seg-list', 'aria-label': '区間の並び'}), notes = h('div', {class: 'stack-small'}), settings = h('div', {class: 'form-stack seg-settings'});
  const strip = h('div', {class: 'seg-strip'});
  const msg = h('p', {class: 'muted', role: 'status'});
  const go = h('button', {type: 'button', class: 'primary big'}, 'つないで作る');
  const joinOnly = h('label', {}, 'つなぎの作り方（全部のつなぎに共通）', method);
  method.onchange = () => { renderList(); renderNotes(); save(); };

  const save = () => writeDraft({sel, label: label.value, method: method.value,
    rows: rows.map(r => ({type: r.type, key: r.key, name: r.name, start: r.start, end: r.end, speed: r.speed, bridge: r.bridge, state: r.fields?.save()}))});
  // 条件の部品は区間ごとに作り、並べ替えても選び直しても書きかけを残す
  const changed = () => () => { renderList(); renderNotes(); };
  const makeRow = (t, extra = {}) => {
    const r = {type: t, start: '', end: '', speed: '1', bridge: String(o.defaultBridge.seconds), ...extra};
    if (!PICK.has(t)) r.fields = t === 'text' ? textFields(text, changed()) : t === 'video' ? videoFields({char, verId, o: video}, changed()) : genFields(gen, changed());
    return r;
  };
  const say = (cls, text) => { msg.className = cls; msg.textContent = text; };

  // 確認待ちの結果は、この画面を開いたあとにも増える。読めなければ今の一覧のまま
  const refreshSources = async () => { try { sources = (await getJSON('/api/motion-recipes')).sources; return true; } catch { return false; } };
  async function addRow(t) {
    if (t === 'job') await refreshSources();
    if (rows.length >= o.maxSegments) { say('err', `区間は ${o.maxSegments} 本まで`); return; }
    const extra = {};
    if (PICK.has(t)) {
      const x = choices(t)[0];
      if (!x) { say('err', t === 'job' ? '確認待ちの結果は無い' : 'モーションが無い'); return; }
      Object.assign(extra, {key: x.key, seg: x.seg, name: x.name});
    }
    say('muted', '');
    rows.push(makeRow(t, extra));
    renderAll(); select(rows.length - 1);
  }
  const adder = h('div', {class: 'seg-add', role: 'group', 'aria-label': '区間を追加'}, types.map(([k]) => h('button', {type: 'button', 'data-add': k, onclick: () => addRow(k)}, ADD[k])));

  const num = (value, attrs, aria, set) => {
    const input = h('input', {type: 'number', value, 'aria-label': aria, ...attrs});
    input.oninput = () => { set(input.value); renderList(); renderNotes(); save(); };
    return input;
  };
  // 区間の長さ(帯と並びに出す)。分からなければ null
  function lengthOf(r) {
    const x = r.key ? find(r.key) : null;
    const full = x ? x.durationSec : r.fields?.seconds?.() ?? null;
    if (full == null) return null;
    if (r.type === 'video') return full;   // 動画は開始と終了の秒から求めてある
    const a = Number(r.start || 0), b = r.end === '' ? full : Math.min(full, Number(r.end));
    return Math.max(0, b - a) / (PICK.has(r.type) ? Number(r.speed) || 1 : 1);
  }
  const rowName = r => {
    const x = r.key ? find(r.key) : null;
    return r.fields ? r.fields.name() : r.seg?.source === 'job' ? `${x?.kind ?? '確認待ち'}: ${x?.name ?? r.name}` : x?.name ?? r.name;
  };
  const rangeText = r => {
    if (r.key && !find(r.key)) return '一覧に無い';
    const len = lengthOf(r), trim = r.start !== '' || r.end !== '' ? `${Number(r.start || 0).toFixed(1)}–${r.end === '' ? '最後' : Number(r.end).toFixed(1)} 秒` : null;
    return [trim ?? (len == null ? '長さは作るまで分からない' : sec(len)), PICK.has(r.type) && Number(r.speed) !== 1 ? `速さ ${Number(r.speed).toFixed(2)}` : null].filter(Boolean).join('・');
  };
  const tagOf = r => {
    if (r.type === 'motionbricks') return {text: '評価用のみ', warn: true};
    const x = r.key ? find(r.key) : null, text = x && limitTag(x, x.name);
    return text ? {text, warn: x.limit.warn} : null;
  };

  // 左の並び: 区間のカードと、区間の間のつなぎ
  function renderList() {
    list.replaceChildren(...rows.flatMap((r, k) => {
      const tag = tagOf(r);
      const card = h('li', {class: 'seg-item'}, h('button', {type: 'button', class: 'seg-card', 'aria-pressed': String(k === sel), 'data-seg': k + 1, 'data-type': r.type, onclick: () => select(k)},
        h('span', {class: 'mono seg-n'}, String(k + 1)),
        h('span', {class: 'seg-body'}, h('span', {class: 'seg-type'}, TYPE_NAME[r.type]), h('span', {class: 'motion-name'}, rowName(r)),
          h('span', {class: 'mono muted'}, rangeText(r)), tag ? h('span', {class: tag.warn ? 'limit warn' : 'limit'}, tag.text) : null)));
      if (k === 0) return [card];
      const s = Number(r.bridge);
      return [h('li', {class: 'seg-gap'}, s > 0 ? `つなぎ ${s} 秒（${o.bridgeMethods[method.value]}）` : 'つなぎ無し'), card];
    }));
    if (!rows.length) list.append(h('li', {class: 'empty small'}, '「区間を追加」から区間を置く。1 つなら作り、2 つ以上なら上から順につなぐ。'));
    renderStrip();
  }
  // 中央の帯: 区間とつなぎの長さの割合。長さの分からない区間は、分かる区間の平均の幅で出す
  function renderStrip() {
    const lens = rows.map(lengthOf), known = lens.filter(x => x != null), unknownW = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 2;
    const parts = [];
    let total = 0;
    rows.forEach((r, k) => {
      const gap = k > 0 ? Number(r.bridge) || 0 : 0;
      if (gap > 0) { parts.push(h('span', {class: 'strip-gap', style: `flex-grow: ${gap}`, title: `つなぎ ${gap} 秒`})); total += gap; }
      if (lens[k] != null) total += lens[k];
      parts.push(h('button', {type: 'button', class: 'strip-seg', 'aria-pressed': String(k === sel), style: `flex-grow: ${lens[k] || unknownW}`, title: `${k + 1}. ${rowName(r)}`, 'aria-label': `${k + 1} 番の区間を選ぶ`, onclick: () => select(k)},
        `${k + 1} ${rowName(r)}`));
    });
    strip.replaceChildren(h('div', {class: 'strip-head mono'}, h('span', {}, '0 秒'), h('span', {}, rows.length ? `目安 ${total.toFixed(1)} 秒${lens.some(x => x == null) ? '（長さの分からない区間を除く）' : ''}` : '')),
      h('div', {class: 'strip-row'}, parts));
  }
  // 右の欄: 選んだ区間の設定
  function renderSettings() {
    const r = rows[sel];
    if (!r) { settings.replaceChildren(h('p', {class: 'muted'}, '区間を選ぶと、ここに設定が出る。')); return; }
    const k = sel, many = rows.length > 1;
    const move = d => { const [x] = rows.splice(k, 1); rows.splice(k + d, 0, x); sel = k + d; renderAll(); };
    const nums = [h('label', {}, '開始の秒', num(r.start, {step: '0.1', min: '0', placeholder: '0'}, `${k + 1} 番の開始の秒`, v => { r.start = v; })),
      h('label', {}, '終了の秒', num(r.end, {step: '0.1', min: '0', placeholder: '最後'}, `${k + 1} 番の終了の秒`, v => { r.end = v; }))];
    let pick = null;
    if (PICK.has(r.type)) {
      const x = find(r.key);
      pick = h('select', {'aria-label': r.type === 'job' ? '確認待ちの結果' : 'モーション'});
      const fillPick = () => pick.replaceChildren(...[find(r.key) ? null : h('option', {value: r.key ?? ''}, `${r.name ?? ''}（一覧に無い）`),
        ...choices(r.type).map(y => h('option', {value: y.key, selected: y.key === r.key}, `${r.type === 'job' ? `${y.kind}: ` : ''}${y.name}（${[sec(y.durationSec), limitTag(y, y.name)].filter(Boolean).join('、')}）`))].filter(Boolean));
      fillPick();
      pick.onchange = () => { const y = find(pick.value); if (!y) return; Object.assign(r, {key: y.key, seg: y.seg, name: y.name}); renderNotes(); select(k); };
      // 確認待ちの結果は作っている間に増えるので、選択肢に触れるたびに読み直して選択肢を作り直す
      if (r.type === 'job') pick.addEventListener('focus', async () => { if (await refreshSources()) { fillPick(); renderList(); renderNotes(); } });
    }
    settings.replaceChildren(...[
      h('div', {class: 'seg-settings-head'}, h('h2', {}, `区間 ${k + 1}（${TYPE_NAME[r.type]}）`),
        h('div', {class: 'seg-ctrl'},
          h('button', {type: 'button', class: 'quiet', 'aria-label': `${k + 1} 番を上へ`, disabled: k === 0, onclick: () => move(-1)}, '↑'),
          h('button', {type: 'button', class: 'quiet', 'aria-label': `${k + 1} 番を下へ`, disabled: k === rows.length - 1, onclick: () => move(1)}, '↓'),
          h('button', {type: 'button', class: 'quiet', 'aria-label': `${k + 1} 番を外す`, onclick: () => { rows.splice(k, 1); sel = Math.max(0, Math.min(k, rows.length - 1)); renderAll(); if (rows.length) select(sel); }}, '外す'))),
      pick ? h('label', {}, r.type === 'job' ? '確認待ちの結果' : 'モーション', pick) : null,
      r.fields ? r.fields.el : null,
      // 切り出しは並べてつなぐときだけ使う。MotionBricks の速さは条件の速さ(m/s)なので、再生の速さは無い
      r.type === 'motionbricks' && many ? h('div', {class: 'seg recipe-nums two'}, nums) : null,
      PICK.has(r.type) ? h('div', {class: 'seg recipe-nums'}, nums,
        h('label', {}, '速さ', num(r.speed, {step: '0.05', min: String(o.speed[0]), max: String(o.speed[1])}, `${k + 1} 番の速さ`, v => { r.speed = v; }))) : null,
      k > 0 ? h('label', {class: 'recipe-bridge'}, '前の区間とのつなぎ（秒。0 でつながない）',
        num(r.bridge, {step: '0.1', min: String(o.bridgeSeconds[0]), max: String(o.bridgeSeconds[1])}, `${k} 番と ${k + 1} 番のつなぎの秒`, v => { r.bridge = v; })) : null].filter(Boolean));   // replaceChildren は null を文字の null にする
  }
  // 先に出す注意: 評価用・個人利用の区間が入ると全体がその条件になる。MotionBricks のつなぎは二次配布不可。範囲の外の長さは補間になる。
  // 文章と動画の区間は 2 つ以上のときに使えない。ボタンの文言も区間の数と種類で変える
  function renderNotes() {
    const out = [], many = rows.length > 1, ms = rows.filter(r => r.key).map(r => find(r.key)).filter(Boolean), gone = rows.filter(r => r.key && !find(r.key));
    const gens = rows.filter(r => r.type === 'motionbricks'), alone = rows.filter(r => ALONE.has(r.type));
    joinOnly.style.display = many ? '' : 'none';   // label は form-stack の display が hidden に勝つので style で隠す
    go.textContent = rows.length === 1 ? GO[rows[0].type] ?? 'つないで作る' : 'つないで作る';
    go.disabled = !rows.length || (rows.length === 1 && rows[0].fields && !rows[0].fields.available) || (many && alone.length > 0);
    if (rows.length === 1 && PICK.has(rows[0].type)) out.push(h('p', {class: 'muted'}, '1 つだけではつなげない。もう 1 つ区間を追加する。'));
    if (many && alone.length) out.push(h('p', {class: 'err'}, `${alone.map(r => `${rows.indexOf(r) + 1} 番（${TYPE_NAME[r.type]}）`).join('、')}は、2 つ以上並べるときには使えない。`
      + '先にその区間だけで作り（ほかの区間を外して作る）、確認待ちに入った結果を「確認待ちの結果」として追加する。'));
    if (!many) { notes.replaceChildren(...out); return; }
    const evals = [...ms.filter(m => m.license?.evaluationOnly).map(m => m.name), ...gens.map(r => r.fields.name())];
    const warns = ms.filter(m => m.limit.warn && !m.license?.evaluationOnly);
    if (gone.length) out.push(h('p', {class: 'err'}, `${gone.map(r => r.name).join('、')} は一覧から無くなった（取り込んだか捨てた）。外して、取り込んだならそのモーションを追加する。`));
    if (evals.length) out.push(h('div', {class: 'limit warn'}, `評価用のみの区間（${[...new Set(evals)].join('、')}）が入るので、つないだモーション全体が評価用のみになる。動画は公開できない。`));
    if (warns.length) out.push(h('div', {class: 'limit warn'}, `${[...new Set(warns.map(m => `${m.name}（${m.limit.text}）`))].join('、')} が入るので、全体もその条件になる。`));
    if (ms.some(m => m.kind)) out.push(h('div', {class: 'muted'}, '確認待ちの結果は、つないでも取り込んだことにはならない。元の確認待ちの結果は残る。つなぐジョブが待っているか動いている間は、その結果を捨てられない。'));
    const gaps = rows.slice(1).map(r => Number(r.bridge));
    if (method.value === 'motionbricks' && gaps.some(s => s > 0)) {
      out.push(h('div', {class: 'muted'}, 'つなぎは MotionBricks のモデル（NVIDIA Open Model Agreement）で作るので、全体は二次配布 不可になる。見本のモーションは使わないので、つなぎだけでは評価用にならない。'));
      const [lo, hi] = o.motionbricksSeconds, out_ = gaps.map((s, k) => [s, k + 1]).filter(([s]) => s > 0 && (s < lo || s > hi));
      if (out_.length) out.push(h('div', {class: 'muted'}, `${out_.map(([, k]) => `${k} 番と ${k + 1} 番`).join('、')}のつなぎは ${lo.toFixed(2)}〜${hi.toFixed(2)} 秒の外なので補間になる。`));
    }
    if (!o.motionbricks && (gens.length || (method.value === 'motionbricks' && gaps.some(s => s > 0))))
      out.push(h('p', {class: 'err'}, `MotionBricks が見つからない（設定の motionbricksDir: ${o.motionbricksDir ?? 'なし'}）。このままでは失敗するので、MotionBricks の条件の区間を外し、つなぎ方を「補間」に変えて送る。`));
    notes.replaceChildren(...out);
  }
  function renderAll() { renderList(); renderSettings(); renderNotes(); save(); }
  // 区間を選ぶ: 設定を出し、ビューアで見られるものを渡す
  function select(k) {
    sel = k; renderList(); renderSettings(); save();
    if (rows[k]) onSelect(previewOf(rows[k]));
  }
  function previewOf(r) {
    const x = r.key ? find(r.key) : null;
    if (r.key && !x) return {note: 'この区間は一覧から無くなったので見られない。'};
    if (x?.motion) return {motion: x.motion};
    if (x?.type === 'motion-gen') {
      const base = `/api/motion-gen/${encodeURIComponent(x.job)}`;
      return {record: {id: `gen-${x.job}`, name: x.name, label: `${x.name}（確認中）`, file: `${base}/motion.vrma`, contactsUrl: `${base}/contacts.json`}};
    }
    if (x?.type === 'motion-text') {
      const base = `/api/motion-texts/${encodeURIComponent(x.job)}/candidates/${x.n}`;
      return {record: {id: `text-${x.job}-${x.n}`, name: x.name, label: `${x.name}（確認中）`, file: `${base}/motion.vrma`, contactsUrl: `${base}/contacts.json`}};
    }
    if (x) return {note: '動画の結果は、モーションの画面の「確認待ちの結果を見比べる」で比較の動画を見る。'};
    return {note: 'まだ作っていない区間なので、ビューアでは見られない。作ると確認待ちに入る。'};
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
    if (!rows.length) { say('err', '区間を追加する'); return; }
    if (rows.length === 1 && PICK.has(rows[0].type)) { say('err', `区間を ${o.minSegments} つ以上並べる`); return; }
    go.disabled = true; say('muted', rows[0].type === 'video' && rows.length === 1 ? '動画を送っている…' : '送っている…');
    try {
      const job = rows.length === 1 ? await queueOne(rows[0]) : await send('POST', '/api/jobs', recipeBody());
      say('muted', `受け付けた: ${job.input.label}。できたら確認待ちに入る（モーションの画面の「確認待ちの結果を見比べる」）。この画面を離れても作り続ける。`);
      queued(job);
    } catch (e) { say('err', '始められない: ' + e.message); }
    renderNotes(); save();
  };
  label.addEventListener('input', save);
  // 条件の部品の入力も下書きに残す(値が変わるたびに知らせない部品がある)
  settings.addEventListener('input', save); settings.addEventListener('change', save);

  // 下書きを戻す。無ければ区間を 1 つ置く(作者の版は文章、キットは動画)
  const d = readDraft();
  if (d) {
    label.value = d.label ?? '';
    if ([...method.options].some(x => x.value === d.method && !x.disabled)) method.value = d.method;
    for (const s of (d.rows ?? []).slice(0, o.maxSegments)) {
      if (!types.some(([k]) => k === s.type)) continue;   // この版に無い種類
      const x = s.key ? find(s.key) : null;
      const r = makeRow(s.type, {...(s.key && {key: s.key, seg: x?.seg ?? segOfKey(s.key)}), name: x?.name ?? s.name, start: s.start ?? '', end: s.end ?? '', speed: s.speed ?? '1',
        bridge: s.bridge ?? String(o.defaultBridge.seconds)});
      if (r.fields && s.state) r.fields.load(s.state);
      rows.push(r);
    }
    sel = Math.min(Math.max(0, d.sel ?? 0), Math.max(0, rows.length - 1));
  } else rows.push(makeRow(kit ? 'video' : 'text'));
  renderAll();
  const aloneNames = types.filter(([k]) => ALONE.has(k)).map(([k]) => ADD[k]);
  const help = [h('p', {class: 'muted'}, `${aloneNames.join('と')}の区間は、先にその区間だけで作って確認待ちに入れてから、「確認待ちの結果」として足してつなぐ。区間は ${o.maxSegments} 本まで。`),
    kit && !o.motionbricks ? missingNote(ov, ['motionbricks'], 'MotionBricks が無いので、つなぎは補間になり、MotionBricks の条件の区間は使えない') : null];
  const footer = h('div', {class: 'form-stack seg-footer'}, joinOnly, notes, h('label', {}, 'ラベル（100 文字まで）', label), go, msg,
    h('p', {class: 'muted'}, '2 つ以上なら、区間の終わりの向きと位置に次の区間を置き、間を作って 1 本にする。元のモーションは変えない。'));
  return {list, adder, help, settings, footer, strip, start: () => { if (rows[sel]) onSelect(previewOf(rows[sel])); }};
}

// 確認待ちの結果 1 件を、確認のモーダルの中身にする(public/motion-review.mjs の形)
export function recipeReview(j) {
  const r = j.result, rep = r.report, far = rep.elsewhereP99 ?? {};
  // 継ぎ目の速さは、継ぎ目から離れたコマの 99 パーセンタイルと比べて読む(check.py)
  const over = s => s.speedMaxMps > far.speedMps || s.speedChangeMaxMps > far.speedChangeMps;
  const seams = rep.seams ?? [], warned = seams.filter(over).length;
  const seamRows = seams.map(s => h('tr', {class: over(s) ? 'warn' : ''},
    h('td', {class: 'mono'}, `${s.frame}`, h('br'), sec(s.frame / 30)), h('td', {class: 'mono'}, String(s.speedMaxMps), h('br'), h('span', {class: 'muted'}, s.joint)), h('td', {class: 'mono'}, String(s.speedChangeMaxMps))));
  const slide = rep.footSlide?.all, lic = r.license;
  return {id: j.id, kind: 'つないだ', label: r.label, motionId: 'compose-' + j.id, api: `/api/motion-recipes/${encodeURIComponent(j.id)}`,
    preview: {id: `recipe-${j.id}`, name: r.label, label: `${r.label}（確認中）`, file: r.vrmaUrl, contactsUrl: r.contactsUrl, generated: {root: 'keep'}},
    facts: [['長さ', `${sec(r.durationSec)}、${r.frames} コマ${r.fake ? '（試しの動き）' : ''}`],
      ['自動の判定', seams.length ? `継ぎ目 ${seams.length} か所のうち ${warned} か所が目安を超えた` : '継ぎ目なし', warned > 0],
      ['区間', r.segments.map((s, k) => `${k + 1}. ${s.name}`).join(' / ')],
      ['つなぎ', r.bridges.map(b => `${b.method === 'motionbricks' ? 'MotionBricks' : b.method === 'interpolate' ? '補間' : 'なし'} ${b.seconds} 秒${b.reason ? `（${b.reason}）` : ''}`).join('、') || 'なし']],
    info: [h('table', {class: 'seam-table'}, h('caption', {class: 'muted'}, `継ぎ目（離れたコマの 99 パーセンタイル: 速さ ${far.speedMps} m/s、変化 ${far.speedChangeMps} m/s。超えた行は注意の色）`),
      h('thead', {}, h('tr', {}, h('th', {}, '継ぎ目'), h('th', {}, '速さの最大 m/s'), h('th', {}, '1 コマの変化 m/s'))), h('tbody', {}, seamRows)),
      slide ? h('div', {class: 'muted'}, `足の滑り（接地のコマ）: 平均 ${slide.meanCmPerSec} cm/s、95% ${slide.p95CmPerSec} cm/s（${slide.contactFrames} コマ）`) : null,
      rep.handInBody ? h('div', {class: rep.handInBody.frames ? 'limit warn' : 'muted'}, `手か肘が胴に入るコマ: ${rep.handInBody.frames}`) : null,
      h('details', {}, h('summary', {class: 'muted'}, '部分ごとの値'),
        (rep.footSlide?.spans ?? []).map((s, k) => h('div', {class: 'muted'}, `${s.label}: 足の滑り 平均 ${s.meanCmPerSec} cm/s、hips の高さ ${rep.hipsHeight?.[k]?.minM}〜${rep.hipsHeight?.[k]?.maxM} m`)))],
    tag: {text: lic?.evaluationOnly ? '評価用のみ（動画は公開できない）' : lic?.redistribution ? '二次配布 可' : '二次配布 不可', warn: !!lic?.evaluationOnly || !lic?.redistribution},
    terms: lic?.summary ?? '', termsLabel: '利用条件の全文（区間とつなぎの条件をまとめたもの）'};
}
