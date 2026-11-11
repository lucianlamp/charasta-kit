// 完成モデル: 工程の外の別ページ。上にプロフィール(public/profile.mjs)、その下に作ったものの一覧、モーションつきの動画を撮る(public/shoot.mjs)、VRM の書き出し(畳みの中のリンク)を 1 画面に置く(docs/screens.md)。
// 声の種類とセリフを作るは小さなモーダル、作ったものの再生は大きなモーダル(public/dialog.mjs)。
import {h, getJSON, send} from './dom.mjs';
import {enc, fmtDate, mb, pendingRow, sortVersions, thumb, viewerHref, watchJobs} from './shared.mjs';
import {shootPanel, CAMERAS, QUALITIES} from './shoot.mjs';
import {moveToTrash} from './confirm.mjs';
import {profilePanel} from './profile.mjs';
import {checkPanel} from './version-check.mjs';
import {gameExportPanel} from './game-export.mjs';
import {can} from './capabilities.mjs';
import {closeButton, dialogId, formDialog, showDialog} from './dialog.mjs';

const VOICES = ['ara', 'eve', 'leo', 'rex'];   // Grok の声の候補。ほかの名前は手で入れる
const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
const voiceText = v => v ? `${v.provider}:${v.id}` : 'なし';

export async function showModel({main, ov, char, verId, alive, jobsChanged}) {
  if (!char) { main.replaceChildren(h('div', {class: 'empty page-empty'}, 'キャラがまだない。')); return; }
  let c = await getJSON('/api/characters/' + enc(char.id));
  const motions = await getJSON('/api/motions');
  const ver = c.versions.find(v => v.id === verId);
  const madeBox = h('div', {class: 'stack-small'}), pendingBox = h('div', {class: 'pending-list'});

  const reload = async () => { c = await getJSON('/api/characters/' + enc(char.id)); renderMade(); panel?.renderLines(); };
  const watcher = watchJobs({filter: j => j.input?.charId === char.id && ['voice', 'video', 'shoot', 'mv', 'short'].includes(j.type), alive, onJobs: jobs => pendingBox.replaceChildren(...jobs.map(pendingRow)),
    onDone: async () => { await reload(); jobsChanged(); }});
  const queued = job => { watcher.queued(job); jobsChanged(); };
  // プロフィールの「変える」: 声の種類の小さなモーダル。保存したらプロフィールの表示を直して閉じる
  const openVoice = () => {
    let busy = false, x = null, dlg = null;
    const box = voicePanel(c, next => { c = {...c, voice: next.voice}; profile.setVoice(c.voice); dlg.close(); }, on => { busy = on; x.disabled = on; });
    ({dlg, x} = formDialog({title: '声の種類', body: [box], busy: () => busy}));
    box.querySelector('select')?.focus();
  };
  // 撮るの欄の「新しいセリフ」: セリフを作る小さなモーダル。受け付けても閉じず、続けて作れる。作成中の仮の行は作ったものの一覧に出る
  const openLine = () => {
    let busy = false, x = null;
    const box = createLine(c, sortVersions(c), ver, queued, on => { busy = on; x.disabled = on; });
    ({x} = formDialog({title: '新しいセリフ', body: [box], busy: () => busy}));
    box.querySelector('input')?.focus();
  };
  const profile = profilePanel(c, {onVoiceEdit: openVoice});
  const panel = ver ? shootPanel({getChar: () => c, ver, motions, queued, reload, onNewLine: openLine}) : null;

  // 作ったもの: このキャラの動画。撮った動画(新しい順)のあとに、セリフだけの動画。行を押すと再生の大きなモーダル(openMade)
  // remove を持つ動画(撮った動画)はモーダルから削除できる
  let items = [], openedMade = null;   // 開いている再生のモーダル(並びが変わったら位置と前後のボタンを出し直す)
  const madeRow = it => h('button', {type: 'button', class: 'made', onclick: () => { openedMade = openMade({getItems: () => items, key: it.key, reload}); }},
    thumb(it.poster, '', 'mini-40'), h('span', {class: 'made-text'}, it.title, h('span', {class: 'muted'}, it.sub), it.terms?.tag ? h('span', {class: 'limit warn'}, it.terms.tag) : null));
  function renderMade() {
    const shots = (c.shoots ?? []).map(s => ({key: 'shoot:' + s.id, url: s.url, poster: s.posterUrl,
      title: [s.kind === 'mv' ? (s.quality === 'preview' ? 'MV の試し' : 'MV') : s.kind === 'short' ? `${s.short?.style === 'dance' ? 'ダンス MV' : 'ショート'}${s.quality === 'preview' ? 'の試し' : ''}` : null, s.motionLabel ?? 'モーションなし', s.lineText].filter(Boolean).join('・'), sub: `${s.aspect}、${s.seconds.toFixed(1)} 秒`,
      facts: [['撮った日', fmtDate(s.createdAt)], ['モーション', s.motionLabel ?? 'なし'], ['縦横', s.aspect], ['長さ', `${s.seconds.toFixed(1)} 秒`], ['セリフ', s.lineText],
        ['条件', [s.audio?.name, s.verId, ...(s.kind === 'mv' ? s.mv.stageLabels : s.kind === 'short' ? s.short.stageLabels : [CAMERAS[s.framing], QUALITIES[s.quality]])].filter(Boolean).join('・')]],
      file: `${c.id}-${s.verId}-${s.motionId ?? 'nomotion'}-${s.aspect.replace(':', 'x')}-${s.id}.mp4`, terms: s.terms,
      remove: {target: {kind: 'shoot', charId: c.id, id: s.id}, name: [s.motionLabel ?? 'モーションなし', s.lineText, s.aspect].filter(Boolean).join('・')}}));
    const lineVideos = (c.lines ?? []).flatMap(l => (l.videos ?? []).map(v => ({key: `line:${l.id}:${v.verId}:${v.framing}`, url: v.url, poster: null, title: l.text || l.id, sub: CAMERAS[v.framing] ?? v.framing,
      facts: [['種類', 'セリフだけの動画'], ['写す範囲', CAMERAS[v.framing] ?? v.framing], ['バージョン', v.verId]], file: `${c.id}-${l.id}-${v.verId}-${v.framing}.mp4`})));
    items = [...shots, ...lineVideos];
    madeBox.replaceChildren(...(items.length ? items.map(madeRow) : [h('p', {class: 'muted'}, '撮った動画がここに並ぶ。まだない。')]));
    openedMade?.refresh();
  }

  main.replaceChildren(profile.box, h('div', {class: 'work model-work'},
    h('aside', {class: 'pane pane-left', 'aria-label': '作ったもの'}, h('h1', {}, '作ったもの'), pendingBox, madeBox),
    h('section', {class: 'center'},
      h('div', {class: 'stage shoot'}, panel?.box ?? h('div', {class: 'empty'}, 'このキャラにはバージョンがまだない。つくるの画面で取り込む。')), panel?.timeline,
      ver ? h('div', {class: 'stage-foot'}, h('a', {class: 'link', href: viewerHref(c.id, ver.id), target: '_blank'}, '全部の操作があるビューアを開く')) : null),
    h('aside', {class: 'pane pane-right', 'aria-label': '撮る'}, h('h2', {}, '撮る'), panel?.controls ?? [h('div', {class: 'empty small'}, 'バージョンがまだない'), h('button', {type: 'button', onclick: openLine}, '新しいセリフ')], ver ? h('a', {class: 'button', href: `#mv/${enc(c.id)}/${enc(ver.id)}`}, 'ダンス MV を作る') : null, ver ? h('a', {class: 'button', href: `#adjust/${enc(c.id)}/${enc(ver.id)}`}, '体型と揺れものを直す') : null, ver ? checkPanel(c, ver) : null, ver && can(ov, 'gameExport') ? gameExportPanel(c, ver, {jobsChanged}) : null, ver ? exportLinks(c, ver) : null)));
  renderMade();
  await watcher.poll();
}

