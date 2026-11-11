// 撮るジョブの撮影: モーションとセリフを決まった時刻で進め、1 コマずつ JPEG に撮る。音は付けない(lib/shoot.mjs が ffmpeg でまとめる)。
//   node tools/shoot.mjs --char <キャラ> [--ver <バージョン>] [--motion <モーション>] [--line hello --line-seconds 2.1] --seconds 21.92 --out DIR
//     [--framing full|upper|face] [--aspect 9:16] [--width 1080 --height 1920] [--fps 30] [--expression motion] [--background viewer|#rrggbb] [--port 8870]
// 再生の速さに左右されないよう、ビューア自身の描画を止め、時刻を手で進める。揺れ骨は dt で振る舞いが変わる(drag は 1 歩ごとに掛かる)ので、
// 画面で見ているのと同じ 1/60 秒の歩みに揃え、30 fps は 2 歩で 1 コマにする。最初のコマの前に、最初の姿勢のまま揺れ骨を落ち着かせる。
// まばたきの間隔は Math.random で決まるので、種を固定して、同じ条件なら同じコマにする。
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig, loadPlaywright, parseArgs, viewerUrl, openViewer} from './common.mjs';
import {launchGPU} from './gpu_browser.mjs';

// 失敗したら、ジョブのエラーに出る一行(原因)だけを書いて終わる。スタックを出すと「Node.js v22」の行しか残らない
try {
  const args = parseArgs(), out = args.out; if (!out) throw Error('--out DIR が要る');
  const W = Number(args.width || 1080), H = Number(args.height || 1920), fps = Number(args.fps || 30), seconds = Number(args.seconds);
  if (!(seconds > 0)) throw Error('--seconds が要る');
  const framing = args.framing || 'full', aspect = (a => a[0] / a[1])((args.aspect || '9:16').split(':').map(Number));
  const expression = args.expression || 'motion', background = !args.background || args.background === 'viewer' ? null : args.background;
  const SETTLE_STEPS = 180, N = Math.round(seconds * fps);
  fs.mkdirSync(out, {recursive: true});
  const {chromium} = loadPlaywright(), url = viewerUrl(args, loadConfig()) + '&embed=1';   // embed: 背景の色を撮る画面のプレビューに合わせる
  const {browser} = await launchGPU(chromium);
  try {
    const page = await browser.newPage({viewport: {width: W, height: H}});
    page.setDefaultTimeout(0);
    page.on('console', m => { if (m.type() === 'error') console.log('PAGE', m.text()); });
    await page.addInitScript(() => { let s = 12345; Math.random = () => (s = s * 16807 % 2147483647) / 2147483647; });
    await openViewer(page, url);
    await page.addStyleTag({content: '#overlay{display:none!important}'});
    await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
    await page.waitForTimeout(200);   // ビューアの毎フレームの描画の残りの 1 回を待つ
    const plan = await page.evaluate(async ({motion, line, lineSeconds, framing, aspect, expression, background, fps, SETTLE_STEPS}) => {
      const v = window.viewer;
      await v.prepareShot({motion});
      dispatchEvent(new Event('resize'));
      v.shotExpression(expression); v.shotBackground(background);
      const plan = v.aimShot({framing, aspect});
      if (line) { await v.playVoice(line, true); v.voice.time = 0; }
      v.hold = !!motion;   // 最初の姿勢のまま揺れ骨を進める(hold は足の IK をかける)
      v.vrm.scene.updateMatrixWorld(true); v.vrm.update(0); v.vrm.springBoneManager?.reset();   // update(0) で骨の位置を揺れ骨に渡してから初めに戻す
      for (let i = 0; i < SETTLE_STEPS; i++) v.step(1 / 60);
      v.hold = false;
      const sub = Math.round(60 / fps);
      window.advance = t => {
        for (let i = 0; i < sub; i++) {
          if (v.voice) { if (t >= lineSeconds) v.voice.audio.onended(); else v.voice.time = t; }   // 声の終わりはビューアの再生と同じ処理にする
          v.step(1 / 60);
        }
      };
      return plan;
    }, {motion: args.motion || null, line: args.line || null, lineSeconds: Number(args['line-seconds'] || 0), framing, aspect, expression, background, fps, SETTLE_STEPS});
    console.log('camera', JSON.stringify(plan), 'frames', N);
    const t0 = Date.now();
    for (let f = 0; f < N; f++) {
      if (f) await page.evaluate(t => window.advance(t), f / fps);
      await page.screenshot({path: path.join(out, `f${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95});
      if (f % 150 === 0) console.log('frame', f, `${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
    }
    console.log('done', N, 'frames', `${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  } finally { await browser.close(); }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
