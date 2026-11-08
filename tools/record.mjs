// きゃらすたのビューアで、顔テクスチャ方式の VRM のデモ動画（表情・視線・口）を 1 コマずつ撮る。
// node tools/record.mjs --char chara4 [--ver v3-smile-mouth] --out OUT_DIR [--motion VRMA_02]  -> OUT_DIR/f00000.jpg ...
// 並列に撮るときは START / END（秒）を分け、それぞれ別の OUT_DIR に出す。つなぐ:
//   ffmpeg -framerate 30 -i OUT_DIR/f%05d.jpg -c:v libx264 -pix_fmt yuv420p -crf 18 out.mp4
// 画面は隠して、時間は 1/FPS ずつ手で進め、1 コマごとに screenshot する。自動まばたきと表情ボタンは window.lock で上書きする。
// 環境変数: FPS (30), W / H (1280 x 720), DIST (顔までの距離 0.9), START / END (秒)。
// --motion はモーション ID (motions/<id>)。ビューアの一覧のボタン #motions button[data-name=<id>] を押す。
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig, loadPlaywright, parseArgs, viewerUrl, openViewer, HIDE_PANEL_CSS} from './common.mjs';
import {launchGPU} from './gpu_browser.mjs';
const args = parseArgs(), out = args.out, motion = args.motion; if (!out) throw Error('--out DIR が要る');
fs.mkdirSync(out, {recursive: true});
const {chromium} = loadPlaywright(), url = viewerUrl(args, loadConfig());
// 評価用のみのモーション(見本の動きの許諾。docs/library.md の license.evaluationOnly)で撮るときは警告する(止めはしない)
if (motion) {
  const m = await fetch(new URL('/api/motions', url)).then(r => r.json(), () => []).then(l => Array.isArray(l) ? l.find(x => x.id === motion) : null);
  if (m?.license?.evaluationOnly) console.warn(`警告: モーション ${motion} は評価用のみ（NVIDIA Sample Data Evaluation License）。この動画は公開できない`);
}
const FPS = Number(process.env.FPS || 30), W = Number(process.env.W || 1280), H = Number(process.env.H || 720);
const DIST = Number(process.env.DIST || 0.9);

// timeline: [start s, end s, caption, function(t local, dur) -> {expression: value, ..., _look: [yaw, pitch]}]
const ease = (t, d, r = 0.25) => Math.min(1, t / r, (d - t) / r);
const blinkAt = (t, t0) => { const s = t - t0; return s < 0 ? 0 : s < 0.08 ? s / 0.08 : s < 0.14 ? 1 : s < 0.28 ? 1 - (s - 0.14) / 0.14 : 0; };
// speech: syllables of [vowel, seconds]; each syllable's vowel rises and falls (sine), neighbours cross-fade
function talk(t, sylls, amp = 0.9) {
  const o = {}; let t0 = 0;
  for (const [v, d] of sylls) {
    if (t >= t0 - 0.05 && t < t0 + d + 0.05 && v !== '-') {
      const x = Math.min(1, Math.max(0, (t - t0 + 0.05) / (d + 0.1)));
      o[v] = Math.max(o[v] || 0, amp * Math.sin(Math.PI * x));
    }
    t0 += d;
  }
  return o;
}
const len = s => s.reduce((a, [, d]) => a + d, 0);
const AIUEO = [['aa', 0.45], ['-', 0.15], ['ih', 0.45], ['-', 0.15], ['ou', 0.45], ['-', 0.15], ['ee', 0.45], ['-', 0.15], ['oh', 0.45], ['-', 0.3]];
// "こんにちは、きゃらくるです。よろしくね" as vowels
const HELLO = [['oh', 0.16], ['ou', 0.12], ['ih', 0.16], ['ih', 0.14], ['aa', 0.24], ['-', 0.25], ['aa', 0.16], ['aa', 0.16], ['ou', 0.14],
  ['ee', 0.16], ['ou', 0.2], ['-', 0.25], ['oh', 0.16], ['oh', 0.14], ['ih', 0.14], ['ou', 0.16], ['ee', 0.3], ['-', 0.3]];
