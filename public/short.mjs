// ショート動画: 一覧(#shorts)と編集画面(#short/<ID>)。ジョブは lib/short.mjs(docs/shorts.md)、画面は docs/shorts.md。
import {h, getJSON, send} from './dom.mjs';
import {enc, figuresReport, jobActive, pendingRow, thumb, uploadAudio, viewerFrame, viewerReady, watchJobs} from './shared.mjs';
import {moveToTrash} from './confirm.mjs';
import {can, missingNote} from './capabilities.mjs';
import {MAX_AUDIO_BYTES} from './shoot-plan.mjs';
import {danceCutBounds, graphicEstimateSec, graphicShares, graphicWords, mvEstimateSec} from './mv-plan.mjs';
import {AMBIENCES, DRAFT_STYLES, EFFECTS, SOUNDS, STYLE_LABEL, TELOP_TYPES, TRANSITIONS, castOf, cutEstimate, direct, keepMadeFigures, memberSpeed, pendingClaims, plainText, scriptChanged} from './short-direct.mjs';
import {MAKER_LABEL, claimsPanel, draftForm, serialPanel} from './short-draft.mjs';
import {videoCard, dropVideos, finalsOf} from './gallery.mjs';
import {KIND_LABEL, cameraAxes, cameraFraming, cameraLabel, cameraSketch, camerasFor, shortKind} from './short-camera.mjs';
import {dancePanel} from './short-dance.mjs';
import {vrmChars} from './char-style.mjs';
import {cueOptions, cueSpec, creaturePanel} from './short-creature.mjs';

const TONE_LABEL = {'': 'ふつう', whispers: 'ささやく', sighs: 'ため息まじり', sad: '悲しげに', angry: '怒って', excited: '弾んで', nervous: '不安げに', crying: '泣きながら', trembling: '震える声で', terrified: 'おびえて'};
const PROP_OPTIONS = [['', 'なし'], ['letter', '手紙（最後の行を折る）'], ['letter_open', '手紙（開く）']];
const SOUND_LABEL = {footsteps: '足音', paper: '紙の音', wind: '風', chime: 'チャイム', heartbeat: '鼓動', door: '戸を開ける', crows: '遠くのカラス', caw: 'カラスの一声', snap: '紙を突きつける', hit: '低い衝撃音', ring: '耳鳴り'};
const EXPRESSIONS = [['motion', 'モーションに合わせる'], ['neutral', 'ふだん'], ['happy', '笑顔'], ['angry', '怒り'], ['sad', '悲しみ'], ['relaxed', '安らぎ'], ['surprised', '驚き（口が開く）'], ['worried', '不安'], ['afraid', '怯え'], ['shocked', 'はっとする'], ['tense', '張りつめる'], ['cold', '冷たい']];
const TRANSITION_LABEL = {none: 'なし', whip: '流し撮り', zoom: 'ズーム', flash: 'フラッシュ', slide: 'スライド', glitch: 'グリッチ', dissolve: 'ディゾルブ', fade: '黒を挟む'};
const EFFECT_LABEL = {none: 'なし', punch: 'ズームパンチ', shake: '揺れ', speedlines: '集中線', particles: '光の粒', flash: '色のフラッシュ', sparkle: 'キラキラ', question: '疑問符', exclaim: '感嘆符', slam: '全画面の語', insert: '別カットの差し込み'};
const TELOP_LABEL = {pop: '弾む', number: '数字', hook: 'フックの帯', follow: 'フォローの誘導', band: '帯', cinema: '映画風', title: '大きな見出し'};
const options = (labels, list) => [['', '自動'], ...list.map(k => [k, labels[k]])];
const uploadFigure = async (id, file) => { const r = await fetch(`/api/shorts/${enc(id)}/figures`, {method: 'POST', headers: {'x-filename': enc(file.name)}, body: file}), j = await r.json(); if (!r.ok) throw Error(j.error); return j; };
const minutes = sec => `約 ${Math.max(1, Math.round(sec / 60))} 分`;
const motionName = m => m.label || m.name || m.id;
// 見本: シーンは 1 つのままカメラと図で変化を付ける。最後は問いで切り、最初の話題へ戻る(ループしやすい)
const SAMPLE = [['talk_bust', 'タコの[心臓]は、[3つ|surprised]あるって知ってた？', '', 'octopus.png'], ['talk_close', '2つはエラに血を送って、もう1つが全身に血を送っているんだよ。', ''], ['talk_bust', 'しかも血の色は、赤じゃなくて[青い|surprised]んだ。', 'なぜ青い？', 'blood.png'],
  ['talk_close', 'ちなみに、体の中の銅が血を青くしているよ。', ''], ['talk_bust', 'じゃあ、タコの心臓はいくつだった？', '']];

// ドラマの見本「夕暮れの手紙」。冒頭で手紙を突きつけ、ひよりが字を見て反転し、最後の一行の途中で切る。
//   rin と hiyori は [動き, 表情]。rin は右手に手紙を持ち、差し出した姿勢を保つ。noLetter は顔の大写しで紙が手前に白く入らないよう外す。hiyori が null のカットは出ない
const RIN = '凛', HIYORI = 'ひより', THRUST = '手紙を差し出す', STILL = '静かに立つ', OFFER_TURN = 30;   // 差し出す動きは体が右へ回るので、相手の方へ足す
const DRAMA = [
  {camera: 'prop_close', who: RIN, text: 'これ、書いたのは[あなた]でしょ。', telop: '差出人のない手紙', tone: 'angry', sound: 'snap', soundAt: 0.1, rin: [THRUST, 'cold'], hiyori: null},
  {camera: 'close_who', who: HIYORI, text: '……何のこと？', tone: 'nervous', rin: [THRUST, 'cold'], hiyori: [STILL, 'worried']},
  {camera: 'over_shoulder', who: RIN, text: '「明日、この街を出る」って、何。', rin: [THRUST, 'cold'], hiyori: [STILL, 'worried']},
  {camera: 'bust_who', who: HIYORI, text: '違う。それ、私の字じゃ……', rin: [THRUST, 'tense'], hiyori: ['覗き込んで驚く', 'shocked']},
  {camera: 'prop_close', who: HIYORI, text: '', seconds: 0.8, sound: 'hit', soundAt: 0.55, soundGain: 1.6, hush: true, rin: [THRUST, 'tense'], hiyori: null},
  {camera: 'close_who', who: HIYORI, text: '三年前に消えた、姉の字だよ。', tone: 'trembling', sound: 'heartbeat', soundAt: 0, soundGain: 1.6, hush: true, rin: [THRUST, 'tense'], hiyori: [STILL, 'afraid']},
  {camera: 'face_who', who: RIN, text: '今朝、机の中に……。', rin: [THRUST, 'shocked', 'noLetter'], hiyori: [STILL, 'afraid']},
  {camera: 'bust_who', who: HIYORI, text: 'ねえ。最後の一行は、読んだ？', tone: 'whispers', rin: [THRUST, 'shocked'], hiyori: ['身を乗り出す', 'tense']},
  {camera: 'prop_line', who: RIN, text: '', seconds: 1.1, sound: 'hit', soundAt: 0, soundGain: 1.6, hush: true, rin: [THRUST, 'shocked'], hiyori: null},
  {camera: 'face_who', who: HIYORI, text: '（お願い、読まないで！）', tone: 'terrified', sound: 'ring', soundAt: 0, rin: [THRUST, 'shocked'], hiyori: ['怯えて縮こまる', 'afraid']},
];

// 見本の動きの名前からモーションを選ぶ。無ければ話す動きか最初のモーション
const motionNamed = (motions, name) => (motions.find(m => (m.label ?? '').includes(name)) ?? motions.find(m => /話す/.test(m.label ?? '')) ?? motions[0]).id;

function dramaSample(ov, choices, motions) {
  const chars = vrmChars(ov.chars).filter(x => x.latest), cast2 = ['avatar-sample-b', 'beta-sample-2'].map(id => chars.find(x => x.id === id)).filter(Boolean);
  const [a, b] = cast2.length === 2 ? cast2 : chars;
  if (!b) throw Error('版のあるキャラが 2 人要る');
  const voice = (name, speaker) => { const v = choices.elevenVoices.find(x => x.name.startsWith(name)); return v ? {provider: 'elevenlabs', voiceId: v.id, voiceName: v.name} : {provider: 'voicevox', speaker, speakerName: '', speed: 1.1}; };
  const cast = [{name: RIN, charId: a.id, verId: a.latest.id, ...voice('Aya', 8)}, {name: HIYORI, charId: b.id, verId: b.latest.id, ...voice('Nao', 3)}];
  const stage = (choices.stages.find(x => x.id === 'classroom') ?? choices.stages[0]).id;
  const cuts = DRAMA.map(({rin, hiyori, ...c}) => {
    const first = {motionId: motionNamed(motions, rin[0]), expression: rin[1], ...(rin[2] ? {} : {prop: c.camera === 'prop_line' ? 'letter_open' : 'letter'}), hold: true, turn: OFFER_TURN};
    const actors = [first, hiyori ? {motionId: motionNamed(motions, hiyori[0]), expression: hiyori[1]} : {absent: true}];
    return {stage, motionId: first.motionId, expression: first.expression, actors, seconds: 0, telop: '', ...c};
  });
  return {title: '夕暮れの手紙', style: 'drama', series: '', defaultBgm: true, ambience: 'wind', cast, cuts};
}

