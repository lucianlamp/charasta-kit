// モーション中の顔の寄りを撮る(docs/expression-studio.md)。表情を順に出し、カメラは頭に追従する。サーバーが動いている前提。
//   node tools/face_motion.mjs --char <キャラ> --ver <版> --motion ID --out DIR [--seconds 24] [--every 16] [--port 8870]
// 正面と斜め下(yaw 45、pitch -15)を交互に撮る。DIR/index.json に lib/face-check.mjs の motionPlan の一覧を書く。
// 表情は window.lock で固定する(ビューアの毎フレームのまばたきと口の値が上書きするため。tools/studio_checks.mjs と同じ)。
// index.json の value は撮ったときの表情の値、camDist は描いたカメラと頭の距離(m)、camYaw は頭の向きから見た描いたカメラの方位(度)。ラベルどおりに撮れたかを test/face-check-real.test.mjs が見る。
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig, loadPlaywright, parseArgs, viewerUrl, openViewer} from './common.mjs';
import {launchGPU} from './gpu_browser.mjs';
import {motionPlan} from '../lib/face-check.mjs';

const args = parseArgs();
if (!args.out || !args.motion) throw Error('--motion ID と --out DIR が要る');
fs.mkdirSync(args.out, {recursive: true});
const {chromium} = loadPlaywright(), {browser} = await launchGPU(chromium);
try {
  const page = await browser.newPage({viewport: {width: 480, height: 480}});
  page.setDefaultTimeout(120000);
  await page.addInitScript(() => { let s = 12345; Math.random = () => (s = s * 16807 % 2147483647) / 2147483647; });
  await openViewer(page, viewerUrl(args, loadConfig()) + '&embed=1');
  await page.addStyleTag({content: '#overlay{display:none!important} aside,header,nav,#panel,#side{display:none!important} canvas{position:fixed!important;left:0;top:0;width:100vw!important;height:100vh!important;z-index:99}'});
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await page.waitForTimeout(200);
  await page.evaluate(async motion => {
    const v = window.viewer; await v.prepareShot({motion}); dispatchEvent(new Event('resize'));
    for (const id of ['autoBlink', 'autoExpr']) { const c = document.getElementById(id); if (c) c.checked = false; }
    const em = v.vrm.expressionManager, set = em.setValue.bind(em); window.lock = {};
    em.setValue = (n, x) => set(n, n in window.lock ? window.lock[n] : x);
    window.setLock = expr => { window.lock = {blink: 0, blinkLeft: 0, blinkRight: 0, happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, ...(expr === 'none' ? {} : {[expr]: 1})}; };
    window.setLock('none');
    const P = v.camera.position.constructor;
    v.vrm.scene.traverse(o => { if (o.isMesh) o.onBeforeRender = (r, s, cam) => { window.drawnCam = new P().setFromMatrixPosition(cam.matrixWorld); }; });
    v.shotExpression('none'); v.camera.fov = 24; v.camera.near = .01; v.camera.updateProjectionMatrix();
    v.vrm.update(0); v.vrm.springBoneManager?.reset();
    v.hold = true; for (let i = 0; i < 120; i++) v.step(1 / 60); v.hold = false;
  }, args.motion);
  const every = Number(args.every || 16), plan = motionPlan(Number(args.seconds || 24), every);
  for (const p of plan) {
    Object.assign(p, await page.evaluate(({every, expr, yaw, pitch}) => {
      const v = window.viewer, T = v.camera.position.constructor;
      window.setLock(expr);
      for (let i = 0; i < every; i++) v.step(1 / 60);
      const head = v.vrm.humanoid.getNormalizedBoneNode('head'), h = head.getWorldPosition(new T());
      const fw = new T(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new v.camera.quaternion.constructor())), a = yaw * Math.PI / 180, b = pitch * Math.PI / 180;
      const t = h.clone(); t.y += .08;
      const dir = new T(fw.x * Math.cos(a) + fw.z * Math.sin(a), Math.sin(b), -fw.x * Math.sin(a) + fw.z * Math.cos(a)).normalize();
      v.controls.target.copy(t); v.camera.position.copy(t).addScaledVector(dir, .6); v.camera.lookAt(t);
      v.step(0);   // カメラを置いたあとに描く(時刻は進めない)
      // 描いたときのカメラ(メッシュの onBeforeRender が残す)。描き忘れると前のコマの値が残る
      const c = window.drawnCam, off = c.clone().sub(t), yawNow = Math.atan2(fw.z * off.x - fw.x * off.z, fw.x * off.x + fw.z * off.z) * 180 / Math.PI;
      return {value: expr === 'none' ? null : Math.round(v.vrm.expressionManager.getValue(expr) * 1000) / 1000, camDist: Math.round(c.distanceTo(h) * 1000) / 1000, camYaw: Math.round(yawNow * 10) / 10};
    }, {every, expr: p.expr, yaw: p.yaw, pitch: p.pitch}));
    await page.screenshot({path: path.join(args.out, p.file), type: 'jpeg', quality: 88});
  }
  fs.writeFileSync(path.join(args.out, 'index.json'), JSON.stringify(plan, null, 1));
  console.log('frames', plan.length);
} finally { await browser.close(); }
