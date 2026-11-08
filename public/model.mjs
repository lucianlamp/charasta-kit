// 完成モデル: 工程の外の別ページ。上にプロフィール(public/profile.mjs)、その下に作ったものの一覧、モーションつきの動画を撮る(public/shoot.mjs)、VRM の書き出し(畳みの中のリンク)を 1 画面に置く(docs/screens.md)。
import {h, getJSON, send} from './dom.mjs';
import {enc, mb, pendingRow, sortVersions, thumb, viewerHref, watchJobs} from './shared.mjs';
import {shootPanel, CAMERAS, QUALITIES} from './shoot.mjs';
import {moveToTrash} from './confirm.mjs';
import {profilePanel} from './profile.mjs';
import {checkPanel} from './version-check.mjs';
import {gameExportPanel} from './game-export.mjs';

const VOICES = ['ara', 'eve', 'leo', 'rex'];   // Grok の声の候補。ほかの名前は手で入れる
const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
const voiceText = v => v ? `${v.provider}:${v.id}` : 'なし';

export async function showModel({main, char, verId, alive, jobsChanged}) {
  if (!char) { main.replaceChildren(h('div', {class: 'empty page-empty'}, 'キャラがまだない。')); return; }
  let c = await getJSON('/api/characters/' + enc(char.id));
  const motions = await getJSON('/api/motions');
  const ver = c.versions.find(v => v.id === verId);
  const madeBox = h('div', {class: 'stack-small'}), pendingBox = h('div', {class: 'pending-list'});

  const reload = async () => { c = await getJSON('/api/characters/' + enc(char.id)); renderMade(); panel?.renderLines(); };
  const watcher = watchJobs({filter: j => j.input?.charId === char.id && ['voice', 'video', 'shoot', 'mv', 'short'].includes(j.type), alive, onJobs: jobs => pendingBox.replaceChildren(...jobs.map(pendingRow)),
    onDone: async () => { await reload(); jobsChanged(); }});
  const queued = job => { watcher.queued(job); jobsChanged(); };
  const voiceSummary = h('summary', {}, `声の種類（今は ${voiceText(c.voice)}）`);
  const voiceBox = h('details', {}, voiceSummary, voicePanel(c, next => { c = {...c, voice: next.voice}; voiceSummary.textContent = `声の種類（今は ${voiceText(c.voice)}）`; profile.setVoice(c.voice); }));
  const more = [h('details', {}, h('summary', {}, 'セリフを作る'), createLine(c, sortVersions(c), ver, queued)), voiceBox];
  // プロフィールの「変える」: 声の種類の畳みと、それを包む畳み(細かい条件)を開いて見せる
  const openVoice = () => { for (let d = voiceBox; d; d = d.parentElement?.closest('details')) d.open = true; voiceBox.scrollIntoView({block: 'nearest'}); voiceBox.querySelector('select')?.focus(); };
  const profile = profilePanel(c, {onVoiceEdit: openVoice});
  const panel = ver ? shootPanel({getChar: () => c, ver, motions, queued, reload, more}) : null;

  // 作ったもの: このキャラの動画。撮った動画(新しい順)のあとに、セリフだけの動画。行を開くと再生とダウンロード
  // remove を渡した動画(撮った動画)には「削除」を付ける。移す前に再生を止めて動画を放す(Windows は開いたファイルのフォルダを移せない)
  const madeVideo = ({url, poster, ratio, title, sub, detail, file, tag, remove}) => {
    const video = h('video', {controls: true, playsinline: true, preload: 'none', src: url, poster, style: `aspect-ratio:${ratio}`});
    const release = () => { video.pause(); video.removeAttribute('src'); video.load(); };
    return h('details', {class: 'made'},
      h('summary', {}, thumb(poster, '', 'mini-40'), h('span', {class: 'made-text'}, title, h('span', {class: 'muted'}, sub), tag ? h('span', {class: 'limit warn'}, tag) : null)),
      h('div', {class: 'video'}, video,
        h('div', {class: 'muted'}, detail, '　', h('a', {href: url, download: file}, 'ダウンロード'),
          remove ? h('button', {type: 'button', class: 'quiet', onclick: async () => { if (await moveToTrash(remove.target, remove.name, {before: release, onFail: () => { video.src = url; }})) await reload(); }}, '削除') : null)));
  };
  function renderMade() {
    const shots = (c.shoots ?? []).map(s => madeVideo({url: s.url, poster: s.posterUrl, ratio: s.aspect.replace(':', ' / '),
      title: [s.kind === 'mv' ? (s.quality === 'preview' ? 'MV の試し' : 'MV') : s.kind === 'short' ? `${s.short?.style === 'dance' ? 'ダンス MV' : 'ショート'}${s.quality === 'preview' ? 'の試し' : ''}` : null, s.motionLabel ?? 'モーションなし', s.lineText].filter(Boolean).join('・'), sub: `${s.aspect}、${s.seconds.toFixed(1)} 秒`,
      detail: [s.audio?.name, s.verId, ...(s.kind === 'mv' ? s.mv.stageLabels : s.kind === 'short' ? s.short.stageLabels : [CAMERAS[s.framing], QUALITIES[s.quality]])].filter(Boolean).join('・'),
      file: `${c.id}-${s.verId}-${s.motionId ?? 'nomotion'}-${s.aspect.replace(':', 'x')}-${s.id}.mp4`, tag: s.terms?.tag,
      remove: {target: {kind: 'shoot', charId: c.id, id: s.id}, name: [s.motionLabel ?? 'モーションなし', s.lineText, s.aspect].filter(Boolean).join('・')}}));
    const lineVideos = (c.lines ?? []).flatMap(l => (l.videos ?? []).map(v => madeVideo({url: v.url, poster: null, ratio: '1', title: l.text || l.id, sub: CAMERAS[v.framing] ?? v.framing,
      detail: v.verId, file: `${c.id}-${l.id}-${v.verId}-${v.framing}.mp4`})));
    const all = [...shots, ...lineVideos];
    madeBox.replaceChildren(...(all.length ? all : [h('p', {class: 'muted'}, '撮った動画がここに並ぶ。まだ無い。')]));
  }

  main.replaceChildren(profile.box, h('div', {class: 'work model-work'},
    h('aside', {class: 'pane pane-left', 'aria-label': '作ったもの'}, h('h1', {}, '作ったもの'), pendingBox, madeBox),
    h('section', {class: 'center'},
      h('div', {class: 'stage shoot'}, panel?.box ?? h('div', {class: 'empty'}, 'このキャラには版がまだない。つくるの画面で取り込む。')), panel?.timeline,
      ver ? h('div', {class: 'stage-foot'}, h('a', {class: 'link', href: viewerHref(c.id, ver.id), target: '_blank'}, '全部の操作があるビューアを開く')) : null),
    h('aside', {class: 'pane pane-right', 'aria-label': '撮る'}, h('h2', {}, '撮る'), panel?.controls ?? [h('div', {class: 'empty small'}, '版がまだない'), ...more], ver ? h('a', {class: 'button', href: `#mv/${enc(c.id)}/${enc(ver.id)}`}, 'ダンス MV を作る') : null, ver ? checkPanel(c, ver) : null, ver ? gameExportPanel(c, ver, {jobsChanged}) : null, ver ? exportLinks(c, ver) : null)));
  renderMade();
  await watcher.poll();
}

