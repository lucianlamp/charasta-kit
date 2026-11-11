// ショートの下書き: 一覧の「テーマから作る」、編集画面の事実の確認の欄と連載の欄。ジョブは lib/short-draft.mjs(docs/shorts-draft.md)、画面は docs/shorts-draft.md。
import {h, getJSON, send} from './dom.mjs';
import {enc, pendingRow, watchJobs} from './shared.mjs';
import {DRAFT_STYLES, pendingClaims, scriptChanged, scriptKey} from './short-direct.mjs';
import {vrmChars} from './char-style.mjs';

const STYLE_LABEL = {trivia: '雑学', drama: 'ドラマ', pop: '派手', news: 'ニュース'};
const DEFAULT_SEC = {trivia: 20, drama: 25, pop: 20, news: 30}, MAX_CAST = 3, DEFAULT_VOICE = 'voicevox:8';
const SURE_LABEL = {high: '高い', medium: '中くらい', low: '低い'};
const EDITOR = id => { location.hash = '#short/' + enc(id); };
export const MAKER_LABEL = {claude: 'Claude', gemini: 'Gemini'};
const makerSelect = text => { const sel = h('select', {'aria-label': text}, ['gemini', 'claude'].map(k => h('option', {value: k}, MAKER_LABEL[k]))); return sel; };

// クリップボードへ写す。http のスマホでは navigator.clipboard が無いので、欄を選んで写す
async function copyText(area) {
  area.hidden = false; area.focus(); area.select();
  try { await navigator.clipboard.writeText(area.value); return true; } catch { return document.execCommand?.('copy') ?? false; }
}

// Gemini の流れの欄: 依頼文を作ってコピーし、答えを貼って取り込む。answerOf は依頼文と取り込みに渡す条件を返す。答えに問題があれば理由と直しの依頼文を出す
function geminiBox({bodyOf, msg, queued, before = async () => {}}) {
  const say = (cls, text) => { msg.className = cls; msg.textContent = text; };
  const request = h('textarea', {rows: '4', readonly: true, hidden: true, 'aria-label': 'Gemini への依頼文'});
  const answer = h('textarea', {rows: '6', maxlength: '60000', placeholder: 'Gemini の答えをここへ貼る。前後の説明文やコードの囲みは付いたままでよい', 'aria-label': 'Gemini の答え'});
  const problems = h('ul', {class: 'err'}), fix = h('textarea', {rows: '4', readonly: true, hidden: true, 'aria-label': 'Gemini への直しの依頼文'});
  const copyFix = h('button', {type: 'button', hidden: true, onclick: async () => say('muted', await copyText(fix) ? '直しの依頼文をコピーした。同じチャットへ貼る。' : '欄の文を選んでコピーする。')}, '直しの依頼文をコピー');
  const copy = h('button', {type: 'button', onclick: async () => {
    copy.disabled = true;
    try {
      await before();
      request.value = (await send('POST', '/api/short-draft/prompt', bodyOf())).prompt;
      say('muted', await copyText(request) ? '依頼文をコピーした。Gemini へ貼る。' : '欄の文を選んでコピーする。');
    } catch (e) { say('err', '依頼文を作れない: ' + e.message); }
    copy.disabled = false;
  }}, '依頼文をコピー');
  const take = h('button', {type: 'button', class: 'primary', onclick: async () => {
    take.disabled = true; say('muted', '確認中…'); problems.replaceChildren(); fix.hidden = copyFix.hidden = true;
    try {
      await before();
      const r = await fetch('/api/short-draft/import', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({...bodyOf(), answer: answer.value})}), j = await r.json();
      if (r.status === 422) {
        say('err', '取り込めない。理由を直しの依頼文にした。');
        problems.replaceChildren(...j.errors.map(e => h('li', {}, e)));
        fix.value = j.fixPrompt; fix.hidden = copyFix.hidden = false;
      } else if (!r.ok) throw Error(j.error);
      else { answer.value = ''; queued(j); say('muted', '受け付けた。雑学は主張を確認するので数分かかる。できると編集画面が開く。'); }
    } catch (e) { say('err', '取り込めない: ' + e.message); }
    take.disabled = false;
  }}, '取り込む');
  return h('div', {class: 'form-stack'}, h('div', {class: 'actions'}, copy), request, h('label', {}, 'Gemini の答え', answer), h('div', {class: 'actions'}, take), problems, fix, copyFix);
}

