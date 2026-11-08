// 完成モデルの「撮る」: 枠とプレビュー、タイムライン、撮る条件の欄(よく使う 2 つのほかは細かい条件に畳む)。ジョブは lib/shoot.mjs(docs/voice-and-jobs.md)、画面の決めごとは docs/ui.md。
import {h, getJSON, send} from './dom.mjs';
import {libUrl, uploadAudio, viewerFrame, viewerReady} from './shared.mjs';
import {MAX_SECONDS, MAX_AUDIO_BYTES, shootSeconds} from './shoot-plan.mjs';
import {moveToTrash} from './confirm.mjs';

export const CAMERAS = {full: '全身', upper: '上半身', face: '顔'};
export const QUALITIES = {'1080p30': '1080p 30fps', '1080p60': '1080p 60fps', '720p30': '720p 30fps'};
const FPS = {'1080p30': 30, '1080p60': 60, '720p30': 30};
const ASPECTS = ['9:16', '16:9', '1:1'];
const EXPRESSIONS = [['motion', 'モーションに合わせる'], ['neutral', 'ふだん'], ['happy', '笑顔'], ['angry', '怒り'], ['sad', '悲しみ'], ['relaxed', '安らぎ'], ['surprised', '驚き']];
const BACKGROUNDS = [['viewer', 'ビューアの色'], ['#ffffff', '白'], ['#000000', '黒'], ['#00b140', '緑']];
const voiceText = v => v ? `${v.provider}:${v.id}` : 'なし';
const motionName = m => m.label || m.name || m.id;
const clock = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const lengthOf = url => new Promise(res => { const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => res(Number.isFinite(a.duration) ? a.duration : 0); a.onerror = () => res(0); a.src = url; });

