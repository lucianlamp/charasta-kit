// プロフィール: 完成モデル(生き物はキャラのページ)の上の欄。名前、スタイル、タグ、声、メモ、出演した動画を出す(docs/screens.md)。保存は PATCH /api/characters/<キャラ>
import {h, send} from './dom.mjs';
import {enc, fmtDate} from './shared.mjs';
import {STYLE_LABEL} from './short-direct.mjs';
import {RESTYLE_WARNING, restyleChoices, styleChip, styleChoices} from './char-style.mjs';
import {confirmDialog} from './confirm.mjs';

// サーバーの検査(lib/library.mjs の checkTags)と同じ上限
export const MAX_TAGS = 8, MAX_TAG_LENGTH = 20;

// 入れた文字をタグの列に足す。サーバーと同じ決まりで、送る前に断る。返すのは {tags} か {error}
export function addTag(tags, text) {
  const tag = text.trim(), n = [...tag].length;
  if (!n) return {error: 'タグを入れる'};
  if (n > MAX_TAG_LENGTH) return {error: `タグは ${MAX_TAG_LENGTH} 文字まで`};
  if (tags.includes(tag)) return {error: 'そのタグはもう付いている'};
  if (tags.length >= MAX_TAGS) return {error: `タグは ${MAX_TAGS} 個まで`};
  return {tags: [...tags, tag]};
}

// 保存の文。msg に「保存中…」を出し、失敗したら err の色で理由を出して投げ直す
async function saving(msg, run) {
  msg.className = 'muted'; msg.textContent = '保存中…';
  try { const r = await run(); msg.textContent = '保存した'; return r; }
  catch (e) { msg.className = 'err'; msg.textContent = '保存できない: ' + e.message; throw e; }
}

const patch = (c, body) => send('PATCH', '/api/characters/' + enc(c.id), body);

// タグ: チップを押すと外す。入れて「足す」か Enter で足す。どちらもすぐ保存する
function tagEditor(c) {
  let tags = [...(c.tags ?? [])];
  const list = h('div', {class: 'chips'}), msg = h('span', {class: 'muted'});
  const input = h('input', {maxlength: String(MAX_TAG_LENGTH), placeholder: 'タグを追加', 'aria-label': 'タグ'});
  const add = h('button', {type: 'button'}, '追加');
  const busy = on => { add.disabled = on; input.disabled = on; for (const b of list.querySelectorAll('button')) b.disabled = on; };
  const save = async next => {
    busy(true);
    try { tags = (await saving(msg, () => patch(c, {tags: next}))).tags ?? next; c.tags = tags; render(); input.value = ''; } catch {}
    busy(false);
  };
  const render = () => list.replaceChildren(...(tags.length ? tags.map(t => h('button', {type: 'button', class: 'chip-btn', 'aria-label': `${t} を外す`, title: '押すと外す', onclick: () => save(tags.filter(x => x !== t))}, t, ' ×'))
    : [h('span', {class: 'muted'}, 'タグはまだない')]));
  const tryAdd = () => { const r = addTag(tags, input.value); if (r.error) { msg.className = 'err'; msg.textContent = r.error; return; } save(r.tags); };
  add.onclick = tryAdd;
  input.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); tryAdd(); } };
  render();
  return h('div', {class: 'profile-tags'}, list, h('div', {class: 'actions'}, input, add, msg));
}

// メモ: textarea で書き換え、「保存」で送る
function noteEditor(c) {
  const area = h('textarea', {rows: '3', 'aria-label': 'メモ'}), msg = h('span', {class: 'muted'}), save = h('button', {type: 'button'}, '保存');
  area.value = c.note ?? '';
  save.onclick = async () => {
    save.disabled = true;
    try { c.note = (await saving(msg, () => patch(c, {note: area.value}))).note; } catch {}
    save.disabled = false;
  };
  return h('div', {class: 'form-stack'}, h('label', {}, 'メモ', area), h('div', {class: 'actions'}, save, msg));
}

// スタイル: 札と「変える」。枠の中で今と違うスタイルを選び、表情を作り直すことになると確かめてから PATCH で送る
// 未設定(前からのキャラ)も同じ枠で決める。null には戻せない(サーバーが断る)
// バージョンがあるキャラは、生き物とそれ以外のあいだを移れない。生き物でバージョンがあれば「変える」を出さない
function styleEditor(c) {
  const chip = h('span', {}), msg = h('span', {class: 'muted', role: 'status'});
  const show = () => chip.replaceChildren(styleChip(c.style));
  const ids = restyleChoices(c.style, (c.versions ?? []).length > 0);
  const change = async () => {
    let pick = c.style ?? null, setReady = () => {};
    const choices = styleChoices(pick, s => { pick = s; setReady(); }, ids);
    const r = await confirmDialog({
      title: 'スタイルを変える', confirm: '変える', tone: 'primary',
      body: [h('p', {}, `${RESTYLE_WARNING}。`), choices.box],
      setup: ({setDisabled}) => { setReady = () => setDisabled(!pick || pick === c.style); setReady(); },
      run: () => send('PATCH', '/api/characters/' + enc(c.id), {style: pick}),
    });
    if (!r) return;
    c.style = r.style ?? pick; show();
    msg.className = 'muted'; msg.textContent = '変えた';
  };
  show();
  return h('span', {class: 'profile-style'}, 'スタイル ', chip, ids.length ? h('button', {type: 'button', class: 'quiet', 'aria-label': 'スタイルを変える', onclick: change}, '変える') : null, msg);
}

// 出演した動画: 保存場所の shorts のうち、このキャラが出るもの(新しい順)。押すとショートの編集画面へ
function appearanceList(list) {
  if (!list.length) return h('p', {class: 'muted'}, '出演した動画はまだない。');
  return h('div', {class: 'appear-list'}, list.map(a => h('a', {class: 'appear-row', href: '#short/' + enc(a.shortId)},
    h('span', {class: 'appear-title'}, a.title || a.shortId),
    a.style ? h('span', {class: 'chip'}, STYLE_LABEL[a.style] ?? a.style) : null,
    h('span', {class: 'muted'}, fmtDate(a.updatedAt)))));
}

// c: GET /api/characters/<キャラ> の記録。onVoiceEdit: 声を変える欄を開く(無ければ表示だけ)。voice: false で声の行を出さない(生き物)
// 返す setVoice は、声を変える欄で保存したあとに表示を直すのに使う
export function profilePanel(c, {onVoiceEdit, voice = true} = {}) {
  const voiceText = h('span', {class: 'mono'});
  const setVoice = v => { voiceText.textContent = v ? `${v.provider}:${v.id}` : 'なし'; };
  setVoice(c.voice);
  const appearances = c.appearances ?? [];
  const box = h('section', {class: 'profile', 'aria-label': 'プロフィール'},
    h('div', {class: 'profile-head'},
      h('h1', {class: 'profile-name'}, c.name, h('span', {class: 'mono muted'}, c.id)),
      styleEditor(c),
      voice ? h('span', {class: 'profile-voice'}, '声 ', voiceText, onVoiceEdit ? h('button', {type: 'button', class: 'quiet', onclick: onVoiceEdit}, '変える') : null) : null),
    tagEditor(c),
    h('details', {class: 'profile-more'}, h('summary', {}, `メモと出演した動画（${appearances.length} 本）`),
      h('div', {class: 'stack-small'}, noteEditor(c), h('h2', {}, '出演した動画'), appearanceList(appearances))));
  return {box, setVoice};
}