// 積んだ下書きのジョブを見張り、できたら編集画面を開く
function draftWatcher(box, alive, reload) {
  let mine = null;
  const watcher = watchJobs({filter: j => j.type === 'short-draft', alive, onJobs: jobs => box.replaceChildren(...jobs.map(pendingRow)), onDone: async () => {
    const job = mine && await getJSON('/api/jobs/' + enc(mine));
    if (job?.state === 'done') EDITOR(job.result.shortId);
    else reload?.();   // 積んだあとに画面を移って戻ったときは、できたショートを一覧に出す
  }});
  return {poll: watcher.poll, queued: job => { mine = job.id; watcher.queued(job); }};
}

// 声の選択肢。値は 提供元:ID
const voiceChoices = o => [...o.speakers.map(v => [`voicevox:${v.id}`, `VOICEVOX ${v.name}`]), ...o.elevenVoices.map(v => [`elevenlabs:${v.id}`, `ElevenLabs ${v.name}`])];
function voiceFields(value, o) {
  const [provider, id] = value.split(/:(.*)/s);
  if (provider === 'elevenlabs') return {provider, voiceId: id, voiceName: o.elevenVoices.find(v => v.id === id)?.name ?? ''};
  const v = o.speakers.find(x => String(x.id) === id);
  return {provider, speaker: Number(id), speakerName: v?.speaker ?? '', speed: 1.25};
}

// 一覧の「テーマから作る」の欄
export function draftForm({ov, alive, msg, reload}) {
  const box = h('div', {class: 'pending-list'}), watcher = draftWatcher(box, alive, reload), form = h('div', {class: 'cut draft-form', hidden: true});
  // 話者の一覧を読むと VOICEVOX Engine が起動するので、欄を開いたときに読む
  const open = h('button', {type: 'button', onclick: async () => {
    if (!form.hasChildNodes()) {
      try { form.append(...await draftFields({ov, msg, watcher})); }
      catch (e) { msg.className = 'err'; msg.textContent = '開けない: ' + e.message; return; }
    }
    form.hidden = !form.hidden;
  }}, 'テーマから作る');
  watcher.poll();
  return {open, form, box};
}

