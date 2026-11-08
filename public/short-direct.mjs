// ショートの文の印と自動演出。入力が同じなら答えも同じ純粋な関数で、Math.random は使わない。
//   書き出し(lib/short-timeline.mjs)と編集画面で使う。描画の道具には依らない
export const SHORT_STYLES = ['trivia', 'drama', 'pop', 'news', 'dance'];
export const STYLE_LABEL = {trivia: '雑学', drama: 'ドラマ', pop: '派手', news: 'ニュース', dance: 'ダンス MV'};
export const DRAFT_STYLES = SHORT_STYLES.filter(k => k !== 'dance');   // 下書き(short-draft)が作れる型。ダンス MV は曲と拍でカットを割るので台本の下書きは無い
export const TRANSITIONS = ['none', 'whip', 'zoom', 'flash', 'slide', 'glitch', 'dissolve', 'fade'];
export const EFFECTS = ['none', 'punch', 'shake', 'speedlines', 'particles', 'flash', 'sparkle', 'question', 'exclaim', 'slam', 'insert'];
export const TELOP_TYPES = ['pop', 'number', 'hook', 'follow', 'band', 'cinema', 'title'];
export const SHORT_FACES = ['worried', 'afraid', 'shocked', 'tense', 'cold'];   // 感情の表情に無い顔(stage-studio の bake_motion.mjs が Fcl_ の形を重ねる)。口は開かない
export const SOUNDS = ['footsteps', 'paper', 'wind', 'chime', 'heartbeat', 'door', 'crows', 'caw', 'snap', 'hit', 'ring'];   // ドラマの環境音と効果音(lib/short-compose.mjs の SFX)
export const AMBIENCES = ['wind', 'crows', 'footsteps'];   // 全体に薄く敷く音
export const FIGURE_STYLES = ['sticker'];   // sticker: ジョブ short-figures が作った透過の図。無ければ手動の図で、丸いカードで出す

const TRANSITION_FRAMES = {none: 0, whip: 6, zoom: 6, flash: 4, slide: 6, glitch: 5, dissolve: 15, fade: 34};
const TRANSITION_SFX = {whip: 'whoosh', zoom: 'whoosh', slide: 'whoosh', glitch: 'glitch', flash: 'impact'};
const MAX_EFFECTS = 2, SLAM_CHARS = 6, SLAM_AT = 0.3;
export const CUT_EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const SURPRISE = /なんと|まさか|えっ|驚|びっくり|しかも/g;

// reactive: 文に応じて転換と飾りを変えるか。sfxGain: 効果音の音量の倍率
const STYLE = {
  trivia: {transitions: ['whip', 'slide', 'zoom'], telop: 'pop', caption: 'karaoke', letterbox: false, kenburns: 0.06, reactive: true, sfxGain: 1, hook: '衝撃の雑学', bgm: 'trivia'},
  drama: {transitions: ['dissolve'], calm: true, telop: 'cinema', caption: 'quiet', letterbox: true, kenburns: 0.03, reactive: false, sfxGain: 0.4, hook: '', bgm: 'drama'},
  pop: {transitions: ['zoom', 'glitch', 'whip', 'flash'], telop: 'pop', caption: 'karaoke', letterbox: false, kenburns: 0.08, reactive: true, sfxGain: 1, hook: '知らないと損', bgm: 'trivia'},
  news: {transitions: ['slide'], telop: 'band', caption: 'band', letterbox: false, kenburns: 0.03, reactive: false, sfxGain: 0.7, hook: '今日の話題', bgm: 'trivia'},
  // ダンス MV: 拍で切るので転換は付けず、声も既定の BGM も効果音も無い。曲は short.audioId の音声
  dance: {transitions: ['none'], calm: true, hardCut: true, telop: 'cinema', caption: 'none', letterbox: false, kenburns: 0, reactive: false, sfxGain: 0, hook: '', bgm: null},
};

// 出演者。cast の無い古いショートは 1 人の出演者として読む
export const castOf = s => (s.cast?.length ? s.cast : [{name: '', charId: s.charId, verId: s.verId, provider: 'voicevox', speaker: s.speaker, speakerName: s.speakerName, speed: s.speed}]);

