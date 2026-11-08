// ショートの timeline: 描画の道具へ渡す 1 本の JSON(work/<quality>/t.json)。docs/voice-and-jobs.md の「timeline」。
//   声の句の時刻を、表示の文の 1 文字ごとの時刻へ写し(ElevenLabs は文字の時刻をそのまま使う)、カットの開始と演出と合わせる
import {SHORT_FACES, direct, expressionMarks, parseMarks, textSeed} from '../public/short-direct.mjs';

// 字幕: 1 行 10 字、2 行、1 画面 18 字まで。語りの 0.25 秒前に出し、句の間を 0.15 秒あけ、最短 0.5 秒
const LINE_CHARS = 10, MAX_LINES = 2, SCREEN_CHARS = 18, CAPTION_LEAD = 0.25, CAPTION_GAP = 0.15, CAPTION_MIN = 0.5;
const TELOP_DELAY = 0.08, ICON_DELAY = 0.3, SLAM_SEC = 0.95, FIGURE_DELAY = 0.2, EXPRESSION_HOLD = 1.6;
const WHO_COLORS = ['#ff4f9a', '#19c8ff', '#ffb01f', '#7be04a'], CAST_COLORS = ['#ffc4d8', '#bfe4ff', '#ffe6a8'];   // CAST_COLORS は出演者の順の字幕の色
const sec = t => Number(t.toFixed(3));

const toKatakana = c => (c >= 'ぁ' && c <= 'ゖ' ? String.fromCharCode(c.charCodeAt(0) + 0x60) : c);
const isKana = c => c >= 'ァ' && c <= 'ヺ';
const isSilent = c => /[\s、。，．,.!！?？…・「」『』（）()〜~-]/.test(c);
const isDigit = c => /[0-9０-９]/.test(c);

// 文字の重み(かなで何拍ぶんか)。かなの一致が無い区間の時間を割るのに使う
const weight = c => (isSilent(c) ? 0 : isKana(toKatakana(c)) || c === 'ー' ? 1 : isDigit(c) ? 2 : /[a-zA-Z]/.test(c) ? 1 : 2);

// 助詞は書きと読みが違う
const READS = {ハ: 'ワ', ヘ: 'エ', ヲ: 'オ'};
const sameKana = (shown, spoken) => shown === spoken || READS[shown] === spoken;