async function draftFields({ov, msg, watcher}) {
  const chars = vrmChars(ov.chars).filter(x => x.latest), o = await getJSON('/api/short-options'), voices = voiceChoices(o).length ? voiceChoices(o) : [['voicevox:8', 'VOICEVOX 8']];
  const theme = h('input', {maxlength: '200', placeholder: '例: ペンギンの意外な生態', 'aria-label': 'テーマ'});
  const style = h('select', {'aria-label': '型'}, DRAFT_STYLES.map(k => h('option', {value: k}, STYLE_LABEL[k])));
  const seconds = h('input', {type: 'number', min: '10', max: '60', step: '1', value: String(DEFAULT_SEC.trivia), 'aria-label': '長さ（秒）'});
  const note = h('textarea', {rows: '2', maxlength: '1000', placeholder: '任意。語り口、入れたい話、避けたい話など', 'aria-label': '補足'});
  const castBox = h('div', {class: 'form-stack'}), rows = [];
  const addRow = (c = chars[rows.length % chars.length]) => {
    const name = h('input', {maxlength: '12', value: c.name.slice(0, 12), 'aria-label': `出演者 ${rows.length + 1} の名前`});
    const char = h('select', {'aria-label': `出演者 ${rows.length + 1} のキャラ`}, chars.map(x => h('option', {value: x.id}, x.name))), voice = h('select', {'aria-label': `出演者 ${rows.length + 1} の声`}, voices.map(([v, t]) => h('option', {value: v}, t)));
    char.value = c.id;
    if (voices.some(([v]) => v === DEFAULT_VOICE)) voice.value = DEFAULT_VOICE;
    rows.push({name, char, voice, el: h('div', {class: 'cut-grid'}, h('label', {}, '名前', name), h('label', {}, 'キャラ', char), h('label', {}, '声', voice))});
    castBox.replaceChildren(...rows.map(r => r.el));
  };
  const setRows = n => { while (rows.length > n) rows.pop(); castBox.replaceChildren(...rows.map(r => r.el)); while (rows.length < n) addRow(); };
  style.onchange = () => { seconds.value = String(DEFAULT_SEC[style.value]); setRows(style.value === 'drama' ? 2 : 1); };
  if (chars.length) setRows(1);
  const conditions = () => ({theme: theme.value, style: style.value, seconds: Number(seconds.value), note: note.value, cast: rows.map(r => ({name: r.name.value.trim(), charId: r.char.value, verId: chars.find(x => x.id === r.char.value).latest.id, ...voiceFields(r.voice.value, o)}))});
  const start = h('button', {type: 'button', class: 'primary', onclick: async () => {
    start.disabled = true; msg.className = 'muted'; msg.textContent = '送っている…';
    try {
      watcher.queued(await send('POST', '/api/jobs', {type: 'short-draft', source: 'claude', ...conditions()}));
      msg.textContent = '受け付けた。雑学は調べるので数分かかる。できると編集画面が開く。';
    } catch (e) { msg.className = 'err'; msg.textContent = '始められない: ' + e.message; }
    start.disabled = false;
  }}, '下書きを作る');
  const maker = makerSelect('作り手'), claudeBox = h('div', {class: 'actions', hidden: true}, start), gemini = geminiBox({bodyOf: conditions, msg, queued: watcher.queued});
  maker.onchange = () => { claudeBox.hidden = maker.value !== 'claude'; gemini.hidden = maker.value !== 'gemini'; };
  return [h('label', {}, '作り手', maker), h('label', {}, 'テーマ', theme), h('div', {class: 'cut-grid'}, h('label', {}, '型', style), h('label', {}, '長さ（秒）', seconds)),
    h('h2', {}, '出演者'), castBox, h('button', {type: 'button', class: 'quiet', onclick: () => { if (rows.length < MAX_CAST && chars.length) addRow(); }}, '出演者を追加'), h('label', {}, '補足', note), claudeBox, gemini];
}

// 編集画面の事実の確認の欄。出典が無い主張は「要確認」と出し、押すまで本番の書き出しを止める。確かめたあとに台本を直すと全部を要確認に戻す。
//   onChange は確認や主張を変えたときに呼ぶ。render は台本が変わったときに呼び直す
export function claimsPanel(s, onChange) {
  const body = h('div', {class: 'form-stack'}), title = h('summary', {}), box = h('details', {class: 'cut draft-panel'}, title, body);
  const render = () => {
    const pending = new Set(pendingClaims(s)), changed = scriptChanged(s);
    title.textContent = `事実の確認（${s.claims.length} 件、要確認 ${pending.size} 件）`;
    box.open ||= pending.size > 0 || changed;
    body.replaceChildren(changed ? h('div', {class: 'claim'}, h('p', {}, h('span', {class: 'tag warn'}, '要確認'), '主張を確認したあとに台本が変わった。直した文と主張と出典を読み直す。'),
      h('button', {type: 'button', onclick: () => { s.scriptKey = scriptKey(s.cuts); onChange(); }}, '直した文を確認した')) : '', ...s.claims.map((c, i) => {
      const need = !c.sources.length;
      return h('div', {class: 'claim'}, h('p', {}, pending.has(c) ? h('span', {class: 'tag warn'}, '要確認') : null, c.text),
        h('p', {class: 'muted'}, `確かさ ${SURE_LABEL[c.confidence]}。確認に使う語: ${c.query || 'なし'}`),
        need ? null : h('ul', {class: 'claim-sources'}, c.sources.map(x => h('li', {}, h('a', {href: x.url, target: '_blank', rel: 'noopener noreferrer'}, x.title || x.url)))),
        h('div', {class: 'actions'}, need ? h('button', {type: 'button', class: c.confirmed ? 'quiet' : '', onclick: () => { c.confirmed = !c.confirmed; onChange(); }}, c.confirmed ? '確認を取り消す' : '人が確認した') : null,
          h('button', {type: 'button', class: 'quiet', onclick: () => { s.claims.splice(i, 1); onChange(); }}, 'この主張を消す')));
    }));
  };
  render();
  return {box, render};
}

