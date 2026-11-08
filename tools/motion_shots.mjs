// モーションの確かめ: キャラにモーションを当てて、横と正面から決まった時刻で撮り、足・膝・腕・向きを測る。
// node tools/motion_shots.mjs --char <キャラ> [--ver ID] --motion <モーション> --out DIR [--port 8870] [--times 0.5,1,1.5] [--every 0.5] [--footik 0] [--views side,front,feet]
//   -> DIR/<motion>-side-t1.50.jpg、-front-…、<motion>-side.jpg（横に並べた 1 枚）、<motion>.json（測った値）
//   views の feet は足元の拡大。カメラは最初の時刻の足元に固定する（hips についていかないので、留まった足は床のグリッドの上で動かない）
// モーションはビューアの再生を止め、この道具が自分の AnimationMixer で時刻を決めて当てる（撮るたびに同じ姿勢になる）。
// 足の IK はビューアと同じ public/foot-ik.mjs で当てる（--footik 0 で切る）。
// カメラは hips の真横（体の右）と真正面に置き、hips の水平の位置についていく（最初のコマの体の向きを基準にする）。
// 測る値（毎コマ、1/30 秒）:
//   footMinY: 足首と爪先の骨の高さの最小（地面は 0。マイナスは床に埋まる）
//   slide: 接地している間（その足の高さが、その足の最低から 3 cm 以内に 5 コマ以上続く区間）の足の水平の速さ（cm/s）。平均と 95 パーセンタイル
//   kneeBack: 膝が後ろへ曲がったコマの数（膝の位置が、股関節と足首を結ぶ線より体の後ろに 1 cm 以上出る）
//   handInBody: 手首か肘が胴の軸（hips から首）の水平の距離 9 cm 以内に入ったコマの数
//   slideContact: 計画の接地の区間（横の情報があればそれ）だけの足の水平の速さ。足首と爪先の遅い方（足を返す間は、足を置いた点だけが止まる）。
//     足を上げる高さが低いと slide は振り出しの足も数えるので、接地中の滑りはこちらを見る
//   kneeJump: 膝の角度の 1 コマの変化の最大（度）と、10 度・20 度を超えたコマの数（左右の合計）。footIK: 接地の判定の出どころ、接地の区間の数、下げた hips の最大（cm）、目標を寄せたコマの数
//   headingDeg: 進む向き（hips の 0.5 秒の移動）と体の向きの差。速さ 0.5 m/s 以上のコマの平均と最大
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadConfig, loadPlaywright, parseArgs, viewerUrl, openViewer, HIDE_PANEL_CSS} from './common.mjs';
import {launchGPU} from './gpu_browser.mjs';

const args = parseArgs();
if (!args.out || !args.motion) throw Error('--motion ID と --out DIR が要る');
fs.mkdirSync(args.out, {recursive: true});
const W = Number(process.env.W || 640), H = Number(process.env.H || 720);
const {chromium} = loadPlaywright(), url = viewerUrl(args, loadConfig());
const {browser} = await launchGPU(chromium);
const page = await browser.newPage({viewport: {width: W, height: H}});
page.on('console', m => { if (m.type() === 'error') console.log('PAGE', m.text()); });
await openViewer(page, url);
await page.addStyleTag({content: HIDE_PANEL_CSS + ' canvas{position:fixed!important;left:0;top:0;width:100vw!important;height:100vh!important;z-index:99}' +
  '#cap{position:fixed;left:16px;top:12px;z-index:100;font:600 20px sans-serif;color:#fff;text-shadow:0 0 6px #000}'});

