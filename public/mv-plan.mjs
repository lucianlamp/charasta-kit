// MV の条件の値とカット割りの計算。MV の画面と lib/mv.mjs が同じものを使う。THREE も DOM も使わない(テストが読み込める)。
export const MV_FPS = 30;
export const BEATS_PER_SHOT = [4, 8, 16], SHOTS_PER_SCENE = [1, 2];
// 試しと本番。frameSec、sceneSec は 1 コマと 1 シーンの読み込みの実測(RTX 4070)。画面の目安と時間の上限に使う
// 本番は 64 サンプル(2026-11-05 に 128 と比べた。原寸でも差が見えず、ちらつきの増加は 3% 以内、1 コマ約 3 割短い)
export const MV_QUALITIES = {
  preview: {label: '試し', pct: 40, samples: 32, width: 432, height: 768, frameSec: 0.5, sceneSec: 15},
  final: {label: '本番', pct: 100, samples: 64, width: 1080, height: 1920, frameSec: 3.2, sceneSec: 15},
};

// 書き出しにかかる秒の目安
export function mvEstimateSec(quality, seconds, scenes) {
  const q = MV_QUALITIES[quality];
  return 60 + scenes * q.sceneSec + seconds * MV_FPS * q.frameSec;
}

// カット割り。stage-studio の lib/shots.py の plan と assign_stages と同じ切り方。音声があると本番の拍は曲から求めるので、画面の表示は目安になる
export function mvCuts({seconds, bpm, stages, beatsPerShot = 8, shotsPerScene = 1}) {
  const step = 60 / bpm, cuts = [0];
  for (let i = beatsPerShot; i * step < seconds - 0.6; i += beatsPerShot) cuts.push(i * step);
  cuts.push(seconds);
  return cuts.slice(1).map((end, k) => ({start: cuts[k], end, stage: stages.length ? stages[Math.floor(k / shotsPerScene) % stages.length] : null}));
}

// ---- ダンス MV のショート(型 dance)の編集画面の計算。docs/shorts-dance-mv.md ----
export const DANCE_MUSIC_DEFAULTS = {bpm: 120, seed: 1, beatsPerShot: 8, shotsPerScene: 1, audioStart: 0, look: 'anime'};
export const DANCE_SECONDS = {min: 3, initial: 15};
const round6 = n => Math.round(n * 1e6) / 1e6;

// 保存したカットの秒の累積。lib/dance.mjs の danceBounds と同じ(画面の帯と書き出しの秒をそろえる)
export function danceCutBounds(cuts) {
  let t = 0;
  return cuts.map(c => { const start = t; t = round6(t + (Number(c.seconds) || 0)); return {start, end: t}; });
}
export const danceTotal = cuts => danceCutBounds(cuts).at(-1)?.end ?? 0;

// 「拍から割る」(POST /api/shorts/<id>/beat-cuts)の本文。music の値と、欄の長さ(秒)
export function beatCutsBody(music, seconds) {
  const m = {...DANCE_MUSIC_DEFAULTS, ...music};
  return {stages: m.stages ?? [], seconds, bpm: m.bpm, seed: m.seed, beatsPerShot: m.beatsPerShot, shotsPerScene: m.shotsPerScene, audioStart: m.audioStart, ...(m.motionId ? {motionId: m.motionId} : {})};
}

// 拍から割ったときの値と比べる欄。手で変えると、stage-studio の make_mv.py が --shots-in を受けないうちは書き出しで止まる
export const DANCE_SPLIT_FIELDS = [['stage', 'ステージ'], ['camera', 'カメラ'], ['angle', '角度']];
export const danceSplitOf = c => ({stage: c.stage, camera: c.camera, angle: Number(c.angle) || 0});
// base(割ったときの値)から変わった欄の名前。base が無ければ空
export function danceEdits(cut, base) {
  if (!base) return [];
  const now = danceSplitOf(cut);
  return DANCE_SPLIT_FIELDS.filter(([k]) => now[k] !== base[k]).map(([, label]) => label);
}

// 割る条件(曲、シーン、テンポなど)が、最後に割ったときから変わったか。last が無ければ(まだ割っていない)変わった扱い
export const splitConditions = (music, seconds, audioId) => {
  const m = {...DANCE_MUSIC_DEFAULTS, ...music};
  return JSON.stringify([m.stages ?? [], m.motionId ?? null, m.bpm, m.seed, m.beatsPerShot, m.shotsPerScene, m.audioStart, Number(seconds) || 0, audioId ?? null]);
};

// シーンを押したときの並び。押した順に足し、もう一度押すと外す。空になったら undefined(music.stages は空の配列を受けない)
export function toggleStage(stages, id) {
  const list = [...(stages ?? [])], i = list.indexOf(id);
  if (i < 0) list.push(id); else list.splice(i, 1);
  return list.length ? list : undefined;
}

