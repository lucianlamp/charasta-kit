// きゃらすたのビューア: VRMA の再生、自動まばたき、モーションに合わせた表情（motion.json の expressions）、
// あいうえお、かなの文を話す、セリフ（line.json）の再生とリップシンク。キャラと版は画面の中で切り替える。
// 移植元: charakuru-claude-code-with-kimi の scripts/viewer/viewer.mjs。window.viewer の名前と振る舞いは同じ。
import * as THREE from 'three';
import {GLTFLoader} from '/vendor/GLTFLoader.js';
import {OrbitControls} from '/vendor/OrbitControls.js';
import {VRMLoaderPlugin, VRMUtils} from '/vendor/three-vrm.module.js';
import {VRMAnimationLoaderPlugin, createVRMAnimationClip} from '/vendor/three-vrm-animation.module.js';
import {footPlanFor, applyFootLayers} from '/app/foot-ik.mjs';
import {springParts} from '/app/spring-clock.mjs';
import {WEAPONS, handGrip, buildWeapon, weaponParts} from '/app/weapon.mjs';
import {fitFull, frameHead, distanceFor, smoothTrack, trackAt, zoomTrack} from '/app/shoot-plan.mjs';

const canvas = document.getElementById('view'), statusEl = document.getElementById('status'), overlay = document.getElementById('overlay');
// 画面の上に出す知らせ（スマホにはコンソールがないので、読み込みの進み具合とエラーをここに出す）
function note(text, kind = 'info', key = kind) {
  let el = overlay.querySelector(`[data-key="${key}"]`);
  if (!text) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.dataset.key = key; overlay.append(el); }
  el.className = kind; el.textContent = text;
}
addEventListener('error', e => note('エラー: ' + (e.message || e.error), 'err', 'err'));
addEventListener('unhandledrejection', e => note('エラー: ' + (e.reason?.message || e.reason), 'err', 'err'));
canvas.addEventListener('webglcontextlost', () => note('WebGL が止まった（端末のメモリが足りない可能性）。版を軽いものにするか、読み込み直す。', 'err', 'gl'));
const renderer = new THREE.WebGLRenderer({canvas, antialias: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ? 1.5 : 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
// ?embed=1: きゃらすたの画面(動き、完成モデル)の iframe の中で、キャンバスだけを出す(docs/screens.md)。背景は周りの画面の色に合わせる
const EMBED = new URLSearchParams(location.search).get('embed') === '1';
if (EMBED) document.body.classList.add('embed');
const BACKGROUND = EMBED ? 0x0b0d10 : 0x11151c;
const scene = new THREE.Scene(); scene.background = new THREE.Color(BACKGROUND);
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
const controls = new OrbitControls(camera, canvas);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 2, 2); scene.add(sun);
const grid = new THREE.GridHelper(4, 16, 0x334455, 0x222a33); scene.add(grid);
const CELL = 4 / 16;   // グリッドの 1 マス（m）

const loader = new GLTFLoader();
loader.register(p => new VRMLoaderPlugin(p)); loader.register(p => new VRMAnimationLoaderPlugin(p));
const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'blinkLeft', 'blinkRight'];
const EMOTION_LABELS = {happy: 'happy（喜び）', angry: 'angry（怒り）', sad: 'sad（悲しみ）', relaxed: 'relaxed（安らぎ）',
  surprised: 'surprised（驚き）', blinkLeft: 'blinkLeft（左ウインク）', blinkRight: 'blinkRight（右ウインク）'};
// 口の形（VRM 1.0 のビセーム）: ボタンで 1 つを保つ。「話す」は打ったかなの母音を 1 拍 MORA 秒で出す
const VISEMES = {aa: 'あ', ih: 'い', ou: 'う', ee: 'え', oh: 'お'};
const MORA = 0.17, VEASE = 0.06;
const ROWS = {aa: 'あかさたなはまやらわがざだばぱぁゃゎアカサタナハマヤラワガザダバパァャヮ', ih: 'いきしちにひみりぎじぢびぴぃイキシチニヒミリギジヂビピィ',
  ou: 'うくすつぬふむゆるぐずづぶぷぅゅゥクスツヌフムユルグズヅブプゥュヴ', ee: 'えけせてねへめれげぜでべぺぇエケセテネヘメレゲゼデベペェ', oh: 'おこそとのほもよろをごぞどぼぽぉょオコソトノホモヨロヲゴゾドボポォョ'};
let visManual = null, speech = null, voice = null;
// 口は一度に 1 つの形だけ。新しい形は今の開きのまま入れ替わり（下げてから上げると、重ねた口の途中のコマが
// 閉じて見える）、開きだけがなめらかに変わる。句の中の ん・っ と拍の間は前の形を少し開けたまま（SOFT）、
// 閉じるのは声が途切れた所だけ。
let lingerEmotion = null; const EMO_HOLD = 1.0;   // セリフの感情は、声が終わってからこの秒数残す
const mouth = {v: null, w: 0}, SOFT = 0.1;
let elapsed = 0;

// ---- 保管場所の URL（サーバーが URL を足していなければ、保管場所の形から組み立てる） ----
const lib = (...parts) => '/lib/' + parts.map(encodeURIComponent).join('/');
// スマホでは軽い VRM（画像を縮めたもの）を読む。?full=1 で元の VRM、?lite=1 でパソコンでも軽い VRM
const QS = new URLSearchParams(location.search);
const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const LITE = QS.get('full') === '1' ? false : QS.get('lite') === '1' || MOBILE;
const modelUrl = (charId, v) => (LITE && v.modelLite) || v.model || v.modelUrl || lib('characters', charId, 'versions', v.id, 'model.vrm');
const audioUrl = (charId, l) => l.audioUrl || l.url || (/^\/|^https?:/.test(l.audio || '') ? l.audio : lib('characters', charId, 'lines', l.id, l.audio || 'audio.mp3'));
const motionUrl = m => m.file || m.fileUrl || m.url || lib('motions', m.id, 'motion.vrma');

let chars = [], character = null, version = null, lines = [], motions = [];
const motionById = new Map();