const info = await page.evaluate(async id => {
  const v = window.viewer, THREE = await import('/vendor/three.module.js');
  const {GLTFLoader} = await import('/vendor/GLTFLoader.js');
  const {VRMAnimationLoaderPlugin, createVRMAnimationClip} = await import('/vendor/three-vrm-animation.module.js');
  const {footPlanFor, applyFootPlan} = await import('/app/foot-ik.mjs');
  const m = (await (await fetch('/api/motions')).json()).find(x => x.id === id);
  if (!m) throw Error('モーションが無い: ' + id);
  v.paused = true; dispatchEvent(new Event('resize'));
  for (const c of ['autoBlink', 'autoExpr']) { const e = document.getElementById(c); if (e) e.checked = false; }
  const loader = new GLTFLoader(); loader.register(p => new VRMAnimationLoaderPlugin(p));
  const anim = (await loader.loadAsync(m.file)).userData.vrmAnimations[0];
  v.vrm.humanoid.resetNormalizedPose();
  const clip = createVRMAnimationClip(anim, v.vrm), mixer = new THREE.AnimationMixer(v.vrm.scene);
  const plan = await footPlanFor(m, v.vrm, clip);   // --footik 0 でも接地の区間を測るのに使う
  const action = mixer.clipAction(clip); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
  const hum = v.vrm.humanoid, P = name => hum.getRawBoneNode(name)?.getWorldPosition(new THREE.Vector3());
  const cap = document.createElement('div'); cap.id = 'cap'; document.body.append(cap);
  v.camera.fov = 30; v.camera.updateProjectionMatrix();
  let base = null, feetAt = null;   // 最初のコマの体の前と右（水平）、足元の拡大のカメラの注視点
  // LoopOnce の動作は終わると止まるので、毎回 reset してから時刻を決める
  // IK で直した骨は次のコマの前に戻す（撮るときの v.step(0) も同じ姿勢を素の骨へ写すので、ここでは残す）
  let undo = null;
  const pose = t => {
    undo?.(); action.reset(); mixer.setTime(Math.min(t, clip.duration - 1e-4));
    undo = v.footIK ? applyFootPlan(plan, action.time) : null; v.vrm.update(1 / 30); v.vrm.scene.updateMatrixWorld(true);
  };
  const frame = t => {
    pose(t);
    const hips = P('hips'), q = hum.getRawBoneNode('hips').getWorldQuaternion(new THREE.Quaternion());
    // 体の前: 正規化した hips の +Z（VRM 1.0 は +Z が前）
    const nq = hum.getNormalizedBoneNode('hips').getWorldQuaternion(new THREE.Quaternion());
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(nq).setY(0).normalize();
    return {t, hips, fwd, q};
  };
  window.motionShot = (t, view, label) => {
    for (let k = Math.max(0, t - 0.5); k < t; k += 1 / 30) pose(k);   // 揺れものを 0.5 秒前から動かしておく
    const f = frame(t);
    if (!base) { const r = new THREE.Vector3().crossVectors(f.fwd, new THREE.Vector3(0, 1, 0)).normalize(); base = {fwd: f.fwd.clone(), right: r}; }
    if (view === 'feet') {
      const c = hum.getRawBoneNode('leftFoot').getWorldPosition(new THREE.Vector3()).add(hum.getRawBoneNode('rightFoot').getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
      feetAt ??= new THREE.Vector3(c.x, 0.03, c.z);
      const d = f.hips.y * 2.6;
      v.controls.target.copy(feetAt); v.camera.position.copy(feetAt).addScaledVector(base.right, d * 0.75).addScaledVector(base.fwd, d * 0.3); v.camera.position.y = d;
      v.controls.update(); cap.textContent = label; v.step(0);
      return;
    }
    const dir = view === 'side' ? base.right : base.fwd;   // side は体の右から、front は体の前から見る
    const target = new THREE.Vector3(f.hips.x, 0.8, f.hips.z);
    v.controls.target.copy(target); v.camera.position.copy(target).addScaledVector(dir, 4.2); v.camera.position.y = 0.95;
    v.controls.update(); cap.textContent = label; v.step(0);
  };
  // 測る
  const n = Math.floor(m.durationSec * 30) + 1, rec = [];
  for (let i = 0; i < n; i++) {
    const f = frame(i / 30), g = k => P(k);
    rec.push({hips: f.hips, fwd: f.fwd, lf: g('leftFoot'), lt: g('leftToes'), rf: g('rightFoot'), rt: g('rightToes'),
      lul: g('leftUpperLeg'), lll: g('leftLowerLeg'), rul: g('rightUpperLeg'), rll: g('rightLowerLeg'),
      lh: g('leftHand'), rh: g('rightHand'), lla: g('leftLowerArm'), rla: g('rightLowerArm'), neck: g('neck')});
  }
  const out = {motion: id, durationSec: m.durationSec, frames: n};
  out.footMinY = Math.min(...rec.flatMap(r => [r.lf.y, r.lt.y, r.rf.y, r.rt.y]));
  out.hipsY = [Math.min(...rec.map(r => r.hips.y)), Math.max(...rec.map(r => r.hips.y))];
  const slides = [];
  for (const [a, b] of [['lf', 'lt'], ['rf', 'rt']]) {
    const low = rec.map(r => Math.min(r[a].y, r[b].y)), floor = Math.min(...low);
    // 接地: 最低から 3 cm 以内が 5 コマ以上続く区間（振り出しの足が床をかすめる 1〜3 コマは数えない）
    const on = low.map(y => y - floor <= 0.03), stance = on.map((x, i) => {
      if (!x) return false; let s = i, e = i; while (s > 0 && on[s - 1]) s--; while (e < n - 1 && on[e + 1]) e++; return e - s + 1 >= 5; });
    for (let i = 1; i < n; i++) {
      if (!stance[i] || !stance[i - 1]) continue;
      const k = rec[i][a].y < rec[i][b].y ? a : b;   // 低い方の骨（かかとか爪先）
      slides.push(Math.hypot(rec[i][k].x - rec[i - 1][k].x, rec[i][k].z - rec[i - 1][k].z) * 30 * 100);
    }
  }
  slides.sort((x, y) => x - y);
  out.slide = {contactFrames: slides.length, meanCmPerSec: slides.reduce((s, x) => s + x, 0) / Math.max(1, slides.length), p95CmPerSec: slides[Math.floor(slides.length * 0.95)] ?? 0};
  const inSpan = [];
  const moved = (i, k) => Math.hypot(rec[i][k].x - rec[i - 1][k].x, rec[i][k].z - rec[i - 1][k].z) * 30 * 100;
  for (const [side, a, b] of [['left', 'lf', 'lt'], ['right', 'rf', 'rt']]) {
    for (const [s, e] of plan?.spans[side] ?? []) for (let i = s + 1; i <= e && i < n; i++) inSpan.push(Math.min(moved(i, a), moved(i, b)));
  }
  inSpan.sort((x, y) => x - y);
  out.slideContact = {contactFrames: inSpan.length, meanCmPerSec: inSpan.reduce((s, x) => s + x, 0) / Math.max(1, inSpan.length), p95CmPerSec: inSpan[Math.floor(inSpan.length * 0.95)] ?? 0};
  const kneeAngle = (a, b, c) => b.clone().sub(a).angleTo(c.clone().sub(b)) * 180 / Math.PI;
  const kneeSteps = rec.slice(1).flatMap((r, i) => { const p = rec[i]; return [Math.abs(kneeAngle(r.lul, r.lll, r.lf) - kneeAngle(p.lul, p.lll, p.lf)), Math.abs(kneeAngle(r.rul, r.rll, r.rf) - kneeAngle(p.rul, p.rll, p.rf))]; });
  out.kneeJump = {maxDeg: Math.max(0, ...kneeSteps), maxFrame: Math.floor(kneeSteps.indexOf(Math.max(...kneeSteps)) / 2), over10: kneeSteps.filter(x => x > 10).length, over20: kneeSteps.filter(x => x > 20).length};
  out.footIK = plan ? {applied: v.footIK, source: plan.source, spans: [plan.spans.left.length, plan.spans.right.length], maxDropCm: plan.maxDrop * 100, pulledFrames: plan.pulled} : null;
  let kneeBack = 0, handIn = 0;
  for (const r of rec) {
    for (const [hip, knee, ankle] of [[r.lul, r.lll, r.lf], [r.rul, r.rll, r.rf]]) {
      const line = ankle.clone().sub(hip), at = hip.clone().add(line.clone().multiplyScalar(knee.clone().sub(hip).dot(line) / line.lengthSq()));
      if (knee.clone().sub(at).dot(r.fwd) < -0.01) kneeBack++;
    }
    const axis = (p, a, b) => { const d = b.clone().sub(a), s = Math.max(0, Math.min(1, p.clone().sub(a).dot(d) / d.lengthSq())); return a.clone().add(d.multiplyScalar(s)).sub(p).setY(0).length(); };
    for (const p of [r.lh, r.rh, r.lla, r.rla]) if (p.y > r.hips.y - 0.05 && p.y < r.neck.y && axis(p, r.hips, r.neck) < 0.09) handIn++;
  }
  out.kneeBack = kneeBack; out.handInBody = handIn;
  const heads = [];
  for (let i = 8; i < n - 8; i++) {
    const d = rec[i + 7].hips.clone().sub(rec[i - 8].hips).setY(0), speed = d.length() / (15 / 30);
    if (speed < 0.5) continue;
    heads.push(Math.abs(Math.atan2(d.clone().cross(rec[i].fwd).y, d.dot(rec[i].fwd))) * 180 / Math.PI);
  }
  out.headingDeg = {frames: heads.length, mean: heads.reduce((s, x) => s + x, 0) / Math.max(1, heads.length), max: Math.max(0, ...heads)};
  const last = rec.at(-1).hips, first = rec[0].hips;
  out.travelM = Math.hypot(last.x - first.x, last.z - first.z);
  return out;
}, args.motion);

const dur = info.durationSec, every = Number(args.every || 0);
const times = args.times ? String(args.times).split(',').map(Number)
  : every ? Array.from({length: Math.floor(dur / every) + 1}, (_, i) => Math.round(i * every * 100) / 100)
  : Array.from({length: 8}, (_, i) => Math.round(dur * i / 7 * 100) / 100);
const views = String(args.views || 'side,front').split(','), files = Object.fromEntries(views.map(view => [view, []]));
const VIEW_LABELS = {side: '横', front: '正面', feet: '足元'};
for (const view of views) {
  for (const t of times) {
    await page.evaluate(([t, view, label]) => window.motionShot(t, view, label), [t, view, `${args.motion} ${VIEW_LABELS[view]} ${t.toFixed(2)} 秒`]);
    const f = path.join(args.out, `${args.motion}-${view}-t${t.toFixed(2)}.jpg`);
    await page.screenshot({path: f, type: 'jpeg', quality: 88}); files[view].push(f);
  }
}
await browser.close();
// 横に並べた 1 枚（ffmpeg の hstack）
for (const view of views) {
  const out = path.join(args.out, `${args.motion}-${view}.jpg`);
  try {
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...files[view].flatMap(f => ['-i', f]), '-filter_complex',
      files[view].map((_, i) => `[${i}:v]scale=320:-1[v${i}]`).join(';') + ';' + files[view].map((_, i) => `[v${i}]`).join('') + `hstack=inputs=${files[view].length}`, out]);
  } catch (e) { console.log('並べられない', view, e.message.split('\n')[0]); }
}
fs.writeFileSync(path.join(args.out, `${args.motion}.json`), JSON.stringify({...info, times}, null, 2));
console.log(JSON.stringify(info));