// ---- 一覧 ----
export async function showShorts({main, ov, reload, alive}) {
  const shorts = await getJSON('/api/shorts'), msg = h('span', {class: 'muted'});
  const make = sample => async () => {
    const c = vrmChars(ov.chars).find(x => x.latest);
    if (!c) { msg.className = 'err'; msg.textContent = '版のあるキャラが要る'; return; }
    try {
      const [choices, motions] = await Promise.all([getJSON('/api/short-options'), getJSON('/api/motions')]);
      if (!choices.stages.length || !motions.length) throw Error('シーンとモーションが要る');
      const motionId = (motions.find(m => /話す/.test(m.label ?? '')) ?? motions[0]).id, stage = choices.stages[0].id;
      const cuts = sample ? SAMPLE.map(([camera, text, telop]) => ({stage, motionId, expression: 'neutral', camera, text, telop})) : [{stage, motionId, expression: 'neutral', camera: 'talk_bust', text: '', telop: ''}];
      const s = await send('POST', '/api/shorts', {title: sample ? 'タコの雑学' : '新しいショート', style: 'trivia', series: sample ? 'サクッと雑学' : '', defaultBgm: sample, charId: c.id, verId: c.latest.id, speaker: 8, speakerName: '春日部つむぎ', cuts});
      if (sample) {   // 見本の図
        for (const [i, row] of SAMPLE.entries()) {
          if (!row[3]) continue;
          const r = await fetch('/app/sample/' + row[3]);
          if (!r.ok) continue;   // 配布版は見本の図を同梱しない。図なしで続ける
          const {file} = await uploadFigure(s.id, new File([await r.blob()], row[3]));
          s.cuts[i].figure = file;
        }
        await send('PUT', '/api/shorts/' + enc(s.id), s);
      }
      location.hash = '#short/' + enc(s.id);
    } catch (e) { msg.className = 'err'; msg.textContent = '作れない: ' + e.message; }
  };
  const makeDrama = async () => {
    try {
      const [choices, motions] = await Promise.all([getJSON('/api/short-options'), getJSON('/api/motions')]);
      if (!choices.stages.length || !motions.length) throw Error('シーンとモーションが要る');
      const s = await send('POST', '/api/shorts', dramaSample(ov, choices, motions));
      location.hash = '#short/' + enc(s.id);
    } catch (e) { msg.className = 'err'; msg.textContent = '作れない: ' + e.message; }
  };
  const draft = draftForm({ov, alive, msg, reload});
  const noStage = !can(ov, 'stageStudio'), note = missingNote(ov, ['stageStudio', 'hyperframes', 'blender'], 'ショートを作って書き出すのに要る道具が未設定');
  main.replaceChildren(h('div', {class: 'library'},
    h('div', {class: 'lib-head', ...(noStage && {inert: ''})}, h('h1', {}, 'ショート'), draft.open, h('button', {type: 'button', onclick: make(true)}, '雑学の見本から作る'), h('button', {type: 'button', onclick: makeDrama}, 'ドラマの見本から作る'), h('button', {type: 'button', class: 'primary', onclick: make(false)}, '新しいショート')),
    note, msg, draft.form, draft.box,
    shorts.length ? h('div', {class: 'stack-small'}, shorts.map(s => h('div', {class: 'short-row'},
      h('a', {class: 'short-name', href: '#short/' + enc(s.id)}, s.title), h('span', {class: 'muted'}, [`${s.cuts.length} カット`, MAKER_LABEL[s.draftBy] && `下書き ${MAKER_LABEL[s.draftBy]}`].filter(Boolean).join('、')),
      h('button', {type: 'button', class: 'quiet', onclick: async () => { if (await moveToTrash({kind: 'short', id: s.id}, s.title)) reload(); }}, '削除'))))
      : h('p', {class: 'muted'}, 'ショートはまだない。カットごとにシーン、動き、セリフを並べて縦動画を作る。')));
}

// ---- 編集画面(#short/<ID>) ----
//   人は確かめて少し直し、直しを頼んで、確認済みにする。上の欄、左の素材、中央のプレビュー、右の選んだカット、下のタイムライン。スマホは縦に積む(docs/shorts.md の「ショート」)
const CAST_COLOR = ['#B79CFF', '#7FD8A6', '#F2A0C4'], NARRATION_COLOR = '#C3C9D3';
const SFX_LABEL = {...SOUND_LABEL, pop: 'ポン', whoosh: 'シュッ', impact: 'ドン', glitch: 'ザザッ', ding: 'チン', sparkle: 'キラッ', soft: 'フワッ', scuff: 'ザッ', caw: 'カラス', crows: 'カラスの群れ'};
const ICON = {back: '<path d="M15 18l-6-6 6-6"></path>', prev: '<path d="M19 20L9 12l10-8z"></path><path d="M5 19V5"></path>', next: '<path d="M5 4l10 8-10 8z"></path><path d="M19 5v14"></path>',
  left: '<path d="M15 18l-6-6 6-6"></path>', right: '<path d="M9 6l6 6-6 6"></path>', check: '<path d="M5 12l5 5 9-10"></path>'};