const T = [
  [0, 3, 'neutral', (t) => ({blink: blinkAt(t, 1.6)})],
  [3, 6, 'gaze', (t) => ({_look: [30 * Math.sin(t * 2.1), -12 * Math.sin(t * 1.3)]})],
  [6, 9, 'happy', (t, d) => ({happy: ease(t, d, 0.35)})],
  [9, 12, 'angry', (t, d) => ({angry: ease(t, d, 0.35), _look: t > 1 && t < 2.3 ? [-25, 0] : [0, 0]})],
  [12, 15, 'sad', (t, d) => ({sad: ease(t, d, 0.35), _look: t > 1 && t < 2.3 ? [0, 15] : [0, 0]})],
  [15, 18, 'relaxed', (t, d) => ({relaxed: ease(t, d, 0.35), blink: blinkAt(t, 1.5)})],
  [18, 21, 'surprised', (t, d) => ({surprised: ease(t, d, 0.2), _look: t > 1 && t < 2.3 ? [25, -8] : [0, 0]})],
  [21, 21 + len(AIUEO), 'lip sync: a i u e o', (t) => talk(t, AIUEO, 1)],
  [21 + len(AIUEO), 21 + len(AIUEO) + len(HELLO) + 0.4, 'lip sync: talking', (t) => ({...talk(t, HELLO), blink: blinkAt(t, 1.9)})],
];
let tt = T.at(-1)[1];
T.push([tt, tt + len(HELLO) + 0.8, 'happy + talking', (t, d) => ({happy: ease(t, d, 0.35), ...talk(t - 0.4, HELLO)})]); tt = T.at(-1)[1];
T.push([tt, tt + len(HELLO) + 0.8, 'angry + talking', (t, d) => ({angry: ease(t, d, 0.35), ...talk(t - 0.4, HELLO)})]); tt = T.at(-1)[1];
T.push([tt, tt + 2.5, 'wink', (t, d) => ({blinkLeft: ease(t - 0.5, 1.2, 0.15) > 0 ? ease(t - 0.5, 1.2, 0.15) : 0})]); tt = T.at(-1)[1];
const TOTAL = tt, START = Number(process.env.START || 0), END = Number(process.env.END || TOTAL);

const {browser} = await launchGPU(chromium);   // the GPU when there is one (SwiftShader took about 4 s a frame at 1280x720)
const page = await browser.newPage({viewport: {width: W, height: H}});
page.on('console', m => { if (m.type() === 'error') console.log('PAGE', m.text()); });
await openViewer(page, url);
await page.addStyleTag({content: HIDE_PANEL_CSS + ' canvas{position:fixed!important;left:0;top:0;width:100vw!important;height:100vh!important;z-index:99}' +
  '#cap{position:fixed;left:24px;bottom:20px;z-index:100;font:600 28px sans-serif;color:#fff;text-shadow:0 0 6px #000}'});
// the motion button sits under the full-window canvas, so it is clicked from the page
if (motion) await page.evaluate(m => document.querySelector(`#motions button[data-name="${m}"]`)?.click(), motion);
page.setDefaultTimeout(0);   // a SwiftShader screenshot took over 30 s with four recorders running
await page.evaluate(([DIST, motion]) => {
  const v = window.viewer; v.paused = !motion; dispatchEvent(new Event('resize'));
  for (const id of ['autoBlink', 'autoExpr']) { const c = document.getElementById(id); if (c) c.checked = false; }
  if (!motion) { v.vrm.humanoid.resetNormalizedPose(); for (const [b, z] of [['leftUpperArm', -1.15], ['rightUpperArm', 1.15]]) v.vrm.humanoid.getNormalizedBoneNode(b).rotation.z = z; v.vrm.humanoid.update(); }
  const em = v.vrm.expressionManager, set = em.setValue.bind(em); window.lock = {};
  em.setValue = (n, x) => set(n, n in window.lock ? window.lock[n] : x);
  v.vrm.lookAt.target = null; v.camera.fov = 24; v.camera.near = 0.01; v.camera.updateProjectionMatrix();
  const cap = document.createElement('div'); cap.id = 'cap'; document.body.append(cap);
  // 頭は素の骨で読む（足の IK が hips を下げた分は、正規化した骨を戻したあとも素の骨に残る）
  const head = v.vrm.humanoid.getRawBoneNode('head'); const P = v.camera.position.constructor;
  window.rec = (lock, look, caption, dt) => {
    const all = {blink: 0, blinkLeft: 0, blinkRight: 0, happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0};
    window.lock = Object.assign(all, lock);
    for (const [n, x] of Object.entries(window.lock)) if (em.getExpression(n)) set(n, x);
    v.vrm.lookAt.yaw = look[0]; v.vrm.lookAt.pitch = look[1];
    const h = head.getWorldPosition(new P()); h.y += 0.02;
    v.controls.target.copy(h); v.camera.position.set(h.x, h.y + 0.02, h.z + DIST); v.controls.update();
    cap.textContent = caption; v.step(dt);
  };
}, [DIST, motion || '']);
const n0 = Math.round(START * FPS), n1 = Math.round(END * FPS);
// a part starting at START: the motion and the spring bones are run up to it first (no screenshots), so parts
// recorded in parallel join up
if (n0) await page.evaluate(([n, dt]) => { for (let i = 0; i < n; i++) window.viewer.step(dt); }, [n0, 1 / FPS]);
console.log('frames', n1 - n0, 'seconds', (n1 - n0) / FPS);
for (let i = n0; i < n1; i++) {
  const t = i / FPS, seg = T.find(s => t >= s[0] && t < s[1]) || T.at(-1);
  const o = seg[3](t - seg[0], seg[1] - seg[0]); const look = o._look || [0, 0]; delete o._look;
  for (const k in o) o[k] = Math.max(0, Math.min(1, o[k]));
  await page.evaluate(([o, look, cap, dt]) => window.rec(o, look, cap, dt), [o, look, seg[2], 1 / FPS]);
  await page.screenshot({path: path.join(out, `f${String(i - n0).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92});
  if (i % 150 === 0) console.log('frame', i, seg[2]);
}
await browser.close(); console.log('done', out, 'total s', TOTAL);
