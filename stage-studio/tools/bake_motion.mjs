// きゃらすたのビューアでモーションを再生し、骨(揺れ骨を含む)と表情を毎コマ書き出す。
//   node tools/bake_motion.mjs --base http://127.0.0.1:8870 --char <キャラ> --ver <版> --motion <ID> --seconds 15 --fps 30 --out out/bake.json [--expression happy] [--lips lips.json]
// --once は繰り返さず最後の姿勢で止める。--hold は動きの最後まで進めてから書き始める。--grip は右手の指を曲げて物を持つ形にする。--expression には FACES の顔も渡せる。--lips はコマごとの口の形の配列 [{aa: 0.7}, ...]。コマに emotion(感情の名前)、face(FACES の顔)、look(度。首を回す。+ は人の左)、lift(度。見上げる)も載せられる。口の形があるコマは、顔の口の形(MTH_)をその開きの分だけ弱める。--springs は揺れ骨の値の置き換え {"skirt": [硬さ, 抵抗]}。骨の名前にキーを含む揺れ骨(大文字小文字は区別しない)の stiffness と dragForce を変える。--stop <秒> は歩きを止める。その秒の前後 STOP_WINDOW 秒で両足が地面に着いているコマを選び、その手前の約 0.3 秒でモーションの進みを 1 から 0 へ落として、そのコマの姿勢で止める(揺れ骨、まばたき、表情、口、首は進み続ける)。出力の steps は、かかとが地面に着いた時刻 [{t, side}](秒、書き出しの 0 秒から)。--expression は motion(モーションの時刻表)、neutral、感情の名前。--cues <json> は表情の時刻表 [{from, to, expr: {happy: 0.7}, ease}](秒)。モーションの表情と口の上から、時刻の間だけ VRM の表情を重みで出す
// ビューアと同じ見た目(足の IK、揺れ骨、まばたき、表情)のまま Blender へ渡すのが目的。保管場所は読むだけ。
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {charastaRoot} from './portable.mjs';

const {values: a} = parseArgs({options: {base: {type: 'string', default: 'http://127.0.0.1:8870'}, char: {type: 'string'}, ver: {type: 'string'}, motion: {type: 'string'}, seconds: {type: 'string', default: '0'}, fps: {type: 'string', default: '30'}, charasta: {type: 'string'}, expression: {type: 'string', default: 'motion'}, lips: {type: 'string'}, once: {type: 'boolean', default: false}, hold: {type: 'boolean', default: false}, grip: {type: 'boolean', default: false}, springs: {type: 'string'}, cues: {type: 'string'}, stop: {type: 'string'}, out: {type: 'string'}}});
const charasta = charastaRoot(a.charasta);
const {loadPlaywright} = await import(pathToFileURL(charasta + '/tools/common.mjs'));
const {launchGPU} = await import(pathToFileURL(charasta + '/tools/gpu_browser.mjs'));
const pw = await loadPlaywright();
const {browser} = await launchGPU(pw.chromium);
const openPage = async () => {
  const page = await browser.newPage({viewport: {width: 320, height: 320}});
  page.on('pageerror', e => console.log('pageerror', e.message));
  await page.addInitScript(() => { let s = 12345; Math.random = () => (s = s * 16807 % 2147483647) / 2147483647; });   // まばたきの間隔を固定する。試しと本番で同じ時刻に瞬く(きゃらすたの tools/shoot.mjs と同じ)
  await page.goto(`${a.base}/viewer?char=${a.char}&ver=${a.ver}&follow=0&embed=1`);
  await page.waitForFunction(() => window.viewer?.vrm && window.viewer.loaded);
  await page.evaluate(() => window.viewer.loaded);
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });   // ビューアの毎フレームの描画を止める。動いていると読み込みの速さでまばたきの時刻が変わる
  await page.waitForTimeout(200);
  return page;
};