// 台本のキー: 全カットの文とテロップ。主張を確かめた時点の台本と今の台本を比べる。強調の印の直しでは変わらない
export const scriptKey = cuts => textSeed(JSON.stringify(cuts.map(c => [plainText(c.text), c.telop ?? ''])));
export const scriptChanged = s => s.scriptKey != null && s.scriptKey !== scriptKey(s.cuts);
// 本番の書き出しを止める主張: 出典が無く人が確認していないもの。確かめたあとに台本を直したときは全部
export const pendingClaims = s => (scriptChanged(s) ? s.claims ?? [] : (s.claims ?? []).filter(c => !c.sources?.length && !c.confirmed));

// i 番目のカットが条件に合えばそれ、合わなければ条件に合う最初のカット。カットは並べ替えられるので番号だけで探さない
export const cutFor = (cuts, i, ok) => (ok(cuts[i]) ? cuts[i] : cuts.find(ok));

// ジョブが作った図を古いカット表へ写す。figuresRev はジョブが図を入れるたびに増える数で、これが低いカット表は最新の図を知らない。
//   図の説明が同じカットへ写し、人が入れた図は変えない。説明を消した図は写さず、最新の表に無い作った図は外す(ファイルは消えている)。
//   stale を直して、変わったカットを返す
export function keepMadeFigures(stored, stale) {
  const rev = stored.figuresRev ?? 0, known = stale.figuresRev ?? 0, changed = [], taken = new Set(), note = c => String(c?.figureNote ?? '').trim();
  if (!rev) return changed;
  stale.figuresRev = rev;
  if (known >= rev) return changed;
  stored.cuts.forEach((c, i) => {
    if (c.figureStyle !== 'sticker' || !note(c)) return;
    const to = cutFor(stale.cuts, i, x => x && note(x) === note(c) && (!x.figure || x.figureStyle === 'sticker') && !taken.has(x));
    if (!to) return;
    taken.add(to);
    if (to.figure !== c.figure) changed.push(to);
    to.figure = c.figure; to.figureStyle = 'sticker';
  });
  const made = new Set(stored.cuts.map(c => c.figure));
  for (const c of stale.cuts) if (c.figureStyle === 'sticker' && !made.has(c.figure)) { c.figure = ''; delete c.figureStyle; changed.push(c); }
  return changed;
}

// カットの長さの目安(秒)。声を作る前に編集画面と下書きの確かめで使う。実際の長さは声で決まる
//   2026-11-02 の実測: VOICEVOX は速さ 1.25 で 1 字 0.12 秒、カットごとに 0.22 秒足される。ElevenLabs は 1 字 0.21 秒
export const MORA_SEC = 0.15, BREATH_SEC = 0.25;
const ELEVEN_SPEED = 0.7;
export const memberSpeed = m => m.speed ?? (m.provider === 'elevenlabs' ? ELEVEN_SPEED : 1);
const SILENT_SEC = 2.5;
export const cutEstimate = (c, speed = 1) => { const line = plainText(c.text); return line ? Math.max(c.seconds || 0, [...line].length * MORA_SEC / speed + BREATH_SEC) : c.seconds || SILENT_SEC; };

// `[語]` を強調の印として読む。`[語|surprised]` はその語の時刻に表情も変える。plain は声と字幕に渡す括弧なしの文、marks は plain の文字の位置 [from, to)。
//   閉じていない括弧と単独の括弧は声に渡さないので捨てる
export function parseMarks(text) {
  const out = [], marks = [];
  let open = -1, tag = null;
  for (const c of text ?? '') {
    if (c === '[') { if (open < 0) { open = out.length; tag = null; } }
    else if (c === ']') {
      if (open >= 0 && out.length > open) marks.push({from: open, to: out.length, ...(CUT_EMOTIONS.includes(tag) ? {expression: tag} : {})});
      open = -1; tag = null;
    } else if (open >= 0 && c === '|' && tag === null) tag = '';
    else if (tag !== null) tag += c;
    else out.push(c);
  }
  if (tag !== null) out.push('|', ...tag);   // 閉じていない印の | 以降は本文へ戻す
  return {plain: out.join('').trim(), marks};
}
export const plainText = text => parseMarks(text).plain;

