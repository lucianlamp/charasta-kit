// 表情づくりの確かめの撮影(工程 8)と、試作と版の撮り比べ。サーバーが動いている前提。
//   node tools/studio_checks.mjs --char chara4 --studio rebuild-v4 --proto 2 --out DIR [--port 8871] [--set full|accept]
//   node tools/studio_checks.mjs --char chara4 --ver v4-natural-hair --out DIR [--port 8871] [--set accept]
// 撮り方: 休めの姿勢(腕は下ろす)、ビューアの face(0.6)(頭の 7cm 上を、0.6m 前から)を、頭のまわりに yaw / pitch だけ回す。
// 720x720、視野はビューアの既定(30°)。1 枚ごとに揺れ骨を初めに戻し、1/60 秒を 30 回進めてから撮る(撮る順や時刻で髪が変わらない)。
// ビューア自身の毎フレームの描画は止め、表情は window.lock で固定する(自動まばたきと表情ボタンの上書きを避ける)。
// set accept(撮り比べ): 表情 7(ふだん + blink happy angry sad relaxed surprised)+ 口の形 5 + 視線 5 を、正面と 45° で 34 枚。
// set full(確かめ): accept に、角度の表(yaw -45/0/25/45/65/90 x pitch 25/0/-25)と、表情と視線の組み合わせ(正面)を足す。
// DIR/index.json に [{name, file, kind, expr, gaze, yaw, pitch}] を書く。
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig, loadPlaywright, parseArgs, viewerUrl, openViewer, HIDE_PANEL_CSS} from './common.mjs';
import {launchGPU} from './gpu_browser.mjs';

const args = parseArgs(), out = args.out, set = args.set || 'full';
if (!out) throw Error('--out DIR が要る');
fs.mkdirSync(out, {recursive: true});
const config = (() => { try { return loadConfig(); } catch { return {port: 8870}; } })();
const url = viewerUrl(args, config);
const D = 0.6, EXPR = ['blink', 'happy', 'angry', 'sad', 'relaxed', 'surprised'], VIS = ['aa', 'ih', 'ou', 'ee', 'oh'];
const GAZE = {left: [30, 0], right: [-30, 0], up: [0, -20], down: [0, 20], upleft: [30, -20]};

const shots = [];   // [name, {kind, expr, gaze, yaw, pitch}]
const add = (name, o) => shots.push([name, {expr: 'neutral', gaze: 'center', pitch: 0, ...o}]);
for (const yaw of [0, 45]) {
  add(`expr_neutral_y${yaw}`, {kind: 'expr', yaw});
  for (const e of EXPR) add(`expr_${e}_y${yaw}`, {kind: 'expr', expr: e, yaw});
  for (const v of VIS) add(`mouth_${v}_y${yaw}`, {kind: 'mouth', expr: v, yaw});
  for (const g of Object.keys(GAZE)) add(`gaze_${g}_y${yaw}`, {kind: 'gaze', gaze: g, yaw});
}
if (set === 'full') {
  for (const pitch of [25, 0, -25]) for (const yaw of [-45, 0, 25, 45, 65, 90]) add(`grid_p${pitch}_y${yaw}`, {kind: 'grid', yaw, pitch});
  for (const e of ['angry', 'sad', 'relaxed', 'surprised', 'happy']) for (const g of ['left', 'right', 'up', 'down']) add(`eg_${e}_${g}_y0`, {kind: 'eg', expr: e, gaze: g, yaw: 0});
}

const {chromium} = loadPlaywright();
const {browser} = await launchGPU(chromium);
try {
  const page = await browser.newPage({viewport: {width: 720, height: 720}});
  page.on('console', m => { if (m.type() === 'error') console.log('PAGE', m.text()); });
  await openViewer(page, url);
  await page.addStyleTag({content: HIDE_PANEL_CSS + ' canvas{position:fixed!important;left:0;top:0;width:100vw!important;height:100vh!important;z-index:99} #overlay{display:none!important}'});
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });   // ビューアの毎フレームの描画を止める(残りの 1 回が終わるのを待つ)
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const v = window.viewer; v.paused = true; dispatchEvent(new Event('resize'));
    for (const id of ['autoBlink', 'autoExpr']) { const c = document.getElementById(id); if (c) c.checked = false; }
    const em = v.vrm.expressionManager, set = em.setValue.bind(em); window.lock = {};
    em.setValue = (n, x) => set(n, n in window.lock ? window.lock[n] : x);
    v.vrm.lookAt.target = null;
    window.shot = (yaw, pitch, lock, look, d) => {
      v.vrm.humanoid.resetNormalizedPose();
      for (const [b, z] of [['leftUpperArm', -1.15], ['rightUpperArm', 1.15]]) v.vrm.humanoid.getNormalizedBoneNode(b).rotation.z = z;
      v.vrm.scene.updateMatrixWorld(true);
      v.vrm.springBoneManager?.reset();
      window.lock = Object.assign({blink: 0, blinkLeft: 0, blinkRight: 0, happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0}, lock);
      for (const [n, x] of Object.entries(window.lock)) if (em.getExpression(n)) set(n, x);
      v.vrm.lookAt.yaw = look[0]; v.vrm.lookAt.pitch = look[1];
      for (let i = 0; i < 30; i++) {
        v.face(d);   // 頭の 7cm 上を見る位置。そこから yaw / pitch だけ回す
        const t = v.controls.target, a = yaw * Math.PI / 180, b = pitch * Math.PI / 180;
        v.camera.position.set(t.x + d * Math.sin(a) * Math.cos(b), t.y + d * Math.sin(b), t.z + d * Math.cos(a) * Math.cos(b));
        v.controls.update(); v.step(1 / 60);
      }
    };
  });
  await page.evaluate(() => window.shot(0, 0, {}, [0, 0], 0.6)); await page.screenshot();   // 1 枚目だけ数画素ゆれたので、捨てる 1 枚
  const index = [];
  for (const [name, o] of shots) {
    const lock = o.expr === 'neutral' ? {} : {[o.expr]: 1};
    await page.evaluate(a => window.shot(...a), [o.yaw, o.pitch, lock, GAZE[o.gaze] ?? [0, 0], D]);
    await page.screenshot({path: path.join(out, name + '.png')});
    index.push({name, file: name + '.png', ...o});
  }
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 1));
  console.log('CHECKS', index.length, out);
} finally { await browser.close(); }
