// 表情づくりのジョブ(段階 2 の順番待ちで 1 件ずつ動く): studio-front / studio-build / studio-video / studio-checks。
// 中身は studio/face_atlas/ のスクリプト(docs の表情づくりの工程の順と引数)。Blender は背景で動かす。
// 試しの動き: CHARASTA_FAKE_BLENDER=1 は Blender と Python のスクリプトを呼ばず、決まった小さなファイルを置く
// (ジョブの積み方・状態・試作の番号・古いかどうかの判定は本物と同じに動く)。CHARASTA_FAKE_CAPTURE=1 はブラウザで撮らない。
import fs from 'node:fs/promises';
import path from 'node:path';
import {root} from './config.mjs';
import {LibraryError, checkId, readJsonOr, writeJson, inside} from './library.mjs';
import {STUDIO_JOBS, EXPRESSIONS, sha256File, copyBusy} from './studio.mjs';

const S = name => path.join(root, 'studio', 'face_atlas', name);
const now = () => new Date().toISOString();
const pad = n => String(n).padStart(3, '0');
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];
// 1x1 の透明な PNG(試しの動きの撮影の代わり)
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// 積むときの確かめ。pending(step) は、その工程のジョブが順番待ちか実行中にあるか(前の工程を続けて積めるように)。
export async function studioJobInput(studio, body, pending) {
  const step = STUDIO_JOBS[body.type];
  const charId = checkId(body.charId, 'キャラ ID'), studioId = checkId(body.studioId, '表情づくり ID');
  const w = await studio.read(charId, studioId);
  const need = (cond, msg) => { if (!cond) throw new LibraryError('bad-input', msg); };
  const ready = s => w.steps[s]?.state === 'done' || pending(charId, studioId, s);
  if (pending(charId, studioId, step)) throw new LibraryError('exists', `この表情づくりの「${step}」のジョブが既に順番待ちにある`);
  if (copyBusy(w)) throw new LibraryError('exists', '材料をコピー中なので、終わってから積む');
  const input = {charId, studioId};
  if (step === 'front') need(w.inputs.some(f => f.name === 'character.blend'), '先に材料をコピーする(工程 1)');
  if (step === 'build') {
    need(ready('front'), '先に正面を撮る(工程 2)'); need(w.rects, '先に区画の範囲を決める(工程 4)');
    need(w.inputs.some(f => f.name === 'review.vrm'), '材料に review.vrm が無い(組み立てが残すメッシュの見本)');
  }
  if (step === 'video') {
    need(ready('build'), '先に組み立てる(工程 5)'); need(w.options.video.videos?.length, '中割りの動画が無い(手で置く)');
    need(w.options.video.open, '設定 video.open(髪のない中立の区画)が無い');
  }
  if (step === 'checks') {
    if (body.proto != null) {
      need(w.prototypes.some(p => p.n === Number(body.proto)), `試作 ${body.proto} が無い`); input.proto = Number(body.proto);
    } else need(w.prototypes.length || pending(charId, studioId, 'build') || pending(charId, studioId, 'video'), '試作が無い(先に組み立てる)');
    input.set = body.set === 'accept' ? 'accept' : 'full';
  }
  return input;
}

// ジョブ 1 件を動かす。ctx は jobs.mjs の {job, log, step, run}。tools: {kit, patchVrm, springTune}、getPort: ビューアのポート
export async function runStudioJob(ctx, {studio, tools, getPort, env}) {
  const {charId, studioId} = ctx.job.input, step = STUDIO_JOBS[ctx.job.type];
  // 読み込みと確かめも try の中に入れる(外に投げると、積んだときに書いた queued が work.json に残って、以後の設定変更が全部 409 になる)
  try {
    const dir = studio.dir(charId, studioId), w = await studio.read(charId, studioId);
    const fake = !!env.CHARASTA_FAKE_BLENDER;
    const abs = r => inside(dir, r);
    const x = {
      dir, w, abs, tools, getPort, env, studio,
      blender: (args, fakeFn) => fake ? fakeFn() : ctx.run('blender', args),
      python: (args, extraEnv = {}, fakeFn) => {
        if (fake) return fakeFn();
        for (const [k, v] of Object.entries(extraEnv)) ctx.log(`  ${k}=${v}\n`);
        return ctx.run('python', args, {env: extraEnv});
      },
      node: (args, fakeFn) => fake ? fakeFn() : ctx.run('node', args),
    };
    const prereq = {build: 'front', video: 'build'}[step];
    if (prereq && w.steps[prereq]?.state !== 'done') throw new Error(`前の工程(${prereq})が終わっていない`);
    if (step === 'checks' && !w.prototypes.length) throw new Error('試作が無い');
    const checked = step === 'checks' ? (ctx.job.input.proto ?? w.prototypes.at(-1)?.n) : null;
    const inputHash = await studio.stepHash(charId, studioId, step, w, checked);
    await studio.update(charId, studioId, w => { w.steps[step] = {...(w.steps[step] ?? {}), state: 'running', jobId: ctx.job.id, error: null}; });
    const result = await RUN[step](ctx, x);
    await studio.update(charId, studioId, w => { w.steps[step] = {state: 'done', jobId: ctx.job.id, inputHash, at: now(), result}; });
    return {charId, studioId, step, ...result};
  } catch (e) {
    // 自分のジョブが書いた状態のときだけ failed にする(別のジョブが積み直していたら触らない)
    await studio.update(charId, studioId, w => {
      if (w.steps[step]?.jobId === ctx.job.id) w.steps[step] = {state: 'failed', jobId: ctx.job.id, at: now(), error: e.message};
    }).catch(err => { ctx.log(`工程の失敗を work.json に書けない: ${err.message}\n`); console.error('工程の失敗を work.json に書けない', ctx.job.id, err.message); });
    throw e;
  }
}