// #mv/<キャラ>[/<バージョン>] から作るダンス MV のショートの本文(POST /api/dance-shorts)
export const danceShortBody = (char, verId) => ({charId: char.id, ...(verId ? {verId} : {}), title: `${char.name ?? char.id} のダンス MV`});

// ---- グラフィック MV(music.look === 'graphic')。docs/shorts-graphic-mv.md の「グラフィック」 ----
// 試しと本番。試しは踊る人を pct 50、16 サンプルで描き、1080x1920 の配置のまま重ねて 540x960 に縮める。本番は試作 v12 と同じ
//   sec は 1 コマあたりの秒(踊る人は描き方ごと、重ねるは CPU 8 並列)。本番は v12 の実測(RTX 4070、18 秒)。試しは 8 秒の実測で、Blender の起動を含む(docs/notes/shorts-graphic-mv.md)
export const GRAPHIC_QUALITIES = {
  preview: {label: '試し', pct: 50, samples: 16, width: 540, height: 960, sec: {full: 0.44, mid: 0.83, face: 0.57, compose: 0.16}, encode: 20},
  final: {label: '本番', pct: 100, samples: 64, width: 1080, height: 1920, sec: {full: 1.25, mid: 1.8, face: 2.69, compose: 0.23}, encode: 40},
};
export const GRAPHIC_WORDS = ['MOVE', 'STEP', 'TURN', 'FEEL', 'BEAT', 'RHYTHM', 'KICK', 'DANCE'];
// 色の組。pop は試作の 5 色、mono は灰色の濃淡。chara はバージョンのサムネイルからサーバーが求める(lib/graphic-mv.mjs の charaPalette)
export const GRAPHIC_PALETTES = {
  pop: {bg: ['#FFE600', '#19D3FF', '#2337FF'], ink: '#0E0E14', accent: '#FF2D87', light: '#F3F0E8'},
  mono: {bg: ['#EDEDED', '#A8A8A8', '#3C3C3C'], ink: '#111111', accent: '#7A7A7A', light: '#F7F7F7'},
};
const passesOf = (catalog, scene) => catalog.find(s => s.id === scene)?.passes ?? ['full'];

// 描き方ごとの時間の割合 {full, mid, face}(カットの秒から。ワイプの重なりは数えない)
export function graphicShares(cuts, catalog) {
  const total = cuts.reduce((s, c) => s + (Number(c.seconds) || 0), 0) || 1, out = {full: 0, mid: 0, face: 0};
  for (const c of cuts) for (const p of passesOf(catalog, c.scene)) out[p] += (Number(c.seconds) || 0) / total;
  return out;
}

// 書き出しにかかる秒の目安: 60 + 秒×30×(描き方ごとの 1 コマの秒×割合) + 秒×30×重ねる + まとめる
export function graphicEstimateSec(quality, seconds, shares = {full: 1, mid: 0, face: 0}) {
  const q = GRAPHIC_QUALITIES[quality], n = seconds * MV_FPS;
  return 60 + n * (q.sec.full * shares.full + q.sec.mid * shares.mid + q.sec.face * shares.face) + n * q.sec.compose + q.encode;
}

// カットごとの言葉。word があればそれ(/ で区切る)、無ければ text.words を場面の言葉の枠の数だけ順に配る(stage-studio の plan.assign_words と同じ)
export function graphicWords(cuts, catalog, words = GRAPHIC_WORDS) {
  const list = words?.length ? words : GRAPHIC_WORDS;
  let k = 0;
  return cuts.map(c => {
    const n = catalog.find(s => s.id === c.scene)?.words ?? 0, own = c.word ? String(c.word).split('/').map(x => x.trim()).filter(Boolean) : null;
    const out = own ?? Array.from({length: n}, (_, i) => list[(k + i) % list.length]);
    k += n;
    return out;
  });
}

// 「拍から割る」の本文(グラフィック)。シーンは要らない
export function graphicCutsBody(music, seconds) {
  const m = {...DANCE_MUSIC_DEFAULTS, ...music};
  return {seconds, bpm: m.bpm, seed: m.seed, audioStart: m.audioStart, look: 'graphic', ...(m.motionId ? {motionId: m.motionId} : {})};
}

// 演出ごとに編集画面で出す欄。グラフィックは 3D の舞台(シーン)、カメラ、カットのテロップを隠し(文字は絵の一部)、グラフィックの欄を出す
export const danceFieldsFor = look => (look === 'graphic'
  ? {scenes: false, camera: false, telop: false, graphic: true, cutLength: false}
  : {scenes: true, camera: true, telop: true, graphic: false, cutLength: true});
// 演出を graphic とほかの間で変えると、カットの形(scene と stage/camera)が変わるので割り直す
export const looksSplitApart = (a, b) => (a === 'graphic') !== (b === 'graphic');
