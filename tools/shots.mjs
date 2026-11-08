// きゃらすたのビューアの撮影: 顔テクスチャ方式の VRM の角度・表情・視線・口・まばたきの連続写真。
// node tools/shots.mjs --char chara4 [--ver v3-smile-mouth] --out OUT_DIR   （サーバーが動いている前提）
// SHOTS=grid,expr,gaze（既定）, eg（表情中の視線）, mouth, blinkseq, sweep（SWEEP=表情名）, closedgrid, lip, skin
// grid: 顔の周りのカメラ yaw -45/0/25/45/65/90 x pitch +25/0/-25、expr: 正面の寄り、gaze: lookAt の向き。
// 表情は window.lock で固定する（ビューア自身の自動まばたきと表情ボタンが毎フレーム上書きするため）。
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig, loadPlaywright, parseArgs, viewerUrl, openViewer, HIDE_PANEL_CSS} from './common.mjs';
import {launchGPU} from './gpu_browser.mjs';
const args = parseArgs(), out = args.out; if (!out) throw Error('--out DIR が要る');
fs.mkdirSync(out, {recursive: true});
const {chromium} = loadPlaywright(), url = viewerUrl(args, loadConfig());
const {browser} = await launchGPU(chromium);   // the GPU when there is one (ANGLE=... forces a backend)
const page = await browser.newPage({viewport: {width: 720, height: 720}});
page.on('console', m => { if (m.type() === 'error') console.log('PAGE', m.text()); });
await openViewer(page, url);
await page.addStyleTag({content: HIDE_PANEL_CSS + ' canvas{position:fixed!important;left:0;top:0;width:100vw!important;height:100vh!important;z-index:99}'});
await page.evaluate(() => {
  const v = window.viewer; v.paused = true; v.vrm.humanoid.resetNormalizedPose(); dispatchEvent(new Event('resize'));
  for (const [b, z] of [['leftUpperArm', -1.15], ['rightUpperArm', 1.15]]) v.vrm.humanoid.getNormalizedBoneNode(b).rotation.z = z;   // arms down (T-pose arms block yaw 90 / pitch -25)
  const em = v.vrm.expressionManager, set = em.setValue.bind(em); window.lock = {};
  em.setValue = (n, x) => set(n, n in window.lock ? window.lock[n] : x);
  v.vrm.lookAt.target = null; v.camera.fov = 24; v.camera.near = 0.01; v.camera.updateProjectionMatrix();
  const T = v.camera.position.constructor; const hb = v.vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new T());
  window.shot = (yaw, pitch, dist, dy, lock, look) => {
    window.lock = Object.assign({blink: 0, blinkLeft: 0, blinkRight: 0, happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, blink_1: 0, blink_2: 0, blink_3: 0, blink_4: 0}, lock || {});
    for (const [n, x] of Object.entries(window.lock)) if (em.getExpression(n)) set(n, x);   // visemes are not set by the viewer
    const [ly, lp] = look || [0, 0]; v.vrm.lookAt.yaw = ly; v.vrm.lookAt.pitch = lp;
    const t = hb.clone(); t.y += dy; const a = yaw * Math.PI / 180, b = pitch * Math.PI / 180;
    v.controls.target.copy(t); v.camera.position.set(t.x + dist * Math.sin(a) * Math.cos(b), t.y + dist * Math.sin(b), t.z + dist * Math.cos(a) * Math.cos(b));
    v.controls.update(); for (let i = 0; i < 3; i++) v.step(1 / 60);
  };
});
async function snap(name, ...a) {
  await page.evaluate(a => window.shot(...a), a);
  await page.screenshot({path: path.join(out, name + '.png')});
}
const P = process.env.SHOTS || 'grid,expr,gaze';
const GD = Number(process.env.GRID_DIST || 0.75), ED = Number(process.env.EXPR_DIST || 0.8), DY = Number(process.env.DY || 0.06);   // chara3: big head
if (P.includes('grid')) for (const p of [25, 0, -25]) for (const y of [-45, 0, 25, 45, 65, 90]) await snap(`grid_p${p}_y${y}`, y, p, GD, DY);
const E = ['neutral', 'blink', 'blinkLeft', 'blinkRight', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh'];
if (P.includes('expr')) for (const e of E) for (const y of [0, 45]) await snap(`expr_${e}_y${y}`, y, 0, ED, DY, e === 'neutral' ? {} : {[e]: 1});
const G = {left: [30, 0], right: [-30, 0], up: [0, -20], down: [0, 20], upleft: [30, -20], downright: [-30, 20]};
if (P.includes('gaze')) for (const [g, l] of Object.entries(G)) for (const y of [0, 45]) await snap(`gaze_${g}_y${y}`, y, 0, ED, DY, {}, l);
// gaze while an expression is out (the eyeball copies behind the layers of blink_layers.py)
if (P.includes('eg')) for (const e of ['neutral', 'angry', 'sad', 'relaxed', 'surprised']) for (const [g, l] of Object.entries({center: [0, 0], left: [30, 0], right: [-30, 0], up: [0, -20], down: [0, 20]})) for (const y of [0, 45]) await snap(`eg_${e}_${g}_y${y}`, y, 0, ED, DY, e === 'neutral' ? {} : {[e]: 1}, l);
if (P.includes('mouth')) for (const e of ['neutral', 'aa', 'happy']) for (const [y, p] of [[0, 0], [25, 0], [45, 0], [65, 0], [0, -30], [30, -30]]) await snap(`mouth_${e}_y${y}_p${p}`, y, p, 0.5, 0.045, e === 'neutral' ? {} : {[e]: 1});
if (P.includes('blinkseq')) for (const e of ['neutral', 'blink_1', 'blink_2', 'blink_3', 'blink_4', 'blink', 'blinkLeft', 'blinkRight']) for (const [y, p] of [[0, 0], [45, 0], [25, 20], [-30, -15]]) await snap(`seq_${e}_y${y}_p${p}`, y, p, ED, DY, e === 'neutral' ? {} : {[e]: 1});
const SW = process.env.SWEEP || 'blink';   // expression to sweep
// expression value sweep (blink_layers.py): weights 0..1 from the front and the side, and the closed eye from many angles
if (P.includes('sweep')) for (const w of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) for (const [y, p] of [[0, 0], [45, 0]]) await snap(`sweep_${SW}_w${Math.round(w * 100)}_y${y}_p${p}`, y, p, ED, DY, {[SW]: w});
if (P.includes('closedgrid')) for (const e of ['neutral', 'blink', 'blinkLeft', 'happy']) for (const [y, p] of [[0, 0], [45, 0], [90, 0], [-45, 0], [0, 25], [0, -25], [65, 20]]) await snap(`cg_${e}_y${y}_p${p}`, y, p, ED, DY, e === 'neutral' ? {} : {[e]: 1});
// lip sync (blink_layers.py): each viseme 0..1, two visemes at once, and visemes over an emotion (the emotion's mouth goes back)
if (P.includes('lip')) {
  const MD = 0.5, MY = 0.045, L = {};
  for (const v of ['aa', 'ih', 'ou', 'ee', 'oh']) for (const w of [0.1, 0.2, 0.4, 0.6, 0.8, 1]) L[`v_${v}_w${w * 100}`] = {[v]: w};
  Object.assign(L, {pair_aa60_oh30: {aa: 0.6, oh: 0.3}, pair_aa30_oh60: {aa: 0.3, oh: 0.6}, pair_aa50_oh50: {aa: 0.5, oh: 0.5}, pair_ih50_ou40: {ih: 0.5, ou: 0.4}});
  for (const e of ['happy', 'angry', 'sad', 'relaxed', 'surprised']) for (const [v, w] of [['aa', 0], ['aa', 0.1], ['aa', 0.2], ['aa', 0.5], ['aa', 1], ['ou', 0.6], ['ih', 1]]) L[`emo_${e}_${v}${w * 100}`] = {[e]: 1, [v]: w};
  for (const [n, lk] of Object.entries(L)) for (const y of (n.startsWith('v_') ? [0] : [0, 45])) await snap(`lip_${n}_y${y}`, y, 0, MD, MY, lk);
}
if (P.includes('skin')) {
  await snap('skin_front', 0, 0, Number(process.env.SKIN_DIST || 1.1), Number(process.env.SKIN_DY || -0.05));
}
await browser.close(); console.log('done', out);