// 撮り直しでカメラが動いた分だけ、描いた絵の位置合わせをずらす(render px = 絵の px * s + t)。
// smooth_jaw.py であごを直すと、正面の撮影の中心が動く(例: 10.9 画素)。倍率が同じなら平行移動だけ。
export function shiftAlign(al, pre, front) {
  const S = pre.size, kp = S / pre.ortho_scale, kf = S / front.ortho_scale, a = kf / kp;
  const dx = (pre.center[0] - front.center[0]) * kf + S / 2 * (1 - a), dy = (front.center[1] - pre.center[1]) * kf + S / 2 * (1 - a);
  return Object.fromEntries(Object.entries(al).map(([k, [s, tx, ty]]) => [k, [s * a, tx * a + dx, ty * a + dy]]));
}

const fakeRender = async (out, dz = 0) => {
  await fs.mkdir(out, {recursive: true});
  await writeJson(path.join(out, 'cam.json'), {center: [0, 1.36 + dz], ortho_scale: 0.2273, size: 2048});
  for (const f of ['skin.png', 'with_hair.png']) await fs.writeFile(path.join(out, f), TINY_PNG);
};

const RUN = {
  // 2 正面を撮る: 撮影 -> 位置合わせ -> チークを焼く -> あごをなめらかに -> 撮り直し
  async front(ctx, x) {
    const o = x.w.options.front, F = x.abs('face'), pre = path.join(F, 'pre'), fr = path.join(F, 'front'), work = x.abs('work');
    const blend = x.abs('inputs/character.blend'), size = String(o.size ?? 2048), faceBlend = path.join(work, 'face.blend');
    for (const d of [pre, fr]) await fs.rm(d, {recursive: true, force: true});
    for (const f of ['cheek.blend', 'face.blend']) await fs.rm(path.join(work, f), {force: true});
    await fs.mkdir(work, {recursive: true});
    await ctx.step('正面を撮る');
    await x.blender(['-b', blend, '--python-exit-code', '1', '--python', S('render_front.py'), '--', pre, size], () => fakeRender(pre));
    if (o.align?.length) {
      await ctx.step('描いた絵の位置合わせ');
      await x.python([S('align.py'), pre, ...o.align.map(x.abs), '--same'], {}, () =>
        writeJson(path.join(pre, 'align.json'), Object.fromEntries(o.align.map(f => [path.basename(f, path.extname(f)), [1.6, 8, 8]]))));
    }
    let cur = blend;
    if (o.cheek) {
      await ctx.step('チークを頭のテクスチャに焼く');
      const out = path.join(work, 'cheek.blend');
      await x.blender(['-b', cur, '--python-exit-code', '1', '--python', S('bake_overlay.py'), '--', pre, x.abs(o.cheek.overlay), o.cheek.align, out], () => fs.copyFile(cur, out));
      cur = out;
    }
    if (o.jaw) {
      await ctx.step('あごをなめらかにする');
      await x.blender(['-b', cur, '--python-exit-code', '1', '--python', S('smooth_jaw.py'), '--', faceBlend, String(o.jaw.mouthZ), String(o.jaw.cuts ?? 2), String(o.jaw.iters ?? 6)],
        () => fs.copyFile(cur, faceBlend));
      cur = faceBlend;
    }
    if (cur !== faceBlend) await fs.copyFile(cur, faceBlend);
    if (cur !== blend) {
      await ctx.step('直したあとの正面を撮る');
      await x.blender(['-b', faceBlend, '--python-exit-code', '1', '--python', S('render_front.py'), '--', fr, size], () => fakeRender(fr, 0.001));
    } else {
      await fs.mkdir(fr, {recursive: true});
      for (const f of ['cam.json', 'skin.png', 'with_hair.png']) await fs.copyFile(path.join(pre, f), path.join(fr, f));
    }
    for (const f of ['cam.json', 'skin.png', 'with_hair.png']) await fs.copyFile(path.join(fr, f), path.join(F, f));
    const al = await readJsonOr(path.join(pre, 'align.json'));
    if (al) await writeJson(path.join(F, 'align.json'), shiftAlign(al, await readJsonOr(path.join(pre, 'cam.json')), await readJsonOr(path.join(F, 'cam.json'))));
    else await fs.rm(path.join(F, 'align.json'), {force: true});
    const cam = await readJsonOr(path.join(F, 'cam.json'));
    return {cam, aligned: al ? Object.keys(al) : [], cheek: !!o.cheek, jaw: !!o.jaw};
  },

  // 5 組み立て: select -> atlas -> build -> paint_gaze -> ball_from_iris -> build_gaze -> メタ -> 試作
  async build(ctx, x) {
    const o = x.w.options.build, F = x.abs('face'), G = path.join(F, 'gaze'), faceBlend = x.abs('work/face.blend'), kit = x.tools.kit;
    await writeJson(path.join(F, 'rects.json'), x.w.rects);
    await ctx.step('区画の三角形を選ぶ');
    await x.blender(['-b', faceBlend, '--python-exit-code', '1', '--python', S('face_vrm.py'), '--', 'select', F, path.join(F, 'rects.json')],
      () => writeJson(path.join(F, 'regions.json'), {upper: {rect: x.w.rects.upper, bbox: [0, 0, 8, 8], triangles: 1}, size: 2048}));
    await ctx.step('アトラスを作る');
    const cells = o.atlas.cells ?? {}, neutral = cells.neutral;
    if (!neutral) throw new Error('設定 build.atlas.cells.neutral が無い');
    const names = ['neutral', ...EXPRESSIONS].filter(n => n === 'neutral' || !VISEMES.includes(n) || x.w.rects.mouth);
    const atlasEnv = {...o.atlas.env};
    if (o.atlas.overlay) { atlasEnv.OVERLAY = x.abs(o.atlas.overlay.file); atlasEnv.OVERLAY_ALIGN = o.atlas.overlay.align; }
    await x.python([S('atlas.py'), F, ...names.map(n => `${n}=${x.abs(cells[n] ?? neutral)}`)], atlasEnv, () => fs.writeFile(path.join(F, 'atlas_upper.png'), TINY_PNG));
    await ctx.step('表情の VRM を書き出す');
    await x.blender(['-b', '--factory-startup', '--python-exit-code', '1', '--python', S('face_vrm.py'), '--', 'build', kit, faceBlend, F, x.abs('inputs/review.vrm'), path.join(F, 'face_expr.vrm')],
      () => fs.copyFile(x.abs('inputs/review.vrm'), path.join(F, 'face_expr.vrm')));
    await ctx.step('視線の層を作る');
    await fs.rm(G, {recursive: true, force: true});
    let hole = o.gaze.holeMask ? x.abs(o.gaze.holeMask) : null;
    if (o.gaze.holeGreen) {
      // 目の中を緑で塗った絵を、位置合わせのとおりに置いて区画の座標へ移す(区画の範囲が変わっても作り直される)
      await ctx.step('目の中の範囲を区画の座標に移す');
      hole = path.join(F, 'hole_upper.png');
      await x.python([S('hole_mask.py'), F, x.abs(o.gaze.holeGreen.file), o.gaze.holeGreen.align, hole, x.abs(cells[o.gaze.holeGreen.align] ?? neutral)], {}, () => fs.writeFile(hole, TINY_PNG));
    }
    const gazeEnv = {...o.gaze.env, ...(hole ? {HOLE_MASK: hole} : {})};
    await x.python([S('paint_gaze.py'), F, G], gazeEnv, async () => { await fs.mkdir(G, {recursive: true}); await writeJson(path.join(G, 'gaze.json'), {}); });
    if (o.iris) {
      await ctx.step('瞳の層を描いた瞳で置き直す');
      await x.python([S('ball_from_iris.py'), F, o.iris.align, ...o.iris.irises.map(i => `${x.abs(i.file)}:${i.box.join(',')}`)], o.iris.env ?? {}, () => {});
    }
    await ctx.step('視線を入れる');
    await x.blender(['-b', '--factory-startup', '--python-exit-code', '1', '--python', S('build_gaze.py'), '--', kit, path.join(F, 'face_expr.blend'), F, G, path.join(G, 'face_gaze.vrm')],
      () => fs.copyFile(path.join(F, 'face_expr.vrm'), path.join(G, 'face_gaze.vrm')));
    await ctx.step('メタ情報を写す');
    await x.node([x.tools.patchVrm, path.join(G, 'face_gaze.vrm'), path.join(G, 'face_gaze.vrm'), '--meta-from', path.join(F, 'face_expr.vrm')], () => {});
    return newPrototype(ctx, x, path.join(G, 'face_gaze.vrm'), 'build');
  },

  // 7 中割り: 表情の動画から expr_video.py build
  async video(ctx, x) {
    const o = x.w.options.video, F = x.abs('face'), V = x.abs('work/video');
    await fs.mkdir(V, {recursive: true});
    await ctx.step(`動画から中割りを作る(${o.videos.length} 本)`);
    const env = {...o.env, ...(o.drawn ? {EXPR_DRAWN: x.abs(o.drawn)} : {}), ...(o.masks ? {OPENING_MASKS: x.abs(o.masks)} : {})};
    await x.python([S('expr_video.py'), 'build', path.join(F, 'gaze', 'face_gaze.vrm'), path.join(V, 'expr.vrm'), x.abs(o.open), V,
      ...o.videos.flatMap(v => ['--video', `${v.name}=${x.abs(v.file)}`]), '--face-dir', F], env,
      () => fs.copyFile(path.join(F, 'gaze', 'face_gaze.vrm'), path.join(V, 'expr.vrm')));
    return newPrototype(ctx, x, path.join(V, 'expr.vrm'), 'video');
  },

  // 8 確かめ: ビューアで試作を撮る(tools/studio_checks.mjs)
  async checks(ctx, x) {
    const {charId, studioId, set = 'full'} = ctx.job.input;
    const proto = ctx.job.input.proto ?? x.w.prototypes.at(-1).n, rel = `checks/${pad(proto)}`, out = x.abs(rel), tmp = x.abs(rel + '.tmp');
    // 撮影は checks/NNN.tmp に行い、成功してから入れ替える(失敗しても前の撮影が残る)
    await fs.rm(tmp, {recursive: true, force: true});
    await fs.mkdir(tmp, {recursive: true});
    await ctx.step(`試作 ${proto} の確かめを撮る`);
    try {
      if (x.env.CHARASTA_FAKE_CAPTURE) {
        const index = [];
        for (const [name, yaw] of [['neutral_y0', 0], ['neutral_y45', 45]]) {
          await ctx.run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x886655:s=64x64', '-frames:v', '1', path.join(tmp, name + '.png')]);
          index.push({name, file: name + '.png', kind: 'expr', expr: 'neutral', yaw});
        }
        await writeJson(path.join(tmp, 'index.json'), index);
      } else {
        await ctx.run('node', [path.join(root, 'tools', 'studio_checks.mjs'), '--char', charId, '--studio', studioId, '--proto', String(proto),
          '--out', tmp, '--port', String(x.getPort()), '--set', set]);
      }
    } catch (e) { await fs.rm(tmp, {recursive: true, force: true}).catch(() => {}); throw e; }
    if (await fs.access(out).then(() => true, () => false)) {   // 前の撮影は作業場所の trash/ へ
      const t = x.abs(`trash/${now().replace(/[:.]/g, '-')}-checks-${pad(proto)}`);
      await fs.mkdir(path.dirname(t), {recursive: true}); await fs.rename(out, t);
    }
    await fs.rename(tmp, out);
    const count = ((await readJsonOr(path.join(out, 'index.json'))) ?? []).length;
    const studio = x.studio;
    await studio.update(charId, studioId, w => { w.checks = w.checks.filter(c => c.proto !== proto); w.checks.push({proto, dir: rel, set, count, jobId: ctx.job.id, at: now()}); });
    return {proto, dir: rel, count};
  },
};

// 試作を out/<番号>/model.vrm に置く。設定 springTune があれば、髪の揺れ骨の当たりを整えてから置く。
async function newPrototype(ctx, x, src, step) {
  const {charId, studioId} = ctx.job.input, studio = x.studio;
  const n = ((await studio.read(charId, studioId)).prototypes.at(-1)?.n ?? 0) + 1, rel = `out/${pad(n)}/model.vrm`, file = x.abs(rel);
  await fs.mkdir(path.dirname(file), {recursive: true});
  const tune = x.w.options.springTune;
  if (tune) {
    await ctx.step('髪の揺れ骨の当たりを整える(spring_tune.py)');
    await x.python([x.tools.springTune, src, file, ...tune], {}, () => fs.copyFile(src, file));
  } else await fs.copyFile(src, file);
  const sha256 = await sha256File(file), size = (await fs.stat(file)).size;
  await studio.update(charId, studioId, w => { w.prototypes.push({n, file: rel, step, from: path.relative(x.dir, src).split(path.sep).join('/'), springTune: tune ?? null, sha256, size, jobId: ctx.job.id, at: now()}); });
  return {proto: n, file: rel, sha256};
}