const FILLED = {play: '<path d="M7 4l13 8-13 8z"></path>', pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z"></path>'};
// 決まった形の SVG だけを入れる(文字は入れない)
const icon = (name, size = 18) => { const sp = h('span', {class: 'se-icon', 'aria-hidden': 'true'}); sp.innerHTML = FILLED[name] ? `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor">${FILLED[name]}</svg>` : `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`; return sp; };
const once = (el, type) => new Promise((ok, no) => { el.addEventListener(type, ok, {once: true}); el.addEventListener('error', no, {once: true}); });
// 効果音の印の色: 生き物の声、演出の音、そのほかの音
const sfxTone = name => (name === 'caw' || name === 'crows' ? 'creature' : SOUNDS.includes(name) || name === 'scuff' ? 'plain' : 'fx');
const asked = x => !!(x.askedAt && x.ask?.trim());

// 書き出した動画からカットごとのコマを切り出す(隠した video を seek して canvas へ描く)。got(i, dataURL) を 1 枚ずつ呼ぶ
async function grabFrames(url, spans, got, alive) {
  const v = h('video', {src: url, preload: 'auto', playsinline: true});
  v.muted = true;
  try {
    await once(v, 'loadeddata');
    for (const [i, sp] of spans.entries()) {
      if (!alive()) return;
      v.currentTime = Math.min(sp.start + Math.min(0.6, (sp.end - sp.start) * 0.4), v.duration - 0.05);
      await once(v, 'seeked');
      const cv = h('canvas', {width: '108', height: '192'});
      cv.getContext('2d').drawImage(v, 0, 0, 108, 192);
      got(i, cv.toDataURL('image/jpeg', 0.75));
    }
  } catch (e) { console.error('コマを切り出せない', e); }
  finally { v.removeAttribute('src'); v.load(); }
}

export async function showShort({main, alive, jobsChanged}, id) {
  const [short, shortOptions, motions, overview] = await Promise.all([getJSON('/api/shorts/' + enc(id)), getJSON('/api/short-options'), getJSON('/api/motions'), getJSON('/api/overview')]);
  let s = {...short, cast: castOf(short)}, picked = 0, timer = null;
  let kind = shortKind(s);   // 生き物を選ぶと walk と creature のあいだで変わる(左の「生き物」)
  const dance = kind === 'dance';   // ダンス MV: 声が無く、カットは「拍から割る」で作る(docs/shorts-dance-mv.md)
  let dancing = null;   // 左の列の「曲とシーン」(dance のときだけ)
  const graphicLook = () => dance && s.music?.look === 'graphic';   // グラフィック MV: カットは場面、ワイプ、言葉。シーン、カメラ、テロップは使わない
  let faceHits = [];   // 最後に書き出したグラフィック MV で、顔に文字がかかったコマの数(カットごと)
  const chars = vrmChars(overview.chars).filter(x => x.latest), expressionOf = (c, k) => c.actors?.[k]?.expression ?? c.expression, motionOf = (c, k) => c.actors?.[k]?.motionId ?? c.motionId;
  const speakerIndex = c => s.cast.findIndex(m => m.name && m.name === c.who);
  const voiceOptions = m => (m.provider === 'elevenlabs' ? shortOptions.elevenVoices.map(v => [v.id, v.name]) : shortOptions.speakers.map(v => [v.id, v.name]));
  const status = h('span', {class: 'muted se-status settled'}, '保存済み'), msg = h('span', {class: 'muted'});
  const label = stage => shortOptions.stages.find(x => x.id === stage)?.label ?? stage;
  const stageThumb = stage => shortOptions.stages.find(x => x.id === stage)?.thumb;

  // スマホの上の欄は狭いので、保存済みのときは出さない(class settled)
  const setStatus = text => { status.textContent = text; status.classList.toggle('settled', text === '保存済み'); };
  // 保存は 1 本ずつ順に送る。s は画面の今の値のまま持ち、応答で置き換えない
  let saving = Promise.resolve();
  function save() {
    clearTimeout(timer); timer = null;
    setStatus('保存中…');
    saving = saving.catch(() => {}).then(() => send('PUT', '/api/shorts/' + enc(id), s)).then(() => { if (!timer) setStatus('保存済み'); }, e => { setStatus('保存できない: ' + e.message); throw e; });
    return saving;
  }
  // 編集のたび: 0.8 秒あとに保存し、上の欄とタイムラインを今の値で描き直す。右の欄は打っている途中なので描き直さない
  const touch = () => { setStatus('未保存'); clearTimeout(timer); timer = setTimeout(() => save().catch(() => {}), 800); renderLive(); gateFinal(); gateFigures(); };

  const select = (text, list, get, set) => {
    const sel = h('select', {'aria-label': text}, list.map(([k, t]) => h('option', {value: String(k)}, t)));
    sel.value = String(get()); sel.onchange = () => set(sel.value);
    return h('label', {}, text, sel);
  };

  // ---- カットの時刻: 最新の書き出しの時間表があればそれ、無ければ声の長さの推定の累積 ----
  // 書き出しのコマと時間表は、読んだときのカットの並び(origin: カット → 何番目だったか)に結び付ける。
  // 並べ替え・足す・消すのあとは、コマはカットに付いていき、時間表は並びが同じに戻るまで推定に替える
  let latest = null, times = null, frames = [], video = null, origin = new WeakMap();
  const cutSec = c => cutEstimate(c, memberSpeed(s.cast[Math.max(0, speakerIndex(c))]));
  const timed = () => !!times && times.cuts.length === s.cuts.length && s.cuts.every((c, i) => origin.get(c) === i);
  const exact = () => timed() || dance;   // ダンス MV のカットの秒は拍で決まっていて、推定ではない
  function spans() {
    if (timed()) return times.cuts;
    if (dance) return danceCutBounds(s.cuts);
    let t = 0;
    return s.cuts.map(c => { const d = cutSec(c), r = {start: t, end: t + d}; t += d; return r; });
  }
  const total = () => spans().at(-1)?.end ?? 0;

  // ---- 中央: 書き出しがあればその動画、無ければビューアで選んだカットの動きを確かめる ----
  const screen = h('div', {class: 'se-screen'}), screenTag = h('span', {class: 'se-screen-tag mono'}), clock = h('span', {class: 'mono se-clock'});
  const frame = viewerFrame(s.charId, s.verId, {});
  let turn = 0;
  async function preview() {
    const c = s.cuts[picked], mine = ++turn;
    if (!c || video) return;
    const v = await viewerReady(frame);
    if (mine !== turn) return;
    await v.prepareShot({motion: c.motionId});
    if (mine !== turn) return;
    v.shotExpression(c.expression); v.aimShot({framing: cameraFraming(c.camera), aspect: 9 / 16});
  }
  const playBtn = h('button', {type: 'button', class: 'se-play', 'aria-label': '再生', disabled: true, title: '書き出すと再生できる', onclick: () => { if (video) video.paused ? video.play() : video.pause(); }}, icon('play', 20));
  const showPlaying = () => { const on = video && !video.paused; playBtn.replaceChildren(icon(on ? 'pause' : 'play', 20)); playBtn.setAttribute('aria-label', on ? '止める' : '再生'); };
  function showClock() {
    const t = video ? video.currentTime : spans()[picked]?.start ?? 0;
    clock.textContent = `${t.toFixed(2).padStart(5, '0')} / ${exact() || !video ? '' : '約 '}${total().toFixed(2)}`;
    playhead.style.left = `calc(var(--tl-label) + (100% - var(--tl-label)) * ${Math.min(1, t / (total() || 1)).toFixed(4)})`;
  }
  function showVideo(rec) {
    video = h('video', {src: rec.url, poster: rec.posterUrl, playsinline: true, preload: 'auto', 'aria-label': '書き出した動画'});
    video.onclick = () => (video.paused ? video.play() : video.pause());
    video.onplay = video.onpause = showPlaying;
    video.ontimeupdate = () => {
      showClock();
      if (video.paused) return;
      const t = video.currentTime, i = spans().findIndex(x => t >= x.start && t < x.end);
      if (i >= 0 && i !== picked && !right.contains(document.activeElement)) { picked = i; renderPicked(); }
    };
    screen.replaceChildren(video, screenTag);
    playBtn.disabled = false; playBtn.removeAttribute('title');
  }
  function showViewer() { screen.replaceChildren(frame, screenTag); preview(); }
  const seek = () => { if (video) { video.currentTime = (spans()[picked]?.start ?? 0) + 0.001; } showClock(); };
  // カットを選ぶ: 右の欄とタイムラインを描き直し、動画はそのカットの頭へ飛ぶ
  function pickCut(i) {
    if (i < 0 || i >= s.cuts.length) return;
    picked = i; renderPicked(); right.scrollTop = 0; seek(); preview();
  }
  const stepBtn = (name, d, cls) => h('button', {type: 'button', class: 'se-step ' + cls, 'aria-label': d < 0 ? '前のカット' : '次のカット', onclick: () => pickCut(picked + d)}, icon(name));

  // 書き出したカットの絵に今の文字と演出を重ねて再生する。転換と効果音は書き出しで変わる
  const playerBox = h('div', {class: 'short-player', hidden: true}), overlay = h('button', {type: 'button', class: 'quiet', onclick: async () => {
    overlay.disabled = true; msg.className = 'muted'; msg.textContent = '';
    try {
      await save();
      const url = `/api/shorts/${enc(id)}/compose/index.html`, r = await fetch(url);
      if (!r.ok) throw Error((await r.json().catch(() => null))?.error ?? '見られない');
      if (!customElements.get('hyperframes-player')) await new Promise((ok, no) => document.head.append(h('script', {src: '/app/vendor/hyperframes-player.global.js', onload: ok, onerror: no})));
      video?.pause();
      playerBox.hidden = false;
      playerBox.replaceChildren(h('hyperframes-player', {src: `${url}?t=${Date.now()}`, controls: true}));
    } catch (e) { msg.className = 'err'; msg.textContent = e.message; }
    overlay.disabled = false;
  }}, '書き出した絵に重ねて見る');

  // ---- 右: 選んだカットの確かめと微調整 ----
  const right = h('aside', {class: 'se-right', 'aria-label': 'カットの確認と微調整'});
  const okBig = h('button', {type: 'button', class: 'se-okbig', onclick: () => { const c = s.cuts[picked]; if (c) setOk(c, !c.ok); }});
  function setOk(c, on) { if (on) c.ok = true; else delete c.ok; touch(); renderOk(); }
  let okRow = null;
  function renderOk() {
    const c = s.cuts[picked], on = !!c?.ok;
    okBig.hidden = !c; okBig.setAttribute('aria-pressed', String(on)); okBig.textContent = on ? 'このカットは確認済み' : 'このカットを確認した';
    if (okRow) { okRow.classList.toggle('on', on); okRow.querySelector('input').checked = on; }
  }
  // 直してほしいこと。「Claude に頼む」は ask を保存して askedAt を入れるだけ(Claude が後で読む)
  function askBox(target, aria, placeholder) {
    const area = h('textarea', {rows: '2', maxlength: '200', placeholder, 'aria-label': aria}, target.ask ?? '');
    const waiting = h('span', {class: 'se-wait', hidden: !asked(target)}, '頼んだ直し: 対応待ち');
    const btn = h('button', {type: 'button', class: 'outline', disabled: !target.ask?.trim()}, 'Claude に頼む');
    area.oninput = () => { target.ask = area.value; if (!area.value.trim()) delete target.askedAt; btn.disabled = !area.value.trim(); waiting.hidden = !asked(target); touch(); };
    // 頼み直すと前の返事は消す(返事は次に頼むまで残す)
    btn.onclick = () => { target.ask = area.value.trim(); target.askedAt = new Date().toISOString(); delete target.reply; delete target.repliedAt; reply?.remove(); waiting.hidden = false; renderLive(); save().catch(() => {}); };
    // Claude が直したあとの返事
    const reply = target.reply ? h('p', {class: 'se-reply'}, h('strong', {}, `Claude の対応${target.repliedAt ? `(${new Date(target.repliedAt).toLocaleString('ja-JP', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})})` : ''}: `), target.reply) : null;
    return [area, h('div', {class: 'actions'}, btn, waiting), reply];
  }

  // 自動で決まる演出の説明
  function autoNote(i) {
    const d = direct(s.cuts, s.style ?? 'trivia').cuts[i];
    return `自動: 転換 ${TRANSITION_LABEL[d.transition]}、効果 ${d.effects.map(e => EFFECT_LABEL[e]).join('と') || 'なし'}、テロップ ${TELOP_LABEL[d.telopType]}`;
  }

  function cameraBox(c) {
    const {axes, offNote, hint} = cameraAxes(c.camera, kind);
    const box = h('section', {class: 'se-camera', 'aria-label': 'カメラ'},
      h('div', {class: 'se-cam-head'}, cameraSketch(c.camera), h('div', {class: 'se-cam-name'}, h('span', {class: 'muted'}, 'カメラ'), h('strong', {}, cameraLabel(c.camera)), hint ? h('span', {class: 'muted'}, hint) : null)),
      ...axes.map(a => h('div', {class: 'se-axis', role: 'group', 'aria-label': a.label}, h('span', {class: 'muted'}, a.label),
        h('div', {class: 'se-axis-items'}, a.items.map(o => h('button', {type: 'button', class: 'chip-btn', 'aria-pressed': String(o.on), disabled: o.off, title: o.why || null,
          onclick: () => { if (!o.camera || o.camera === c.camera) return; c.camera = o.camera; touch(); box.replaceWith(cameraBox(c)); preview(); if (dance) showEdits(c); }}, o.value))))),
      offNote ? h('span', {class: 'muted'}, offNote) : null);
    return box;
  }

  // カットの始めに生き物がすること。選んだ生き物に無い動きは選べず、今の値が無い動きなら注意を出す(撮る前にサーバーも断る)
  function cueField(c, i) {
    const opts = cueOptions(cueSpec(s.take?.creature, overview.chars)), now = opts.find(o => o.id === c.creature);
    const sel = h('select', {'aria-label': `カット ${i + 1} の生き物の動き`}, h('option', {value: ''}, 'なし'),
      opts.map(o => h('option', {value: o.id, disabled: o.lacks.length > 0 && o.id !== c.creature}, o.lacks.length ? `${o.label}(この生き物に無い)` : o.label)));
    sel.value = c.creature ?? '';
    const warn = h('span', {class: 'limit warn', hidden: !now?.lacks.length}, now?.lacks.length ? `この生き物に無い動き(${now.lacks.join('、')})。書き出す前に選び直す` : '');
    sel.onchange = () => { if (sel.value) c.creature = sel.value; else delete c.creature; warn.hidden = true; touch(); };
    return h('label', {}, '生き物の動き', sel, warn);
  }

  function cutPane(c, i) {
    const sp = spans()[i], speaker = speakerIndex(c), many = s.cast.length > 1, eleven = s.cast[Math.max(0, speaker)].provider === 'elevenlabs';
    const text = h('textarea', {rows: '2', maxlength: '200', placeholder: 'セリフ。[語] で強調、[語|surprised] でその語の時刻に表情も変える。空なら声も字幕も無し', 'aria-label': `カット ${i + 1} のセリフ`}, c.text);
    text.oninput = () => { c.text = text.value; touch(); };
    // 改行を残すため textarea にする。最初のカットのフックの帯は、改行で 2 行(前置きと題)になる
    const telop = h('textarea', {rows: c.telop?.includes('\n') ? '2' : '1', maxlength: '40', placeholder: 'テロップ（画面の上の大きな文字）。最初のカットは改行で 2 行（前置きと題）', 'aria-label': `カット ${i + 1} のテロップ`}, c.telop);
    telop.oninput = () => { c.telop = telop.value; telop.rows = telop.value.includes('\n') ? 2 : 1; touch(); };
    const seconds = h('input', {type: 'number', min: '0', max: '30', step: '0.5', value: String(c.seconds || 0), 'aria-label': `カット ${i + 1} の長さ`});
    seconds.oninput = () => { c.seconds = Math.min(30, Math.max(0, Number(seconds.value) || 0)); touch(); };
    const whoTag = h('input', {maxlength: '12', value: c.who ?? '', placeholder: '空なら無し', 'aria-label': `カット ${i + 1} の話者の名札`});
    whoTag.oninput = () => { c.who = whoTag.value; touch(); };
    const figure = h('input', {type: 'file', accept: '.png,.jpg,.jpeg,.webp', 'aria-label': `カット ${i + 1} の図`}), figureBox = h('div', {class: 'cut-figure'});
    // 図があれば絵を出す(押すと原寸)。作った図は作り直せる。人が入れた図は作り直さない
    const figureUrl = () => `/api/shorts/${enc(id)}/compose/figures/${enc(c.figure)}`;
    const showFigure = () => figureBox.replaceChildren(...(c.figure ? [h('a', {href: figureUrl(), target: '_blank', rel: 'noopener'}, h('img', {src: figureUrl(), alt: `カット ${i + 1} の図`})), c.figureStyle === 'sticker' && c.figureNote ? h('button', {type: 'button', class: 'quiet', onclick: makeFigures(i)}, '作り直す') : null,
      h('button', {type: 'button', class: 'quiet', onclick: () => { c.figure = ''; delete c.figureStyle; showFigure(); touch(); }}, '図を外す')] : c.figureNote ? [h('p', {class: 'muted'}, `図の提案: ${c.figureNote}`)] : []).filter(Boolean));
    figureViews.set(c, showFigure);
    showFigure();
    const figureNote = h('input', {maxlength: '200', value: c.figureNote ?? '', placeholder: '図にしたい絵の説明。「図を作る」で透過の図になる', 'aria-label': `カット ${i + 1} の図の説明`});
    figureNote.oninput = () => { c.figureNote = figureNote.value; showFigure(); touch(); };
    figure.onchange = async () => {
      if (!figure.files[0]) return;
      try { c.figure = (await uploadFigure(id, figure.files[0])).file; delete c.figureStyle; showFigure(); touch(); }
      catch (e) { msg.className = 'err'; msg.textContent = '図を送れない: ' + e.message; }
    };
    const audio = h('audio', {controls: true, hidden: true});
    const listen = h('button', {type: 'button', class: 'quiet', onclick: async () => {
      if (!plainText(c.text)) return;
      listen.disabled = true;
      try {
        const m = s.cast[Math.max(0, speakerIndex(c))];
        const r = await fetch('/api/short-voice', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(m.provider === 'elevenlabs' ? {text: c.text, provider: m.provider, voiceId: m.voiceId, tone: c.tone, shortId: id, cut: i} : {text: c.text, provider: 'voicevox', speaker: m.speaker, speed: m.speed})});
        if (!r.ok) throw Error(await r.text());
        audio.src = URL.createObjectURL(await r.blob()); audio.hidden = false; audio.play();
      } catch (e) { msg.className = 'err'; msg.textContent = '声を作れない: ' + e.message; }
      listen.disabled = false;
    }}, '声を聞く');
    const sets = (key, then) => v => { c[key] = v; touch(); then?.(); };
    // 出演者ごとの動きと表情。2 人以上のときは actors に持ち、最初の人の値をカットの値にもそろえる
    const actorSet = (k, key, v) => { c.actors = s.cast.map((_, j) => ({motionId: motionOf(c, j), expression: expressionOf(c, j), ...c.actors?.[j]})); c.actors[k][key] = v; if (!k) { if (key === 'motionId') c.motionId = v; if (key === 'expression') c.expression = v; } touch(); if (!k) preview(); };
    const actorRow = (m, k) => {
      const here = h('input', {type: 'checkbox', 'aria-label': `カット ${i + 1} に ${m.name} が出る`});
      here.checked = !c.actors?.[k]?.absent;
      here.onchange = () => actorSet(k, 'absent', !here.checked);
      const hold = h('input', {type: 'checkbox', 'aria-label': `カット ${i + 1} の ${m.name} 動きの最後の姿勢から`});
      hold.checked = !!c.actors?.[k]?.hold; hold.onchange = () => actorSet(k, 'hold', hold.checked);
      return h('div', {class: 'cut-grid'}, h('label', {class: 'check'}, here, m.name || '出演者'), select(`${m.name} の小道具`, PROP_OPTIONS, () => c.actors?.[k]?.prop ?? '', v => actorSet(k, 'prop', v)), h('label', {class: 'check'}, hold, '動きの最後の姿勢から'), select(`${m.name} の動き`, motions.map(x => [x.id, motionName(x)]), () => motionOf(c, k), v => actorSet(k, 'motionId', v)), select(`${m.name} の表情`, EXPRESSIONS, () => expressionOf(c, k), v => actorSet(k, 'expression', v)));
    };
    // ダンス MV: 角度は stage-studio の plan が決めた値。シーン、カメラ、角度を手で直すと注意を出す
    const angle = h('input', {type: 'number', min: '-180', max: '180', step: '1', value: String(c.angle ?? 0), 'aria-label': `カット ${i + 1} の角度`});
    angle.oninput = () => { const v = Number(angle.value); if (angle.value === '' || !Number.isFinite(v) || v < -180 || v > 180) return; c.angle = v; touch(); showEdits(c); };
    editNote = dance ? h('p', {class: 'limit warn', hidden: true}) : null;
    const okBox = h('input', {type: 'checkbox', 'aria-label': `カット ${i + 1} を確認した`});
    okBox.checked = !!c.ok; okBox.onchange = () => setOk(c, okBox.checked);
    okRow = h('label', {class: 'se-ok' + (c.ok ? ' on' : '')}, okBox, 'このカットを確認した');
    const [askArea, askActions, askReply] = askBox(c, `カット ${i + 1} で直してほしいこと`, '例: もう少し寄って。表情を大きく');
    const whoName = graphicLook() ? dancing?.sceneLabel(c.scene) : dance ? label(c.stage) : c.who || (plainText(c.text) ? (many ? '語り' : s.cast[0].name || '') : 'セリフなし');
    return [
      h('div', {class: 'se-cut-head'}, h('h2', {}, `カット ${i + 1} `, h('span', {class: 'se-who'}, whoName)), h('span', {class: 'mono muted'}, sp ? `${exact() ? '' : '約 '}${sp.start.toFixed(2)}–${sp.end.toFixed(2)} 秒` : '')),
      ...(dance ? [] : [h('label', {class: 'se-field'}, 'セリフ', text), h('div', {class: 'actions'}, listen, audio)]),
      ...(graphicLook() ? graphicCutFields(c, i) : [h('label', {class: 'se-field'}, dance ? 'テロップ(改行で 2 行。空なら出ない)' : 'テロップ(改行で 2 行)', telop),
        cameraBox(c), ...(editNote ? [editNote] : [])]),
      h('section', {class: 'se-ask', 'aria-label': '直してほしいこと'}, h('label', {class: 'se-field'}, 'このカットで直してほしいこと', askArea), askActions, askReply),
      okRow,
      graphicLook() ? null : h('details', {class: 'se-more'}, h('summary', {}, '演出と細かい設定'),
        h('div', {class: 'form-stack'},
          h('p', {class: 'muted'}, autoNote(i)),
          many ? select('話す人', [['', '語り（口は動かない）'], ...s.cast.map(m => [m.name, m.name])], () => c.who ?? '', sets('who', renderAll)) : null,
          figureBox,
          dance ? h('p', {class: 'muted'}, 'シーン、カメラ、角度、秒は「拍から割る」で決まる。動きは左の「曲とシーン」で全カットに 1 つ。') : null,
          dance ? h('div', {class: 'cut-grid'}, select('シーン', shortOptions.stages.map(x => [x.id, x.label]), () => c.stage, sets('stage', renderAll)), h('label', {}, '角度（度）', angle)) : null,
          dance ? null : h('div', {class: 'cut-grid'},
            select('シーン', shortOptions.stages.map(x => [x.id, x.label]), () => c.stage, sets('stage', renderAll)),
            ...(many ? [] : [select('動き', motions.map(m => [m.id, motionName(m)]), () => c.motionId, sets('motionId', preview)), select('表情', EXPRESSIONS, () => c.expression, sets('expression', preview))]),
            h('label', {}, '長さ（秒。0 で声に合わせる）', seconds),
            eleven ? select('演じ方', shortOptions.tones.map(k => [k, TONE_LABEL[k] ?? k]), () => c.tone ?? '', sets('tone')) : null,
            select('音', [['', 'なし'], ...SOUNDS.map(k => [k, SOUND_LABEL[k]])], () => c.sound ?? '', sets('sound')),
            kind === 'creature' ? cueField(c, i) : null,
            (() => { const box = h('input', {type: 'checkbox', 'aria-label': `カット ${i + 1} で BGM を止める`}); box.checked = !!c.hush; box.onchange = () => { c.hush = box.checked; touch(); }; return h('label', {class: 'check'}, box, 'BGM を止める'); })()),
          ...(many ? s.cast.map(actorRow) : []),
          h('div', {class: 'cut-grid'},
            select('転換', options(TRANSITION_LABEL, TRANSITIONS), () => c.transition ?? '', sets('transition')),
            select('効果', options(EFFECT_LABEL, EFFECTS), () => c.effect ?? '', sets('effect')),
            select('テロップの型', options(TELOP_LABEL, TELOP_TYPES), () => c.telopType ?? '', sets('telopType')),
            many ? null : h('label', {}, '話者の名札', whoTag),
            h('label', {}, '図（語に合わせて弾んで出る）', figure), h('label', {}, '図の説明', figureNote))))];
  }
  // グラフィックのカットの欄: 場面、言葉、入りのワイプ。顔に文字がかかったコマがあれば注意を出す
  function graphicCutFields(c, i) {
    const cat = shortOptions.graphic ?? [], meta = cat.find(x => x.id === c.scene), slots = meta?.words ?? 0;
    const now = graphicWords(s.cuts, cat, s.music?.graphic?.text?.words)[i] ?? [];
    const word = h('input', {type: 'text', value: c.word ?? '', placeholder: now.join(' / ') || '言葉の枠が無い場面', maxlength: String(16 * 4 + 9), 'aria-label': `カット ${i + 1} の言葉`, disabled: !slots});
    word.oninput = () => { if (word.value.trim()) c.word = word.value; else delete c.word; touch(); };
    const wipe = h('select', {'aria-label': `カット ${i + 1} の入りのワイプ`}, [['', '場面の既定'], ['iris', '丸が広がる'], ['diag', '斜め'], ['bars', '縦の帯'], ['slab', '板が下りる'], ['columns', '3 本の柱'], ['none', 'なし（切り替え）']].map(([k, t]) => h('option', {value: k}, t)));
    wipe.value = c.wipe ?? ''; wipe.disabled = i === 0;
    wipe.onchange = () => { if (wipe.value) c.wipe = wipe.value; else delete c.wipe; touch(); };
    const hit = faceHits.find(x => x.cut === i);
    return [h('p', {class: 'muted'}, `場面: ${meta ? `${meta.label}（${meta.name}）` : c.scene}。場面の並びと秒は「拍から割る」で決まる。文字は絵の一部で、テロップは重ねない。`),
      hit ? h('p', {class: 'limit warn'}, `最後の書き出しで、${hit.frames} コマで手前の文字が顔にかかった。言葉を短くするか、場面を変える。`) : null,
      h('div', {class: 'cut-grid'}, h('label', {}, slots ? `言葉（枠 ${slots}。/ で区切る。空なら左の言葉を順に使う）` : '言葉（この場面は使わない）', word), h('label', {}, '入りのワイプ', wipe))];
  }
  function renderRight() {
    const c = s.cuts[picked];
    okRow = null; editNote = null;
    right.replaceChildren(...(c ? cutPane(c, picked) : [h('p', {class: 'muted'}, dance ? 'カットが無い。左の「曲とシーン」で踊る動きとシーンを選び、「拍から割る」を押す。' : 'カットが無い。下のタイムラインの「カットを足す」で足す。')]));
    renderOk();
    if (c && dance) showEdits(c);
  }
  // ダンス MV: 拍から割ったときからシーン、カメラ、角度を手で直したカットに注意を出す
  let editNote = null;
  function showEdits(c) {
    const changed = dancing?.edits(c) ?? [];
    if (editNote) { editNote.hidden = !changed.length; editNote.textContent = changed.length ? `${changed.join('、')}を手で直した。書き出しで止まることがある（stage-studio が手で直したカット表を受けないうちは）。戻すときは左の「拍から割る」を押す。` : ''; }
    dancing?.render(picked);
  }

  // ---- 下: タイムライン(PC)と、横に流れるカットの列(スマホ) ----
  const tlGrid = h('div', {class: 'se-tl-grid'}), playhead = h('div', {class: 'se-playhead', 'aria-hidden': 'true'}), strip = h('div', {class: 'se-strip', role: 'list', 'aria-label': 'カット'});
  const newCut = () => { const l = s.cuts[picked] ?? s.cuts.at(-1); return {stage: l?.stage ?? shortOptions.stages[0].id, motionId: l?.motionId ?? motions[0].id, expression: l?.expression ?? 'neutral', camera: camerasFor(kind).includes(l?.camera) ? l.camera : camerasFor(kind)[0], angle: 0, text: '', telop: '', seconds: 0}; };
  const move = d => () => { const j = picked + d; if (!s.cuts[picked] || j < 0 || j >= s.cuts.length) return; [s.cuts[picked], s.cuts[j]] = [s.cuts[j], s.cuts[picked]]; picked = j; renderAll(); touch(); };
  const cutOps = h('div', {class: 'se-tl-ops'},
    h('button', {type: 'button', class: 'quiet', onclick: move(-1)}, '前へ'), h('button', {type: 'button', class: 'quiet', onclick: move(1)}, '後へ'),
    h('button', {type: 'button', class: 'quiet', onclick: () => { if (!s.cuts[picked]) return; s.cuts.splice(picked, 1); picked = Math.max(0, Math.min(picked, s.cuts.length - 1)); renderAll(); touch(); }}, 'このカットを消す'),
    h('button', {type: 'button', class: 'outline', onclick: () => { s.cuts.splice(picked + 1, 0, newCut()); picked = Math.min(picked + 1, s.cuts.length - 1); renderAll(); touch(); }}, 'カットを足す'));
  const badges = c => h('span', {class: 'se-badges'}, asked(c) ? h('span', {class: 'se-dot ask', 'aria-label': '直しを頼んだ', title: '直しを頼んだ'}) : null,
    c.ok ? h('span', {class: 'se-dot ok', 'aria-label': '確認した', title: '確認した'}, icon('check', 10)) : null);
  const voiceColor = c => (!plainText(c.text) ? 'transparent' : speakerIndex(c) >= 0 ? CAST_COLOR[speakerIndex(c)] : s.cast.length > 1 ? NARRATION_COLOR : CAST_COLOR[0]);
  const picture = (i, c) => (origin.has(c) ? frames[origin.get(c)] : null) ?? stageThumb(c.stage);
  function renderTimeline() {
    const sp = spans(), end = total() || 1, pct = t => `${(Math.max(0, t) / end * 100).toFixed(3)}%`, row = (name, cls, ...items) => [h('span', {class: 'se-tl-label'}, name), h('div', {class: 'se-tl-row ' + cls}, ...items)];
    const bar = (start, len, text, cls, style = '') => h('div', {class: 'se-tl-bar ' + cls, style: `left:${pct(start)};width:calc(${pct(len)} - 2px);${style}`, title: text}, text);
    const step = end > 40 ? 5 : 2, ticks = Array.from({length: Math.floor(end / step) + 1}, (_, k) => k * step).filter(t => t < end);
    // 効果音: 書き出しの時間表があればその時刻(砂利の足音は目盛り)、無ければカットの音の欄
    const sfx = timed() ? times.sfx : s.cuts.flatMap((c, i) => (c.sound ? [{t: sp[i].start + (c.soundAt ?? 0.3), name: c.sound}] : []));
    const hush = timed() ? times.hush : s.cuts.flatMap((c, i) => (c.hush ? [[sp[i].start, sp[i].end]] : []));
    const bgm = s.audioId || s.defaultBgm, gaps = [[0, 0], ...hush, [end, end]], bgmBars = [];
    for (let k = 1; k < gaps.length; k++) if (gaps[k][0] > gaps[k - 1][1]) bgmBars.push(bar(gaps[k - 1][1], gaps[k][0] - gaps[k - 1][1], '', 'bgm'));
    screenTag.textContent = s.cuts.length ? `カット ${picked + 1}` : '';
    tlGrid.replaceChildren(
      h('span', {}), h('div', {class: 'se-tl-row ticks'}, ticks.map(t => h('span', {class: 'se-tick mono', style: `left:${pct(t)}`}, `${t}s`))),
      ...row('カット', 'cuts', s.cuts.map((c, i) => h('button', {type: 'button', class: 'se-tl-cut' + (i === picked ? ' on' : ''), style: `left:${pct(sp[i].start)};width:calc(${pct(sp[i].end - sp[i].start)} - 3px)`, 'aria-label': `カット ${i + 1} を選ぶ`, 'aria-pressed': String(i === picked), onclick: () => pickCut(i)},
        picture(i, c) ? h('img', {src: picture(i, c), alt: ''}) : null, h('span', {class: 'se-no mono'}, String(i + 1)), badges(c), h('span', {class: 'se-cam'}, graphicLook() ? dancing?.sceneLabel(c.scene) : cameraLabel(c.camera))))),
      ...(dance ? [] : row('セリフ', 'voices', s.cuts.flatMap((c, i) => {
        const line = plainText(c.text);
        if (!line) return [];
        const v = timed() ? times.cuts[i].voice : null, start = v ? v.start : sp[i].start + 0.1, len = v ? v.seconds : Math.max(0.2, sp[i].end - sp[i].start - 0.3);
        return [bar(start, len, `${c.who ? c.who + ' ' : ''}${line}`, 'voice', `background:${voiceColor(c)}`)];
      }))),
      ...row('テロップ', 'telops', s.cuts.flatMap((c, i) => (c.telop?.trim() ? [bar(sp[i].start, sp[i].end - sp[i].start, c.telop.replace(/\n/g, ' / '), 'telop')] : []))),
      ...row('図', 'figures', s.cuts.flatMap((c, i) => (c.figure || c.figureNote ? [bar(sp[i].start, sp[i].end - sp[i].start, c.figureNote || '図', c.figure ? 'figure' : 'figure todo')] : []))),
      ...row('効果音', 'sfx', sfx.map(q => (q.name === 'gravel' ? h('span', {class: 'se-step-tick', style: `left:${pct(q.t)}`}) : h('span', {class: 'se-sfx ' + sfxTone(q.name), style: `left:${pct(q.t)}`}, h('span', {class: 'se-sfx-dot'}), SFX_LABEL[q.name] ?? q.name)))),
      ...row(dance ? '曲' : 'BGM', 'bgm', bgm ? bgmBars : [h('span', {class: 'muted'}, 'なし')]),
      playhead);
    strip.replaceChildren(...s.cuts.map((c, i) => h('button', {type: 'button', role: 'listitem', class: 'se-strip-cut' + (i === picked ? ' on' : ''), style: `width:${Math.round(18 + (sp[i].end - sp[i].start) * 14)}px`, 'aria-label': `カット ${i + 1} を選ぶ`, 'aria-pressed': String(i === picked), onclick: () => pickCut(i)},
      picture(i, c) ? h('img', {src: picture(i, c), alt: ''}) : null, h('span', {class: 'se-no mono'}, String(i + 1)), badges(c), h('span', {class: 'se-voice', style: `background:${voiceColor(c)}`}))));
    showClock();
  }

  // ---- 上の欄: 題、型、動画の種類、長さ、確認と直しの進み具合、書き出し ----
  const title = h('input', {class: 'se-title', value: s.title, maxlength: '80', 'aria-label': 'ショートの題'});
  title.oninput = () => { s.title = title.value; touch(); };
  const styleChip = h('span', {class: 'chip'}), secChip = h('span', {class: 'mono muted'}), progText = h('span', {class: 'se-prog-text'}), progBar = h('span', {class: 'se-prog-fill'});
  function renderProgress() {
    const n = s.cuts.length, ok = s.cuts.filter(c => c.ok).length, asks = s.cuts.filter(asked).length + (asked(s) ? 1 : 0);
    progText.replaceChildren('確認 ', h('strong', {class: 'mono'}, `${ok} / ${n}`), ` · 直し ${asks}`);
    progBar.style.width = `${n ? ok / n * 100 : 0}%`;
    styleChip.textContent = STYLE_LABEL[s.style ?? 'trivia'];
    secChip.textContent = `${exact() ? '' : '約 '}${total().toFixed(1)} 秒`;
  }
  const kindChip = h('span', {class: 'chip se-kind'}, KIND_LABEL[kind]);
  const finalBtn = h('button', {type: 'button', class: 'primary', onclick: e => start('final')(e)}, '本番', h('span', {class: 'se-wide'}, 'で書き出す'));
  const previewBtn = h('button', {type: 'button', class: 'outline', onclick: e => start('preview')(e)}, '試し', h('span', {class: 'se-wide'}, 'で書き出す'));
  const finalNote = h('p', {class: 'muted'});
  const top = h('header', {class: 'se-top'},
    h('a', {class: 'se-back', href: '#shorts', 'aria-label': 'ショートの一覧へ戻る'}, icon('back'), h('span', {class: 'se-wide'}, 'ショート')),
    h('div', {class: 'se-title-box'}, title, h('div', {class: 'se-title-sub'}, h('div', {class: 'se-progress se-phone'}), status)),
    h('div', {class: 'se-chips'}, styleChip, dance ? null : kindChip, secChip),
    h('div', {class: 'se-top-end'}, h('div', {class: 'se-progress se-pc'}, progText, h('span', {class: 'se-prog-bar', 'aria-hidden': 'true'}, progBar)), previewBtn, finalBtn));
  // スマホの上の欄の進み具合は PC の写し
  const phoneProg = top.querySelector('.se-progress.se-phone');
  const renderLive = () => {
    renderProgress();
    phoneProg.replaceChildren(h('span', {class: 'se-prog-bar', 'aria-hidden': 'true'}, progBar.cloneNode()), progText.cloneNode(true));
    renderTimeline(); renderSounds(); renderSummary(); dancing?.render(picked);
  };
  function renderPicked() { renderRight(); renderTimeline(); scrollStrip(); dancing?.render(picked); }
  // スマホのカットの列を、選んだカットが見える所まで横に送る(ページは縦に動かさない)
  function scrollStrip() {
    const on = strip.querySelector('.on');
    if (!on) return;
    if (on.offsetLeft < strip.scrollLeft) strip.scrollLeft = on.offsetLeft - 12;
    else if (on.offsetLeft + on.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = on.offsetLeft + on.offsetWidth - strip.clientWidth + 12;
  }
  function renderAll() { renderRight(); renderLive(); renderScenes(); }

  // ---- 書き出し: ジョブ、本番の門 ----
  const madeBox = h('div', {class: 'vid-grid small'}), pendingBox = h('div', {class: 'pending-list'}), summary = h('p', {class: 'muted'});
  function renderSummary() {
    const t = total();
    if (graphicLook()) {   // グラフィック: 時間は描き方(全身、膝上、顔の寄り)ごとの秒の割合で決まる
      const sh = graphicShares(s.cuts, shortOptions.graphic ?? []);
      summary.textContent = `${s.cuts.length} カット、${t.toFixed(1)} 秒。試し ${minutes(graphicEstimateSec('preview', t, sh))}、本番 ${minutes(graphicEstimateSec('final', t, sh))}。文字と色だけの直しは重ねるからやり直す。`;
      return;
    }
    if (dance) {   // 全カットを 1 回の描画で作るので、時間はシーンの数で決まる
      const scenes = new Set(s.cuts.map(c => c.stage)).size || 1;
      summary.textContent = `${s.cuts.length} カット、${t.toFixed(1)} 秒。試し ${minutes(mvEstimateSec('preview', t, scenes))}、本番 ${minutes(mvEstimateSec('final', t, scenes))}。カットを 1 つ直しても全カットを描き直す。`;
      return;
    }
    summary.textContent = `${s.cuts.length} カット、約 ${t.toFixed(0)} 秒。試し ${minutes(mvEstimateSec('preview', t, s.cuts.length))}、本番 ${minutes(mvEstimateSec('final', t, s.cuts.length))}。直したカットだけ描き直す。`;
  }
  async function renderMade() {
    const list = (await getJSON('/api/shoots')).filter(x => x.short?.id === id);
    if (!alive()) return;
    dropVideos(madeBox);
    const hits = list.find(x => x.short?.faceHits)?.short.faceHits ?? [];
    if (JSON.stringify(hits) !== JSON.stringify(faceHits)) { faceHits = hits; if (graphicLook()) renderRight(); }
    madeBox.replaceChildren(...(list.length ? list.map(x => videoCard(x, {reload: renderMade, queued, finals: finalsOf(list)})) : [h('p', {class: 'muted'}, '書き出した動画がここに並ぶ。')]));
    await useLatest(list[0] ?? null);   // 一覧は新しい順
  }
  // 最新の書き出しを中央に出す。時間表はその画質のもので、カットの数と長さが合うときだけ使う
  async function useLatest(rec) {
    if (rec?.id === latest?.id) return;
    latest = rec; frames = []; origin = new WeakMap(s.cuts.map((c, i) => [c, i]));
    if (!rec) { video = null; times = null; playBtn.disabled = true; showViewer(); renderAll(); return; }
    const t = await getJSON(`/api/shorts/${enc(id)}/times/${enc(rec.quality)}`).catch(() => null);
    times = t && Math.abs(t.seconds - rec.seconds) < 0.1 ? t : null;
    showVideo(rec); renderAll(); seek();
    const mine = rec.id;
    grabFrames(rec.url, (times?.cuts ?? spans()).slice(0, s.cuts.length), (i, url) => { if (latest?.id !== mine) return; frames[i] = url; renderTimeline(); }, () => alive() && latest?.id === mine);
  }
  const watcher = watchJobs({filter: j => j.type === 'short' && j.input?.shortId === id, alive, onJobs: jobs => pendingBox.replaceChildren(...jobs.map(pendingRow)), onDone: async () => { await renderMade(); jobsChanged(); }});
  const queued = job => { watcher.queued(job); jobsChanged(); };
  const claimBox = s.claims ? claimsPanel(s, touch) : null;
  const gateFinal = () => { claimBox?.render(); const n = pendingClaims(s).length, changed = scriptChanged(s); finalBtn.disabled = n > 0 || changed; finalNote.textContent = n || changed ? `要確認が残っている（${changed ? '台本が変わった' : `主張 ${n} 件`}）。確かめると本番を書き出せる。試しは書き出せる。` : ''; };
  const start = quality => async e => {
    const b = e.currentTarget;
    b.disabled = true; msg.className = 'muted'; msg.textContent = '送っている…';
    try { await save(); queued(await send('POST', '/api/jobs', {type: 'short', shortId: id, quality})); msg.textContent = '積んだ。進み具合はこの下に出る。'; }
    catch (err) { msg.className = 'err'; msg.textContent = '積めない: ' + err.message; }
    b.disabled = false; gateFinal();
  };

  // 図を作るジョブ。cut を渡すとそのカットを作り直す。カットの図はジョブがショートへ入れるので、動いている間に読み直して画面へ写す
  const figureViews = new WeakMap(), figurePending = h('div', {class: 'pending-list'}), figureMsg = h('span', {class: 'muted'});
  const makeFigures = cut => async e => {
    const b = e.currentTarget;
    e.stopPropagation(); b.disabled = true; figureMsg.className = 'muted'; figureMsg.textContent = '送っている…';
    try { await save(); figureWatcher.queued(await send('POST', '/api/jobs', {type: 'short-figures', shortId: id, ...(cut == null ? {} : {cut})})); jobsChanged(); figureMsg.textContent = '積んだ。1 枚に数分かかる。'; }
    catch (err) { figureMsg.className = 'err'; figureMsg.textContent = '積めない: ' + err.message; }
    b.disabled = false; gateFigures();
  };
  const figureBtn = h('button', {type: 'button', onclick: makeFigures()}, '図を作る');
  const gateFigures = () => { const n = s.cuts.filter(c => c.figureNote && !c.figure).length; figureBtn.disabled = !n; figureBtn.textContent = n ? `図を作る（${n} 枚）` : '図を作る'; };
  async function syncFigures() {
    for (const c of keepMadeFigures(await getJSON('/api/shorts/' + enc(id)), s)) figureViews.get(c)?.();
    gateFigures(); renderTimeline();
  }
  const figureWatcher = watchJobs({filter: j => j.type === 'short-figures' && j.input?.shortId === id, alive,
    onJobs: jobs => { figurePending.replaceChildren(...jobs.map(pendingRow)); if (jobs.some(jobActive)) syncFigures().catch(console.error); },
    onDone: async () => { await syncFigures(); const [last] = (await getJSON('/api/jobs')).filter(j => j.type === 'short-figures' && j.input?.shortId === id); figureMsg.className = 'muted'; figureMsg.textContent = last?.result ? figuresReport(last.result) : ''; jobsChanged(); }});

  // ---- 左: 出演者、シーン、音、全体への頼みごと、型、確認の欄、書き出した動画 ----
  const series = h('input', {maxlength: '20', value: s.series ?? '', placeholder: '例: サクッと雑学', 'aria-label': 'シリーズ帯'});
  series.oninput = () => { s.series = series.value; touch(); };
  // 出演者の欄: キャラ、版、声の提供元、声。名前を変えると、カットの話す人も合わせる
  const castBox = h('div', {class: 'form-stack'}), castList = h('div', {class: 'se-list'});
  const setVoice = (m, value) => {
    if (m.provider === 'elevenlabs') { m.voiceId = value; m.voiceName = shortOptions.elevenVoices.find(v => v.id === value)?.name ?? ''; delete m.speaker; delete m.speakerName; delete m.speed; }
    else { m.speaker = Number(value); m.speakerName = shortOptions.speakers.find(v => v.id === m.speaker)?.speaker ?? ''; m.speed ??= 1.25; delete m.voiceId; delete m.voiceName; }
  };
  const syncFirst = () => { const m = s.cast[0]; s.charId = m.charId; s.verId = m.verId; };
  async function memberCard(m, i) {
    const versions = (await getJSON('/api/characters/' + enc(m.charId))).versions, name = h('input', {maxlength: '12', value: m.name ?? '', 'aria-label': `出演者 ${i + 1} の名前`, placeholder: '名前（2 人以上は必須）'});
    // 確定したときだけ変える。入力の途中の空や重なりでカットの話す人を失わない
    name.onchange = () => {
      const next = name.value.trim(), old = m.name;
      if ((s.cast.length > 1 && !next) || s.cast.some(x => x !== m && x.name === next)) { name.value = old; return; }
      m.name = next;
      for (const c of s.cuts) if (old && c.who === old) c.who = next;
      touch(); renderCastList(); renderAll();
    };
    const reCast = () => { syncFirst(); touch(); renderCast(); renderAll(); };
    const speedBox = h('input', {type: 'number', min: '0.8', max: '1.8', step: '0.05', value: String(m.speed ?? 1.25), 'aria-label': `出演者 ${i + 1} の話す速さ`});
    speedBox.oninput = () => { m.speed = Math.min(1.8, Math.max(0.8, Number(speedBox.value) || 1.25)); touch(); };
    const choices = voiceOptions(m), current = m.provider === 'elevenlabs' ? m.voiceId : m.speaker;
    if (dance) return h('div', {class: 'cut form-stack'},   // ダンス MV は 1 人で声が無い。キャラと版だけ
      select('キャラ', chars.map(x => [x.id, x.name]), () => m.charId, v => { m.charId = v; m.verId = chars.find(x => x.id === v).latest.id; reCast(); }),
      select('版', versions.map(v => [v.id, v.label ?? v.id]), () => m.verId, v => { m.verId = v; reCast(); }));
    return h('div', {class: 'cut form-stack'},
      h('label', {}, '名前', name),
      select('キャラ', chars.map(x => [x.id, x.name]), () => m.charId, v => { m.charId = v; m.verId = chars.find(x => x.id === v).latest.id; reCast(); }),
      select('版', versions.map(v => [v.id, v.label ?? v.id]), () => m.verId, v => { m.verId = v; reCast(); }),
      select('声の提供元', [['voicevox', 'VOICEVOX'], ...(shortOptions.elevenVoices.length ? [['elevenlabs', 'ElevenLabs']] : [])], () => m.provider ?? 'voicevox', v => { m.provider = v; setVoice(m, String(voiceOptions(m)[0]?.[0] ?? '')); reCast(); }),
      select('声', choices.length ? choices : [[current ?? '', m.speakerName || String(current ?? '')]], () => current ?? '', v => { setVoice(m, v); touch(); renderCastList(); }),
      m.provider === 'elevenlabs' ? null : h('label', {}, '話す速さ', speedBox),
      s.cast.length > 1 ? h('button', {type: 'button', class: 'quiet', onclick: () => {
        s.cast.splice(i, 1);
        for (const c of s.cuts) {
          c.actors?.splice(i, 1);
          if (c.who === m.name) c.who = '';
          const first = c.actors?.[0];
          if (first) { c.motionId = first.motionId ?? c.motionId; c.expression = first.expression ?? c.expression; }
          if (s.cast.length === 1) delete c.actors;   // 1 人の画面はカットの動きと表情を編集する
        }
        syncFirst(); touch(); renderCast(); renderAll();
      }}, 'この人を外す') : null);
  }
  const item = (dot, name, note, pic) => h('div', {class: 'se-item'}, pic ?? (dot ? h('span', {class: 'se-cast-dot', style: `background:${dot}`, 'aria-hidden': 'true'}) : null), h('div', {class: 'se-item-text'}, h('strong', {}, name), note ? h('span', {class: 'muted'}, note) : null));
  const charName = m => chars.find(x => x.id === m.charId)?.name ?? m.charId;
  const renderCastList = () => castList.replaceChildren(...s.cast.map((m, k) => (dance ? item(CAST_COLOR[k], charName(m), `${m.verId ?? ''} · 声なし`)
    : item(CAST_COLOR[k], m.name || '出演者', `${charName(m)} · 声 ${m.provider === 'elevenlabs' ? m.voiceName || 'ElevenLabs' : m.speakerName || `VOICEVOX ${m.speaker}`}`))));
  async function renderCast() {
    renderCastList();
    const cards = await Promise.all(s.cast.map(memberCard));
    if (dance) { castBox.replaceChildren(...cards); return; }
    const allEleven = s.cast.length > 1 && s.cast.every(m => m.provider === 'elevenlabs'), dialogue = h('input', {type: 'checkbox', 'aria-label': '全カットを 1 回の会話で読ませる'});
    dialogue.checked = !!s.dialogue; dialogue.onchange = () => { if (dialogue.checked) s.dialogue = true; else delete s.dialogue; touch(); };
    castBox.replaceChildren(...[...cards, allEleven ? h('label', {class: 'check'}, dialogue, '全カットを 1 回の会話で読ませる(ElevenLabs v4。声と課金が 1 文ずつの声と別になる。書き出して試しを聞くまで「声を聞く」は使えない)') : null, s.cast.length < 3 ? h('button', {type: 'button', onclick: () => {
      const c = chars.find(x => !s.cast.some(m => m.charId === x.id)) ?? chars[0];
      let n = s.cast.length + 1;
      while (s.cast.some(m => m.name === `出演者${n}`)) n++;
      s.cast.push({name: `出演者${n}`, charId: c.id, verId: c.latest.id, provider: 'voicevox', speaker: 8, speakerName: '', speed: 1.25});
      for (const cut of s.cuts) if (cut.actors) cut.actors.push({motionId: cut.motionId, expression: cut.expression});
      touch(); renderCast(); renderAll();
    }}, '出演者を足す') : null].filter(Boolean));
  }
  const sceneList = h('div', {class: 'se-list'});
  function renderScenes() {
    const stages = [...new Set(s.cuts.map(c => c.stage))], take = s.take;
    sceneList.replaceChildren(...stages.map(st => item(null, label(st), take ? ['歩きながら話す 1 テイク', take.stop ? `立ち止まる ${take.stop.toFixed(1)} 秒` : ''].filter(Boolean).join(' · ') : `${s.cuts.filter(c => c.stage === st).length} カット`, thumb(stageThumb(st), '', 'se-scene-pic'))));
  }
  const soundList = h('div', {class: 'se-list'});
  const soundRow = (name, value) => h('div', {class: 'se-item se-sound'}, h('span', {}, name), h('span', {class: 'muted'}, value));
  function renderSounds() {
    if (dance) { soundList.replaceChildren(soundRow('曲', s.audioId ? s.audioName : 'なし（テンポから割る。音の無い動画になる）')); return; }
    soundList.replaceChildren(soundRow('BGM', s.audioId ? s.audioName : s.defaultBgm ? `${STYLE_LABEL[s.style ?? 'trivia']}の既定` : 'なし'), soundRow('環境音', SOUND_LABEL[s.ambience] ?? 'なし'), ...(s.take?.footsteps ? [soundRow('足音', '砂利 · 自動')] : []));
  }
  const ambience = select('環境音（全体に薄く敷く）', [['', 'なし'], ...AMBIENCES.map(k => [k, SOUND_LABEL[k]])], () => s.ambience ?? '', v => { s.ambience = v; touch(); });
  const bgm = h('input', {type: 'file', accept: '.mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4', 'aria-label': 'BGM'}), bgmNote = h('input', {maxlength: '200', value: s.audioSummary ?? '', placeholder: '例: 〇〇のフリー音源', 'aria-label': 'BGM の利用条件'});
  const bgmPublic = h('input', {type: 'checkbox', 'aria-label': 'この音声は動画と一緒に公開してよい'}), bgmWord = dance ? '曲' : ' BGM', bgmName = h('p', {class: 'muted'}, s.audioName ? `今の${bgmWord}: ${s.audioName}` : dance ? '曲なし' : 'BGM なし');
  bgmPublic.checked = !!s.audioPublic;
  const autoBgm = h('input', {type: 'checkbox', 'aria-label': '型の既定の BGM を使う'});
  autoBgm.checked = !!s.defaultBgm; autoBgm.onchange = () => { s.defaultBgm = autoBgm.checked; touch(); };
  bgm.onchange = async () => {
    const f = bgm.files[0];
    if (!f) return;
    if (f.size > MAX_AUDIO_BYTES) { msg.className = 'err'; msg.textContent = '音声ファイルが大きすぎる'; return; }
    try { const a = await uploadAudio(f); s.audioId = a.id; s.audioName = a.name; bgmName.textContent = `今の${bgmWord}: ${a.name}`; touch(); }
    catch (e) { msg.className = 'err'; msg.textContent = '送れない: ' + e.message; }
  };
  bgmNote.oninput = () => { s.audioSummary = bgmNote.value; touch(); };
  bgmPublic.onchange = () => { s.audioPublic = bgmPublic.checked; touch(); };
  const sec = (name, ...kids) => h('section', {class: 'se-sec'}, h('h2', {}, name), ...kids);
  const more = (name, open, ...kids) => h('details', {class: 'se-more', open}, h('summary', {}, name), h('div', {class: 'form-stack'}, ...kids));

  const audioFields = [bgmName, h('label', {}, dance ? '曲の音声ファイル（mp3、wav、m4a）' : '音声ファイル', bgm), h('label', {}, '利用条件（任意）', bgmNote), h('label', {class: 'check'}, bgmPublic, 'この音声は動画と一緒に公開してよい')];
  // 拍から割ったショートで画面を置き換える。s は同じ物のまま中身を替える(頼みごとの欄などが s を持っている)
  const replaceShort = short => {
    clearTimeout(timer); timer = null;
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, short, {cast: castOf(short)});
    picked = 0; origin = new WeakMap(); faceHits = [];   // 割り直したら、前のカットの番号の顔の文字を捨てる
    renderAll(); seek(); preview();
    save().catch(() => {});   // 割っている間に送った保存が古いカットで上書きしていても、今のカットに戻す
  };
  if (dance) dancing = dancePanel({s, id, options: shortOptions, motions, audio: audioFields, save, touch, onSplit: replaceShort, onPick: i => pickCut(i), onMotion: () => preview()});
  // ダンス MV の型は変えられない(出演者 1 人、拍で割った秒が要る)。ほかの型からもダンス MV には変えない
  const styleField = dance ? h('p', {class: 'muted'}, '型: ダンス MV（変えられない。ほかの型は「ショートを作る」から）')
    : select('型', DRAFT_STYLES.map(k => [k, STYLE_LABEL[k]]), () => s.style ?? 'trivia', v => { s.style = v; touch(); renderAll(); });

  // 歩く 1 テイクだけ: 枝に止まる生き物を選ぶ。選ぶと動画の種類が変わり、カメラと右の欄の「生き物の動き」が変わる
  const creatureBox = s.take && !dance ? creaturePanel(s.take, overview.chars, () => { kind = shortKind(s); kindChip.textContent = KIND_LABEL[kind]; touch(); renderRight(); renderTimeline(); }) : null;
  const left = h('aside', {class: 'se-left', 'aria-label': '素材'},
    dancing?.box,
    sec('出演者', castList, more('出演者を直す', false, castBox)),
    sec('シーン', sceneList),
    creatureBox ? sec('生き物', creatureBox) : null,
    sec(dance ? '曲' : '音', soundList, dance ? null : more('音を直す', false, ambience, h('label', {class: 'check'}, autoBgm, '音声ファイルが無いときは型の既定の BGM を使う'), ...audioFields)),
    sec('全体への頼みごと', ...askBox(s, '全体への頼みごと', '例: 全体にテンポを上げて。最後のオチをもう少し長く')),
    sec('型とシリーズ帯', h('div', {class: 'form-stack'}, styleField, h('label', {}, 'シリーズ帯（画面の上の小さな帯）', series))),
    MAKER_LABEL[s.draftBy] ? h('p', {class: 'muted'}, `下書きの作り手: ${MAKER_LABEL[s.draftBy]}${s.draft?.checkedBy ? `。主張の確かめ: ${s.draft.checkedBy}` : ''}`) : null,
    s.draft?.warnings?.length ? h('details', {class: 'cut'}, h('summary', {}, `下書きの注意 ${s.draft.warnings.length} 件`), h('ul', {}, s.draft.warnings.map(w => h('li', {}, w)))) : null,
    claimBox?.box,
    s.style === 'drama' || s.serial ? serialPanel(s, touch, {save, alive}) : null,
    sec('図', h('div', {class: 'actions'}, figureBtn, figureMsg), figurePending),
    sec('書き出し', summary, more('書き出した動画', false, madeBox)));

  const center = h('section', {class: 'se-center', 'aria-label': 'プレビュー'},
    h('div', {class: 'se-stage-row'}, stepBtn('left', -1, 'se-phone round'), screen, stepBtn('right', 1, 'se-phone round')),
    h('div', {class: 'se-controls'}, stepBtn('prev', -1, 'se-pc'), playBtn, stepBtn('next', 1, 'se-pc'), clock, overlay),
    playerBox);
  const timeline = h('section', {class: 'se-timeline', 'aria-label': 'タイムライン'},
    h('div', {class: 'se-tl-head'}, h('h2', {}, 'タイムライン'),
      h('span', {class: 'se-legend'}, h('span', {class: 'se-dot ok', 'aria-hidden': 'true'}), '確認した'), h('span', {class: 'se-legend'}, h('span', {class: 'se-dot ask', 'aria-hidden': 'true'}), '直しを頼んだ'),
      h('span', {class: 'muted se-tl-hint'}, dance ? 'カットは「拍から割る」で作る。押すと右の欄で確かめて直せる' : 'カットを押すと右の欄で確かめて直せる'), dance ? null : cutOps),
    h('div', {class: 'se-tl-scroll'}, tlGrid));

  main.replaceChildren(h('div', {class: 'short-edit'}, top,
    h('div', {class: 'se-note'}, finalNote, msg, pendingBox),
    left, center, h('div', {class: 'se-strip-box'}, strip), right, timeline,
    h('div', {class: 'se-okbar'}, okBig)));
  gateFinal(); gateFigures(); renderSummary(); renderAll(); showViewer();
  await renderCast();
  await renderMade();
  await Promise.all([watcher.poll(), figureWatcher.poll()]);
}
