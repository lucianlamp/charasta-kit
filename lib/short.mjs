// ショート動画: カット表(シーン、モーション、表情、カメラ、セリフ、テロップ)から縦動画を作る。docs/shorts.md の「short ジョブ」。
//   声を作る -> カットの長さと口の動きを決める -> stage-studio の tools/make_short.py がカットごとに描く -> HyperFrames で文字と演出を重ねて撮った動画として記録する
//   出演者(cast)は 1〜3 人。cast の無い古い short.json は、キャラと話者の欄から 1 人の出演者として読む
//   カットの id は絵が変わる条件のハッシュなので、直したカットだけ描き直す。作業は shorts/<id>/work/<quality>/ に残す
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {root} from './config.mjs';
import {LibraryError, checkId, readJsonOr, rejectCreature} from './library.mjs';
import {checkCues, creatureRefBody, resolveCreature} from './creature.mjs';
import {mediaSeconds} from './audio.mjs';
import {videoTerms} from './terms.mjs';
import {SHOT_EXPRESSIONS} from './shoot.mjs';
import {stageCatalog, stageCode} from './stages.mjs';
import {speechEnd} from './elevenlabs.mjs';
import {THOUGHT, castDialogue, speak, speakDialogue, storedDialogue, storedVoice, useDialogue, voiceLips, voiceOf} from './short-voice.mjs';
import {MV_FPS, MV_QUALITIES, mvEstimateSec} from '../public/mv-plan.mjs';
import {MAX_SECONDS} from '../public/shoot-plan.mjs';
import {AMBIENCES, EFFECTS, FIGURE_STYLES, SHORT_FACES, SHORT_STYLES, SOUNDS, TELOP_TYPES, TRANSITIONS, castOf, keepMadeFigures, pendingClaims, plainText, scriptChanged} from '../public/short-direct.mjs';
import {buildTimeline, takeFrames, withExpressions, withFootsteps} from './short-timeline.mjs';
import {DANCE_LUFS, DANCE_NEW_LOOK, danceBounds, danceCutId, danceDrawn, danceJobCheck, danceKey, danceSeconds, danceSplit, drawDance, musicBody, roundHalfEven, supportsLook, splitDanceFrames} from './dance.mjs';
import {DANCE_CAMERAS} from '../public/short-camera.mjs';
import {checkGraphicFit, checkGraphicShots, composeKey, dancerKey, drawGraphic, faceHitsByCut, graphicCatalog, graphicCutBody, graphicProgress, graphicSpec, vrmExpressions} from './graphic-mv.mjs';
import {GRAPHIC_QUALITIES, graphicEstimateSec, graphicShares} from '../public/mv-plan.mjs';
import {OUT_HEIGHT, OUT_WIDTH, ambienceFile, buildBase, buildMix, checkHyperframes, compositionHtml, defaultBgm, fakeRender, fxScript, prepareInserts, renderProject, writeProject} from './short-compose.mjs';

const TALK_CAMERAS = ['talk_bust', 'talk_close', 'talk_wide', 'orbit', 'wide_push', 'low_feet', 'close_who', 'bust_who', 'face_who', 'over_shoulder', 'two_shot', 'pull_back', 'prop_close', 'prop_line', 'front_walk', 'side_walk', 'back_walk', 'diag_walk', 'walk_close', 'crow_close', 'crow_takeoff'];
// ダンス MV のカメラは stage-studio の lib/shots.py の FLOW。ダンス MV の型のカットだけが選べ、ほかの型のカットは前からある 21 から選ぶ
export const SHORT_CAMERAS = [...TALK_CAMERAS, ...DANCE_CAMERAS.filter(id => !TALK_CAMERAS.includes(id))];
export const VOICE_PROVIDERS = ['voicevox', 'elevenlabs'];
export const VOICE_TONES = ['', 'whispers', 'sighs', 'sad', 'angry', 'excited', 'nervous', 'crying', 'trembling', 'terrified'];   // ElevenLabs の eleven_v3 の演じ方のタグ
export const PROPS = ['letter', 'letter_open'];
export const GAZES = ['up', 'each'];   // 1 つの時間の流れで撮るときの首の向き。up は見上げる、each は相手の方を向く
const DIALOGUE_TAIL = 0.1;   // 会話のカットの声のあとの間。音の余韻と合わせて 0.2 秒以内
const MAX_CAST = 3, DRAMA_LEAD = 0, DRAMA_TAIL = 0.08, DRAMA_END_TAIL = 0.35, DRAMA_MIN_CUT = 0.8, DRAMA_MAX_CUT = 7, MAX_NAME = 12, VOICE_ID = /^[\w-]{1,64}$/;   // ドラマのカットは声の前後に間を置く
const MAX_CUTS = 60, MAX_TEXT = 200, MAX_TELOP = 40, MAX_TITLE = 80, MAX_WHO = 12, MAX_SERIES = 20, MAX_CUT_SEC = 30, MIN_SPEED = 0.8, MAX_SPEED = 1.8, TAIL_SEC = 0.1, QUESTION_TAIL_SEC = 0.45, SILENT_CUT_SEC = 2.5, DEFAULT_SPEED = 1.25;
export const CREATURE_CUES = ['tilt', 'down', 'stare', 'takeoff'];   // カットの始めに生き物がすること(stage-studio の lib/creature.py)
const MAX_CLAIMS = 20, MAX_SOURCES = 5, MAX_CLAIM = 200, MAX_QUERY = 100, MAX_URL = 500, CONFIDENCES = ['high', 'medium', 'low'];
const MAX_SERIAL_CHARS = 6, MAX_THREADS = 10, MAX_NOTE = 200, MAX_SYNOPSIS = 1000, MAX_NEXT = 400;
export const MAX_EPISODE = 999, DRAFT_MAKERS = ['claude', 'gemini'];
export const LIMITS = {cuts: MAX_CUTS, text: MAX_TEXT, telop: MAX_TELOP, title: MAX_TITLE, figureNote: MAX_NOTE, claims: MAX_CLAIMS, claim: MAX_CLAIM, query: MAX_QUERY, serialName: MAX_TITLE, characters: MAX_SERIAL_CHARS, characterName: MAX_NAME, characterNote: MAX_NOTE, synopsis: MAX_SYNOPSIS, threads: MAX_THREADS, thread: MAX_NOTE, next: MAX_NEXT};
const PROGRESS_MS = 15000, COMPOSE_SEC_PER_SEC = 12, MAX_FIGURE_BYTES = 10000000;

const text = (v, what, max) => {
  if (v == null) return '';
  if (typeof v !== 'string') throw new LibraryError('bad-input', `${what} は文字列`);
  const s = v.trim();
  if ([...s].length > max) throw new LibraryError('bad-input', `${what} は ${max} 文字まで`);
  return s;
};
const pick = (v, list, what) => {
  if (!list.includes(v)) throw new LibraryError('bad-input', `${what} は ${list.join(' / ')}: ${JSON.stringify(v)}`);
  return v;
};
// カットの図: ショートのフォルダの figures/ の中のファイル名
const FIGURE_RE = /^[\w-]+\.(png|jpg|jpeg|webp)$/;
const figureName = v => { if (!v) return ''; if (typeof v !== 'string' || !FIGURE_RE.test(v)) throw new LibraryError('bad-input', `図のファイル名が正しくない: ${JSON.stringify(v)}`); return v; };
// 図の出し方。sticker は透過の図で、丸く抜かない。図の無いカットには残さない
const figureStyle = (v, figure) => { if (!v) return {}; pick(v, FIGURE_STYLES, '図の出し方'); return figure ? {figureStyle: v} : {}; };
const auto = (v, list, what) => (v ? pick(v, list, what) : '');   // 空なら自動の演出
// 人が編集画面で頼む直し(カットごとと、ショート全体)。askedAt は「Claude に頼む」を押した時刻で、Claude が後で読む。頼みごとが空なら時刻も残さない
const MAX_ASK = 200;
const isoTime = (v, what) => {
  const t = typeof v === 'string' && v.length <= 40 ? new Date(v) : null;
  if (!t || Number.isNaN(t.getTime())) throw new LibraryError('bad-input', `${what} は ISO の時刻: ${JSON.stringify(v)}`);
  return t.toISOString();
};
// reply は Claude が直したあとに残す返事(scripts/short-asks.mjs done)。repliedAt はその時刻
const askOf = v => {
  const ask = text(v.ask, '直してほしいこと', MAX_ASK), reply = text(v.reply, 'Claude の対応', MAX_ASK);
  return {...(ask ? {ask, ...(v.askedAt ? {askedAt: isoTime(v.askedAt, '頼んだ時刻')} : {})} : {}), ...(reply ? {reply, ...(v.repliedAt ? {repliedAt: isoTime(v.repliedAt, '対応した時刻')} : {})} : {})};
};
const range = (v, lo, hi, what) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new LibraryError('bad-input', `${what} は ${lo} から ${hi}: ${JSON.stringify(v)}`);
  return n;
};