// 書き出す: 今ある範囲(VRM と軽量版のダウンロード)。モーションは書き出さない
function exportLinks(c, ver) {
  const name = s => `${c.id}-${ver.id}${s}.vrm`;
  return h('details', {class: 'export'}, h('summary', {}, 'ファイルを書き出す'),
    h('div', {class: 'stack-small'},
      h('a', {class: 'file-link', href: ver.model, download: name('')}, 'VRM', ver.sizeBytes ? h('span', {class: 'mono muted'}, mb(ver.sizeBytes)) : null),
      ver.modelLite ? h('a', {class: 'file-link', href: ver.modelLite, download: name('-lite')}, '軽量版 VRM') : h('span', {class: 'muted'}, '軽量版 VRM はこの版に無い'),
      h('p', {class: 'muted'}, 'モーションは二次配布できないものがあるので、ここからは書き出さない。')));
}

// 声の種類: 候補から選ぶか、手で入れる(provider:id。: が無ければ grok の声)
function voicePanel(c, onSaved) {
  const sel = h('select', {'aria-label': '声の候補'}, VOICES.map(v => h('option', {value: v}, v)), h('option', {value: ''}, '手で入れる'));
  const custom = h('input', {placeholder: '例: grok:eve', 'aria-label': '声の名前'}), msg = h('span', {class: 'muted'}), save = h('button', {}, '保存');
  const preset = c.voice?.provider === 'grok' && VOICES.includes(c.voice.id);
  sel.value = preset ? c.voice.id : ''; custom.value = preset ? '' : (c.voice ? voiceText(c.voice) : ''); custom.hidden = preset;
  sel.onchange = () => { custom.hidden = sel.value !== ''; if (!custom.hidden) custom.focus(); };
  save.onclick = async () => {
    let v = sel.value ? 'grok:' + sel.value : custom.value.trim();
    if (!v) { msg.className = 'err'; msg.textContent = '声の名前を入れる'; return; }
    if (!v.includes(':')) v = 'grok:' + v;
    save.disabled = true; msg.className = 'muted'; msg.textContent = '保存中…';
    try { onSaved(await send('PATCH', '/api/characters/' + enc(c.id), {voice: v})); }
    catch (e) { msg.className = 'err'; msg.textContent = '保存できない: ' + e.message; save.disabled = false; }
  };
  return h('div', {class: 'form-stack', id: 'voicePanel'}, sel, custom, h('div', {class: 'actions'}, save, msg));
}