// getChar: 今のキャラの記録(ジョブのあとで読み直される)。queued: 積んだジョブを渡す。reload: セリフを消したあとに読み直す。more: 細かい条件の末尾に足す要素
export function shootPanel({getChar, ver, motions, queued, reload, more = []}) {
  const c0 = getChar(), s = {line: '', motion: motions[0]?.id ?? '', expression: 'motion', framing: 'full', aspect: '9:16', quality: '1080p30', loops: 1, seconds: 5,
    background: 'viewer', lineSec: 0, audioFile: null, audioSec: 0, audioNote: '', audioPublic: false, audioStart: 0};
  const motion = () => motions.find(m => m.id === s.motion) ?? null;
  const audioLeft = () => Math.max(0, s.audioSec - s.audioStart);   // 開始位置から後ろの音声の長さ
  const total = () => shootSeconds({motionSec: motion()?.durationSec ?? 0, loops: s.loops, seconds: s.audioFile || s.line ? 0 : s.seconds, lineSec: s.lineSec, audioSec: audioLeft()});

  // 枠とプレビュー: 動画と同じ縦横、同じカメラ、同じ背景で、モーションを流し続ける
  const frame = viewerFrame(c0.id, ver.id, s.motion ? {motion: s.motion} : {});
  const box = h('div', {class: 'shot-frame'}, frame);
  const setRatio = () => { box.style.setProperty('--ratio', s.aspect.replace(':', ' / ')); box.dataset.aspect = s.aspect; };
  let turn = 0;
  async function preview() {
    const mine = ++turn, v = await viewerReady(frame), [a, b] = s.aspect.split(':').map(Number);
    if (mine !== turn) return;
    await v.prepareShot({motion: s.motion || null});
    if (mine !== turn) return;
    look(v); v.aimShot({framing: s.framing, aspect: a / b});
  }
  const look = v => { v.shotExpression(s.expression); v.shotBackground(s.background === 'viewer' ? null : s.background); };
  const seg = (list, key, then) => {
    const btns = list.map(([k, label]) => h('button', {type: 'button', class: 'seg-btn', 'aria-pressed': String(k === s[key]), onclick: e => {
      s[key] = k; btns.forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); then?.(); }}, label));
    return h('div', {class: 'seg three'}, btns);
  };
  const select = (label, options, key, then) => {
    const sel = h('select', {'aria-label': label}, options.map(([k, text]) => h('option', {value: k}, text)));
    sel.value = s[key]; sel.onchange = () => { s[key] = sel.value; then?.(); };
    return h('label', {}, label, sel);
  };

  // 長さ: モーションがあれば繰り返しの回数、無ければ秒(音声やセリフがあるときはその長さ)
  const lengthBox = h('div', {class: 'form-stack'});
  function renderLength() {
    const m = motion();
    if (m) {
      const loops = h('input', {type: 'number', min: '1', max: '10', step: '1', value: String(s.loops), 'aria-label': '繰り返す回数'});
      loops.oninput = () => { s.loops = Math.min(10, Math.max(1, Math.round(Number(loops.value)) || 1)); renderSummary(); };
      lengthBox.replaceChildren(h('label', {}, `繰り返す回数（1 回 ${m.durationSec.toFixed(1)} 秒）`, loops));
    } else if (s.audioFile || s.line) lengthBox.replaceChildren(h('p', {class: 'muted'}, '長さはセリフと音声の長い方。'));
    else {
      const sec = h('input', {type: 'number', min: '1', max: String(MAX_SECONDS), step: '1', value: String(s.seconds), 'aria-label': '長さ（秒）'});
      sec.oninput = () => { s.seconds = Math.min(MAX_SECONDS, Math.max(1, Number(sec.value) || 5)); renderSummary(); };
      lengthBox.replaceChildren(h('label', {}, '長さ（秒）', sec));
    }
  }

  // タイムラインと、長さの要約、音声の切り方の知らせ
  const timeline = h('div', {class: 'timeline', 'aria-label': 'タイムライン'}), summary = h('p', {class: 'muted'}), audioInfo = h('p', {class: 'muted'});
  const bar = (cls, from, to, tot) => h('span', {class: 'tl-bar ' + cls, style: `left:${from / tot * 100}%;width:${(to - from) / tot * 100}%`});
  function renderSummary() {
    const T = total(), m = motion(), rows = [];
    const row = (label, bars) => rows.push(h('span', {}, label), h('div', {class: 'tl-track'}, bars));
    if (s.line) row('セリフ', bar('tl-line', 0, Math.min(s.lineSec, T), T));
    if (m) row('動き', Array.from({length: Math.ceil(T / m.durationSec)}, (_, i) => bar('tl-motion', i * m.durationSec, Math.min((i + 1) * m.durationSec, T), T)));
    const expr = s.expression === 'motion' ? (m?.expressions ?? []).flatMap(e => Array.from({length: Math.ceil(T / m.durationSec)}, (_, i) => bar('tl-expr', (i + e.from) * m.durationSec, Math.min((i + e.to) * m.durationSec, T), T)))
      : s.expression === 'neutral' ? [] : [bar('tl-expr', 0, T, T)];
    if (expr.length) row('表情', expr);
    if (s.audioFile) row('音声', bar('tl-audio', 0, Math.min(audioLeft() || T, T), T));
    timeline.replaceChildren(...rows);
    const n = Math.round(T * FPS[s.quality]);
    summary.textContent = `この条件の長さは ${T.toFixed(1)} 秒、${n} コマ。` + (s.expression === 'motion' && m && !m.expressions?.length ? 'このモーションには表情の時刻表が無いので、ふだんの顔のまま。' : '');
    const from = s.audioStart ? `${clock(s.audioStart)} から使う。` : '', left = audioLeft();
    audioInfo.textContent = !s.audioFile ? '' : s.audioSec && s.audioStart >= s.audioSec ? `開始位置 ${clock(s.audioStart)} が音声の長さ ${clock(s.audioSec)} より後ろ。`
      : left > T ? `${from}音声は動画より長いので、動画の長さで切り、最後の 0.5 秒で音を小さくする。` : left ? `${from}音声が終わったあとは無音。` : '';
  }

  // 利用条件: 判定はサーバー(lib/terms.mjs)。止めはしない。注意があるときだけ「撮る」の上に出し、無いときは細かい条件に畳む
  const terms = h('section', {class: 'terms', 'aria-labelledby': 'termsTitle'}), termsTop = h('div', {class: 'terms-slot'}), termsFolded = h('div', {class: 'terms-slot'});
  let termsTurn = 0;
  async function renderTerms() {
    const mine = ++termsTurn, q = new URLSearchParams();
    if (s.motion) q.set('motion', s.motion);
    if (s.audioFile) { q.set('audioName', s.audioFile.name); q.set('audioSummary', s.audioNote); if (s.audioPublic) q.set('audioPublic', '1'); }
    const t = await getJSON('/api/terms?' + q).catch(e => ({level: 'check', tag: null, notes: [{text: '利用条件を読めない: ' + e.message}]}));
    if (mine !== termsTurn) return;
    terms.dataset.level = t.level;
    (t.level === 'ok' ? termsFolded : termsTop).append(terms);
    terms.replaceChildren(h('h3', {id: 'termsTitle'}, 'この動画の利用条件', t.tag ? h('span', {class: 'terms-tag'}, t.tag) : null),
      ...(t.notes.length ? t.notes.map(n => h('p', {}, n.text)) : [h('p', {}, 'モーションも音声も使わない。')]));
  }

  // セリフの選択。セリフの顔ぶれが変わったときだけ作り直す(再生中の音声を止めない)
  const lineBox = h('div', {class: 'form-stack'}), msg = h('span', {class: 'muted'});
  let lineKey = null;
  async function pickLine() {
    const l = lines().find(x => x.id === s.line);
    s.lineSec = l ? await lengthOf(l.audioUrl) : 0;
    renderLength(); renderSummary();
  }
  const lines = () => getChar().lines ?? [];
  function renderLines() {
    const ls = lines(), key = ls.map(l => l.id).join();
    if (key === lineKey) return;
    lineKey = key;
    if (!ls.some(l => l.id === s.line)) { s.line = ''; pickLine(); }
    const sel = h('select', {'aria-label': 'セリフ'}, h('option', {value: ''}, 'セリフなし'), ls.map(l => h('option', {value: l.id}, l.text || l.id)));
    sel.value = s.line;
    const audio = h('audio', {controls: true, preload: 'none'}), info = h('div', {class: 'muted'});
    const say = h('button', {}, 'ここで話させる'), del = h('button', {class: 'danger'}, 'このセリフを消す'), detail = h('div', {class: 'form-stack'}, info, audio, h('div', {class: 'actions'}, say, del));
    const cur = () => ls.find(l => l.id === s.line);
    const fill = () => {
      s.line = sel.value; const l = cur(); detail.hidden = !l; pickLine();
      if (!l) return;
      audio.src = l.audioUrl || libUrl('characters', c0.id, 'lines', l.id, l.audio || 'audio.mp3');
      info.textContent = [l.id, '声 ' + voiceText(l.voice), l.emotion ? '感情 ' + l.emotion : null, l.reading && l.reading !== l.text ? '読み: ' + l.reading : null].filter(Boolean).join('・');
    };
    sel.onchange = fill; fill();
    say.onclick = async () => { try { await (await viewerReady(frame)).playVoice(cur()); } catch (e) { msg.className = 'err'; msg.textContent = '話させられない: ' + e.message; } };
    del.onclick = async () => {
      const l = cur();
      if (await moveToTrash({kind: 'line', charId: c0.id, id: l.id}, l.text || l.id)) await reload();
    };
    lineBox.replaceChildren(h('label', {}, 'セリフ', sel), detail);
  }

  // 音声ファイル: 撮るときに送る
  const audioPick = h('input', {type: 'file', accept: '.mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4', 'aria-label': '音声ファイル'});
  const audioNote = h('input', {maxlength: '200', placeholder: '例: 自作の曲、〇〇のフリー音源', 'aria-label': '音声の利用条件'});
  const audioClear = h('button', {type: 'button', hidden: true}, '音声を外す');
  const audioStart = h('input', {type: 'number', min: '0', step: '0.1', value: '0', 'aria-label': '音声の開始位置（秒）'});
  const audioPublic = h('input', {type: 'checkbox', 'aria-label': 'この音声は動画と一緒に公開してよい'});
  const bigAudio = f => f && f.size > MAX_AUDIO_BYTES ? `音声ファイルが大きすぎる（${(f.size / 1048576).toFixed(1)} MB。上限 ${MAX_AUDIO_BYTES / 1048576} MB）` : null;
  audioPick.onchange = async () => {
    const big = bigAudio(audioPick.files[0]);
    if (big) { audioPick.value = ''; msg.className = 'err'; msg.textContent = big; }
    s.audioFile = audioPick.files[0] ?? null; audioClear.hidden = !s.audioFile;
    s.audioSec = s.audioFile ? await lengthOf(URL.createObjectURL(s.audioFile)) : 0;
    renderLength(); renderSummary(); renderTerms();
  };
  audioClear.onclick = () => { audioPick.value = ''; audioPick.onchange(); };
  audioNote.oninput = () => { s.audioNote = audioNote.value.trim(); renderTerms(); };
  audioStart.oninput = () => { s.audioStart = Math.max(0, Number(audioStart.value) || 0); renderLength(); renderSummary(); };
  audioPublic.onchange = () => { s.audioPublic = audioPublic.checked; renderTerms(); };

  const shoot = h('button', {class: 'primary big'}, '撮る');
  shoot.onclick = async () => {
    if (s.audioFile && s.audioSec && s.audioStart >= s.audioSec) { msg.className = 'err'; msg.textContent = '積めない: 音声の開始位置が音声の長さより後ろ'; return; }
    shoot.disabled = true; msg.className = 'muted'; msg.textContent = '送っている…';
    try {
      const audioId = s.audioFile ? (await uploadAudio(s.audioFile)).id : null;
      queued(await send('POST', '/api/jobs', {type: 'shoot', charId: c0.id, verId: ver.id, motionId: s.motion || null, loops: s.loops, seconds: s.motion || s.line || s.audioFile ? undefined : s.seconds,
        expression: s.expression, framing: s.framing, aspect: s.aspect, quality: s.quality, lineId: s.line || null, audioId, audioSummary: s.audioNote, audioPublic: s.audioPublic, audioStart: s.audioStart, background: s.background}));
      msg.textContent = '積んだ';
    } catch (e) { msg.className = 'err'; msg.textContent = '積めない: ' + e.message; }
    shoot.disabled = false;
  };

  const reframe = () => { setRatio(); preview(); };
  const controls = h('div', {class: 'form-stack'},
    select('モーション', [['', 'なし'], ...motions.map(m => [m.id, `${motionName(m)}（${m.limit.text}）`])], 'motion', () => { s.loops = 1; preview(); renderLength(); renderSummary(); renderTerms(); }),
    h('fieldset', {}, h('legend', {}, '縦横'), seg(ASPECTS.map(a => [a, a]), 'aspect', reframe)),
    h('details', {}, h('summary', {}, '細かい条件（写す範囲、画質、長さ、背景、表情、音声、セリフ）'), h('div', {class: 'form-stack'},
      h('fieldset', {}, h('legend', {}, '写す範囲'), seg(Object.entries(CAMERAS), 'framing', preview)),
      select('画質', Object.entries(QUALITIES), 'quality', renderSummary),
      lengthBox,
      select('背景', BACKGROUNDS, 'background', async () => look(await viewerReady(frame))),
      select('表情', EXPRESSIONS, 'expression', async () => { look(await viewerReady(frame)); renderSummary(); }),
      h('details', {}, h('summary', {}, '音声ファイル（曲を足す）'), h('div', {class: 'form-stack'},
        h('label', {}, '音声ファイル（mp3、wav、m4a）', audioPick), audioClear, h('label', {}, '音声の利用条件（任意）', audioNote),
        h('label', {class: 'check'}, audioPublic, 'この音声は動画と一緒に公開してよい（選ばなければ、公開前に確かめる扱い）'),
        h('label', {}, '音声の開始位置（秒）', audioStart), audioInfo)),
      lineBox, more, summary, termsFolded)),
    termsTop, shoot, msg);

  setRatio(); renderLines(); renderLength(); renderSummary(); renderTerms(); preview();
  return {box, timeline, controls, renderLines};
}