// カットの話す人の番号。名札の文字が出演者の名前でなければ -1(古いショートの名札、語り)
const speakerOf = (cast, c) => (c.who ? cast.findIndex(m => m.name === c.who) : -1);
// カットに出る人。actors が無ければカットの動きと表情を全員に使う
const actorsOf = (cast, c) => cast.map((m, slot) => ({slot, member: m, motionId: c.motionId, expression: c.expression, ...c.actors?.[slot]})).filter(a => !a.absent);
const leadOf = short => (short.style === 'drama' ? DRAMA_LEAD : 0);

// 出演者の数と名前
export function checkCast(cast) {
  if (!Array.isArray(cast) || !cast.length || cast.length > MAX_CAST) throw new LibraryError('bad-input', `出演者は 1 から ${MAX_CAST} 人`);
  if (cast.length > 1 && new Set(cast.map(m => m.name)).size !== cast.length) throw new LibraryError('bad-input', '出演者の名前が重なっている');
  if (cast.length > 1 && cast.some(m => !m.name)) throw new LibraryError('bad-input', '2 人以上のときは出演者に名前が要る');
}

export async function memberBody(lib, m) {
  if (!m || typeof m !== 'object') throw new LibraryError('bad-input', '出演者が連想配列ではない');
  const charId = checkId(m.charId, 'キャラ ID'), ch = rejectCreature(await lib.getCharacterJson(charId), '出演者(生き物は take.creature で使う)'), verId = checkId(m.verId ?? ch.latestVersion, '版 ID'), provider = pick(m.provider ?? 'voicevox', VOICE_PROVIDERS, '声の提供元');
  if (!await lib.versionExists(charId, verId)) throw new LibraryError('not-found', `版 ${charId}/${verId} が無い`);
  const base = {name: text(m.name, '出演者の名前', MAX_NAME), charId, verId, provider};
  if (provider === 'voicevox') return {...base, speaker: Math.round(range(m.speaker ?? 8, 0, 9999, 'speaker')), speakerName: text(m.speakerName, '話者', MAX_TITLE), speed: range(m.speed ?? DEFAULT_SPEED, MIN_SPEED, MAX_SPEED, 'speed')};
  if (typeof m.voiceId !== 'string' || !VOICE_ID.test(m.voiceId)) throw new LibraryError('bad-input', '声が選ばれていない');
  return {...base, voiceId: m.voiceId, voiceName: text(m.voiceName, '声の名前', MAX_TITLE)};
}

// 事実の確認の主張。sources は下書きのジョブが検索の結果と照らして残した URL
function sourceBody(v) {
  const url = text(v?.url, '出典の URL', MAX_URL);
  if (!/^https?:\/\/\S+$/i.test(url) || !URL.canParse(url)) throw new LibraryError('bad-input', `出典の URL が正しくない: ${JSON.stringify(v?.url)}`);
  return {url, title: text(v?.title, '出典の題', MAX_TITLE)};
}
function claimsBody(list) {
  if (!Array.isArray(list) || list.length > MAX_CLAIMS) throw new LibraryError('bad-input', `主張は ${MAX_CLAIMS} 個までの配列`);
  return list.map(c => {
    const claim = text(c?.text, '主張', MAX_CLAIM);
    if (!claim) throw new LibraryError('bad-input', '主張が空');
    if ((c.sources ?? []).length > MAX_SOURCES) throw new LibraryError('bad-input', `出典は 1 つの主張に ${MAX_SOURCES} 個まで`);
    return {text: claim, confidence: pick(c.confidence ?? 'low', CONFIDENCES, '確かさ'), query: text(c.query, '確認に使う語', MAX_QUERY), sources: (c.sources ?? []).map(sourceBody), confirmed: c.confirmed === true};
  });
}

// 連載: 登場人物の設定、あらすじ、未回収の伏線、次の話の方向。シリーズ帯(series)とは別のもの
function serialBody(v) {
  if (typeof v !== 'object' || Array.isArray(v)) throw new LibraryError('bad-input', '連載が連想配列ではない');
  const lines = (items, what, max, each) => { if (!Array.isArray(items ?? []) || (items ?? []).length > max) throw new LibraryError('bad-input', `${what} は ${max} 個までの配列`); return (items ?? []).map(each); };
  return {name: text(v.name, '連載の名前', MAX_TITLE), episode: Math.round(range(v.episode ?? 1, 1, MAX_EPISODE, '何話目か')), previousId: v.previousId ? checkId(v.previousId, '前の話の ID') : '',
    characters: lines(v.characters, '登場人物', MAX_SERIAL_CHARS, c => ({name: text(c?.name, '登場人物の名前', MAX_NAME), note: text(c?.note, '登場人物の設定', MAX_NOTE)})),
    synopsis: text(v.synopsis, 'あらすじ', MAX_SYNOPSIS), threads: lines(v.threads, '伏線', MAX_THREADS, t => text(t, '伏線', MAX_NOTE)), next: text(v.next, '次の話の方向', MAX_NEXT)};
}

// 全カットを 1 つの時間の流れで撮る設定(歩きながら話す動画)。motions は出演者の順の歩く動き。creature は stage-studio の lib/creature.py の spec から events を除いたもの、
// または {charId, verId?, perch, path, ...} の参照(生き物のキャラ。撮るときに model.blend と creature.json の値へ解く。docs/creature.md)
export async function takeBody(lib, take, castCount) {
  if (typeof take !== 'object' || Array.isArray(take)) throw new LibraryError('bad-input', 'take が連想配列ではない');
  if (!Array.isArray(take.motions) || take.motions.length !== castCount) throw new LibraryError('bad-input', 'take.motions は出演者ごとの配列');
  for (const m of take.motions) await lib.getMotion(m);
  if (!Array.isArray(take.mark) || take.mark.length !== 3 || !take.mark.every(Number.isFinite)) throw new LibraryError('bad-input', 'take.mark は [x, y, z]');
  // springs: 出演者ごとの揺れ骨の値 {"skirt": [硬さ, 抵抗]}。骨の名前にキーを含む揺れ骨を置き換える(stage-studio の tools/bake_motion.mjs)
  if (take.springs !== undefined && (!Array.isArray(take.springs) || take.springs.length !== castCount)) throw new LibraryError('bad-input', 'take.springs は出演者ごとの配列');
  const springs = take.springs?.map(m => {
    if (m == null) return null;
    if (typeof m !== 'object' || Array.isArray(m)) throw new LibraryError('bad-input', 'take.springs の要素は {骨の名前: [硬さ, 抵抗]}');
    return Object.fromEntries(Object.entries(m).map(([k, v]) => {
      if (!/^[A-Za-z0-9_]{1,32}$/.test(k) || !Array.isArray(v) || v.length !== 2) throw new LibraryError('bad-input', 'take.springs の要素は {骨の名前: [硬さ, 抵抗]}');
      return [k, [range(v[0], 0, 10, 'take.springs の硬さ'), range(v[1], 0, 1, 'take.springs の抵抗')]];
    }));
  });
  // stop: 全員が歩きを止める動画の秒(焼き込みの 0 秒と同じ)。前後 0.6 秒で両足が地面に着いたコマに止まる。footsteps: かかとが着いた時刻に砂利の足音を鳴らす
  if (take.footsteps !== undefined && typeof take.footsteps !== 'boolean') throw new LibraryError('bad-input', 'take.footsteps は true か false');
  const stop = take.stop == null ? 0 : range(take.stop, 1, 600, 'take.stop');
  return {motions: take.motions, mark: take.mark, spread: range(take.spread ?? 0.5, 0.3, 1.5, 'take.spread'), look: range(take.look ?? 0, 0, 60, 'take.look'), ...(take.creature ? {creature: await creatureRefBody(lib, take.creature)} : {}), ...(springs?.some(Boolean) ? {springs} : {}), ...(stop ? {stop} : {}), ...(take.footsteps ? {footsteps: true} : {})};
}

