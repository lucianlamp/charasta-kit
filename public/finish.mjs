// 仕上げ: 試作を 1 つ選び、確かめの撮影(表情の 72 枚など)を撮って見て、「版にする」(docs/screens.md)。
import {h, getJSON, send, elapsedText} from './dom.mjs';
import {enc} from './shared.mjs';

const api = (c, id, rest = '') => `/api/studio/${enc(c)}/${enc(id)}${rest}`;
const KINDS = [['expr', '表情'], ['mouth', '口の形'], ['gaze', '視線'], ['eg', '表情と視線'], ['grid', '角度の表']];
let timer = null;

export async function showFinish({main, char, alive, jobsChanged}, studioId) {
  clearTimeout(timer);
  if (!char) { main.replaceChildren(h('div', {class: 'empty page-empty'}, 'キャラがまだない。')); return; }
  if (!studioId) {
    main.replaceChildren(h('div', {class: 'narrow'}, h('h1', {}, '仕上げ'),
      h('p', {class: 'lead'}, `${char.name} の表情づくりがまだないので、確かめる試作が無い。`), h('a', {class: 'button primary', href: `#expression/${enc(char.id)}`}, '表情づくりへ')));
    return;
  }
  const charId = char.id, id = studioId;
  let st = await getJSON(api(charId, id)), kind = 'expr', proto = st.prototypes.at(-1)?.n ?? null, rightKey = null, promoteBtn = null;
  const head = h('div', {class: 'stack-small'}), shots = h('div', {class: 'stack'}), right = h('div', {class: 'form-stack'});
  const reload = async () => { st = await getJSON(api(charId, id)); render(); };

  function poll() {
    clearTimeout(timer);
    const s = st.steps.checks;
    if (alive() && (s.state === 'queued' || s.state === 'running')) timer = setTimeout(() => { if (alive()) reload(); }, 3000);
  }
  const current = () => st.checks.find(c => c.proto === proto) ?? null;
  const images = k => (current()?.images ?? []).filter(i => i.kind === k);
  const syncPromote = () => { if (promoteBtn) promoteBtn.textContent = proto ? `試作 ${proto} を版にする` : '版にする'; };

  function renderHead() {
    const s = st.steps.checks, busy = s.state === 'queued' || s.state === 'running', msg = h('span', {class: 'muted'});
    const go = h('button', {class: 'outline'}, '撮る');
    go.disabled = !proto || busy;
    go.onclick = async () => {
      go.disabled = true;
      try { await send('POST', '/api/jobs', {type: 'studio-checks', charId, studioId: id, proto}); jobsChanged(); await reload(); }
      catch (e) { msg.className = 'err'; msg.textContent = '積めない: ' + e.message; go.disabled = false; }
    };
    const sel = proto ? h('select', {'aria-label': '試作', onchange: e => { proto = Number(e.target.value); syncPromote(); renderHead(); renderShots(); }},
      [...st.prototypes].reverse().map((p, i) => { const n = st.checks.find(c => c.proto === p.n)?.count;
        return h('option', {value: p.n}, `試作 ${p.n}${i ? '' : '（最新）'}${n ? `・${n} 枚` : ''}`); })) : null;
    if (sel) sel.value = proto;
    head.replaceChildren(...[
      h('div', {class: 'page-head'}, h('h1', {}, '表情の撮り比べ'), h('span', {class: 'mono muted'}, id), sel, go),
      s.stale ? h('div', {class: 'err'}, '入力が変わった。確かめを撮り直す。') : null,
      s.upstreamStale ? h('div', {class: 'err'}, '前の工程が古い。') : null,
      st.steps.copy.sourceChanged ? h('div', {class: 'err'}, 'きゃらくる側が変わった。') : null,
      s.state === 'failed' ? h('div', {class: 'err'}, s.error) : null,
      busy ? h('div', {class: 'muted'}, ['実行中', s.job?.step, s.job && elapsedText(s.job)].filter(Boolean).join('・')) : null,
      msg,
      h('div', {class: 'chips', role: 'group', 'aria-label': '確かめの種類'}, KINDS.map(([k, label]) => { const n = images(k).length;
        return h('button', {type: 'button', class: 'chip-btn', 'aria-pressed': String(k === kind), onclick: () => { kind = k; renderHead(); renderShots(); }}, n ? `${label} ${n}` : label); }))].filter(Boolean));
  }
  function renderShots() {
    const list = images(kind);
    shots.replaceChildren(list.length ? h('div', {class: 'thumbs checks'}, list.map(i => h('a', {href: i.url, target: '_blank'}, h('img', {src: i.url, loading: 'lazy', alt: i.name}),
      h('span', {}, [i.expr !== 'neutral' ? i.expr : '', i.gaze !== 'center' ? '視線 ' + i.gaze : '', `${i.yaw}°`, i.pitch ? `上下 ${i.pitch}°` : ''].filter(Boolean).join(' ')))))
      : h('div', {class: 'empty small'}, proto ? `試作 ${proto} の確かめの撮影がまだない。「撮る」で撮る。` : '試作がまだない。表情の画面の組み立てで作る。'));
  }
  // 版にする欄は、試作か作った版が変わったときだけ作り直す(読み直しで書きかけが消えないように)
  function renderRight() {
    const key = JSON.stringify([st.prototypes.map(p => p.n), st.versions]);
    if (key === rightKey) return;
    rightKey = key;
    const ver = h('input', {value: `v${char.versions.length + 1}-${id}`.slice(0, 64), 'aria-label': '版 ID'}), label = h('input', {placeholder: '例: 口を描き直した', 'aria-label': '見出し'});
    const note = h('textarea', {rows: 3, placeholder: '前の版から変えたこと（必須）', 'aria-label': '変えたこと'});
    const latest = h('input', {type: 'checkbox'}), msg = h('span', {class: 'muted'}), go = h('button', {class: 'primary big'});
    const more = h('details', {}, h('summary', {}, '版の ID と見出し'), h('div', {class: 'form-stack'}, h('label', {}, '版 ID', ver), h('label', {}, '見出し', label), h('label', {class: 'check'}, latest, '最新の版にする')));
    promoteBtn = go; syncPromote();
    go.disabled = !proto;
    go.onclick = async () => {
      if (!ver.value.trim() || !note.value.trim()) { more.open = !ver.value.trim(); msg.className = 'err'; msg.textContent = '版 ID と変えたことを入れる'; return; }
      if (!confirm(`試作 ${proto} を版 ${ver.value.trim()} として保管場所に取り込む？（版はあとから変えられない）`)) return;
      go.disabled = true; msg.className = 'muted'; msg.textContent = '取り込み中…（スマホ用の軽い VRM も作る）';
      try {
        const r = await send('POST', api(charId, id, '/promote'), {proto, verId: ver.value.trim(), label: label.value.trim(), note: note.value.trim(), latest: latest.checked});
        location.hash = `#model/${enc(charId)}/${enc(r.version.id)}`;   // 残した版は完成モデルのページで使う
      } catch (e) { more.open = true; msg.className = 'err'; msg.textContent = '版にできない: ' + e.message; go.disabled = false; }
    };
    right.replaceChildren(...[h('h2', {}, '版にする'),
      st.versions.length ? h('div', {class: 'muted'}, '作った版: ' + st.versions.map(v => `${v.verId}（試作 ${v.proto}）`).join('、')) : null,
      h('label', {}, '変えたこと', note), more, go, msg].filter(Boolean));
  }
  function render() { renderHead(); renderShots(); renderRight(); poll(); }

  main.replaceChildren(h('div', {class: 'work'},
    h('section', {class: 'center page-body'}, head, shots),
    h('aside', {class: 'pane pane-right', 'aria-label': '版にする'}, right)));
  render();
}