// 感情の表情に無い顔。VRoid の Fcl_ の形を重ねる。口は開かない形だけを使う
const FACES = {
  worried: {BRW_Sorrow: 0.9, EYE_Sorrow: 0.25, MTH_Sorrow: 0.85},
  afraid: {BRW_Sorrow: 1, EYE_Surprised: 0.85, MTH_Sorrow: 0.85},
  shocked: {BRW_Surprised: 1, EYE_Surprised: 0.7, MTH_Sorrow: 0.9},
  tense: {BRW_Angry: 0.6, EYE_Angry: 0.25, MTH_Sorrow: 0.6},
  cold: {BRW_Angry: 0.85, EYE_Angry: 0.45, MTH_Angry: 0.4},
};
const FLEX = {Proximal: 32, Intermediate: 42, Distal: 28};   // 紙を挟む指の曲がり(度)

const stop = a.stop === undefined ? 0 : Number(a.stop);
if (a.stop !== undefined && !(stop > 0)) throw Error('--stop は正の秒数');
// 足の高さ(m)の判定。足首の骨(Foot)で、かかとが着いた時刻を決める。足首は着いている間 IK で床に留まるので、一歩ごとの最低の高さを基準にする
//   PLANT 以内に下りたら着いた、RELEASE を超えたら離れた(ふらつきで二度数えない)。LIFT 以上に上がった足だけが次に着いたとき一歩に数える(立ち止まりの揺れを歩きと見ない)
//   GROUND は足首かつま先(Toes)のどちらかが基準に近い、地面に着いている足。止めるコマの両足の判定に使い、そのコマが無い歩きでは LOOSE まで許す
const FOOT = {plant: 0.004, release: 0.01, lift: 0.05, ground: 0.006, loose: 0.02}, STOP_WINDOW = 0.6, STOP_EASE = 0.3;
// --cues は表情の時刻表 [{from, to, expr: {表情の名前: 重み}, ease}](秒、書き出しの 0 秒から)。VRM の表情(custom も)を重みで出し、ease 秒(既定 0.2)で出入りする
const cues = a.cues ? JSON.parse(fs.readFileSync(a.cues, 'utf8')) : null;
for (const c of cues ?? []) if (!(c.to > c.from) || !c.expr || typeof c.expr !== 'object' || !Object.values(c.expr).every(w => w >= 0 && w <= 1) || (c.ease != null && !(c.ease > 0))) throw Error('--cues の行が不正(from < to、expr は {名前: 0〜1}、ease は正の秒): ' + JSON.stringify(c));
const lips = a.lips ? JSON.parse(fs.readFileSync(a.lips, 'utf8')) : null, springs = a.springs ? JSON.parse(a.springs) : null;
const run = async ({motion, seconds, fps, expression, lips, cues: exprCues, once, hold, grip, faces, flex, springs, stop, foot, window: win, easeSec, measure, ease: planned}) => {
  const v = window.viewer, VOWELS = ['aa', 'ih', 'ou', 'ee', 'oh'];
  const springHits = {};   // 置き換えた揺れ骨の数。キーに当たる骨が無いと値は変わらないので、書き出して気づけるようにする
  for (const [key, [stiffness, drag]] of Object.entries(springs ?? {})) {
    springHits[key] = 0;
    for (const j of v.vrm.springBoneManager?.joints ?? []) if (j.bone.name.toLowerCase().includes(key.toLowerCase())) { j.settings.stiffness = stiffness; j.settings.dragForce = drag; springHits[key]++; }
  }
  const face = faces[expression], fingers = grip ? v.fingerCurl(flex) : null;   // 休めの姿勢を測るので、モーションより先に呼ぶ
  const begin = async () => {
    await v.prepareShot({motion, once});
    v.shotExpression(face ? 'neutral' : expression);
    if (hold) for (let f = 0; f < v.duration * fps + 15; f++) v.step(1 / fps);
  };
  await begin();
  const dur = v.duration, F = Math.round((seconds > 0 ? seconds : dur) * fps), bones = [], meshes = [];
  v.vrm.scene.traverse(o => { if (o.isBone) bones.push(o); if (o.isMesh && o.morphTargetInfluences?.length) meshes.push(o); });
  // 足の高さ。足首とつま先の世界の高さ [左足首, 右足首, 左つま先, 右つま先]。つま先の骨が無い体は Infinity(足首だけで判定する)
  const sides = ['left', 'right'].map(k => ({ankle: v.vrm.humanoid.getRawBoneNode(k + 'Foot'), toes: v.vrm.humanoid.getRawBoneNode(k + 'Toes')})), probe = sides[0].ankle.position.clone();
  const heights = () => { v.vrm.scene.updateMatrixWorld(true); return [...sides.map(s => s.ankle.getWorldPosition(probe).y), ...sides.map(s => (s.toes ? s.toes.getWorldPosition(probe).y : Infinity))]; };
  const floors = hs => [0, 1, 2, 3].map(j => Math.min(...hs.map(r => r[j])));   // 足首と左右のつま先が一番低いときの高さ。この動きでの床
  // 止める計画。測る呼び出し(measure)ではモーションを通しで走らせて足の高さを測り、止めるコマを決めて答える。決めた計画は、別のページで最初から焼くときに渡す
  //   n コマで進みを 1 から 0 へ落とす(cos で、進む量の合計は n/2 コマ)。止めるコマ g の姿勢は g + 1 コマ目の時刻なので、落とし始めは g + 1 - n / 2
  if (measure) {
    const last = Math.min(F, Math.ceil((stop + win) * fps) + 1), hs = [];
    for (let f = 0; f < last; f++) { v.step(1 / fps); hs.push(heights()); }
    const ref = floors(hs), n = 2 * Math.round(easeSec * fps / 2);
    // 足ごとに、足首とつま先のうち低い方が床から離れている高さ。両足とも GROUND 以内のコマを探し、その中で高さの和が小さいコマ(同じなら指定の秒に近いコマ)を選ぶ
    //   ギャップ(片足が離れてから他方が着くまでに両足が浮く 1〜2 コマ)の歩きでは、そのコマが無い。前後 win 秒で二つの足の高い方が一番低いコマを選び、それが LOOSE を超えるときだけ失敗にする
    const lift = r => [0, 1].map(k => Math.min(r[k] - ref[k], Number.isFinite(ref[2 + k]) ? r[2 + k] - ref[2 + k] : Infinity));   // つま先の骨が無い体は足首だけで見る(Infinity - Infinity が NaN になり、どのコマも同じに見える)
    const cands = [...hs.keys()].filter(f => Math.abs(f / fps - stop) <= win && f + 1 >= n / 2 && f + n / 2 < F);
    const worst = f => Math.max(...lift(hs[f])), total = f => lift(hs[f]).reduce((x, y) => x + y, 0), nearer = (f, p) => Math.abs(f / fps - stop) < Math.abs(p / fps - stop);
    const strict = cands.filter(f => worst(f) <= foot.ground);
    const pool = strict.length ? strict : cands, score = strict.length ? total : worst;
    if (!pool.length) throw Error(`--stop ${stop}: 前後 ${win} 秒に止められるコマが無い`);
    const g = pool.reduce((p, f) => (score(f) < score(p) - 1e-9 || (Math.abs(score(f) - score(p)) <= 1e-9 && nearer(f, p)) ? f : p));
    if (worst(g) > foot.loose) throw Error(`--stop ${stop}: 前後 ${win} 秒に両足が地面に着いたコマが無い(一番近いコマで足が ${(worst(g) * 1000).toFixed(0)} mm 浮く)`);
    return {ease: {from: g + 1 - n / 2, n, frame: g, lift: worst(g)}};
  }
  const ease = planned;
  // コマごとの進み。1 は普通に進む。0 より大きく 1 より小さいときは、モーションを進める短い一歩と、止めたまま揺れ骨や表情などだけを進める一歩に分ける(足の IK は止めた姿勢にもかかる)
  const rateAt = f => (!ease || f < ease.from ? 1 : f < ease.from + ease.n ? 0.5 * (1 + Math.cos(Math.PI * (f - ease.from + 0.5) / ease.n)) : 0);
  const advance = f => {
    const r = rateAt(f);
    if (r >= 1) { v.step(1 / fps); return; }
    if (r > 1e-6) { v.hold = false; v.step(r / fps); }
    v.hold = true; v.step((r > 1e-6 ? 1 - r : 1) / fps);
    v.hold = false;
  };
  const sample = [];
  const out = {fps, duration: dur, yaw: v.vrm.scene.rotation.y, ...(springs ? {springHits} : {}), bones: bones.map(b => b.name), meshes: meshes.map(m => m.parent?.isGroup && !m.parent.isBone && m.parent !== v.vrm.scene ? m.parent.name : m.name), frames: []};
  // 顔の形の番号。名前の末尾で探す(材質の前置きが付くモデルがある)
  const shapes = !face ? [] : meshes.flatMap(m => Object.entries(face).flatMap(([k, w]) => {
    const key = Object.keys(m.morphTargetDictionary ?? {}).find(n => n.endsWith('Fcl_' + k));
    return key ? [{m, i: m.morphTargetDictionary[key], w, mouth: k.startsWith('MTH_')}] : [];
  }));
  // コマごとの顔。EASE 秒で出入りする(ビューアの感情と同じ)
  const EASE = 0.15, cues = !lips?.some(x => x?.face) ? [] : Object.entries(faces).map(([name, keys]) => ({name, w: 0, shapes: meshes.flatMap(m => Object.entries(keys).flatMap(([k, w]) => {
    const key = Object.keys(m.morphTargetDictionary ?? {}).find(n => n.endsWith('Fcl_' + k));
    return key ? [{m, i: m.morphTargetDictionary[key], w, mouth: k.startsWith('MTH_')}] : [];
  }))}));
  // 首を回す。頭と首で半分ずつ、世界の軸で回す。左右は上向きの軸、見上げは人の左向きの軸(左右の太ももの付け根を結ぶ向き)
  const neck = v.vrm.humanoid.getRawBoneNode('neck'), head = v.vrm.humanoid.getRawBoneNode('head');
  const legL = v.vrm.humanoid.getRawBoneNode('leftUpperLeg'), legR = v.vrm.humanoid.getRawBoneNode('rightUpperLeg');
  const turn = (bone, rad, axis = bone.up.clone().set(0, 1, 0)) => {
    const parent = bone.parent.getWorldQuaternion(bone.quaternion.clone());
    const spin = bone.quaternion.clone().setFromAxisAngle(axis, rad);
    bone.quaternion.premultiply(parent.clone().invert().multiply(spin).multiply(parent));
    bone.updateMatrixWorld(true);
  };
  for (let f = 0; f < F; f++) {
    if (lips) v.mouthOverride = lips[f] ?? {};
    advance(f);
    sample.push(heights());
    const open = Math.min(1, Math.max(0, ...VOWELS.map(k => lips?.[f]?.[k] ?? 0))), keep = s => (s.mouth ? 1 - open : 1);   // 話す間は顔の口の形を弱めて、母音の口を開かせる
    for (const s of [...shapes, ...cues.flatMap(c => c.shapes)]) s.m.morphTargetInfluences[s.i] = 0;   // 顔の形は表情に結ばれていないので、置き直さないと前のコマの値が残る(顔が抜けても眉や口が戻らない)
    for (const s of shapes) s.m.morphTargetInfluences[s.i] = Math.max(s.m.morphTargetInfluences[s.i], s.w * keep(s));
    for (const c of cues) {
      c.w = Math.max(0, Math.min(1, c.w + (lips[f]?.face === c.name ? 1 : -1) / (EASE * fps)));
      for (const s of c.shapes) s.m.morphTargetInfluences[s.i] = Math.max(s.m.morphTargetInfluences[s.i], s.w * c.w * keep(s));
    }
    if (lips?.[f]?.look) { const rad = lips[f].look * Math.PI / 360; turn(neck, rad); turn(head, rad); }
    if (lips?.[f]?.lift) {
      const left = legL.getWorldPosition(legL.position.clone()).sub(legR.getWorldPosition(legR.position.clone())).normalize(), rad = -lips[f].lift * Math.PI / 360;
      turn(neck, rad, left); turn(head, rad, left);
    }
    if (exprCues?.length) {   // 表情の時刻表。重みは台形(出入り ease 秒)。同じ表情が重なれば大きい方
      const em = v.vrm.expressionManager, t = f / fps, want = {};
      for (const c of exprCues) {
        const e = c.ease ?? 0.2, k = Math.max(0, Math.min(1, (t - c.from) / e, (c.to - t) / e));
        for (const [n, w] of Object.entries(c.expr)) want[n] = Math.max(want[n] ?? 0, w * k);
      }
      for (const c of exprCues) for (const n of Object.keys(c.expr)) if (em.getExpression(n)) em.setValue(n, want[n] ?? 0);
      em.update();
    }
    fingers?.();
    out.frames.push({b: bones.map(b => [...b.position.toArray(), ...b.quaternion.toArray()].map(x => +x.toFixed(5))), m: meshes.map(m => m.morphTargetInfluences.map(x => +x.toFixed(4)))});
  }
  // かかとが地面に着いた時刻。足ごとに、LIFT 以上に上がったあと PLANT 以内へ下りた最初のコマ
  const ref = floors(sample), steps = [];
  sides.forEach((_, side) => {
    let planted = false, lifted = false;
    sample.forEach((r, f) => {
      const y = r[side] - ref[side];
      if (planted) { if (y > foot.release) planted = false; } else if (y <= foot.plant) { planted = true; if (lifted) { steps.push({t: +(f / fps).toFixed(4), side: side ? 'right' : 'left'}); lifted = false; } }
      if (y >= foot.lift) lifted = true;
    });
  });
  out.steps = steps.sort((x, y) => x.t - y.t);
  if (ease) out.stop = {t: +((ease.frame) / fps).toFixed(4), from: +(ease.from / fps).toFixed(4), seconds: +(ease.n / fps).toFixed(4), lift: +(ease.lift * 1000).toFixed(1)};
  return out;
};
const args = {motion: a.motion, seconds: Number(a.seconds), fps: Number(a.fps), expression: a.expression, lips, cues, once: a.once, hold: a.hold, grip: a.grip, faces: FACES, flex: FLEX, springs, stop, foot: FOOT, window: STOP_WINDOW, easeSec: STOP_EASE};
let ease = null;
if (stop > 0) {   // 止めるコマは別のページで測る。同じページで最初に戻すと、揺れ骨が最初のコマから少し違う
  const probe = await openPage();
  ease = (await probe.evaluate(run, {...args, measure: true})).ease;
  await probe.close();
}
const page = await openPage();
const res = await page.evaluate(run, {...args, ease});
fs.writeFileSync(a.out, JSON.stringify(res));
if (res.springHits) console.log('springs', JSON.stringify(res.springHits));
if (res.stop) console.log('stop', JSON.stringify(res.stop));
console.log('steps', res.steps.length, res.steps.slice(0, 6).map(s => `${s.side[0]}${s.t}`).join(' '));
console.log('frames', res.frames.length, 'bones', res.bones.length, 'meshes', res.meshes.length, 'duration', res.duration, 'yaw', res.yaw);
await browser.close();