// ダンス MV のカットの shot: stage-studio の plan が決めたカメラの向き(dir)と乱数の種(seed)。拍から割るときに入る
const shotBody = v => {
  if (typeof v !== 'object' || Array.isArray(v)) throw new LibraryError('bad-input', 'shot が連想配列ではない');
  if (v.dir !== 1 && v.dir !== -1) throw new LibraryError('bad-input', 'shot.dir は 1 か -1');
  return {dir: v.dir, seed: Math.round(range(v.seed ?? 0, 0, 99999, 'shot.seed'))};
};

// 画面から来たカット表を確かめて保存の形にする
export async function shortBody(lib, stageDir, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LibraryError('bad-input', '本文が JSON の連想配列ではない');
  const cast = [];
  if (body.cast !== undefined) {
    checkCast(body.cast);
    for (const m of body.cast) cast.push(await memberBody(lib, m));
    checkCast(cast);
  }
  const charId = checkId(cast[0]?.charId ?? body.charId, 'キャラ ID'), ch = rejectCreature(await lib.getCharacterJson(charId), 'ショートの出演者(生き物は take.creature で使う)'), verId = checkId(cast[0]?.verId ?? body.verId ?? ch.latestVersion, '版 ID');
  if (!await lib.versionExists(charId, verId)) throw new LibraryError('not-found', `版 ${charId}/${verId} が無い`);
  if (!Array.isArray(body.cuts) || body.cuts.length > MAX_CUTS) throw new LibraryError('bad-input', `cuts は ${MAX_CUTS} 個までの配列`);
  const style = pick(body.style ?? 'trivia', SHORT_STYLES, '型'), dance = style === 'dance';
  // ダンス MV: 出演者は 1 人、動きは music.motionId の 1 つ(無ければ最初のカットの motionId)で全カットに使う。音声は short.audioId の曲
  const music = dance ? await musicBody(lib, stageDir, body.music) : null;
  if (dance) {
    if ((cast.length || 1) !== 1) throw new LibraryError('bad-input', 'ダンス MV の出演者は 1 人');
    const motionId = music.motionId ?? body.cuts.find(c => c?.motionId)?.motionId;
    if (motionId) music.motionId = (await lib.getMotion(motionId)).id;
    else if (body.cuts.length) throw new LibraryError('bad-input', 'motionId(踊る動き)が要る');
  }
  const known = (await stageCatalog(stageDir)).map(s => s.id), cuts = [], cameras = dance ? DANCE_CAMERAS : TALK_CAMERAS;
  const graphic = dance && music.look === 'graphic', scenes = graphic ? (await graphicCatalog(stageDir)).map(s => s.id) : [];
  for (const c0 of body.cuts) {
    if (!c0 || typeof c0 !== 'object') throw new LibraryError('bad-input', 'カットが連想配列ではない');
    if (graphic) {   // グラフィック: 場面、ワイプ、言葉、秒。シーンとカメラは持たない(lib/graphic-mv.mjs)
      if (c0.scene == null) throw new LibraryError('bad-input', 'グラフィックのカットには場面(scene)が要る。演出を変えたあとは「拍から割る」を押す');
      cuts.push({...graphicCutBody(c0, scenes), motionId: music.motionId, stage: '', camera: '', angle: 0, expression: 'motion', text: '', telop: '', transition: '', effect: '', telopType: '', who: '', figure: '', ...(c0.ok === true ? {ok: true} : {}), ...askOf(c0)});
      continue;
    }
    const c = dance ? {...c0, motionId: music.motionId, actors: undefined, text: ''} : c0;
    await lib.getMotion(c.motionId);
    if (dance && !c.seconds) throw new LibraryError('bad-input', 'ダンス MV のカットには秒が要る(拍から割る)');
    const actors = [];
    if (c.actors !== undefined) {
      if (!Array.isArray(c.actors) || c.actors.length > (cast.length || 1)) throw new LibraryError('bad-input', 'actors は出演者ごとの配列');
      for (const a of c.actors) {
        if (a?.motionId) await lib.getMotion(a.motionId);
        actors.push({...(a?.motionId ? {motionId: a.motionId} : {}), ...(a?.expression ? {expression: pick(a.expression, [...SHOT_EXPRESSIONS, ...SHORT_FACES], '表情')} : {}), ...(a?.prop ? {prop: pick(a.prop, PROPS, '小道具')} : {}), ...(a?.hold ? {hold: true} : {}), ...(a?.absent ? {absent: true} : {}), ...(a?.turn ? {turn: range(a.turn, -90, 90, '向き')} : {}), ...(a?.gaze ? {gaze: pick(a.gaze, GAZES, '視線')} : {})});
      }
    }
    cuts.push({stage: pick(c.stage, known, 'シーン'), motionId: c.motionId, expression: pick(c.expression ?? 'motion', [...SHOT_EXPRESSIONS, ...SHORT_FACES], '表情'), camera: pick(c.camera ?? (dance ? 'wide_push' : 'talk_bust'), cameras, 'カメラ'),
      angle: range(c.angle ?? 0, -180, 180, 'angle'), text: text(c.text, 'セリフ', MAX_TEXT), telop: text(c.telop, 'テロップ', MAX_TELOP), seconds: c.seconds ? range(c.seconds, 0.5, MAX_CUT_SEC, 'seconds') : 0,
      transition: auto(c.transition, TRANSITIONS, '転換'), effect: auto(c.effect, EFFECTS, '効果'), telopType: auto(c.telopType, TELOP_TYPES, 'テロップの型'), who: text(c.who, '話者の名札', MAX_WHO), figure: figureName(c.figure), ...figureStyle(c.figureStyle, c.figure), ...(c.figureNote ? {figureNote: text(c.figureNote, '図の説明', MAX_NOTE)} : {}), ...(actors.length ? {actors} : {}),
      ...(c.sound ? {sound: pick(c.sound, SOUNDS, '音'), soundAt: range(c.soundAt ?? 0.3, 0, MAX_CUT_SEC, '音の時刻'), soundGain: range(c.soundGain ?? 1, 0.25, 4, '音の大きさ')} : {}), ...(c.tone ? {tone: pick(c.tone, VOICE_TONES, '演じ方')} : {}), ...(c.hush ? {hush: true} : {}), ...(c.creature ? {creature: pick(c.creature, CREATURE_CUES, '生き物の動き')} : {}),
      ...(c.ok === true ? {ok: true} : {}), ...askOf(c), ...(dance && c.shot ? {shot: shotBody(c.shot)} : {})});
  }
  if (dance && danceSeconds(cuts) > MAX_SECONDS + 1e-4) throw new LibraryError('bad-input', `ダンス MV は ${MAX_SECONDS} 秒まで`);
  // グラフィックの表情は、その版の VRM にある名前だけ。時刻は動画の長さの中
  if (dance && music.graphic) checkGraphicFit(music.graphic, {seconds: cuts.length ? danceSeconds(cuts) : null, expressions: await vrmExpressions(path.join(lib.dir, 'characters', charId, 'versions', verId, 'model.vrm'))});
  const out = {title: text(body.title, 'タイトル', MAX_TITLE) || '無題', style, series: text(body.series, 'シリーズ帯', MAX_SERIES), charId, verId, speaker: Math.round(range(body.speaker ?? 8, 0, 9999, 'speaker')), speakerName: text(body.speakerName, '話者', MAX_TITLE),
    speed: range(body.speed ?? DEFAULT_SPEED, MIN_SPEED, MAX_SPEED, 'speed'), defaultBgm: body.defaultBgm === true, ambience: body.ambience ? pick(body.ambience, AMBIENCES, '環境音') : '', audioId: null, audioName: '', audioSummary: '', audioPublic: false, cuts};
  if (cast.length) out.cast = cast;
  if (dance) out.music = music;
  Object.assign(out, askOf(body));
  if (body.dialogue !== undefined && typeof body.dialogue !== 'boolean') throw new LibraryError('bad-input', 'dialogue は true か false');
  if (body.dialogue === true) out.dialogue = true;   // 全カットを 1 回の会話で読ませる経路(ElevenLabs v4)。欄が無いショートは 1 文ずつの経路
  if (body.take) out.take = await takeBody(lib, body.take, cast.length || 1);
  if (body.claims !== undefined) out.claims = claimsBody(body.claims);
  if (body.draftBy) out.draftBy = pick(body.draftBy, DRAFT_MAKERS, '下書きの作り手');
  if (body.figuresRev) out.figuresRev = Math.round(range(body.figuresRev, 0, 2 ** 32, '図の版'));
  if (body.scriptKey != null) out.scriptKey = Math.round(range(body.scriptKey, 0, 2 ** 32, '台本のキー'));
  if (body.serial) out.serial = serialBody(body.serial);
  if (body.draft && typeof body.draft === 'object') out.draft = body.draft;   // 下書きのジョブの記録。画面は読むだけで、そのまま返す
  if (body.audioId) {
    const a = await lib.getAudio(body.audioId);
    out.audioId = a.id; out.audioName = a.name; out.audioSummary = text(body.audioSummary, '音声の利用条件', 200); out.audioPublic = body.audioPublic === true;
  }
  return out;
}