// セリフの音声に口を合わせる: 10ms ごとの音量（RMS）から声の区間を求める。セリフ（かな）は句読点で句に分け、
// 声の区間は PAUSE 秒を超える間で区切りに分ける。句と区切りの数が合えば、句ごとに拍をその区切りの声の時間へ
// 割り当てる（合わなければ全部の拍を全部の声の時間へ）。口の開きは音量に合わせる。
const PAUSE = 0.2;
let audioCtx = null;
function findLine(x) {   // セリフ（line.json の形）、セリフの ID、音声のファイル名、音声の URL のどれでもよい
  if (x && typeof x === 'object') return x;
  const s = String(x);
  const l = lines.find(l => l.id === s) || lines.find(l => l.audio === s || audioUrl(character?.id, l) === s);
  if (l) return l;
  if (s.startsWith('/')) return {id: s.split('/').pop(), text: '', emotion: null, audioUrl: s};
  throw Error(`セリフ ${s} がない（キャラ ${character?.id ?? '-'}）`);
}
// iPhone の Safari は、押してから時間の空いた再生を止める。押した時点で同期的に再生を始め、口の計画は後から
// 追いつかせる（口は audio.currentTime を見るのでずれない）。計画と <audio> はセリフごとに使い回す。
const voicePlans = new Map();   // url -> {audio, env, peak, plan, emotion, line}
async function playVoice(lineOrId, silent = false) {   // silent: 計画だけ作る。window.viewer.voice.time を手で進める（撮影）
  const line = findLine(lineOrId), url = audioUrl(character?.id, line);
  let cached = voicePlans.get(url);
  const audio = cached?.audio || new Audio(url);
  let started = null;
  if (!silent) {
    if (voice && voice.audio !== audio) voice.audio.pause();
    audio.currentTime = 0; started = audio.play();   // ここまで await なし（押した操作の中で再生を始める）
    started.catch(e => note('音声を再生できない: ' + e.message, 'err', 'audio'));
  }
  if (cached) { startVoice(cached, audio, silent); if (started) await started; return; }
  const buf = await fetch(url).then(r => { if (!r.ok) throw Error(`${url}: ${r.status}`); return r.arrayBuffer(); });
  audioCtx ??= new AudioContext();
  const ab = await audioCtx.decodeAudioData(buf.slice(0)); const d = ab.getChannelData(0), sr = ab.sampleRate;
  const hop = Math.round(sr * 0.01), env = [];
  for (let i = 0; i + hop <= d.length; i += hop) { let s2 = 0; for (let j = i; j < i + hop; j++) s2 += d[j] * d[j]; env.push(Math.sqrt(s2 / hop)); }
  const peak = Math.max(...env), on = env.map(e => e > Math.max(peak * 0.04, 0.003));
  let spans = [];
  for (let i = 0, s0 = -1; i <= on.length; i++) { if (on[i] && s0 < 0) s0 = i; if (!on[i] && s0 >= 0) { spans.push([s0 / 100, i / 100]); s0 = -1; } }
  spans = spans.reduce((a, s1) => { const l = a[a.length - 1]; if (l && s1[0] - l[1] < 0.08) l[1] = s1[1]; else a.push([...s1]); return a; }, [])
    .filter(s1 => s1[1] - s1[0] >= 0.05);
  const groups = [];
  for (const s1 of spans) { const g = groups[groups.length - 1]; if (g && s1[0] - g[g.length - 1][1] < PAUSE) g.push(s1); else groups.push([s1]); }
  // 口は読み（かな）で動かす。読みが無ければ文。感情は line.emotion。古い形の「[happy] 文」も読む
  let text = line.reading?.trim() || line.text || ''; const tag = /^\s*\[(\w+)\]\s*/.exec(text); if (tag) text = text.slice(tag[0].length);
  const emotion = line.emotion || (tag ? tag[1] : null);
  const phrases = text.split(/[、。！？!?,.\s]+/).map(morae).filter(m => m.some(Boolean));
  const plan = [];   // [start, end, viseme | null]
  const spread = (ms, gs) => {
    const tot = gs.reduce((a, s1) => a + s1[1] - s1[0], 0); let k = 0;
    gs.forEach((s1, gi) => {
      const n = gi === gs.length - 1 ? ms.length - k : Math.round(ms.length * (s1[1] - s1[0]) / tot);
      const part = ms.slice(k, k + n); k += part.length;
      part.forEach((v, i) => plan.push([s1[0] + (s1[1] - s1[0]) * i / part.length, s1[0] + (s1[1] - s1[0]) * (i + 1) / part.length, v]));
      for (let j = plan.length - part.length; j < plan.length; j++) if (!plan[j][2]) { const prev = plan[j - 1]?.[2] ?? plan[j + 1]?.[2]; if (prev) plan[j] = [plan[j][0], plan[j][1], prev, true]; }
    });
  };
  if (phrases.length && phrases.length === groups.length) phrases.forEach((m, i) => spread(m, groups[i]));
  else if (phrases.length) spread(phrases.flat(), spans);
  else spans.forEach(s1 => plan.push([s1[0], s1[1], 'aa']));
  const envS = env.map((_, i) => { let a = 0, n = 0; for (let j = Math.max(0, i - 2); j <= Math.min(env.length - 1, i + 2); j++) { a += env[j]; n++; } return a / n; });
  cached = {audio, env: envS, peak: Math.max(...envS), plan, file: line.id, line, emotion}; voicePlans.set(url, cached);
  statusEl.textContent = `${line.id}: 声の区間 ${spans.length}、区切り ${groups.length}、句 ${phrases.length}`;
  startVoice(cached, audio, silent);
  if (started) await started;
}
function startVoice(c, audio, silent) {
  if (voice && voice.audio !== audio && !silent) voice.audio.pause();
  speech = null; visManual = null; note(null, 'err', 'audio');
  voice = {...c, audio};
  audio.onended = () => { if (voice?.audio === audio) { lingerEmotion = {name: c.emotion, until: elapsed + EMO_HOLD}; voice = null; } };
}
function morae(text) {   // かな -> 拍ごとの [viseme | null]。小さい ゃゅょ は前の拍の母音を置き換える
  const seq = [];
  for (const ch of text) {
    const v = Object.keys(ROWS).find(k => ROWS[k].includes(ch));
    if ('ゃゅょャュョぁぃぅぇぉァィゥェォ'.includes(ch) && seq.length) { seq[seq.length - 1] = v; continue; }
    if (ch === 'ー' || ch === '〜') { seq.push(seq[seq.length - 1] ?? null); continue; }
    seq.push(v ?? null);   // ん、っ、記号、空白は 1 拍ぶん口を閉じる
  }
  return seq;
}
function speak(text) {
  const seq = morae(text);
  voice?.audio.pause(); voice = null; visManual = null; document.querySelectorAll('#visemes button').forEach(c => c.classList.remove('on'));
  speech = {seq, t0: elapsed, text: [...text].filter(ch => !'ゃゅょャュョぁぃぅぇぉァィゥェォ'.includes(ch))};
}

let vrm, mixer, current = null, currentName = '', manual = null;
const springCenter = new THREE.Object3D(); scene.add(springCenter);
// 揺れを今の姿勢のまま落ち着いた形へ戻す。基準の点は hips に合わせる（呼ぶ前に trackHips で hips の位置を取る）
function resetSpring() {
  springCenter.position.set(hipsNow.x, 0, hipsNow.z); springCenter.updateMatrixWorld(true);
  vrm.update(0); vrm.scene.updateMatrixWorld(true); vrm.springBoneManager?.reset();
}
window.viewer = {get vrm() { return vrm; }, get motion() { return currentName; }, camera, controls,
  get character() { return character?.id ?? null; }, get version() { return version?.id ?? null; }};   // コンソールから調べる用