// セリフを作る: 文・読み・感情・顔を撮る版で voice ジョブを積む
function createLine(c, versions, ver, queued) {
  const text = h('input', {maxlength: '200', placeholder: '例: 今日はいい天気だね', 'aria-label': '文'});
  const reading = h('input', {placeholder: '例: きょうはいいてんきだね', 'aria-label': '読み'});
  const emotion = h('select', {'aria-label': '感情'}, h('option', {value: ''}, 'なし'), EMOTIONS.map(e => h('option', {value: e}, e)));
  const verSel = h('select', {'aria-label': '顔を撮る版'}, versions.map(v => h('option', {value: v.id}, v.id)));
  if (ver) verSel.value = ver.id;
  const msg = h('span', {class: 'muted'}), go = h('button', {class: 'primary'}, '声を作る');
  go.onclick = async () => {
    if (!text.value.trim()) { msg.className = 'err'; msg.textContent = '文を入れる'; return; }
    go.disabled = true; msg.className = 'muted'; msg.textContent = '送っている…';
    try {
      const job = await send('POST', '/api/jobs', {type: 'voice', charId: c.id, text: text.value.trim(), reading: reading.value.trim(), emotion: emotion.value || undefined, verId: verSel.value || undefined});
      msg.textContent = `積んだ: ${job.input.lineId}`; text.value = ''; reading.value = '';
      queued(job);
    } catch (e) { msg.className = 'err'; msg.textContent = '積めない: ' + e.message; }
    go.disabled = false;
  };
  return h('div', {class: 'form-stack', id: 'createPanel'},
    h('label', {}, '文（200 文字まで）', text), h('label', {}, '読み（かな。口の動きに使う。空なら文）', reading),
    h('label', {}, '感情', emotion), h('label', {}, '顔を撮る版', verSel), h('div', {class: 'actions'}, go, msg));
}