// 新しく作るショート(POST /api/shorts)。dialogue を指定しなければ、出演者が 2 人以上で全員 ElevenLabs のときに true を付ける
export async function newShortBody(lib, stageDir, raw) {
  const out = await shortBody(lib, stageDir, raw);
  if (raw.dialogue === undefined && castDialogue(castOf(out))) out.dialogue = true;
  return out;
}

// 拍から割って保存する(POST /api/shorts/<id>/beat-cuts)。カット、music(指定を足したもの)を置き換え、ほかの欄は変えない。
//   答えは {short: 保存したショート, source: 'audio' か 'bpm', detectedBpm: 曲から求めたテンポ(曲が無ければ null)}
export async function splitShort({lib, stageDir, python}, shortId, body, active) {
  const short = await lib.getShort(checkId(shortId, 'ショート ID'));
  if (short.style !== 'dance') throw new LibraryError('bad-input', 'ダンス MV の型のショートだけ拍から割れる');
  const split = await danceSplit({lib, stageDir, python}, short, body ?? {});
  const saved = await saveShortEdit(lib, shortId, await shortBody(lib, stageDir, {...short, music: split.music, cuts: split.cuts}), active);
  return {short: saved, source: split.source, detectedBpm: split.detectedBpm};
}

// ダンス MV のショートを新しく作る(POST /api/dance-shorts)。出演者 1 人、music は既定、body.stages(省略時はシーンの最初の 1 つ)と motionId があれば、拍から割ったカットも入れる。
//   カットを割れなかったときは理由を cutsError に入れて、カット無しのショートを返す(あとで画面から割れる)
export async function newDanceShort({lib, stageDir, python}, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LibraryError('bad-input', '本文が JSON の連想配列ではない');
  const known = (await stageCatalog(stageDir)).map(s => s.id);
  const music = {look: DANCE_NEW_LOOK, ...body.music, ...(body.motionId ? {motionId: body.motionId} : {}), ...(body.stages ? {stages: body.stages} : known[0] ? {stages: [known[0]]} : {})};
  const base = {title: body.title, style: 'dance', charId: body.charId, cast: [{name: '', charId: body.charId, verId: body.verId}], defaultBgm: false, cuts: [], music};
  if (music.stages && !music.motionId) delete music.stages;   // 動きが決まるまでは、シーンも置かない(画面で選ぶ)
  const made = await shortBody(lib, stageDir, base), id = 's' + Date.now().toString(36);
  let cutsError = null;
  if (music.motionId && music.stages) {
    try {
      const split = await danceSplit({lib, stageDir, python}, {...made, id}, {seconds: body.seconds});
      Object.assign(made, await shortBody(lib, stageDir, {...made, music: split.music, cuts: split.cuts}));
    } catch (e) { cutsError = e.message; }
  }
  const saved = await lib.saveShort(id, made);
  return {...saved, ...(cutsError ? {cutsError} : {})};
}

// セリフの試し聞きの入力
export function voiceBody(b) {
  const line = plainText(text(b.text, 'セリフ', MAX_TEXT)), provider = pick(b.provider ?? 'voicevox', VOICE_PROVIDERS, '声の提供元');
  if (!line) throw new LibraryError('bad-input', 'セリフが空');
  if (provider === 'voicevox') return {line, member: {provider, speaker: Math.round(range(b.speaker ?? 8, 0, 9999, 'speaker')), speed: range(b.speed ?? DEFAULT_SPEED, MIN_SPEED, MAX_SPEED, 'speed')}};
  if (typeof b.voiceId !== 'string' || !VOICE_ID.test(b.voiceId)) throw new LibraryError('bad-input', '声が選ばれていない');
  return {line, member: {provider, voiceId: b.voiceId, tone: b.tone ? pick(b.tone, VOICE_TONES, '演じ方') : ''}};
}

// 会話の経路のショートの試し聞き: 保管済みの切り出しを返す。無ければ ElevenLabs を呼ばずに断る(会話の声は v3 の声と別物)
async function dialogueSample(lib, body) {
  const short = await lib.getShort(checkId(body.shortId, 'ショート ID')), cast = castOf(short);
  if (!useDialogue(short, cast)) return null;
  const cut = body.cut;
  if (!Number.isInteger(cut) || cut < 0 || cut >= short.cuts.length || !plainText(short.cuts[cut].text)) throw new LibraryError('bad-input', 'cut はセリフのあるカットの番号');
  const stored = await storedDialogue(lib, spokenLines(short, cast)), file = stored?.[short.cuts.slice(0, cut).filter(c => plainText(c.text)).length]?.file;
  if (!file || !await fs.stat(file).then(() => true, () => false)) throw new LibraryError('busy', '会話の声は試しを書き出すと聞ける');
  return {file, type: 'audio/wav'};
}