// 文からの種。FNV-1a。描画側の揺らぎもこの値から作る
export function textSeed(s) {
  let h = 0x811c9dc5;
  for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const KANJI_NUMBER = /[一二三四五六七八九十百千万億]+(?=[つ個本人回倍年歳匹枚割%％])/;
const halfDigits = s => s.replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xff10)).replace(/，/g, ',');

// テロップの中の最初の数字。無ければ null
export function numberIn(s) {
  const digits = /[0-9][0-9,.]*/.exec(halfDigits(s));
  if (digits) return digits[0].replace(/[,.]+$/, '');
  return KANJI_NUMBER.exec(s)?.[0] ?? null;
}

const kindOf = (plain, i, count) => {
  if (i === 0) return 'hook';
  if (i === count - 1) return /フォロー/.test(plain) ? 'follow' : 'end';
  if (/[?？]/.test(plain)) return 'question';
  if (/[!！]/.test(plain)) return 'exclaim';
  return 'plain';
};

function autoTransition(kind, style, seed, previous, sceneChange) {
  if (style.hardCut) return 'none';   // ダンス MV: 拍の上で直に切る。シーンが変わっても黒を挟まない
  if (style.calm) return sceneChange ? 'fade' : 'none';   // ドラマ: 切り返しは直につなぐ。場所が変わるときは黒を挟む。ディゾルブは時間が経つカットに人が選ぶ
  if (style.reactive && kind === 'exclaim') return 'flash';
  if (style.reactive && kind === 'question') return 'zoom';
  const list = style.transitions.filter(t => t !== previous);
  return (list.length ? list : style.transitions)[seed % (list.length || style.transitions.length)];
}

function autoEffects({kind, questionMark, expression, hasMarks, number, punchline}, style, name) {
  if (!style.reactive) return [];
  const fx = [];
  if (punchline) fx.push('slam');
  if (expression === 'surprised') fx.push('shake');
  if (kind === 'hook') fx.push(questionMark ? 'question' : 'speedlines');
  else if (kind === 'follow') fx.push('sparkle');
  else if (kind === 'question') fx.push('question');
  else if (kind === 'exclaim') fx.push('exclaim');
  if (hasMarks || number) fx.push('punch');
  if (name === 'pop' && !fx.length) fx.push('particles');
  return fx.slice(0, MAX_EFFECTS);
}

function autoTelop(kind, hasNumber, style) {
  if (style.calm && (kind === 'hook' || kind === 'end')) return 'title';
  if (!style.reactive) return style.telop;
  if (kind === 'hook') return 'hook';
  if (kind === 'follow') return 'follow';
  return hasNumber ? 'number' : style.telop;
}

// カットごとの音。at: transition(カットの頭の転換) / telop(テロップの出現) / marks(強調語ごと) / icon(記号の出現) / cut(カットの頭) / slam(全画面の語)
function autoSfx({transition, telopText, telopType, hasMarks, effects, figure, sound, soundGain}, style) {
  const cues = [], add = (name, at, gain) => { if (style.sfxGain > 0) cues.push({name, at, gain: Number((gain * style.sfxGain).toFixed(3))}); };   // 音量 0 の型は鳴らさない(ffmpeg の volume に -inf dB を渡さない)
  if (TRANSITION_SFX[transition]) add(TRANSITION_SFX[transition], 'transition', 1);
  if (telopText) add(style.reactive ? {hook: 'impact', number: 'ding', follow: 'sparkle'}[telopType] ?? 'pop' : 'soft', 'telop', 1);
  if (hasMarks && style.reactive) add('ding', 'marks', 0.7);
  if (effects.includes('question') || effects.includes('exclaim') || effects.includes('insert')) add('pop', 'icon', 0.9);
  if (figure) add('pop', 'figure', 2);   // 図はセリフと同時に出るので、語りに埋もれないよう強める
  if (effects.includes('shake')) add('impact', 'cut', 0.8);
  if (effects.includes('slam')) add('impact', 'slam', 1);
  if (effects.includes('sparkle') && telopType !== 'follow') add('sparkle', 'cut', 0.8);
  if (sound) cues.push({name: sound, at: 'sound', gain: soundGain ?? 1});   // 人が選んだ音は型の倍率で弱めない
  return cues;
}