// カメラの追従: hips の水平の位置（x, z）が動いた分だけ、カメラと OrbitControls の target を同じ量だけ動かす。
// 高さは追わない（しゃがみやジャンプで画面が上下しない）。回した向きと寄った距離はそのまま残る。
// グリッドは 1 マス単位でキャラの真下へ寄せる（線は床に止まって見え、キャラが端から出ない）。
// 照明は半球光と影のない平行光だけなので、位置で明るさは変わらない。
// 既定でオン。?follow=0、画面のチェック、window.viewer.follow = false で切る（撮影の道具は ?follow=0 で開く）。
const followBox = document.getElementById('follow');
followBox.checked = QS.get('follow') !== '0';
let followFrom = null;   // 前のフレームの hips の水平の位置（null: 次のフレームを起点にする）
followBox.onchange = () => { followFrom = null; };
Object.defineProperty(window.viewer, 'follow', {get: () => followBox.checked, set: on => { followBox.checked = !!on; followFrom = null; }});
// 接地中の足を床に留める IK（docs/foot-ik.md）。既定でオン。?footik=0、画面のチェック、window.viewer.footIK = false で切る。
// window.viewer.footPlan は今のモーションの計画（source: 'contacts' は横の情報、'height' は足の高さと速さで判定、spans は接地の区間）。
const footBox = document.getElementById('footik');
footBox.checked = QS.get('footik') !== '0';
const footPlans = new Map();   // モーションの ID -> 今のキャラの計画（留めないモーションは null）。オフの間は作らない
let fading = [];               // フェードアウト中の前のアクションと、その計画 {action, plan}
// オフの間に再生を始めたモーションは計画が無いので、オンにしたときに今のモーションの分を作る
async function footPlanNow() {
  const name = currentName, owner = vrm;
  if (!footBox.checked || !clips.has(name) || footPlans.has(name)) return;
  const plan = await footPlanFor(motionById.get(name), owner, clips.get(name));
  if (vrm === owner) footPlans.set(name, plan);
}
footBox.onchange = () => footPlanNow().catch(fail);
Object.defineProperty(window.viewer, 'footIK', {get: () => footBox.checked, set: on => { footBox.checked = !!on; footPlanNow().catch(fail); }});
Object.defineProperty(window.viewer, 'footPlan', {get: () => footPlans.get(currentName) ?? null});
const hipsPos = new THREE.Vector3();
const snapGrid = (x, z) => grid.position.set(Math.round(x / CELL) * CELL, 0, Math.round(z / CELL) * CELL);
function follow() {
  if (!followBox.checked || !vrm) return;
  vrm.humanoid.getRawBoneNode('hips').getWorldPosition(hipsPos); hipsPos.y = 0;
  if (followFrom) { const d = hipsPos.clone().sub(followFrom); camera.position.add(d); controls.target.add(d); }
  followFrom = hipsPos.clone();
  snapGrid(hipsPos.x, hipsPos.z);
}
// 再生のバーから使う: time(今の位置の秒)、duration(長さの秒)、seek(秒)、hold(true で止める。paused と違い、止めた姿勢にも足の IK をかける)
Object.defineProperty(window.viewer, 'time', {get: () => current ? current.time % current.getClip().duration : 0});
Object.defineProperty(window.viewer, 'duration', {get: () => current?.getClip().duration ?? 0});
window.viewer.seek = t => { if (current) { current.time = t; mixer.update(0); advance(0, 0, true); } };   // 足の IK をかけた姿勢で揺れを戻す（次のコマで hips が動かない）
// 表情を確かめる顔の寄り: window.viewer.face(距離 = 0.45)。window.viewer.paused = true でモーションを止める
// （window.viewer.vrm.humanoid.resetNormalizedPose() のあとは休めの姿勢）
window.viewer.face = (d = 0.45) => {
  const h = vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new THREE.Vector3()); h.y += 0.07;
  controls.target.copy(h); camera.position.set(h.x, h.y, h.z + d); controls.update();
};
const clips = new Map();

// ---- 武器(public/weapon.mjs)。手の骨の子にするので、モーションにも足の IK にもそのままついていく ----
// 手の骨の座標は体ごとに違うので、休めの姿勢の世界の座標で置いてから手の骨の座標へ直す。?weapon=<ID>、画面のボタン、window.viewer.weapon で選ぶ。
const WEAPON_HIPS = 1.9;   // 武器の大きさは身長が基準だが、頭が大きいチビの体は腰の高さのこの倍までにする(身長のままだと剣が床を突き抜ける)
const FINGER_NAMES = ['Index', 'Middle', 'Ring', 'Little'], JOINT_NAMES = ['Proximal', 'Intermediate', 'Distal'];
let handRest = null, weaponId = WEAPONS[QS.get('weapon')] ? QS.get('weapon') : 'none', weaponObj = null, weaponSub = [], weaponRest = null, otherFist = null;
// 休めの姿勢の手と指の位置。loadModel がモーションを当てる前に取る
function measureHand(side) {
  const raw = n => vrm.humanoid.getRawBoneNode(n), at = n => raw(n)?.getWorldPosition(new THREE.Vector3()).toArray();
  const fingers = Object.fromEntries(FINGER_NAMES.map(f => [f, Object.fromEntries(JOINT_NAMES.map(j => [j, at(`${side}${f}${j}`)]))]));
  return {hand: at(side + 'Hand'), lowerArm: at(side + 'LowerArm'), fingers, toHand: raw(side + 'Hand').matrixWorld.clone().invert()};
}
function wearWeapon() {
  for (const o of [weaponObj, ...weaponSub]) if (o) { o.removeFromParent(); VRMUtils.deepDispose(o); }
  weaponObj = null; weaponSub = []; otherFist = null;
  document.querySelectorAll('#weapons button').forEach(b => b.classList.toggle('on', b.dataset.weapon === weaponId));
  const w = WEAPONS[weaponId];
  if (!vrm || !w.hand) return;
  const [main, ...rest2] = weaponParts(weaponId, handRest).map(p => {
    const y = new THREE.Vector3(...p.axis), x = new THREE.Vector3(...p.lie), o = buildWeapon(THREE, p.id, rest.reach, rest.height);
    new THREE.Matrix4().copy(handRest[p.hand].toHand).multiply(new THREE.Matrix4().makeBasis(x, y, x.clone().cross(y)).setPosition(...p.center))
      .decompose(o.position, o.quaternion, o.scale);
    vrm.humanoid.getRawBoneNode(p.hand + 'Hand').add(o);
    return o;
  });
  weaponObj = main; weaponSub = rest2;
  weaponRest = weaponObj.quaternion.clone();
  otherFist = w.both ? new THREE.Vector3(...handGrip(handRest.left, 'left').center).applyMatrix4(handRest.left.toHand) : null;   // 左手の骨の座標の、左の拳の穴
}
// 両手で握るモーションは素材ごとに柄と手の角度が違うので、柄を持つ手の拳からもう一方の拳へ向ける。手が離れた間は持つ手の向きへ戻す
const BOTH_NEAR = 0.2, BOTH_FAR = 0.3;   // 拳の間の距離(m)。BOTH_NEAR までは向け切り、BOTH_FAR から先は向けない
const AIM = {hand: new THREE.Quaternion(), to: new THREE.Quaternion(), tip: new THREE.Vector3(), from: new THREE.Vector3(), other: new THREE.Vector3()};
function aimWeapon() {
  if (!otherFist) return;
  const {hand, to, tip, from, other} = AIM, right = weaponObj.parent;
  right.updateWorldMatrix(true, false); vrm.humanoid.getRawBoneNode('leftHand').updateWorldMatrix(true, false);
  weaponObj.quaternion.copy(weaponRest); weaponObj.updateMatrixWorld();
  from.setFromMatrixPosition(weaponObj.matrixWorld); tip.setFromMatrixColumn(weaponObj.matrixWorld, 1).normalize();
  other.copy(otherFist).applyMatrix4(vrm.humanoid.getRawBoneNode('leftHand').matrixWorld).sub(from).negate();   // もう一方の拳から持つ手の拳へ
  const gap = other.length(), {smoothstep} = THREE.MathUtils;
  if (gap < 1e-6) return;
  other.normalize();
  // 向ける強さは連続に変える。打ち切ると、拳を結ぶ線が柄と直交に近い動き(手を合わせるなど)で剣が 1 コマで 90 度跳ぶ
  const near = smoothstep(BOTH_FAR - gap, 0, BOTH_FAR - BOTH_NEAR) * smoothstep(gap, 0.02, 0.06) * smoothstep(other.dot(tip), 0, 0.5);
  if (near === 0) return;
  right.getWorldQuaternion(hand);
  to.setFromUnitVectors(tip, other).slerp(AIM.none ??= new THREE.Quaternion(), 1 - near);
  weaponObj.quaternion.copy(hand).invert().multiply(to).multiply(hand).multiply(weaponRest);
}
Object.defineProperty(window.viewer, 'weapon', {get: () => weaponId, set: id => {
  if (!WEAPONS[id]) throw Error(`武器 ${id} がない`);
  weaponId = id; wearWeapon(); if (character) setUrl();
}});