// 試し聞きの音声。答えは {file, type}。shortId があり、そのショートが会話の経路なら保管済みの会話の切り出し
export async function voiceSample({lib, voicevox, eleven}, body) {
  if (body.shortId !== undefined) { const stored = await dialogueSample(lib, body); if (stored) return stored; }
  const {line, member} = voiceBody(body), dir = path.join(lib.dir, 'voice-cache');
  await fs.mkdir(dir, {recursive: true});
  const voice = await voiceOf({lib, voicevox, eleven}, member, line, dir);
  return {file: voice.file, type: voice.file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'};
}

export async function shortJobInput(lib, body, active, stageDir) {
  const shortId = checkId(body.shortId, 'ショート ID'), short = await lib.getShort(shortId);
  if (!short.cuts.length) throw new LibraryError('bad-input', 'カットが無い');
  if (short.style === 'dance') await danceJobCheck(lib, short, stageDir);
  if (active(shortId)) throw new LibraryError('busy', 'このショートは書き出している');
  const quality = pick(body.quality ?? 'preview', Object.keys(MV_QUALITIES), 'quality'), pending = pendingClaims(short).length;
  if (quality === 'final' && scriptChanged(short)) throw new LibraryError('busy', '主張を確かめたあとに台本が変わった。事実の確認の欄で確かめてから本番を書き出す');
  if (quality === 'final' && pending) throw new LibraryError('busy', `出典の無い主張が ${pending} 件ある。事実の確認の欄で確かめてから本番を書き出す`);
  return {shortId, charId: short.charId, verId: short.verId, quality, previewOf: body.previewOf ? checkId(body.previewOf, '動画 ID') : null, short};
}

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

// 投稿の説明に書くクレジット。話した人の声だけ
function voiceCredit(cast, short, speech) {
  const spoke = new Set(short.cuts.flatMap((c, i) => (speech[i] ? [cast[Math.max(0, speakerOf(cast, c))]] : [])));
  return [...new Set([...spoke].map(m => (m.provider === 'elevenlabs' ? 'ElevenLabs' : `VOICEVOX:${m.speakerName || m.speaker}`)))].join('、') || null;
}

// モーションと音声の札をまとめる。一番重い扱いを動画の札にする
function shortTerms(motions, audio) {
  const parts = [...motions.map(motion => videoTerms({motion})), ...(audio ? [videoTerms({audio})] : [])], order = ['ok', 'check', 'no'];
  const level = parts.reduce((l, t) => (order.indexOf(t.level) > order.indexOf(l) ? t.level : l), 'ok');
  return {level, tag: parts.find(t => t.level === level)?.tag ?? null, notes: parts.flatMap(t => t.notes)};
}

// 声のあるカットの行。語りは最初の出演者の声
const spokenLines = (short, cast) => short.cuts.filter(c => plainText(c.text)).map(c => ({line: plainText(c.text), member: cast[Math.max(0, speakerOf(cast, c))], tone: c.tone || ''}));
// 行ごとの声をカットの並びへ戻す。声の無いカットは null
const placeLines = (short, said, voices) => { let k = 0; return short.cuts.map(c => (plainText(c.text) ? voices[k++] : null)); };

// ダンス MV の下ごしらえ: カットごとの id(plan と timed に積む)、描画の作業フォルダ、コマの数。コマの数のカットごとの内訳は、描いたあとの shots.json から決まる
//   カットの id は条件のハッシュ + 番号なので、テロップなど絵に関わらない直しでは変わらず、base を作り直さない
async function planDance(ctx, {lib, short, stageDir, cast, code, q, work, plan, timed, motions}) {
  const music = short.music, motion = await lib.getMotion(music.motionId ?? short.cuts[0].motionId), member = cast[0];
  motions.set(motion.id, motion);
  const version = (await lib.getCharacter(member.charId)).versions.find(v => v.id === member.verId), audio = short.audioId ? await lib.getAudio(short.audioId) : null;
  if (audio) {
    const left = await mediaSeconds(ctx, audio.file) - music.audioStart;
    if (left <= 0) throw new Error(`曲の開始位置 ${music.audioStart} 秒が、曲の長さより後ろ: ${audio.name}`);
    if (left < danceSeconds(short.cuts) - 1e-4) throw new Error(`曲が足りない: 開始位置から ${(Math.round(left * 1000) / 1000)} 秒しかない(必要 ${(Math.round(danceSeconds(short.cuts) * 1000) / 1000)} 秒): ${audio.name}`);
  }
  const tools = await Promise.all(['tools/make_mv.py', 'tools/beats.py'].map(f => fs.readFile(path.join(stageDir, f)).then(sha1, () => ''))), stageCodes = await Promise.all(short.cuts.map(c => stageCode(stageDir, c.stage)));
  const key = danceKey({code: code + tools.join(), version: version?.sha256, motion: motion.sha256, cast: member, cuts: short.cuts, stageCodes, music, audio: audio?.id ?? null, pct: q.pct, samples: q.samples, lookOn: await supportsLook(stageDir)}), bounds = danceBounds(short.cuts);
  short.cuts.forEach((c, i) => {
    const id = danceCutId(key, i);
    plan.cuts.push({id, stage: c.stage, seconds: c.seconds, camera: c.camera, angle: c.angle, who: 0, count: 1, actors: [{slot: 0, char: member.charId, ver: member.verId, motion: motion.id, expression: 'neutral', once: false, turn: 0}]});
    timed.push({...c, id, start: bounds[i].start, end: bounds[i].end, count: 0, voiceAt: bounds[i].start, slot: 0, side: 0});
  });
  return {key, mvDir: path.join(work, `mv-${key}`), frames: roundHalfEven(danceSeconds(short.cuts) * MV_FPS), audio};
}

// グラフィック MV の下ごしらえ: 踊る人の作業(dancerKey)と重ねの作業(composeKey)を分ける。文字と色だけの直しは重ねるからやり直す
async function planGraphic(ctx, {lib, short, stageDir, cast, code, q, quality, work, plan, timed, motions}) {
  const music = short.music, motion = await lib.getMotion(music.motionId ?? short.cuts[0].motionId), member = cast[0];
  motions.set(motion.id, motion);
  const version = (await lib.getCharacter(member.charId)).versions.find(v => v.id === member.verId), audio = short.audioId ? await lib.getAudio(short.audioId) : null, seconds = danceSeconds(short.cuts);
  if (audio) {
    const left = await mediaSeconds(ctx, audio.file) - music.audioStart;
    if (left <= 0) throw new Error(`曲の開始位置 ${music.audioStart} 秒が、曲の長さより後ろ: ${audio.name}`);
    if (left < seconds - 1e-4) throw new Error(`曲が足りない: 開始位置から ${(Math.round(left * 1000) / 1000)} 秒しかない(必要 ${(Math.round(seconds * 1000) / 1000)} 秒): ${audio.name}`);
  }
  const read = files => Promise.all(files.map(f => fs.readFile(path.join(stageDir, f)).then(sha1, () => ''))).then(x => x.join());
  const dancerCode = code + await read(['tools/render_dancer.py', 'lib/look.py', 'tools/make_graphic_mv.py']);
  const composeCode = await read(['tools/graphic_mv/core.py', 'tools/graphic_mv/scenes.py', 'tools/graphic_mv/compose.py', 'tools/graphic_mv/plan.py', 'tools/graphic_mv/catalog.json', 'tools/make_graphic_mv.py', 'tools/beats.py']);
  const dancer = dancerKey({code: dancerCode, version: version?.sha256, motion: motion.sha256, seconds, graphic: music.graphic, pct: q.pct, samples: q.samples});
  const key = composeKey({dancer, code: composeCode, cuts: short.cuts, graphic: music.graphic, bpm: music.bpm, audio: audio?.id ?? null, audioStart: music.audioStart, width: q.width, height: q.height}), bounds = danceBounds(short.cuts);
  short.cuts.forEach((c, i) => {
    const id = danceCutId(key, i);
    plan.cuts.push({id, stage: '', scene: c.scene, seconds: c.seconds, camera: '', angle: 0, who: 0, count: 1, actors: [{slot: 0, char: member.charId, ver: member.verId, motion: motion.id, expression: 'neutral', once: false, turn: 0}]});
    timed.push({...c, id, start: bounds[i].start, end: bounds[i].end, count: 0, voiceAt: bounds[i].start, slot: 0, side: 0});
  });
  return {key, dancerKey: dancer, mvDir: path.join(work, `mv-${key}`), dancerDir: path.join(work, `dancer-${dancer}`), frames: roundHalfEven(seconds * MV_FPS), audio,
    spec: graphicSpec({short, motionId: motion.id, cast: member, audio, q}), shares: graphicShares(short.cuts, await graphicCatalog(stageDir)), quality};
}

export async function runShort(ctx, {lib, voicevox, eleven, stageDir, hyperframesCli, hyperframesBrowser, blender, getPort, env}) {
  if (!env.CHARASTA_FAKE_CAPTURE) await checkHyperframes({cli: hyperframesCli, browser: hyperframesBrowser});
  const {job} = ctx, input = job.input, {shortId, charId, verId, quality, short} = input, graphic = short.style === 'dance' && short.music?.look === 'graphic', q = (graphic ? GRAPHIC_QUALITIES : MV_QUALITIES)[quality];
  const dir = lib.shortDir(shortId), voiceDir = path.join(dir, 'voice'), work = path.join(dir, 'work', quality), compose = path.join(work, 'compose');
  await fs.mkdir(voiceDir, {recursive: true}); await fs.mkdir(compose, {recursive: true});

  const dance = short.style === 'dance';
  await ctx.step(dance ? 'カットを確かめる' : '声を作る');
  const cast = castOf(short), tools = {lib, voicevox, eleven, ctx, log: ctx.log};
  let speech = [];
  if (dance) speech = short.cuts.map(() => null);   // ダンス MV は声を作らない。曲が音の主役
  else if (useDialogue(short, cast)) {
    const said = spokenLines(short, cast), voices = await speakDialogue(tools, said);
    speech = placeLines(short, said, voices);
  } else for (const c of short.cuts) {
    const line = plainText(c.text), who = Math.max(0, speakerOf(cast, c));   // `[語]` の括弧は声にもキャッシュの鍵にも入れない。語りは最初の出演者の声
    speech.push(line ? await speak(tools, {...cast[who], tone: c.tone}, line, voiceDir) : null);
  }

  // カットの長さは声の長さで決める。指定があれば長い方。コマの境に揃えて、音と絵をずらさない
  const plan = {cuts: []}, timed = [], lead = leadOf(short), drama = short.style === 'drama', versions = new Map();
  for (const m of cast) versions.set(`${m.charId}/${m.verId}`, (await lib.getCharacter(m.charId)).versions.find(v => v.id === m.verId));
  let start = 0, motions = new Map(), frames = 0;
  const takeCuts = [];
  // 焼き込みの道具とビューアのコードも絵を変える。作業を残すので、直したあとに古いコマと混ざらないよう ID に入れる
  const code = (await Promise.all([...['tools/bake_motion.mjs', 'tools/bake_glb.py', 'tools/make_short.py', 'tools/render.py', 'lib/shots.py', 'lib/studio.py', 'lib/creature.py', 'assets/props/letter.png'].map(f => path.join(stageDir, f)), ...['viewer.mjs', 'foot-ik.mjs', 'spring-clock.mjs', 'weapon.mjs', 'shoot-plan.mjs'].map(f => path.join(root, 'public', f)), ...['three-vrm.module.js', 'three-vrm-animation.module.js'].map(f => path.join(root, 'vendor', f))].map(f => fs.readFile(f).then(sha1, () => '')))).join();
  for (const [i, c] of (dance ? [] : short.cuts).entries()) {
    // 問いの文のあとは少し間を残す
    const voice = speech[i], line = plainText(c.text), tail = voice?.dialogue ? DIALOGUE_TAIL : drama ? (i === short.cuts.length - 1 ? DRAMA_END_TAIL : DRAMA_TAIL) : /[?？]$/.test(line) ? QUESTION_TAIL_SEC : TAIL_SEC;
    const wanted = Math.max(c.seconds || 0, voice ? lead + (drama && voice.chars && !voice.dialogue ? speechEnd(voice.chars) : voice.seconds) + tail : c.seconds || SILENT_CUT_SEC, drama ? DRAMA_MIN_CUT : 0), count = Math.ceil(wanted * MV_FPS), seconds = count / MV_FPS;
    if (drama && seconds > DRAMA_MAX_CUT) ctx.log(`カット ${i + 1} は ${seconds.toFixed(1)} 秒で、ドラマの目安 ${DRAMA_MAX_CUT} 秒より長い\n`);
    // 口が動くのは話す人だけ。心の声と語りは閉じたまま
    const heard = speakerOf(cast, c), slot = Math.max(0, heard), inner = voice && (THOUGHT.test(line) || (cast.length > 1 && heard < 0));
    const leadFrames = Math.round(lead * MV_FPS);
    const lips = voice && !inner ? [...Array(leadFrames).fill({}), ...withExpressions(await voiceLips(ctx, voice, count - leadFrames, MV_FPS), c.text, voice, short.style ?? 'trivia', MV_FPS)] : [];
    const actors = actorsOf(cast, c);
    if (!actors.length) throw new LibraryError('bad-input', `カット ${i + 1} に出る人がいない`);
    const planned = [];
    for (const a of actors) {
      const motion = await lib.getMotion(a.motionId);
      motions.set(motion.id, motion);
      planned.push({slot: a.slot, char: a.member.charId, ver: a.member.verId, motion: motion.id, sha: motion.sha256, version: versions.get(`${a.member.charId}/${a.member.verId}`)?.sha256, expression: a.expression, once: drama || !!a.hold, turn: a.turn ?? 0, prop: a.prop, hold: a.hold, lips: a.slot === slot ? lips : []});
    }
    const id = sha1(JSON.stringify([code, planned, await stageCode(stageDir, c.stage), c.stage, c.camera, c.angle, slot, seconds, cast.length, q.pct, q.samples])).slice(0, 16);
    plan.cuts.push({id, stage: c.stage, seconds, camera: c.camera, angle: c.angle, who: slot, count: cast.length, actors: planned.map(({sha, version, ...a}) => a)});
    timed.push({...c, id, start, end: start + seconds, count, voiceAt: start + lead, slot, side: cast.length === 2 && heard >= 0 ? (slot ? 1 : -1) : 0});
    takeCuts.push({lips, count, slot: heard, expressions: cast.map((m, s) => actors.find(a => a.slot === s)?.expression ?? 'neutral'), gazes: cast.map((m, s) => actors.find(a => a.slot === s)?.gaze ?? '')});
    start += seconds; frames += count;
  }
  let dancing = null;
  if (graphic) { dancing = await planGraphic(ctx, {lib, short, stageDir, cast, code, q, quality, work, plan, timed, motions}); frames = dancing.frames; }
  else if (dance) { dancing = await planDance(ctx, {lib, short, stageDir, cast, code, q, work, plan, timed, motions}); frames = dancing.frames; }
  const seconds = frames / MV_FPS;
  if (short.take) {
    if (short.take.stop > frames / MV_FPS) throw new LibraryError('bad-input', `take.stop ${short.take.stop} 秒が動画の長さ ${(frames / MV_FPS).toFixed(1)} 秒より後`);
    const t = short.take, actors = cast.map((m, slot) => ({slot, char: m.charId, ver: m.verId, motion: t.motions[slot], expression: 'neutral', once: true, lips: takeFrames(takeCuts, slot, t.look), ...(t.springs?.[slot] ? {springs: t.springs[slot]} : {}), ...(t.stop ? {stop: t.stop} : {})}));
    const events = short.cuts.flatMap((c, i) => (c.creature ? [{at: timed[i].start, name: c.creature}] : []));
    // 生き物は参照を spec({blend, perch, ...})に解く。blend の中身が変わったらコマの ID も変わるよう、sha256 を ID に混ぜる
    const creature = t.creature ? await resolveCreature(lib, t.creature) : null;
    if (creature) checkCues(creature.spec, events.map(e => e.name));
    plan.take = {stage: short.cuts[0].stage, seconds, mark: t.mark, spread: t.spread, actors, ...(creature ? {creature: {...creature.spec, events}} : {})};
    plan.take.id = sha1(JSON.stringify([code, plan.take, await stageCode(stageDir, plan.take.stage), plan.cuts.map(c => [c.camera, c.angle, c.who, c.seconds]), q.pct, q.samples, ...(creature?.sha256 ? [creature.sha256] : [])])).slice(0, 16);
    plan.cuts.forEach((c, i) => { c.id = timed[i].id = `${plan.take.id}-${i}`; });
  }
  job.timeoutMs = env.CHARASTA_SHOOT_TIMEOUT_MS ? Number(env.CHARASTA_SHOOT_TIMEOUT_MS) : ((graphic ? graphicEstimateSec(quality, seconds, dancing.shares) : mvEstimateSec(quality, seconds, plan.cuts.length)) + seconds * COMPOSE_SEC_PER_SEC) * 4000;
  const deadline = Date.now() + job.timeoutMs, left = () => Math.max(1, deadline - Date.now());
  ctx.log(`${q.label}、${seconds.toFixed(2)} 秒、${frames} コマ、${plan.cuts.length} カット、上限 ${Math.round(job.timeoutMs / 1000)} 秒\n`);
  await fs.writeFile(path.join(work, 'plan.json'), JSON.stringify(plan));
  // グラフィックは色を決めて重ねてあるので、base に色の補正(コントラストと彩度)を掛けない
  const timelineOf = () => ({...buildTimeline({short, timed, speech, width: q.width, height: q.height, fps: MV_FPS, cast}), ...(graphic ? {grade: false} : {})});
  let timeline = dance ? null : timelineOf();   // ダンス MV はコマの数が描いたあとに決まるので、あとで作る
  if (timeline) await fs.writeFile(path.join(work, 't.json'), JSON.stringify(timeline));

  const framesOf = c => path.join(work, c.id, 'frames');
  const countOf = async c => (await fs.readdir(framesOf(c)).catch(() => [])).filter(f => /^\d{5}\.png$/.test(f)).length;
  const drawn = dance ? () => danceDrawn(dancing.mvDir, frames) : async () => (await Promise.all(timed.map(countOf))).reduce((a, b) => a + b, 0);
  let last = -1;
  const report = graphic
    ? async () => { const msg = await graphicProgress(dancing.mvDir, dancing.dancerDir); if (msg && msg !== last) { last = msg; await ctx.step(msg); } }
    : async () => { const n = await drawn(); if (n !== last) { last = n; await ctx.step(`コマを描く ${n} / ${frames}`); } };
  await report();
  const timer = setInterval(() => report().catch(() => {}), PROGRESS_MS);
  let faceHits = [];
  try {
    if (graphic) {
      const rep = await drawGraphic(ctx, {lib, short, stageDir, blender, getPort, mvDir: dancing.mvDir, dancerDir: dancing.dancerDir, frames, q, quality, left, spec: dancing.spec});
      if (await drawn() < frames) throw new Error(`重ねたコマが足りない: ${await drawn()} / ${frames}`);
      if (rep?.timings) ctx.log(`時間 ${JSON.stringify(rep.timings)}、描いたコマ ${JSON.stringify(rep.passes ?? {})}\n`);
      const counts = await splitDanceFrames({mvDir: dancing.mvDir, work, ids: timed.map(c => c.id), cuts: short.cuts, frames, check: checkGraphicShots});
      faceHits = faceHitsByCut(rep?.faceHits, counts);
      if (faceHits.length) ctx.log(`顔に文字がかかったコマ: ${faceHits.map(x => `カット ${x.cut + 1} で ${x.frames} コマ`).join('、')}\n`);
      let at = 0;
      counts.forEach((n, i) => { Object.assign(timed[i], {count: n, start: at / MV_FPS, end: (at + n) / MV_FPS, voiceAt: at / MV_FPS}); plan.cuts[i].seconds = n / MV_FPS; at += n; });
      await fs.writeFile(path.join(work, 'plan.json'), JSON.stringify(plan));
      timeline = timelineOf();
      await fs.writeFile(path.join(work, 't.json'), JSON.stringify(timeline));
      await ctx.step('動画にまとめる');
    } else if (dance) {
      await drawDance(ctx, {lib, short, stageDir, blender, getPort, env, mvDir: dancing.mvDir, frames, q, left, fake: env.CHARASTA_FAKE_CAPTURE});
      if (await drawn() !== frames) throw new Error(`描いたコマが足りない: ${await drawn()} / ${frames}`);
      // shots.json の時刻をカット表と照らし、カットごとのコマの数で時間表を決める(ずれていれば失敗)
      const counts = await splitDanceFrames({mvDir: dancing.mvDir, work, ids: timed.map(c => c.id), cuts: short.cuts, frames});
      let at = 0;
      counts.forEach((n, i) => { Object.assign(timed[i], {count: n, start: at / MV_FPS, end: (at + n) / MV_FPS, voiceAt: at / MV_FPS}); plan.cuts[i].seconds = n / MV_FPS; at += n; });
      await fs.writeFile(path.join(work, 'plan.json'), JSON.stringify(plan));
      timeline = timelineOf();
      await fs.writeFile(path.join(work, 't.json'), JSON.stringify(timeline));
    } else if (env.CHARASTA_FAKE_CAPTURE) {
      for (const c of timed) {
        await fs.mkdir(framesOf(c), {recursive: true});
        await ctx.run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x445566:s=${q.width}x${q.height}:r=${MV_FPS}`, '-frames:v', String(c.count), '-start_number', '1', path.join(framesOf(c), '%05d.png')]);
      }
    } else {
      await ctx.run('python', [path.join(stageDir, 'tools', 'make_short.py'), path.join(work, 'plan.json'), '--out', work, '--pct', String(q.pct), '--samples', String(q.samples), '--base', `http://127.0.0.1:${getPort()}`, '--charasta', root],
        {cwd: stageDir, timeoutMs: left(), env: {CHARASTA_LIBRARY: lib.dir, CHARASTA_ROOT: root, ...(blender && {BLENDER: blender}), PYTHONUNBUFFERED: '1'}});
    }
  } finally { clearInterval(timer); }
  if (!graphic && await drawn() !== frames) throw new Error(`描いたコマが足りない: ${await drawn()} / ${frames}`);

  // 砂利の足音は、撮ったあとの焼き込みの steps(かかとが着いた時刻)から足す。立ち止まった人は止めたコマ(stop)で擦る音を鳴らす。コマは変わらないので、絵の ID には入れない
  let mixing = timeline;
  if (short.take?.footsteps) {
    const baked = await Promise.all(plan.take.actors.map((_, k) => fs.readFile(path.join(work, plan.take.id, `a${k}.json`), 'utf8').then(s => JSON.parse(s), () => null)));
    const steps = baked.map(b => b?.steps ?? null), stops = baked.map(b => b?.stop ?? null);
    if (steps.every(Array.isArray)) { mixing = withFootsteps(timeline, steps, 1 / MV_FPS, stops); ctx.log(`足音 ${steps.map(s => s.length).join(' + ')} 歩、止まる音 ${stops.filter(s => Number.isFinite(s?.t)).length}\n`); }
    else ctx.log('足音: 焼き込みに steps が無いので鳴らさない\n');
    await fs.writeFile(path.join(work, 't.json'), JSON.stringify(mixing));
  }

  await ctx.step('文字と演出を重ねる');
  const audio = short.audioId ? await lib.getAudio(short.audioId) : null, out = path.join(ctx.workDir, 'video.mp4'), poster = path.join(ctx.workDir, 'poster.jpg');
  const voices = speech.flatMap((v, i) => (v ? [{file: v.file, start: timed[i].voiceAt, who: timed[i].slot}] : []));
  const rebuilt = await buildBase(ctx, timeline, {work, dir: compose, width: q.width, height: q.height, env, timeoutMs: left});
  const remixed = await buildMix(ctx, mixing, {dir: compose, voices, bgm: audio ? {file: audio.file, ...(dance ? {start: short.music.audioStart, lufs: DANCE_LUFS, duck: false} : {})} : short.defaultBgm && timeline.bgm ? defaultBgm(timeline.bgm) : null, ambience: short.ambience ? ambienceFile(short.ambience, {log: m => ctx.log?.(m)}) : null});
  ctx.log(`base ${rebuilt ? '作り直した' : 'そのまま'}、音 ${remixed ? '作り直した' : 'そのまま'}\n`);
  await prepareInserts(ctx, timeline, {work, dir: compose, figures: path.join(dir, 'figures')});
  await writeProject(timeline, compose);
  if (env.CHARASTA_FAKE_CAPTURE) await fakeRender(ctx, {dir: compose, out});
  else await renderProject(ctx, {cli: hyperframesCli, browser: hyperframesBrowser, dir: compose, quality, out, timeoutMs: left()});
  await ctx.run('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.min(seconds / 2, seconds - 0.1)), '-i', out, '-frames:v', '1', '-q:v', '3', poster], {timeoutMs: left()});

  const labels = Object.fromEntries((await stageCatalog(stageDir)).map(s => [s.id, s.label])), stages = graphic ? [] : [...new Set(short.cuts.map(c => c.stage))];
  const terms = shortTerms([...motions.values()], audio && {name: audio.name, summary: short.audioSummary, publishOk: short.audioPublic}), credit = voiceCredit(cast, short, speech);
  const record = {id: job.id, kind: 'short', charId, verId, motionId: short.cuts[0].motionId, motionLabel: short.title, loops: 1, lineId: null, lineText: null,
    audio: audio ? {id: audio.id, name: audio.name, summary: short.audioSummary, publicOk: short.audioPublic, start: dance ? short.music.audioStart : 0, seconds, cut: false} : null,
    framing: 'full', aspect: '9:16', quality, expression: 'motion', background: 'stage', width: OUT_WIDTH, height: OUT_HEIGHT, fps: MV_FPS, seconds: Number(seconds.toFixed(3)), frames, terms,
    short: {id: shortId, title: short.title, cuts: short.cuts.length, credit, stages, stageLabels: stages.map(s => labels[s] ?? s), previewOf: input.previewOf, ...(dance ? {style: 'dance', music: short.music} : {}), ...(graphic ? {faceHits} : {})}, createdAt: new Date().toISOString()};
  const saved = await lib.saveShoot(record, {video: out, poster});

  // 今のカット表に無いカットの作業を消す。あるカットは残して、次に直すときに描き直さない
  const keep = new Set([...timed.map(c => c.id), plan.take?.id, dancing && `mv-${dancing.key}`, dancing?.dancerKey && `dancer-${dancing.dancerKey}`, 'plan.json', 't.json', 'compose']);
  for (const name of await fs.readdir(work)) if (!keep.has(name)) await fs.rm(path.join(work, name), {recursive: true, force: true});
  return {shootId: job.id, url: saved.url, posterUrl: saved.posterUrl, seconds: record.seconds, width: OUT_WIDTH, height: OUT_HEIGHT, fps: MV_FPS, terms};
}

// カットの図を置く。本文は画像そのもの
export async function saveFigure(lib, shortId, name, data) {
  await lib.getShort(shortId);
  const ext = (/\.(png|jpg|jpeg|webp)$/i.exec(name ?? '')?.[1] ?? '').toLowerCase();
  if (!ext) throw new LibraryError('bad-input', '図は png、jpg、webp');
  if (!data.length || data.length > MAX_FIGURE_BYTES) throw new LibraryError('bad-input', `図は ${MAX_FIGURE_BYTES / 1000000} MB まで`);
  const file = `fig-${sha1(data).slice(0, 12)}.${ext}`, dir = path.join(lib.shortDir(shortId), 'figures');
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, file), data);
  return {file};
}