// 書き出す: 今ある範囲(VRM と軽量版のダウンロード)。モーションは書き出さない
function exportLinks(c, ver) {
  const name = s => `${c.id}-${ver.id}${s}.vrm`;
  return h('details', {class: 'export'}, h('summary', {}, 'ファイルを書き出す'),
    h('div', {class: 'stack-small'},
      h('a', {class: 'file-link', href: ver.model, download: name('')}, 'VRM', ver.sizeBytes ? h('span', {class: 'mono muted'}, mb(ver.sizeBytes)) : null),
      ver.modelLite ? h('a', {class: 'file-link', href: ver.modelLite, download: name('-lite')}, '軽量版 VRM') : h('span', {class: 'muted'}, '軽量版 VRM はこのバージョンに無い'),
      h('p', {class: 'muted'}, 'モーションは二次配布できないものがあるので、ここからは書き出さない。')));
}

// 作ったものの再生の大きなモーダル。getItems() は今の作ったものの並び(ジョブのあとで読み直されて変わる)、key は開く動画。
// 前後のボタンは並び順で、端では押せない。削除は確認の枠(moveToTrash)を通し、移したら一覧を読み直して次の動画を出す。次が無ければ閉じる
function openMade({getItems, key, reload}) {
  let cur = key, busy = false;
  const titleId = dialogId('md');
  const title = h('h2', {id: titleId}), count = h('span', {class: 'mono muted review-count'});
  const step = d => { const list = getItems(), i = list.findIndex(x => x.key === cur); if (i >= 0 && list[i + d]) show(list[i + d].key); };
  const prev = h('button', {type: 'button', class: 'quiet', 'aria-label': '前の動画', onclick: () => step(-1)}, '‹');
  const next = h('button', {type: 'button', class: 'quiet', 'aria-label': '次の動画', onclick: () => step(1)}, '›');
  const x = closeButton('quiet review-close');
  const video = h('video', {controls: true, playsinline: true, preload: 'metadata'});
  const side = h('aside', {class: 'review-side form-stack', 'aria-label': '動画の情報と操作'});
  const dlg = h('dialog', {class: 'dialog review-dialog made-dialog', 'aria-labelledby': titleId},
    h('div', {class: 'review-head'}, title, h('div', {class: 'review-nav'}, prev, count, next), x),
    h('div', {class: 'review-body'}, h('div', {class: 'review-media made-media'}, video), side));
  // 移す前に再生を止めて動画を放す(Windows は開いたファイルのフォルダを移せない)
  const release = () => { video.pause(); video.removeAttribute('src'); video.load(); };

  // 位置の表示と前後のボタン。ジョブが終わって並びが変わったときも呼ばれる(削除の処理中は触らない)
  const place = () => {
    const list = getItems(), i = list.findIndex(it => it.key === cur);
    if (i < 0 || busy) return;
    count.textContent = `${i + 1} / ${list.length}`;
    prev.disabled = i === 0; next.disabled = i === list.length - 1;
  };

  function show(k) {
    const list = getItems(), i = list.findIndex(it => it.key === k), it = list[i];
    if (!it) { dlg.close(); return; }
    cur = k;
    title.textContent = it.title;
    place();
    video.pause();
    if (it.poster) video.poster = it.poster; else video.removeAttribute('poster');
    video.src = it.url;
    const remove = it.remove ? h('button', {type: 'button', class: 'quiet danger'}, '削除') : null;
    if (remove) remove.onclick = async () => {
      const after = list[i + 1]?.key ?? null;
      busy = true; remove.disabled = x.disabled = prev.disabled = next.disabled = true;
      let moved = null;
      try { moved = await moveToTrash(it.remove.target, it.remove.name, {before: release, onFail: () => { video.src = it.url; }}); }
      finally { busy = false; x.disabled = false; }
      if (!moved) { remove.disabled = false; place(); return; }   // やめたら再生はそのまま
      try { await reload(); } catch { dlg.close(); return; }   // 読み直せなければ、空の動画を残さず閉じる
      if (after && getItems().some(x => x.key === after)) show(after); else dlg.close();
    };
    const notes = it.terms?.notes ?? [];
    side.replaceChildren(...[   // replaceChildren は null を文字の null にするので外す
      h('dl', {class: 'facts'}, it.facts.filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      it.terms?.tag ? h('div', {class: 'limit warn'}, it.terms.tag) : null,
      notes.length ? h('details', {}, h('summary', {class: 'muted'}, '利用条件の全文'), h('div', {class: 'stack-small'}, notes.map(n => h('p', {class: 'muted'}, n.text)))) : null,
      h('a', {class: 'button outline', href: it.url, download: it.file}, 'ダウンロード'),
      remove].filter(Boolean));
  }

  showDialog(dlg, {busy: () => busy, onClose: () => video.pause()});
  show(key);
  x.focus();
  return {refresh: () => { if (dlg.isConnected) place(); }};
}

// 声の種類: 候補から選ぶか、手で入れる(provider:id。: が無ければ grok の声)。setBusy(true) のあいだは保存中
function voicePanel(c, onSaved, setBusy = () => {}) {
  const sel = h('select', {'aria-label': '声の候補'}, VOICES.map(v => h('option', {value: v}, v)), h('option', {value: ''}, '手で入れる'));
  const custom = h('input', {placeholder: '例: grok:eve', 'aria-label': '声の名前'}), msg = h('span', {class: 'muted'}), save = h('button', {}, '保存');
  const preset = c.voice?.provider === 'grok' && VOICES.includes(c.voice.id);
  sel.value = preset ? c.voice.id : ''; custom.value = preset ? '' : (c.voice ? voiceText(c.voice) : ''); custom.hidden = preset;
  sel.onchange = () => { custom.hidden = sel.value !== ''; if (!custom.hidden) custom.focus(); };
  save.onclick = async () => {
    let v = sel.value ? 'grok:' + sel.value : custom.value.trim();
    if (!v) { msg.className = 'err'; msg.textContent = '声の名前を入れる'; return; }
    if (!v.includes(':')) v = 'grok:' + v;
    save.disabled = true; setBusy(true); msg.className = 'muted'; msg.textContent = '保存中…';
    let saved;
    try { saved = await send('PATCH', '/api/characters/' + enc(c.id), {voice: v}); }
    catch (e) { msg.className = 'err'; msg.textContent = '保存できない: ' + e.message; save.disabled = false; setBusy(false); return; }
    setBusy(false); onSaved(saved);
  };
  return h('div', {class: 'form-stack', id: 'voicePanel'}, sel, custom, h('div', {class: 'actions'}, save, msg));
}

// セリフを作る: 文・読み・感情・顔を撮るバージョンで voice ジョブを積む。setBusy(true) のあいだは送っている
function createLine(c, versions, ver, queued, setBusy = () => {}) {
  const text = h('input', {maxlength: '200', placeholder: '例: 今日はいい天気だね', 'aria-label': '文'});
  const reading = h('input', {placeholder: '例: きょうはいいてんきだね', 'aria-label': '読み'});
  const emotion = h('select', {'aria-label': '感情'}, h('option', {value: ''}, 'なし'), EMOTIONS.map(e => h('option', {value: e}, e)));
  const verSel = h('select', {'aria-label': '顔を撮るバージョン'}, versions.map(v => h('option', {value: v.id}, v.id)));
  if (ver) verSel.value = ver.id;
  const msg = h('span', {class: 'muted', role: 'status'}), go = h('button', {class: 'primary'}, '声を作る');
  go.onclick = async () => {
    if (!text.value.trim()) { msg.className = 'err'; msg.textContent = '文を入れる'; return; }
    go.disabled = true; setBusy(true); msg.className = 'muted'; msg.textContent = '送っている…';
    try {
      const job = await send('POST', '/api/jobs', {type: 'voice', charId: c.id, text: text.value.trim(), reading: reading.value.trim(), emotion: emotion.value || undefined, verId: verSel.value || undefined});
      msg.textContent = `受け付けた: ${job.input.lineId}。作っている様子は「作ったもの」に出て、できたら撮るのセリフに入る。続けて作れる。`; text.value = ''; reading.value = '';
      queued(job);
    } catch (e) { msg.className = 'err'; msg.textContent = '始められない: ' + e.message; }
    go.disabled = false; setBusy(false);
  };
  return h('div', {class: 'form-stack', id: 'createPanel'},
    h('label', {}, '文（200 文字まで）', text), h('label', {}, '読み（かな。口の動きに使う。空なら文）', reading),
    h('label', {}, '感情', emotion), h('label', {}, '顔を撮るバージョン', verSel), h('div', {class: 'actions'}, go, msg));
}