// ---- 撮る(撮る画面のプレビューと tools/shoot.mjs が同じカメラにする。計算は public/shoot-plan.mjs) ----
let rest = null, shotTrack = null;   // 休めの姿勢の体の寸法(loadModel が測る)。上半身と顔でカメラが追う頭の道筋
const SHOT_SAMPLE = 1 / 15, SHOT_SMOOTH = 0.3;   // 測る間隔、頭の道筋をならす前後の幅(秒)
const SHOT_BONES = ['neck', 'chest', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes'];
// 今の姿勢の頭、手足の位置を点にする
function shotSample(t) {
  const h = vrm.humanoid, at = n => h.getRawBoneNode(n)?.getWorldPosition(new THREE.Vector3()), head = at('head'), pad = rest.height * 0.04;
  const pts = [{x: head.x, y: head.y, z: head.z, rx: rest.headTop * 0.8, ry: rest.headTop}];
  for (const n of SHOT_BONES) {
    const p = at(n), r = /Hand/.test(n) ? pad * 1.8 : pad;
    if (p) pts.push({x: p.x, y: p.y, z: p.z, rx: r, ry: r});
  }
  return {t, head, hips: at('hips'), pts};
}
// 今のモーションを最初から最後まで測り、カメラを置く。カメラは測った道筋を step の中で追う。
// 全身は体の左右の幅の真ん中(足を大きく出すと hips から離れるので、hips を追うより寄れる)と hips の前後を追い、高さは動かさない。
// 上半身と顔は頭を追う。道筋はならしてあるので、細かい揺れはカメラに出ない。床のグリッドは 1 マス単位で寄せる
window.viewer.aimShot = ({framing, aspect}) => {
  const fov = camera.fov, full = framing === 'full', dur = current?.getClip().duration ?? 0, times = [0];
  for (let t = SHOT_SAMPLE; t < dur; t += SHOT_SAMPLE) times.push(t);
  const samples = times.map(t => {
    if (current) window.viewer.seek(t);
    vrm.humanoid.update(); vrm.scene.updateMatrixWorld(true);
    return shotSample(t);
  });
  if (current) window.viewer.seek(0);
  const midX = pts => (Math.min(...pts.map(p => p.x - p.rx)) + Math.max(...pts.map(p => p.x + p.rx))) / 2;
  const path = smoothTrack(samples.map(s => full ? [s.t, midX(s.pts), 0, s.hips.z] : [s.t, s.head.x, s.head.y, s.head.z]), SHOT_SMOOTH);
  const {cy, dist} = full ? fitFull(samples.flatMap((s, i) => s.pts.map(p => ({...p, x: p.x - path[i][1], z: p.z - path[i][3]}))), {fov, aspect})
    : (({frameH, dy}) => ({cy: dy, dist: distanceFor(frameH, fov)}))(frameHead(framing, rest, aspect));
  // 全身は、広がる瞬間だけ引き、それ以外は寄る(縦長の枠は足を蹴り出した幅で距離が決まり、固定だと小さく映る)
  const zoom = full && samples.length > 1 ? zoomTrack(samples.map(s => s.t), samples.map((s, i) => Math.min(dist, fitFull(s.pts.map(p => ({...p, x: p.x - path[i][1], z: p.z - path[i][3]})), {fov, aspect, cy}).dist))) : null;
  window.viewer.follow = false;
  shotTrack = t => {
    const [x, y, z] = trackAt(path, t), ty = full ? cy : y + cy, d = zoom ? trackAt(zoom, t)[0] : dist;
    controls.target.set(x, ty, z); camera.position.set(x, ty, z + d);
    snapGrid(x, z);
  };
  shotTrack(0); controls.update();
  return {framing, cy, dist};
};
// モーションを最初から当て直す。無ければ腕を下ろした休めの姿勢
let shotSeq = 0;   // 素早く呼び直されたとき、最後の呼び出しだけが姿勢を決める
window.viewer.prepareShot = async ({motion, once = false}) => {
  const mine = ++shotSeq, stale = () => mine !== shotSeq;
  await window.viewer.loaded;   // 読み込み中の最初の play と重なると、切り替えのフェードが残る
  if (stale()) return;
  mixer.stopAllAction(); fading = []; current = null; currentName = ''; shotTrack = null; springRest = 0; springInGap = false;
  // 読み込みの速さで時刻が変わらないよう、時刻に依存する状態も初めに戻す(まばたきの時刻、表情の値、口、セリフの余韻)
  elapsed = 0; nextBlink = 1.5; blinkStart = -1; for (const k of Object.keys(emoValue)) delete emoValue[k];
  mouth.v = null; mouth.w = 0; lingerEmotion = null;
  vrm.humanoid.resetNormalizedPose();
  window.viewer.paused = !motion;
  if (motion) { await play(motion, stale); if (once && current) { current.setLoop(THREE.LoopOnce, 1); current.clampWhenFinished = true; } }   // once: 繰り返さず最後の姿勢で止める
  else for (const [b, z] of [['leftUpperArm', -1.15], ['rightUpperArm', 1.15]]) vrm.humanoid.getNormalizedBoneNode(b).rotation.z = z;
  trackHips(0); resetSpring();   // 基準の点も、ここまでに描いたコマの数によらず同じにする
};
// 右手の指を曲げる関数を返す。モーションを当てる前に呼び、毎コマ、モーションのあとに返った関数を呼ぶ(ショートの小道具)。flex は関節ごとの度
window.viewer.fingerCurl = flex => {
  const h = vrm.humanoid, node = n => h.getRawBoneNode(n), pos = n => node(n).getWorldPosition(new THREE.Vector3());
  if (!node('rightMiddleProximal') || !node('rightIndexProximal') || !node('rightLittleProximal')) return () => {};   // 指の骨の無い体
  h.resetNormalizedPose(); vrm.scene.updateMatrixWorld(true);
  const hand = pos('rightHand'), fwd = pos('rightMiddleProximal').sub(hand).normalize(), across = pos('rightIndexProximal').sub(pos('rightLittleProximal')), palm = new THREE.Vector3().crossVectors(fwd, across.addScaledVector(fwd, -across.dot(fwd)).normalize()).negate(), axis = new THREE.Vector3().crossVectors(fwd, palm).normalize();
  const bends = ['Index', 'Middle', 'Ring', 'Little'].flatMap(f => ['Proximal', 'Intermediate', 'Distal'].filter(j => node(`right${f}${j}`)).map(j => {
    const b = node(`right${f}${j}`), local = axis.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()).invert());
    return {b, q: b.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(local, flex[j] * Math.PI / 180))};
  }));
  return () => { for (const {b, q} of bends) b.quaternion.copy(q); };
};
// ---- 体型と揺れものの下見(仕上げの「体型と揺れもの」、public/adjust.mjs、docs/adjust.md) ----
// 書き換える道具(tools/vrm/body_shape.py)の結果に近い見た目を、読み込んだ VRM のまま作る。版のファイルは変えない。
//   腕、腰、脚: 骨ごとの逆バインド行列に、骨の軸に垂直な縮めを掛ける(重みで混ざるのは道具と同じ。足首を戻す分と法線は直さない)
//   頭: 頭の骨の大きさ(中心は頭の骨。道具は首の区間の中ほど)。首: 頭の骨を上へ。肩幅: 上腕の骨を横へ(肩の頂点の帯は直さない)
//   揺れもの: 揺れ骨の設定(stiffness、dragForce、gravityPower)を節点の番号ごとに入れ替える
let adjustRest = null;   // 読み込んだときの逆バインド行列、骨の位置、揺れ骨の設定
function measureAdjust(associations) {
  vrm.humanoid.resetNormalizedPose(); vrm.scene.updateMatrixWorld(true);
  const raw = n => vrm.humanoid.getRawBoneNode(n), meshes = [];
  vrm.scene.traverse(o => { if (o.isSkinnedMesh) meshes.push({mesh: o, inv: o.skeleton.boneInverses.map(m => m.clone())}); });
  const bones = Object.fromEntries(['head', 'leftUpperArm', 'rightUpperArm'].map(b => [b, {node: raw(b), pos: raw(b).position.clone(), scale: raw(b).scale.clone(),
    parentQ: raw(b).parent.getWorldQuaternion(new THREE.Quaternion())}]));
  const springs = [...(vrm.springBoneManager?.joints ?? [])].map(j => ({joint: j, node: associations?.get(j.bone)?.nodes ?? null,
    settings: {stiffness: j.settings.stiffness, dragForce: j.settings.dragForce, gravityPower: j.settings.gravityPower}}));
  adjustRest = {meshes, bones, springs, body: null, spring: null};
}
// バインドの姿勢の骨の位置(逆バインド行列の逆)。骨が skin に無ければ null
function bindPos(name) {
  const bone = vrm.humanoid.getRawBoneNode(name);
  for (const {mesh, inv} of adjustRest.meshes) {
    const i = mesh.skeleton.bones.indexOf(bone);
    if (i >= 0) return new THREE.Vector3().setFromMatrixPosition(inv[i].clone().invert());
  }
  return null;
}
// 点 p0 を通る向き u の軸に垂直な成分を k 倍にする行列(waist は左右 k、前後は変化を半分)
function squeeze(p0, u, k, waist = false) {
  const M = new THREE.Matrix4();
  if (waist) M.makeScale(k, 1, 1 - (1 - k) / 2);
  else {
    const c = (i, j) => (i === j ? k : 0) + (1 - k) * u.getComponent(i) * u.getComponent(j);   // k I + (1 - k) u u^T
    M.set(c(0, 0), c(0, 1), c(0, 2), 0, c(1, 0), c(1, 1), c(1, 2), 0, c(2, 0), c(2, 1), c(2, 2), 0, 0, 0, 0, 1);
  }
  return new THREE.Matrix4().makeTranslation(p0.x, p0.y, p0.z).multiply(M).multiply(new THREE.Matrix4().makeTranslation(-p0.x, -p0.y, -p0.z));
}
// values: {head, neck(cm), shoulder(cm、片側。正は広く), arm, waist, leg}(public/adjust-plan.mjs の BODY_FIELDS)。null で元へ戻す
window.viewer.bodyPreview = values => {
  if (!adjustRest) return;
  const v = values ?? {};
  adjustRest.body = values ? {...values} : null;
  const squeezeOf = new Map();   // 骨 -> 行列
  const axis = (b, c, k) => {
    const p0 = bindPos(b), p1 = bindPos(c);
    if (p0 && p1 && k != null && Math.abs(k - 1) > 1e-6) squeezeOf.set(vrm.humanoid.getRawBoneNode(b), squeeze(p0, p1.clone().sub(p0).normalize(), k));
  };
  for (const s of ['left', 'right']) {
    axis(`${s}UpperArm`, `${s}LowerArm`, v.arm); axis(`${s}LowerArm`, `${s}Hand`, v.arm);
    axis(`${s}UpperLeg`, `${s}LowerLeg`, v.leg); axis(`${s}LowerLeg`, `${s}Foot`, v.leg);
  }
  const spine = bindPos('spine');
  if (spine && v.waist != null && Math.abs(v.waist - 1) > 1e-6) squeezeOf.set(vrm.humanoid.getRawBoneNode('spine'), squeeze(spine, null, v.waist, true));
  for (const {mesh, inv} of adjustRest.meshes) mesh.skeleton.bones.forEach((bone, i) => {
    const S = squeezeOf.get(bone);
    mesh.skeleton.boneInverses[i].copy(inv[i]);
    if (S) mesh.skeleton.boneInverses[i].multiply(S);
  });
  const {head, leftUpperArm, rightUpperArm} = adjustRest.bones;
  const local = (r, x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(r.parentQ.clone().invert());
  head.node.scale.copy(head.scale).multiplyScalar(v.head ?? 1);
  head.node.position.copy(head.pos).add(local(head, 0, (v.neck ?? 0) / 100, 0));
  leftUpperArm.node.position.copy(leftUpperArm.pos).add(local(leftUpperArm, (v.shoulder ?? 0) / 100, 0, 0));
  rightUpperArm.node.position.copy(rightUpperArm.pos).add(local(rightUpperArm, -(v.shoulder ?? 0) / 100, 0, 0));
  vrm.scene.updateMatrixWorld(true);
};
// values: {節点の番号: {stiffness, dragForce, gravityPower}}(public/adjust-plan.mjs の springJointValues)。null で元へ戻す。答え: 入れ替えた揺れ骨の数
window.viewer.springPreview = values => {
  if (!adjustRest) return 0;
  adjustRest.spring = values ?? null;
  let n = 0;
  for (const {joint, node, settings} of adjustRest.springs) {
    const want = values?.[node];
    Object.assign(joint.settings, settings, want ?? {});
    if (want) n++;
  }
  return n;
};
// 今の画面の絵(PNG の data URL)。描いた直後に読む(描画の後に消える絵を読まないため)
window.viewer.snapshot = () => { renderer.render(scene, camera); return canvas.toDataURL('image/png'); };

// 'motion': モーションの表情の時刻表。'neutral': ふだんの顔。感情の名前: その表情に固定
window.viewer.shotExpression = e => { document.getElementById('autoExpr').checked = e === 'motion'; manual = EMOTIONS.includes(e) ? e : null; };
// null: ビューアの色と床のグリッド。色: その単色でグリッドを消す
window.viewer.shotBackground = c => { scene.background.set(c ?? BACKGROUND); grid.visible = !c; };

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

function button(parent, text, onclick, data = {}) {
  const b = document.createElement('button'); b.textContent = text; Object.assign(b.dataset, data); b.onclick = onclick; parent.append(b); return b;
}

// 版の VRM を読み込む。前のモデルは外して捨て、表情と口のボタンを作り直す
async function loadModel(url) {
  const gltf = await loader.loadAsync(url, e => {
    const mb = (e.loaded / 1048576).toFixed(1), all = e.total ? ` / ${(e.total / 1048576).toFixed(1)}` : '';
    note(`モデルを読み込み中 ${mb}${all} MB`, 'info', 'load');
  });
  note(null, 'info', 'load');
  const next = gltf.userData.vrm;
  if (!next) throw Error('VRM ではない: ' + url);
  if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
  mixer?.stopAllAction(); clips.clear(); footPlans.clear(); fading = []; current = null;
  for (const k of Object.keys(emoValue)) delete emoValue[k];
  mouth.v = null; mouth.w = 0; manual = null; visManual = null; speech = null; voice?.audio.pause(); voice = null; lingerEmotion = null;
  vrm = next; VRMUtils.removeUnnecessaryVertices(gltf.scene); VRMUtils.rotateVRM0(vrm);
  // 進むモーション（hips が原点から離れる）でも消えないように、メッシュの視野の外での省略を切る（境界の球は静止姿勢のまま動かないため）
  vrm.scene.traverse(o => { o.frustumCulled = false; });
  scene.add(vrm.scene); mixer = new THREE.AnimationMixer(vrm.scene);
  hipsLast.set = false; springRest = 0; springInGap = false;
  for (const j of vrm.springBoneManager?.joints ?? []) j.center ??= springCenter;   // VRM に center の指定があれば、それに従う
  trackHips(0); resetSpring();
  if (vrm.lookAt) vrm.lookAt.target = camera;
  const box = new THREE.Box3().setFromObject(vrm.scene), size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
  // 骨が無いモデル(neck の無い VRM など)は、あとの名前で代える
  const boneY = (...names) => vrm.humanoid.getRawBoneNode(names.find(n => vrm.humanoid.getRawBoneNode(n))).getWorldPosition(new THREE.Vector3()).y;
  rest = {height: size.y, headTop: box.max.y - boneY('head'), headH: box.max.y - boneY('neck', 'head', 'chest'), torso: boneY('head') - boneY('hips'), reach: Math.min(size.y, boneY('hips') * WEAPON_HIPS)};
  handRest = {left: measureHand('left'), right: measureHand('right')}; weaponObj = null; weaponSub = []; otherFist = null; wearWeapon();
  measureAdjust(gltf.parser.associations);
  controls.target.copy(mid); camera.position.set(mid.x, mid.y + size.y * 0.05, mid.z + size.y * 2.4); controls.update();
  followFrom = null; grid.position.set(0, 0, 0);
  const names = Object.keys(vrm.expressionManager?.expressionMap ?? {});
  const box2 = document.getElementById('expressions'); box2.replaceChildren();
  for (const name of ['none', ...EMOTIONS.filter(e => names.includes(e))]) {
    const b = button(box2, name === 'none' ? '（なし）' : EMOTION_LABELS[name] || name, () => {
      manual = name === 'none' ? null : name; [...box2.children].forEach(c => c.classList.toggle('on', c === b));
    }, {e: name});
  }
  const box3 = document.getElementById('visemes'); box3.replaceChildren();
  for (const [v, label] of [['none', '（閉じる）'], ...Object.entries(VISEMES)]) {
    if (v !== 'none' && !names.includes(v)) continue;
    const b = button(box3, label, () => {
      speech = null; visManual = v === 'none' ? null : v; [...box3.children].forEach(c => c.classList.toggle('on', c === b));
    }, {v});
  }
  return names;
}
document.getElementById('speakBtn').onclick = () => speak(document.getElementById('speakText').value);
document.getElementById('speakText').onkeydown = e => { if (e.key === 'Enter') speak(e.target.value); };

async function play(name, stale = () => false) {   // name: モーションの ID。stale: 待つ間に新しい呼び出しに置き換わったかを答える
  const m = motionById.get(name);
  if (!m) throw Error(`モーション ${name} がない`);
  const owner = vrm;
  let clip = clips.get(name);
  if (!clip) {
    const gltf = await loader.loadAsync(motionUrl(m));
    const anim = gltf.userData.vrmAnimations?.[0];
    if (!anim) throw Error(name + ' に VRM のアニメーションがない');
    clip = createVRMAnimationClip(anim, owner);
  }
  const plan = footBox.checked && !footPlans.has(name) ? await footPlanFor(m, owner, clip) : footPlans.get(name);
  if (vrm !== owner || stale()) return;   // 待つ間に版が替わった(今の版の再生は openVersion が始める)か、新しい呼び出しに置き換わった
  clips.set(name, clip);
  if (plan !== undefined) footPlans.set(name, plan);
  window.viewer.hold = false;   // 止めたまま切り替えると、重みが進まず前の姿勢のままになる
  const action = mixer.clipAction(clip); action.reset().setLoop(THREE.LoopRepeat, Infinity).play();
  fading = fading.filter(f => f.action !== action);
  if (current && current !== action) { fading.push({action: current, plan: footPlans.get(currentName)}); current.crossFadeTo(action, 0.3, false); }
  current = action; currentName = name;
  document.querySelectorAll('#motions button').forEach(b => b.classList.toggle('on', b.dataset.name === name));
}

// 表情の時刻表（motion.json の expressions、from/to は長さに対する割合）
function timelineFor(name) { return motionById.get(name)?.expressions || []; }

// 自動まばたき: 2.5〜6 秒ごと。0 -> 1 を 0.08 秒、0.06 秒保って、0.14 秒で戻す（VMagicMirror や UniVRM の Blinker と同じ動かし方）。
// 0/1 のまばたきでも完全に閉じるところは出る。blink_layers.py のまばたきは途中のコマを通る。
// 途中のコマをカスタム表情（blink_1..N、expr_video.py の atlas.vrm）で持つモデルは、それを順に出す:
// blink_1..N、blink を 4 歩、blink_N..1、1 歩 42 ms。カスタム表情は感情の overrideBlink "block" で消えず、
// UV のずらしが感情のものに足されるので、感情（とウインク）を出している間はまばたきしない。
let nextBlink = 1.5, blinkStart = -1;
const emoValue = {}, EASE = 0.25;
const STEP = 0.042, CLOSE = 0.08, HOLD = 0.06, OPEN = 0.14;
function blinkValue(t) {
  if (!document.getElementById('autoBlink').checked) { blinkStart = -1; return 0; }
  if (blinkStart < 0 && t >= nextBlink) blinkStart = t;
  if (blinkStart < 0) return 0;
  const s = t - blinkStart;
  if (s < CLOSE) return s / CLOSE;
  if (s < CLOSE + HOLD) return 1;
  if (s < CLOSE + HOLD + OPEN) return 1 - (s - CLOSE - HOLD) / OPEN;
  blinkStart = -1; nextBlink = t + 2.5 + Math.random() * 3.5; return 0;
}
function blinkStepName(t, steps) {   // 今出すコマの名前、または null
  if (!document.getElementById('autoBlink').checked) { blinkStart = -1; return null; }
  if (blinkStart < 0 && t >= nextBlink) blinkStart = t;
  if (blinkStart < 0) return null;
  const seq = [...steps, 'blink', 'blink', 'blink', 'blink', ...[...steps].reverse()];
  const k = Math.floor((t - blinkStart) / STEP);
  if (k < seq.length) return seq[k];
  blinkStart = -1; nextBlink = t + 2.5 + Math.random() * 3.5; return null;
}

function applyExpressions(t, dt) {
  const em = vrm?.expressionManager; if (!em) return;
  const active = new Set(), cue = window.viewer.mouthOverride?.emotion;   // ショートの焼き込み: コマごとの口の形に載せた表情
  if (cue) active.add(cue);
  else if (manual) active.add(manual);
  else if (voice?.emotion) active.add(voice.emotion);
  else if (lingerEmotion?.name && t < lingerEmotion.until) active.add(lingerEmotion.name);
  else if (current && document.getElementById('autoExpr').checked) {
    const f = current.loop === THREE.LoopOnce ? Math.min(current.time / current.getClip().duration, 0.9999) : (current.time % current.getClip().duration) / current.getClip().duration;   // 繰り返さない動きは最後の時刻に留まる
    for (const s of timelineFor(currentName)) if (f >= s.from && f < s.to) active.add(s.expression);
  }
  // 感情は EASE 秒で出入りする（動画のコマを重ねた表情は途中のコマが出る）。0/1 の表情は 0.5 で切り替わる
  for (const e of EMOTIONS) {
    if (!em.getExpression(e)) continue;
    const cur = emoValue[e] || 0, goal = active.has(e) ? 1 : 0;
    emoValue[e] = goal > cur ? Math.min(goal, cur + dt / EASE) : Math.max(goal, cur - dt / EASE);
    em.setValue(e, emoValue[e]);
  }
  let vis = visManual, amp = 1;
  if (voice) {
    const at = voice.time ?? voice.audio.currentTime, m = voice.plan.find(p => at >= p[0] && at < p[1]);
    const e = voice.env[Math.min(voice.env.length - 1, Math.floor(at * 100))] || 0;
    vis = m ? m[2] : null; amp = m ? (m[3] ? SOFT : Math.min(1, 0.2 + 0.6 * e / voice.peak)) : 0;
  }
  if (speech) {
    const k = Math.floor((t - speech.t0) / MORA);
    if (k >= speech.seq.length) speech = null;
    else {
      const prev = speech.seq.slice(0, k + 1).reverse().find(Boolean) ?? speech.seq.find(Boolean);
      vis = speech.seq[k] ?? prev; amp = speech.seq[k] ? 0.6 : SOFT;   // ん、っ: 前の形を小さく
      if (/^[\s、。！？!?,.]$/.test(speech.text[k] ?? '')) amp = 0;      // 句読点: 本当に止める
    }
  }
  const goal = vis ? amp : 0;
  if (vis && vis !== mouth.v) mouth.v = vis;                             // 今の開きのまま形を入れ替える
  mouth.w = goal > mouth.w ? Math.min(goal, mouth.w + dt / VEASE) : Math.max(goal, mouth.w - dt / VEASE);
  const ov = window.viewer.mouthOverride;   // {aa: 0.5, oh: 0.5}: ビセームの値をそのまま。モデルが形をどう混ぜるかを確かめる用
  for (const v of Object.keys(VISEMES)) if (em.getExpression(v)) em.setValue(v, ov ? (ov[v] || 0) : v === mouth.v ? mouth.w : 0);
  const steps = Object.keys(em.customExpressionMap || {}).filter(n => /^blink_\d+$/.test(n)).sort((a, b) => a.slice(6) - b.slice(6));
  if (steps.length) {
    let name = null;
    if (active.size === 0) name = blinkStepName(t, steps);
    else if (blinkStart >= 0) { blinkStart = -1; nextBlink = t + 1 + Math.random() * 2; }   // 感情が出たらまばたきを切る
    for (const s of steps) em.setValue(s, s === name ? 1 : 0);
    if (em.getExpression('blink')) em.setValue('blink', name === 'blink' ? 1 : 0);
    return;
  }
  // overrideBlink "block" の感情は three-vrm の中で blink を消すので、blink はいつ入れてもよい
  if (em.getExpression('blink')) em.setValue('blink', blinkValue(t));
}

const clock = new THREE.Clock();
// 揺れ骨は drag を 1 歩ごとに掛け、戻す力は dt に比例するので、1 歩の dt で別の動きになる（20 fps は 60 fps より戻す力も減衰も 1/3）。
// どの fps でも 60 fps と同じ動きにするため、モーションは画面の dt のまま進め、揺れ骨だけ 1/60 秒の刻みで進める（public/spring-clock.mjs）。
const JUMP_M = 0.25, JUMP_RAD = 30 * Math.PI / 180;   // 1 回の移動でこれを超える hips の動きは瞬間移動（ループの継ぎ目）として揺れを戻す
const CENTER_TAU = 0.7;   // 基準の点が hips を遅れて追う時定数（秒）
let springRest = 0, springInGap = false;   // 次の揺れの 1 歩までに済んだ秒、前の dt も長かったか
const hipsLast = {pos: new THREE.Vector3(), quat: new THREE.Quaternion(), set: false}, hipsNow = new THREE.Vector3(), hipsQuat = new THREE.Quaternion();
// center の指定が無いモデルの揺れ骨の基準の点を、hips の水平の位置へ CENTER_TAU 秒遅れて追わせる。モーションは Root ではなく hips を
// 動かすので、基準が止まったままだと進む速さが風になって、前髪が 1 m/s を超えるあたりで後ろへ飛ぶ。遅れて追う点は等速では hips と
// 同じ速さになるので風は消え、踏み込みの加速と左右の往復（時定数より速い動き）は揺れとして残る。
// 答え: hips が瞬間移動したか
function trackHips(springDt) {
  const node = vrm.humanoid.getNormalizedBoneNode('hips');
  node.getWorldPosition(hipsNow); node.getWorldQuaternion(hipsQuat);
  const k = 1 - Math.exp(-springDt / CENTER_TAU);
  springCenter.position.x += (hipsNow.x - springCenter.position.x) * k; springCenter.position.z += (hipsNow.z - springCenter.position.z) * k;
  springCenter.updateMatrixWorld(true);
  const jumped = hipsLast.set && !window.viewer.paused && !window.viewer.hold && (hipsNow.distanceTo(hipsLast.pos) > JUMP_M || hipsQuat.angleTo(hipsLast.quat) > JUMP_RAD);
  hipsLast.pos.copy(hipsNow); hipsLast.quat.copy(hipsQuat); hipsLast.set = true;
  return jumped;
}
function advance(dt, springDt, gap) {
  if (!window.viewer.paused && !window.viewer.hold) mixer?.update(dt);
  // 止めている間は手で置いた姿勢なので直さない。vrm.update の中で素の骨、揺れ骨の順に動くので、直してから呼ぶ
  // 切り替えの間は前のアクションの計画も、その重みで当てる（前の計画、今の計画の順）。前のアクションが止まったら前の計画はやめる
  fading = fading.filter(f => f.action.isRunning());
  const undo = current && footBox.checked && !window.viewer.paused ? applyFootLayers([...fading, {action: current, plan: footPlans.get(currentName)}]) : null;
  const jumped = vrm && trackHips(springDt);
  vrm?.update(springDt);
  if (vrm && (jumped || gap)) resetSpring();
  undo?.();
}
function step(dt) {
  elapsed += dt; applyExpressions(elapsed, dt);
  const {parts, rest, inGap, gap} = springParts(dt, springRest, springInGap);
  springRest = rest; springInGap = inGap;
  for (const p of parts) advance(p.dt, p.spring, gap);
  aimWeapon(); follow(); shotTrack?.(window.viewer.time); controls.update(); renderer.render(scene, camera);
}
function frame() { step(clock.getDelta()); requestAnimationFrame(frame); }
window.viewer.step = step;
window.viewer.speak = speak; window.viewer.playVoice = playVoice; Object.defineProperty(window.viewer, 'voice', {get: () => voice}); Object.defineProperty(window.viewer, 'speech', {get: () => speech});   // 画面が隠れていると requestAnimationFrame が止まるので、手で進める
window.viewer.play = play;   // モーションの ID で再生（撮影の道具から）
// 保管場所に入れる前の候補を再生する(動きの画面の確認の欄)。rec は {id, name, label, file, contactsUrl}。一覧には出さない
window.viewer.playCandidate = rec => { motionById.set(rec.id, rec); clips.delete(rec.id); footPlans.delete(rec.id); return play(rec.id); };
// 今のモーションの間に、スカートの頂点が太ももの中へ入る数を数える（コンソールから）:
//   window.viewer.skirtTest()  ->  {framesHit, worst, deepest_mm, total, byAngle}
// 太ももは脚の付け根（r0）から膝（r1）への円すい。r - 6 mm より近い頂点を数え、太ももの 15% より下だけを見る
// （腰のゴムは付け根のあたり）。byAngle: 腰のまわりの角度、0 = 正面。
window.viewer.skirtTest = (frames = 300, r0 = 0.08, r1 = 0.052) => {
  let skirt; vrm.scene.traverse(o => { if (o.isSkinnedMesh && /skirt/i.test(o.name)) skirt = o; });
  if (!skirt) return 'no mesh named *skirt*';
  const h = vrm.humanoid, P = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3(), Q = new THREE.Vector3(), H = new THREE.Vector3();
  const n = skirt.geometry.attributes.position.count, byAngle = {}; let worst = 0, deepest = 0, framesHit = 0, total = 0;
  for (let f = 0; f < frames; f++) {
    step(1 / 60); let c = 0; h.getRawBoneNode('hips').getWorldPosition(H);
    for (const s of ['left', 'right']) {
      h.getRawBoneNode(s + 'UpperLeg').getWorldPosition(A); h.getRawBoneNode(s + 'LowerLeg').getWorldPosition(B);
      const AB = B.clone().sub(A), L2 = AB.lengthSq();
      for (let i = 0; i < n; i++) {
        skirt.getVertexPosition(i, P); P.applyMatrix4(skirt.matrixWorld);
        const t = P.clone().sub(A).dot(AB) / L2; if (t < 0.15 || t > 1) continue;
        Q.copy(A).addScaledVector(AB, t); const r = r0 + (r1 - r0) * t, d = P.distanceTo(Q);
        if (d < r - 0.006) {
          c++; deepest = Math.max(deepest, r - d);
          const a = Math.round(Math.atan2(P.x - H.x, P.z - H.z) * 180 / Math.PI / 30) * 30; byAngle[a] = (byAngle[a] || 0) + 1;
        }
      }
    }
    if (c) { framesHit++; worst = Math.max(worst, c); } total += c;
  }
  return {framesHit, worst, deepest_mm: Math.round(deepest * 1000), total, byAngle};
};

// ---- キャラと版 ----
const charSelect = document.getElementById('charSelect'), verSelect = document.getElementById('verSelect');
const getJSON = url => fetch(url).then(r => { if (!r.ok) throw Error(`${url}: ${r.status}`); return r.json(); });

function fillVersions() {
  const vs = [...(character?.versions || [])].sort((a, b) => (b.order ?? 0) - (a.order ?? 0));   // 新しい順（最新が先頭）
  verSelect.replaceChildren(...vs.map(v => new Option(`${v.id === character.latestVersion ? '★最新　' : ''}${v.label || v.id}`, v.id)));
}
function fillLines() {
  const vbox = document.getElementById('voices'); vbox.replaceChildren();
  for (const l of lines) {
    const b = button(vbox, `▶ ${l.text || l.id}${l.emotion ? `（${l.emotion}）` : ''}`, () => playVoice(l).catch(e => statusEl.textContent = e.message), {line: l.id});
    b.title = l.id;
  }
  if (!lines.length) vbox.innerHTML = '<div class="muted">（このキャラのセリフはまだない）</div>';
}
// ?studio=<表情づくり ID>: その表情づくりの試作も版の一覧に出す(ver=proto-<番号>。表情づくりの確かめの撮影が使う)
const STUDIO = new URLSearchParams(location.search).get('studio');
function setUrl() {
  const q = new URLSearchParams({char: character.id}); if (version) q.set('ver', version.id);
  if (STUDIO) q.set('studio', STUDIO);
  if (EMBED) q.set('embed', '1');
  if (QS.get('follow') === '0') q.set('follow', '0');
  if (QS.get('footik') === '0') q.set('footik', '0');
  if (weaponId !== 'none') q.set('weapon', weaponId);
  history.replaceState(null, '', '/viewer?' + q);
}
async function openVersion(verId) {
  version = character.versions.find(v => v.id === verId) || character.versions.find(v => v.id === character.latestVersion)
    || [...character.versions].sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0];
  if (!version) throw Error(`キャラ ${character.id} に版がない`);
  verSelect.value = version.id; setUrl();
  document.getElementById('verNote').textContent = version.note || '';
  document.title = `${character.name || character.id} ${version.id} - きゃらすた`;
  statusEl.textContent = `${character.id} / ${version.id} を読み込み中…`;
  const keep = currentName || QS.get('motion');   // ?motion=<ID>: 最初に当てるモーション
  const names = await loadModel(modelUrl(character.id, version));
  if (keep && motionById.has(keep)) await play(keep);
  else if (motions.length) await play(motions[0].id);
  statusEl.textContent = `表情 ${names.length} 種、モーション ${motions.length} 種、セリフ ${lines.length} 件` + (motions.length ? '' : '（モーションがまだない）');
}
async function openCharacter(charId, verId) {
  character = await getJSON('/api/characters/' + encodeURIComponent(charId));
  character.versions ||= []; lines = character.lines || [];
  if (STUDIO) {
    const st = await getJSON(`/api/studio/${encodeURIComponent(charId)}/${encodeURIComponent(STUDIO)}`).catch(() => null);
    for (const p of st?.prototypes ?? []) character.versions.push({id: 'proto-' + p.n, label: `試作 ${p.n}（表情づくり ${STUDIO}）`, order: 100000 + p.n, model: p.url,
      note: `表情づくり ${STUDIO} の試作 ${p.n}（${p.step === 'video' ? '中割りあり' : '組み立て'}${p.springTune ? '、揺れ骨を整えた' : ''}）。まだ版ではない`});
  }
  charSelect.value = character.id;
  document.getElementById('lineLink').href = '/#model/' + encodeURIComponent(character.id);
  fillVersions(); fillLines();
  await openVersion(verId);
}
const fail = e => { statusEl.textContent = '読み込みに失敗: ' + e.message; note('読み込みに失敗: ' + e.message, 'err', 'err'); console.error(e); };
charSelect.onchange = () => openCharacter(charSelect.value).catch(fail);
verSelect.onchange = () => openVersion(verSelect.value).catch(fail);