const charLines = list => (list ?? []).map(c => `${c.name}: ${c.note}`).join('\n');
const parseChars = text => text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 6).map(l => { const i = l.search(/[:：]/); return i < 0 ? {name: l.slice(0, 12), note: ''} : {name: l.slice(0, i).trim().slice(0, 12), note: l.slice(i + 1).trim()}; });

// 編集画面の連載の欄と「次の話を作る」。save は編集を保存して終わる約束を返す
export function serialPanel(s, touch, {save, alive}) {
  s.serial ??= {name: s.title, episode: 1, previousId: '', characters: [], synopsis: '', threads: [], next: ''};
  const v = s.serial, area = (label, rows, value, set, max) => { const t = h('textarea', {rows: String(rows), maxlength: String(max), 'aria-label': label}, value); t.oninput = () => { set(t.value); touch(); }; return h('label', {}, label, t); };
  const name = h('input', {maxlength: '80', value: v.name ?? '', 'aria-label': '連載の名前'});
  name.oninput = () => { v.name = name.value; touch(); };
  const msg = h('span', {class: 'muted'}), box = h('div', {class: 'pending-list'}), watcher = draftWatcher(box, alive), note = h('input', {maxlength: '1000', placeholder: '任意。この話で進めたいこと', 'aria-label': '次の話の補足'});
  const next = h('button', {type: 'button', class: 'primary', onclick: async () => {
    next.disabled = true; msg.className = 'muted'; msg.textContent = '送っている…';
    try { await save(); watcher.queued(await send('POST', '/api/jobs', {type: 'short-draft', source: 'claude', fromShortId: s.id, note: note.value})); msg.textContent = '受け付けた。できると新しいショートの編集画面が開く。'; }
    catch (e) { msg.className = 'err'; msg.textContent = '始められない: ' + e.message; }
    next.disabled = false;
  }}, '次の話を作る');
  const maker = makerSelect('次の話の作り手'), claudeBox = h('div', {class: 'actions', hidden: true}, next), gemini = geminiBox({bodyOf: () => ({fromShortId: s.id, note: note.value}), msg, queued: watcher.queued, before: save});
  maker.onchange = () => { claudeBox.hidden = maker.value !== 'claude'; gemini.hidden = maker.value !== 'gemini'; };
  watcher.poll();
  return h('details', {class: 'cut draft-panel', open: true}, h('summary', {}, `連載（第 ${v.episode ?? 1} 話）`),
    v.previousId ? h('p', {}, h('a', {href: '#short/' + enc(v.previousId)}, '前の話を開く')) : null,
    h('label', {}, '連載の名前', name),
    area('登場人物（1 行に 名前: 設定）', 3, charLines(v.characters), t => { v.characters = parseChars(t); }, 1500),
    area('これまでのあらすじ', 3, v.synopsis ?? '', t => { v.synopsis = t; }, 1000),
    area('未回収の伏線（1 行に 1 つ）', 3, (v.threads ?? []).join('\n'), t => { v.threads = t.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 10); }, 2000),
    area('次の話の方向', 2, v.next ?? '', t => { v.next = t; }, 400),
    h('label', {}, '次の話の作り手', maker), h('label', {}, '次の話の補足', note), claudeBox, gemini, msg, box);
}