// カットから外れた図のファイルを消す(カットを消した、図を外した、作り直した)。前のカット表にあって今は無いものだけを見るので、送ったばかりでまだカットに入っていない図は消さない。
//   順番待ちや実行中の書き出しは積んだ時点のカット表を使うので、それが指す図は残す
export async function dropFigures(lib, shortId, before, after, active) {
  const files = short => short.cuts.map(c => c.figure).filter(Boolean), keep = new Set([...files(after), ...active.flatMap(j => (j.type === 'short' && j.input.shortId === shortId ? files(j.input.short) : []))]);
  for (const f of new Set(files(before))) if (!keep.has(f)) await fs.rm(path.join(lib.shortDir(shortId), 'figures', f), {force: true});
}

// 編集画面の保存。作った図をまだ読んでいない画面の保存で、その図を消さない
export async function saveShortEdit(lib, shortId, body, active) {
  let before;
  const saved = await lib.updateShort(shortId, stored => { before = stored; keepMadeFigures(stored, body); return body; });
  await dropFigures(lib, shortId, before, saved, active);
  return saved;
}

// 書き出し済みの合成のフォルダのうち新しい方。無ければ null
export async function shortCompose(lib, shortId) {
  const dir = lib.shortDir(shortId), found = [];
  for (const quality of Object.keys(MV_QUALITIES)) {
    const compose = path.join(dir, 'work', quality, 'compose'), stat = await fs.stat(path.join(compose, 'base.mp4')).catch(() => null);
    if (stat) found.push({quality, compose, tJson: path.join(dir, 'work', quality, 't.json'), time: stat.mtimeMs});
  }
  return found.sort((a, b) => b.time - a.time)[0] ?? null;
}