// モーションの一覧を読み直す(動きの画面でモーションが増えたとき)
window.viewer.reloadMotions = async () => {
  motions = await getJSON('/api/motions').catch(() => motions);
  for (const m of motions) motionById.set(m.id, m);
  fillMotions();
};
function fillMotions() {
  const box = document.getElementById('motions'); box.replaceChildren();
  for (const m of motions) {
    const b = button(box, m.label ? `${m.label}（${m.name || m.id}）` : (m.name || m.id), () => play(m.id).catch(e => statusEl.textContent = e.message), {name: m.id});
    b.title = m.id;
  }
  if (!motions.length) box.innerHTML = '<div class="muted">（動きの画面で取り込む）</div>';
  const holders = [...new Set(motions.map(m => m.license?.holder).filter(Boolean))];
  document.getElementById('credit').textContent = holders.map(h => /ピクシブ|pixiv/i.test(h)
    ? 'キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト' : `モーション: ${h}`).join(' / ');
}

const weaponBox = document.getElementById('weapons');
for (const [id, w] of Object.entries(WEAPONS)) button(weaponBox, w.label, () => { window.viewer.weapon = id; }, {weapon: id});
wearWeapon();

resize();
try {
  const q = new URLSearchParams(location.search);
  [chars, motions] = await Promise.all([getJSON('/api/characters'), getJSON('/api/motions').catch(() => [])]);
  chars = chars.filter(c => c.style !== 'creature');   // 生き物(Blender のファイル)はビューアで開けない
  for (const m of motions) motionById.set(m.id, m);
  charSelect.replaceChildren(...chars.map(c => new Option(`${c.name || c.id}（${c.id}）`, c.id)));
  fillMotions();
  const charId = q.get('char') || chars[0]?.id;
  if (!charId) throw Error('キャラがまだない（scripts/new-character.mjs と import-version.mjs で取り込む）');
  window.viewer.loaded = openCharacter(charId, q.get('ver'));   // 最初のモーションの計画ができるまで待てるように残す
  await window.viewer.loaded;
  // ?line=: そのセリフを話させる。ブラウザは押す前の再生を止めるので、ボタンを示して押してもらう
  const want = lines.find(l => l.id === q.get('line'));
  if (want) {
    const b = [...document.querySelectorAll('#voices button')].find(b => b.dataset.line === want.id);
    b.classList.add('on'); b.scrollIntoView({block: 'nearest'});
    note(`「▶ ${want.text || want.id}」を押すと話す`, 'info', 'audio');
  }
} catch (e) { fail(e); }
requestAnimationFrame(frame);