// かなの最長共通部分列: 表示の文字の添え字 -> 声の文字の添え字
function lcsAnchors(display, voice) {
  const n = display.length, m = voice.length, dp = Array.from({length: n + 1}, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = sameKana(display[i], voice[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const anchors = new Map();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (sameKana(display[i], voice[j])) anchors.set(i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return anchors;
}

// 間の無い 1 区間の、表示の文字ごとの時刻。かなは声のモーラに合わせ、漢字などは間を重みで割る
function alignRun(chars, phrases) {
  const voice = phrases.flatMap(p => p.moras.flatMap(m => {
    const list = [...m.text], d = (m.to - m.from) / list.length;
    return list.map((c, i) => ({c, from: m.from + d * i, to: m.from + d * (i + 1)}));
  }));
  const anchors = lcsAnchors(chars.map(toKatakana), voice.map(v => v.c));
  const out = chars.map((c, i) => (anchors.has(i) ? {c, from: voice[anchors.get(i)].from, to: voice[anchors.get(i)].to} : {c, from: null, to: null}));
  const first = voice[0]?.from ?? 0, last = voice.at(-1)?.to ?? 0;
  for (let i = 0; i < out.length;) {
    if (out[i].from != null) { i++; continue; }
    let j = i;
    while (j < out.length && out[j].from == null) j++;
    const a = i ? out[i - 1].to : first, b = j < out.length ? out[j].from : last, total = chars.slice(i, j).reduce((s, c) => s + weight(c), 0);
    let t = a;
    for (let k = i; k < j; k++) {
      const d = total ? (b - a) * weight(chars[k]) / total : 0;
      out[k].from = t; t += d; out[k].to = t;
    }
    i = j;
  }
  return out;
}

const isBreak = c => /[、。，．,.!！?？…]/.test(c);

// 表示の文を句読点の後ろで、声の句を間のあとで分ける。数が合えば区間ごとに対応させ、合わなければ文全体で対応させる
export function charTimes(plain, phrases) {
  const chars = [...plain], shown = [], spoken = [];
  chars.forEach((c, i) => {
    if (!shown.length || (isBreak(chars[i - 1]) && !isBreak(c))) shown.push([]);
    shown.at(-1).push(c);
  });
  phrases.forEach((p, i) => { if (!i || phrases[i - 1].pause) spoken.push([]); spoken.at(-1).push(p); });
  if (shown.length !== spoken.length) return alignRun(chars, phrases);
  return shown.flatMap((run, i) => alignRun(run, spoken[i]));
}

// 句の並びを行へ分ける。改行はアクセント句の境で、1 句が行より長いときだけ途中で切る。答えは行ごとの字数
function breakLines(pieces) {
  const lines = [];
  for (const piece of pieces) {
    let left = piece;
    if (lines.length && lines.at(-1) + left <= LINE_CHARS) { lines[lines.length - 1] += left; continue; }
    while (left > LINE_CHARS) { lines.push(LINE_CHARS); left -= LINE_CHARS; }
    lines.push(left);
  }
  return lines;
}

const TAIL_CHARS = 4;

// アクセント句を字幕の句へまとめる。読点と句点の間、または 2 行に収まらなくなる所で切り替える。時刻は声の頭からの秒
//   together: 句読点でも切らず、1 画面に収まるだけ続けて出す(ドラマ)
export function captionsOf(plain, marks, phrases, times = charTimes(plain, phrases), together = false) {
  const chars = times.map((c, i) => ({c: c.c, from: sec(c.from), to: sec(c.to), em: marks.some(m => m.from <= i && i < m.to)}));
  const owner = charTimes(plain, phrases).map(c => sec(c.from));   // 文字がどの句に入るかは読みで決める。ElevenLabs の文字の時刻は句の時刻と少しずれる
  const groups = [];
  let at = 0, cur = [];
  const flush = () => { if (cur.length) groups.push(cur); cur = []; };
  const size = list => list.reduce((s, n) => s + n.length, 0);
  phrases.forEach((p0, n) => {
    const p = together ? {...p0, pause: false} : p0;
    let end = at;
    if (n === phrases.length - 1) end = chars.length;
    else { while (end < chars.length && (owner[end] < p.to - 0.002 || isSilent(chars[end].c))) end++; }   // from は丸めてあるので少し手前で比べる
    const piece = chars.slice(at, end);
    at = end;
    if (!piece.length) { if (p.pause) flush(); return; }
    // 「んだよ。」のような短い語尾は前の句に付ける。語尾だけの行や、語尾だけの字幕を作らない
    if (cur.length && piece.length <= TAIL_CHARS && piece.every(c => /[ぁ-ん、。！？]/.test(c.c))) {
      cur[cur.length - 1] = [...cur.at(-1), ...piece];
      if (cur.length > 1 && (size(cur) > SCREEN_CHARS || breakLines(cur.map(x => x.length)).length > MAX_LINES)) { const last = cur.pop(); flush(); cur.push(last); }
      if (p.pause) flush();
      return;
    }
    if (cur.length && (size(cur) + piece.length > SCREEN_CHARS || breakLines([...cur, piece].map(x => x.length)).length > MAX_LINES)) flush();
    cur.push(piece);
    if (p.pause) flush();
  });
  flush();
  // 次の句は語りの CAPTION_LEAD 秒前に出すが、前の句の語りが終わるまでは出さない
  const shown = [];
  groups.forEach((g, i) => { const first = g[0][0].from; shown.push(Math.max(0, i ? Math.max(first - CAPTION_LEAD, groups[i - 1].at(-1).at(-1).to) : first - CAPTION_LEAD)); });
  return groups.map((g, i) => {
    const list = g.flat(), from = shown[i], end = list.at(-1).to, next = shown[i + 1];
    const to = next === undefined ? end : Math.min(next, Math.max(end, from + CAPTION_MIN, next - CAPTION_GAP));
    return {text: list.map(c => c.c).join(''), from: sec(from), to: sec(to), lines: breakLines(g.map(x => x.length)), chars: list};
  });
}

// カットの音の合図を動画の時刻へ直す
function sfxTimes(cue, cut, fps) {
  if (cue.at === 'transition') return [Math.max(0, cut.start - cut.direction.transitionFrames / fps / 2)];
  if (cue.at === 'telop') return [cut.start + (cut.direction.slamAt != null ? cut.direction.slamAt + SLAM_SEC : TELOP_DELAY)];
  if (cue.at === 'icon') return [cut.start + ICON_DELAY];
  if (cue.at === 'slam') return [cut.start + cut.direction.slamAt];
  if (cue.at === 'cut') return [cut.start];
  if (cue.at === 'sound') return [cut.start + cut.soundAt];
  if (cue.at === 'figure') return [cut.figureAt];
  return cut.marks.map(m => m.t);
}

// 語の時刻に表情を変える合図を、コマごとの口の形の配列へ載せる。ビューアが emotion を読む(焼き込みに入る)
export function withExpressions(lips, text, voice, styleName, fps) {
  const cues = expressionMarks(text, styleName);
  if (!cues.length) return lips;
  const chars = voice.chars ?? charTimes(parseMarks(text).plain, voice.phrases);
  const spans = cues.map(c => ({from: chars[c.at]?.from ?? 0, expression: c.expression}));
  return lips.map((frame, f) => {
    const t = f / fps, on = spans.filter(s => t >= s.from && t < s.from + EXPRESSION_HOLD).at(-1);
    return on ? {...frame, emotion: on.expression} : frame;
  });
}

// 1 つの時間の流れで撮るときの、出演者 1 人の全カットのコマ。口の形に、カットの表情と首の向きを載せる。話す人は相手の方へ look 度向き、聞く人は半分返す。向きはなだらかに移す
//   cuts: [{lips, count, slot(話す人。語りは -1), expressions(出演者ごと), gazes(出演者ごと。省略可)}]。slot 0 は x が負の側に居るので、人の左(+)が相手の方
//   gaze: up は前を向いたまま GAZE_UP 度見上げる(lift)。each は話す人に関係なく相手の方へ GAZE_EACH 度向く
const LOOK_FOLLOW = 0.08, GAZE_UP = 24, GAZE_EACH = 65;
export function takeFrames(cuts, slot, look) {
  const out = [], toward = slot ? -1 : 1;
  let now = 0, up = 0;
  for (const c of cuts) {
    const gaze = c.gazes?.[slot] ?? '', expression = c.expressions[slot];
    const goal = gaze === 'each' ? toward * GAZE_EACH : gaze === 'up' || c.slot < 0 ? 0 : toward * look * (c.slot === slot ? 1 : 0.5), lift = gaze === 'up' ? GAZE_UP : 0;
    const mood = SHORT_FACES.includes(expression) ? {face: expression} : expression === 'neutral' || expression === 'motion' ? {} : {emotion: expression};
    for (let f = 0; f < c.count; f++) {
      now += (goal - now) * LOOK_FOLLOW; up += (lift - up) * LOOK_FOLLOW;
      out.push({...mood, ...(c.slot === slot ? c.lips[f] : {}), ...(Math.abs(now) > 0.05 ? {look: Number(now.toFixed(2))} : {}), ...(up > 0.05 ? {lift: Number(up.toFixed(2))} : {})});
    }
  }
  return out;
}

// 歩く足音の合図。steps は出演者ごとの、かかとが地面に着いた時刻 [{t, side}](焼き込みの steps)。1 歩に 1 つ、動画の時刻で鳴らす
//   強さは歩の番号から決める(乱数は使わない)。出演者の歩幅が重なっても同じ強さが並ばないよう、出演者ごとに番号をずらす
//   lead: 焼き込みの時刻から引く秒。Blender の最初のコマは 1 番で、焼き込みの 0 番目ではなく 1 番目のコマを描くので、動画は焼き込みより 1 コマ早い(stage-studio の tools/render.py)
const STEP_GAINS = [1, 0.8, 0.92, 0.74, 0.86];
export const footstepCues = (steps, lead = 0, name = 'gravel') => steps.flatMap((list, slot) => (list ?? []).map((s, i) => ({name, t: sec(Math.max(0, s.t - lead)), gain: STEP_GAINS[(i + slot * 2) % STEP_GAINS.length]})));
// 立ち止まる音の合図。stops は出演者ごとの焼き込みの stop({t: 止めたコマの秒} か null)。止めたコマで 1 回、砂利を擦る音を鳴らす
export const stopCues = (stops, lead = 0) => stops.flatMap(s => (Number.isFinite(s?.t) ? [{name: 'scuff', t: sec(Math.max(0, s.t - lead)), gain: 1}] : []));
export const withFootsteps = (timeline, steps, lead = 0, stops = []) => ({...timeline, sfx: [...timeline.sfx, ...footstepCues(steps, lead), ...stopCues(stops, lead)].sort((a, b) => a.t - b.t)});

// timed: [{...カット, id, start, end, count, voiceAt, slot, side}]。speech: カットごとの {phrases, seconds, chars?} か null。cast: 出演者
export function buildTimeline({short, timed, speech, width, height, fps, cast = []}) {
  const plan = direct(short.cuts, short.style ?? 'trivia');
  const cuts = timed.map((c, i) => {
    const {kind, seed, transition, transitionFrames, kenburns, pull, thought, slamAt, slamWord, effects, telopType, telopText, number} = plan.cuts[i];
    const {plain, marks} = parseMarks(c.text), voice = speech[i], phrases = voice?.phrases ?? [], at = c.voiceAt ?? c.start;
    const shift = x => ({...x, from: sec(x.from + at), to: sec(x.to + at)});
    const captions = voice ? captionsOf(plain, marks, phrases, voice.chars, plan.together).map(g => ({...shift(g), to: sec(Math.min(g.to + at, c.end)), chars: g.chars.map(shift)})) : [];
    const chars = captions.flatMap(g => g.chars), found = marks.map(m => ({text: [...plain].slice(m.from, m.to).join(''), t: chars[m.from]?.from ?? sec(c.start)}));
    return {index: i, id: c.id, start: sec(c.start), end: sec(c.end), count: c.count, frames: `${c.id}/frames/%05d.png`, stage: c.stage, camera: c.camera, expression: c.expression, text: plain, telop: telopText, who: c.who ?? '',
      whoColor: c.who ? (cast.length > 1 ? CAST_COLORS[c.slot] : WHO_COLORS[textSeed(c.who) % WHO_COLORS.length]) : '', side: c.side ?? 0, soundAt: c.soundAt ?? 0.3, insertFrom: effects.includes('insert') ? timed[i + 1]?.id ?? timed[i - 1]?.id ?? null : null,
      direction: {kind, seed, transition, transitionFrames, kenburns, pull, thought, slamAt, slamWord, effects, telopType, number},
      figure: c.figure ? `figures/${c.figure}` : '', figureStyle: c.figureStyle ?? '', figureAt: sec(found[0]?.t ?? c.start + FIGURE_DELAY), marks: found, punches: effects.includes('punch') ? (found.length ? found.map(m => m.t) : [sec(c.start + 0.7)]) : [],
      voice: voice ? {start: sec(at), seconds: sec(voice.seconds), phrases: phrases.map(p => ({...shift(p), moras: p.moras.map(shift)}))} : null, captions};
  });
  const sfx = cuts.flatMap((c, i) => plan.cuts[i].sfx.flatMap(q => sfxTimes(q, c, fps).map(t => ({name: q.name, t: sec(t), gain: q.gain})))).sort((a, b) => a.t - b.t);
  // BGM を止める区間: hush のカットが続く間
  const hush = [];
  for (const c of cuts) { if (!timed[c.index].hush) continue; if (hush.at(-1)?.[1] === c.start) hush.at(-1)[1] = c.end; else hush.push([c.start, c.end]); }
  return {version: 1, hush, title: short.title, series: short.series ?? '', bgm: plan.bgm, style: plan.style, caption: plan.caption, letterbox: plan.letterbox, width, height, fps, seconds: sec(cuts.at(-1)?.end ?? 0), cuts, sfx};
}