// 書き出しの時間表(work/<quality>/t.json)から、編集画面がカットの頭へ飛ぶのに要る所だけ返す。無ければ not-found
export async function shortTimes(lib, shortId, quality) {
  pick(quality, Object.keys(MV_QUALITIES), 'quality');
  const t = await readJsonOr(path.join(lib.shortDir(checkId(shortId, 'ショート ID')), 'work', quality, 't.json'));
  if (!t) throw new LibraryError('not-found', `${quality} の書き出しの時間表が無い`);
  return {quality, seconds: t.seconds, cuts: t.cuts.map(c => ({start: c.start, end: c.end, voice: c.voice ? {start: c.voice.start, seconds: c.voice.seconds} : null})), sfx: t.sfx.map(q => ({t: q.t, name: q.name})), hush: t.hush ?? []};
}

// 編集画面のプレビュー: 書き出し済みの base と音に、今のカット表の文字と演出を重ねる。声やカットの数が変わっていれば書き出しが要る。転換と効果音は書き出しで変わる
export async function shortPreview(lib, shortId) {
  const short = await lib.getShort(shortId), dir = lib.shortDir(shortId), pick = await shortCompose(lib, shortId), saved = pick && await readJsonOr(pick.tJson);
  if (!saved) throw new LibraryError('not-found', '書き出したカットが無い。試しを書き出すと見られる');
  const same = saved.cuts.length === short.cuts.length && short.cuts.every((c, i) => plainText(c.text) === saved.cuts[i].text);
  if (!same) throw new LibraryError('busy', 'セリフかカットの数が変わった。試しを書き出すと見られる');
  const cast = castOf(short), said = useDialogue(short, cast) ? spokenLines(short, cast) : null, stored = said && await storedDialogue(lib, said);
  if (said && !stored) throw new LibraryError('busy', '声が変わった。試しを書き出すと見られる');
  const speech = stored ? placeLines(short, said, stored) : await Promise.all(short.cuts.map(async c => {
    const line = plainText(c.text);
    if (!line) return null;
    const voice = await storedVoice(lib, {...cast[Math.max(0, speakerOf(cast, c))], tone: c.tone}, line, path.join(dir, 'voice'));
    if (!voice) throw new LibraryError('busy', '声が変わった。試しを書き出すと見られる');
    return voice;
  }));
  const timed = short.cuts.map((c, i) => { const heard = speakerOf(cast, c), slot = Math.max(0, heard); return {...c, id: saved.cuts[i].id, start: saved.cuts[i].start, end: saved.cuts[i].end, count: saved.cuts[i].count, voiceAt: saved.cuts[i].voice?.start ?? saved.cuts[i].start, slot, side: cast.length === 2 && heard >= 0 ? (slot ? 1 : -1) : 0}; });
  const timeline = {...buildTimeline({short, timed, speech, width: saved.width, height: saved.height, fps: saved.fps, cast}), ...(short.style === 'dance' && short.music?.look === 'graphic' ? {grade: false} : {})};   // 書き出しと同じく、グラフィックは色味もビネットも付けない
  timeline.cuts.forEach(c => { if (c.insertFrom) c.insert = `insert-${c.insertFrom}.jpg`; });
  return compositionHtml(timeline, {runtime: await fxScript(), vendorRuntime: '/app/vendor/hyperframe.runtime.iife.js'});
}