const FOLLOW_TELOP = 'フォローしてね';

// 語の時刻に変える表情: 印の指定と、型が文から見つける驚きの語。[{at: plain の文字の位置, expression}]
export function expressionMarks(text, styleName = 'trivia') {
  const {plain, marks} = parseMarks(text), at = n => [...plain.slice(0, n)].length;
  const out = marks.filter(m => m.expression).map(m => ({at: m.from, expression: m.expression}));
  if (STYLE[styleName].reactive) for (const m of plain.matchAll(SURPRISE)) if (!out.some(x => x.at === at(m.index))) out.push({at: at(m.index), expression: 'surprised'});
  return out.sort((a, b) => a.at - b.at);
}

// オチのカット: 最後から数えて最初に強調語か短いテロップのあるカット。全画面で見せる語を返す
function punchlineOf(list) {
  for (let i = list.length - 2; i > 0; i--) {
    const {plain, marks} = parseMarks(list[i].text), word = marks.map(m => [...plain].slice(m.from, m.to).join('')).find(w => [...w].length <= SLAM_CHARS) ?? ([...(list[i].telop ?? '')].length <= SLAM_CHARS ? list[i].telop : '');
    if (word) return {index: i, word};
  }
  return null;
}

// カット表から演出を決める。カットの transition、effect、telopType が空なら自動、値があれば上書きする
export function direct(cuts, styleName = 'trivia') {
  const style = STYLE[styleName], punchline = style.reactive ? punchlineOf(cuts) : null;
  let previous = null;
  const planned = cuts.map((c, i) => {
    const {plain, marks} = parseMarks(c.text), hasMarks = marks.length > 0, telop = halfDigits(c.telop ?? '');
    // seed はテロップの揺らぎ用。転換の種はセリフだけから作り、テロップの直しで base.mp4 を作り直さない
    const kind = kindOf(plain, i, cuts.length), seed = textSeed(`${i}|${plain}|${telop}`), transitionSeed = textSeed(`${i}|${plain}`), number = numberIn(telop);
    const transition = i === 0 ? 'none' : c.transition || autoTransition(kind, style, transitionSeed, previous, c.stage !== cuts[i - 1].stage);
    previous = transition;
    const isPunchline = punchline?.index === i;
    const effects = c.effect ? (c.effect === 'none' ? [] : [c.effect]) : autoEffects({kind, questionMark: /[?？]/.test(plain), expression: c.expression, hasMarks, number, punchline: isPunchline}, style, styleName);
    const telopText = telop || (kind === 'follow' && style.reactive ? FOLLOW_TELOP : kind === 'hook' ? style.hook : '');
    const telopType = c.telopType === 'number' && !number ? style.telop : c.telopType || autoTelop(kind, !!number, style);
    const sfx = autoSfx({transition, telopText, telopType, hasMarks, effects, figure: !!c.figure, sound: c.sound, soundGain: c.soundGain}, style);
    return {kind, seed, transitionSeed, transition, transitionFrames: TRANSITION_FRAMES[transition], kenburns: style.kenburns, pull: kind === 'follow' || kind === 'end', thought: /^[（(].*[）)]$/.test(plain), slamAt: effects.includes('slam') ? SLAM_AT : null, slamWord: effects.includes('slam') ? (isPunchline ? punchline.word : telop || plain.slice(0, SLAM_CHARS)) : '', effects, telopType, telopText, number, sfx};
  });
  return {style: styleName, caption: style.caption, together: !!style.calm, letterbox: style.letterbox, bgm: style.bgm, cuts: planned};
}
