// グラフィック MV(ダンス MV の演出 music.look === 'graphic')。値の検査、既定値、作業の鍵、画面の計算、ジョブ(make_graphic_mv.py の偽物)。docs/dance-short.md の「グラフィック」。
//   stage-studio は一時のフォルダに作った偽物。偽の make_graphic_mv.py は引数と spec を記録し、ffmpeg で無地のコマと shots.json と report.json を書く
import test from 'node:test';
import {findPython} from '../lib/platform.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {charaPalette, graphicCutBody, checkGraphicFit, checkGraphicShots, composeKey, dancerKey, defaultCues, defaultText, faceHitsByCut, graphicBody, graphicSpec, paletteFromPixels, supportsGraphic} from '../lib/graphic-mv.mjs';
import {GRAPHIC_PALETTES, GRAPHIC_QUALITIES, danceFieldsFor, graphicCutsBody, graphicEstimateSec, graphicShares, graphicWords, looksSplitApart} from '../public/mv-plan.mjs';
import {tempDir, fakeGlb, FAKE_ENV, SAMPLE_VRMA, startServer} from './helpers.mjs';

const CATALOG = [
  {id: 'intro', label: 'INTRO', name: '出だし', passes: ['full'], words: 0, wipe: null, back: 0, role: 'first'},
  {id: 'name', label: 'NAME', name: '大きな名前', passes: ['mid'], words: 0, wipe: 'iris', back: 0},
  {id: 'move', label: 'MOVE', name: '斜めに流れる言葉', passes: ['full'], words: 3, wipe: 'diag', back: 0},
  {id: 'feel', label: 'FEEL', name: '色の残像', passes: ['full'], words: 2, wipe: 'bars', back: 9},
  {id: 'face', label: 'FACE', name: '顔の寄り', passes: ['face'], words: 1, wipe: 'iris', back: 0},
  {id: 'end', label: 'END', name: '締め', passes: ['mid'], words: 0, wipe: 'bars', back: 0, role: 'last'},
];
const NURSE_EXPR = ['aa', 'happy', 'blink', 'blinkLeft', 'blink_smile', 'blink_smile_L', 'happy_mouth', 'surprised_eye'];

// ---- 値の検査 ----
test('music.graphic の検査: 色は #RRGGBB、文字の長さ、cues の秒と重み', () => {
  const ok = graphicBody({});
  assert.deepEqual(ok.palette, {preset: 'pop', ...GRAPHIC_PALETTES.pop});
  assert.equal(ok.text.titleEn, 'DANCE'); assert.deepEqual(ok.skirt, [3, 0.4]); assert.equal(ok.skirtDamp, 0.6);
  assert.equal(graphicBody({palette: {preset: 'custom', bg: ['#ff0000', '#00FF00', '#0000ff'], ink: '#000000', accent: '#123abc', light: '#ffffff'}}).palette.accent, '#123ABC');
  const bad = (raw, re) => assert.throws(() => graphicBody(raw), e => e.code === 'bad-input' && re.test(e.message), JSON.stringify(raw));
  bad({palette: {preset: 'custom', bg: ['#FFF', '#000000', '#000000'], ink: '#000000', accent: '#000000', light: '#000000'}}, /#RRGGBB/);
  bad({palette: {bg: ['#000000', '#000000']}}, /3 色/);
  bad({palette: {preset: 'neon'}}, /preset/);
  bad({text: {title: 'あ'.repeat(25)}}, /24 文字/);
  bad({text: {titleEn: 'ナース'}}, /英数字/);
  bad({text: {credit: 'x'.repeat(61)}}, /60 文字/);
  bad({text: {words: []}}, /words/);
  bad({text: {words: ['A'.repeat(17)]}}, /16 文字/);
  bad({cues: [{from: 2, to: 1, expr: {happy: 1}}]}, /from < to/);
  bad({cues: [{from: 0, to: 1, expr: {happy: 1.5}}]}, /重み/);
  bad({cues: [{from: 0, to: 1, expr: {}}]}, /expr/);
  bad({cues: [{from: 0, to: 1, expr: {'a b': 1}}]}, /名前/);
  bad({skirt: [3]}, /skirt/);
  bad({skirtDamp: 2}, /skirtDamp/);
});

test('表情の名前はその VRM にあるものだけ、時刻は動画の長さの中', () => {
  const g = graphicBody({cues: [{from: 1, to: 2, expr: {happy_mouth: 0.8}}]});
  checkGraphicFit(g, {seconds: 18, expressions: NURSE_EXPR});
  assert.throws(() => checkGraphicFit(graphicBody({cues: [{from: 1, to: 2, expr: {wink: 1}}]}), {seconds: 18, expressions: NURSE_EXPR}), /"wink" はこの VRM に無い/);
  assert.throws(() => checkGraphicFit(graphicBody({cues: [{from: 20, to: 21, expr: {happy: 1}}]}), {seconds: 18, expressions: NURSE_EXPR}), /動画の長さ/);
  checkGraphicFit(graphicBody({cues: [{from: 1, to: 2, expr: {wink: 1}}]}), {seconds: 18, expressions: null});   // VRM を読めないときは名前を見ない
});

// ---- 既定値 ----
test('既定値: nurse のキャラと illit-itsme-nurse-v4 のモーション', () => {
  const t = defaultText({character: {id: 'nurse', name: 'ナースの子'}, motion: {id: 'illit-itsme-nurse-v4', label: "ILLIT It's Me(ナース用、ExMR、手と足と体のめり込みを補正)"}});
  assert.deepEqual(t, {title: 'ナースの子', titleEn: 'NURSE', credit: "DANCE  ILLIT IT'S ME", words: ['MOVE', 'STEP', 'TURN', 'FEEL', 'BEAT', 'RHYTHM', 'KICK', 'DANCE']});
  assert.equal(defaultText({character: {id: 'キャラ', name: 'x'}, motion: null}).titleEn, 'DANCE', '英字が無ければ DANCE');
  assert.equal(defaultText({character: {id: 'chara-4', name: 'x'}, motion: {label: '踊り（全角）'}}).credit, 'DANCE  踊り');
  const plan = [{scene: 'intro', start: 0, end: 2}, {scene: 'face', start: 10, end: 12}, {scene: 'end', start: 16, end: 18}];
  assert.deepEqual(defaultCues(plan, NURSE_EXPR), [{from: 10, to: 12, expr: {happy: 0.6}}, {from: 11, to: 11.25, expr: {blink_smile_L: 1}, ease: 0.12}, {from: 16, to: 18, expr: {blink_smile: 0.8}}]);
  assert.deepEqual(defaultCues(plan, ['happy', 'blinkLeft']).map(c => Object.keys(c.expr)[0]), ['happy', 'blinkLeft', 'happy']);
  assert.deepEqual(defaultCues(plan, ['aa']), [], '無い名前は足さない');
  const g = graphicBody({text: t, cues: defaultCues(plan, NURSE_EXPR)});
  checkGraphicFit(g, {seconds: 18, expressions: NURSE_EXPR});
});

test('キャラの色: 彩度の高い色から背景 3 色と差し色を作り、文字の色は明るさの差が大きい方', () => {
  const px = [];
  for (let i = 0; i < 300; i++) px.push(230, 30, 40);   // 赤
  for (let i = 0; i < 150; i++) px.push(240, 240, 240);   // 白(数えない)
  for (let i = 0; i < 100; i++) px.push(30, 60, 220);   // 青
  const p = paletteFromPixels(Buffer.from(px));
  assert.equal(p.preset, 'chara'); assert.equal(p.bg.length, 3);
  for (const c of [...p.bg, p.ink, p.accent, p.light]) assert.match(c, /^#[0-9A-F]{6}$/);
  graphicBody({palette: p});
  assert.ok(['#141432', '#FFFFFF'].includes(p.ink));
});

// ---- 作業の鍵 ----
test('文字だけ変えると composeKey だけが変わる。表情を変えると dancerKey も変わる', () => {
  const g = graphicBody({cues: [{from: 1, to: 2, expr: {happy: 1}}]}), cuts = [{scene: 'intro', seconds: 2}, {scene: 'end', seconds: 2}];
  const keys = gg => { const d = dancerKey({code: 'c', version: 'v', motion: 'm', seconds: 4, graphic: gg, pct: 50, samples: 16}); return [d, composeKey({dancer: d, code: 'k', cuts, graphic: gg, bpm: 120, audio: null, audioStart: 0, width: 540, height: 960})]; };
  const [d0, c0] = keys(g);
  const [d1, c1] = keys({...g, text: {...g.text, title: '別の名前'}});
  assert.equal(d1, d0); assert.notEqual(c1, c0);
  const [d2, c2] = keys({...g, palette: {...g.palette, accent: '#000000'}});
  assert.equal(d2, d0); assert.notEqual(c2, c0);
  const [d3, c3] = keys({...g, cues: []});
  assert.notEqual(d3, d0); assert.notEqual(c3, c0);
  const [d4] = keys({...g, skirt: [4, 0.4]});
  assert.notEqual(d4, d0);
});

test('supportsGraphic は stage-studio の tools/make_graphic_mv.py があるかで決まる', async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'tools'));
  assert.equal(await supportsGraphic(dir), false);
  await fs.writeFile(path.join(dir, 'tools', 'make_graphic_mv.py'), '#');
  assert.equal(await supportsGraphic(dir), true);
});

test('shots.json とカット表の照らし合わせ、顔にかかったコマのカットごとの数', () => {
  const cuts = [{scene: 'intro', seconds: 2}, {scene: 'end', seconds: 2.5}];
  checkGraphicShots(cuts, [{scene: 'intro', start: 0, end: 2}, {scene: 'end', start: 2, end: 4.51}]);
  assert.throws(() => checkGraphicShots(cuts, [{scene: 'intro', start: 0, end: 2}]), /2 カット/);
  assert.throws(() => checkGraphicShots(cuts, [{scene: 'intro', start: 0, end: 2}, {scene: 'face', start: 2, end: 4.5}]), /場面/);
  assert.throws(() => checkGraphicShots(cuts, [{scene: 'intro', start: 0, end: 2.2}, {scene: 'end', start: 2.2, end: 4.5}]), /時刻/);
  assert.deepEqual(faceHitsByCut([[3, 10], [61, 5], [62, 7]], [60, 75]), [{cut: 0, frames: 1}, {cut: 1, frames: 2}]);
});

// ---- 画面の計算(public/mv-plan.mjs) ----
test('目安: 本番の 18 秒は v12 の実測(約 23 分)に近い。試しは本番より短い', () => {
  // v12 の描いたコマの割合: 全身 510、膝上 152、顔の寄り 81(540 コマ中)
  const v12 = {full: 510 / 540, mid: 152 / 540, face: 81 / 540};
  const final = graphicEstimateSec('final', 18, v12) / 60;
  assert.ok(final > 20 && final < 26, `本番 ${final.toFixed(1)} 分`);
  assert.ok(graphicEstimateSec('preview', 18, v12) < graphicEstimateSec('final', 18, v12) / 2);
  assert.deepEqual([GRAPHIC_QUALITIES.preview.width, GRAPHIC_QUALITIES.preview.height, GRAPHIC_QUALITIES.final.width], [540, 960, 1080]);
  const sh = graphicShares([{scene: 'intro', seconds: 2}, {scene: 'name', seconds: 2}, {scene: 'face', seconds: 4}], CATALOG);
  assert.deepEqual(sh, {full: 0.25, mid: 0.25, face: 0.5});
});

test('言葉の配り方: word があればそれ、無ければ言葉の枠の数だけ順に(stage-studio の assign_words と同じ)', () => {
  const cuts = [{scene: 'intro'}, {scene: 'move', word: 'KAWAII / CUTE / POP'}, {scene: 'feel'}, {scene: 'face'}, {scene: 'end'}];
  assert.deepEqual(graphicWords(cuts, CATALOG), [[], ['KAWAII', 'CUTE', 'POP'], ['FEEL', 'BEAT'], ['RHYTHM'], []]);
  assert.deepEqual(graphicWords(cuts, CATALOG, ['A', 'B']), [[], ['KAWAII', 'CUTE', 'POP'], ['B', 'A'], ['B'], []]);
});

test('グラフィックを選ぶとシーン、カメラ、テロップの欄が隠れ、グラフィックの欄が出る。演出を graphic とほかで変えると割り直す', () => {
  assert.deepEqual(danceFieldsFor('graphic'), {scenes: false, camera: false, telop: false, graphic: true, cutLength: false});
  for (const look of ['anime', 'plain', undefined]) assert.equal(danceFieldsFor(look).scenes, true);
  assert.equal(looksSplitApart('anime', 'graphic'), true); assert.equal(looksSplitApart('graphic', 'plain'), true); assert.equal(looksSplitApart('anime', 'plain'), false);
  assert.deepEqual(graphicCutsBody({bpm: 100, motionId: 'm', stages: ['x']}, 12), {seconds: 12, bpm: 100, seed: 1, audioStart: 0, look: 'graphic', motionId: 'm'});
});

// ---- ジョブ(偽の stage-studio) ----
const STUB = `import json, os, subprocess, sys
args = sys.argv[1:]
def opt(k):
    return args[args.index(k) + 1] if k in args else None
if '--catalog' in args:
    print(json.dumps(json.load(open(os.path.join(os.path.dirname(__file__), 'graphic_mv', 'catalog.json'), encoding='utf8')))); sys.exit(0)
spec = json.load(open(opt('--spec'), encoding='utf8'))
if '--plan-only' in args:
    json.dump(spec, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'plan-spec.json'), 'w'))
    n = max(2, round(spec['seconds'] * spec.get('bpm', 120) / 60 / 4))
    ids = ['intro'] + ['move', 'face', 'feel', 'name'][:n - 2] + ['end'] if n <= 6 else None
    step = spec['seconds'] / n
    plan = [{'scene': s, 'start': round(i * step, 6), 'end': round(spec['seconds'] if i == n - 1 else (i + 1) * step, 6), 'wipe': None if i == 0 else 'iris', 'b0': 4 * i} for i, s in enumerate(ids)]
    print(json.dumps({'bpm': spec.get('bpm', 120), 'source': 'audio' if (spec.get('audio') or spec.get('beats')) else 'bpm', 'frames': round(spec['seconds'] * 30), 'plan': plan, 'passes': {'full': '1-10'}})); sys.exit(0)
out = opt('--out'); dancer = opt('--dancer-dir')
os.makedirs(os.path.join(out, 'frames'), exist_ok=True); os.makedirs(dancer, exist_ok=True)
with open(os.path.join(dancer, 'calls.txt'), 'a') as f:
    f.write('x')
json.dump({'argv': args, 'spec': spec}, open(os.path.join(out, 'args.json'), 'w', encoding='utf8'), ensure_ascii=False)
if spec['text']['title'] == 'EXPOSE':
    json.dump({'exposed': [{'pass': 'full', 'frames': [31, 32], 'seconds': [1.0]}]}, open(os.path.join(out, 'report.json'), 'w')); sys.exit(3)
n = round(spec['seconds'] * 30)
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', f"color=c=0x223344:s={spec['compW']}x{spec['compH']}:r=30", '-frames:v', str(n), '-start_number', '1', os.path.join(out, 'frames', '%05d.png')], check=True)
json.dump([{'scene': p['scene'], 'start': p['start'], 'end': p['end']} for p in spec['plan']], open(os.path.join(out, 'shots.json'), 'w'))
json.dump({'faceHits': [[2, 40]], 'timings': {'full': 1}, 'passes': {'full': '1-%d' % n}}, open(os.path.join(out, 'report.json'), 'w'))
json.dump({'phase': 'done'}, open(os.path.join(out, 'progress.json'), 'w'))
`;

// 曲の拍: 0.25 秒から 0.5 秒おき(120 BPM)
const BEATS_PY = `import json, sys
json.dump([round(0.25 + 0.5 * i, 4) for i in range(80)], open(sys.argv[2], 'w'))
print('bpm 120.0 offset 0.25 beats 80')
`;

async function graphicStage() {
  const dir = await tempDir();
  for (const d of ['stages', 'lib', 'tools/graphic_mv']) await fs.mkdir(path.join(dir, d), {recursive: true});
  await fs.writeFile(path.join(dir, 'stages', 'catalog.json'), JSON.stringify([{id: 'concert', label: 'コンサート'}]));
  await fs.writeFile(path.join(dir, 'lib', 'shots.py'), '# 偽物');
  await fs.writeFile(path.join(dir, 'tools', 'make_mv.py'), '# make_mv(偽物) --look');
  await fs.writeFile(path.join(dir, 'tools', 'make_graphic_mv.py'), STUB);
  await fs.writeFile(path.join(dir, 'tools', 'beats.py'), BEATS_PY);
  await fs.writeFile(path.join(dir, 'tools', 'graphic_mv', 'catalog.json'), JSON.stringify(CATALOG));
  return dir;
}

test('ジョブ: spec を渡し、shots.json を照らしてカットに分ける。文字だけの直しは踊る人の作業をそのまま使う。スカートが見えたら秒を出して止める', async () => {
  const s = await startServer({stageStudioDir: await graphicStage(), env: FAKE_ENV}), lib = s.server.jobs.lib;
  const api = async (method, url, body) => { const r = await fetch(s.base + url, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)}); return {status: r.status, json: await r.json().catch(() => null)}; };
  try {
    await lib.createCharacter({id: 'c1', name: 'いち'});
    await lib.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({a: 1})});
    await lib.importMotion({id: 'dance', data: await fs.readFile(SAMPLE_VRMA), label: 'ダンス(練習)', license: {holder: 'h', summary: '改変可', redistribution: false}});
    const opts = await api('GET', '/api/short-options');
    assert.deepEqual(opts.json.graphic.map(x => x.id), CATALOG.map(x => x.id));
    const made = await api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', stages: ['concert'], seconds: 8});
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const id = made.json.id;
    // 演出を graphic にするとき、前のシーンとカメラのカットは場面が無いので保存できない(画面はカットを空にする)
    const old = {stage: 'concert', camera: 'wide_push', seconds: 2, motionId: 'dance'};
    assert.equal((await api('PUT', '/api/shorts/' + id, {...made.json, cuts: [old]})).status, 200);
    assert.equal((await api('PUT', '/api/shorts/' + id, {...made.json, music: {...made.json.music, look: 'graphic'}, cuts: [old]})).status, 400);
    assert.equal((await api('PUT', '/api/shorts/' + id, {...made.json, music: {...made.json.music, look: 'graphic'}, cuts: []})).status, 200);
    const split = await api('POST', `/api/shorts/${id}/beat-cuts`, {seconds: 6, look: 'graphic'});
    assert.equal(split.status, 200, JSON.stringify(split.json));
    const sh = split.json.short;
    assert.deepEqual(sh.cuts.map(c => c.scene), ['intro', 'move', 'end']);
    assert.ok(sh.cuts.every(c => c.stage === '' && c.camera === '' && c.telop === '' && c.motionId === 'dance'));
    assert.equal(sh.music.graphic.text.title, 'いち'); assert.equal(sh.music.graphic.text.titleEn, 'C1'); assert.equal(sh.music.graphic.text.credit, 'DANCE  ダンス');
    assert.equal(sh.music.graphic.palette.preset, 'pop');
    // 既定の値の API(保存しない)
    const def = await api('GET', `/api/shorts/${id}/graphic-defaults?preset=mono`);
    assert.equal(def.status, 200); assert.deepEqual(def.json.palette, {preset: 'mono', ...GRAPHIC_PALETTES.mono});
    // 色が正しくなければ保存できない
    const badColor = await api('PUT', '/api/shorts/' + id, {...sh, music: {...sh.music, graphic: {...sh.music.graphic, palette: {...sh.music.graphic.palette, ink: 'black'}}}});
    assert.equal(badColor.status, 400); assert.match(badColor.json.error, /#RRGGBB/);
    const late = await api('PUT', '/api/shorts/' + id, {...sh, music: {...sh.music, graphic: {...sh.music.graphic, cues: [{from: 9, to: 10, expr: {happy: 1}}]}}});
    assert.equal(late.status, 400, '表情の秒は動画の長さの中');

    const j = await api('POST', '/api/jobs', {type: 'short', shortId: id, quality: 'preview'});
    assert.equal(j.status, 201, JSON.stringify(j.json));
    await s.server.jobs.whenIdle();
    const done = await s.server.jobs.get(j.json.id);
    assert.equal(done.state, 'done', done.error);
    const work = path.join(s.libraryDir, 'shorts', id, 'work', 'preview'), dirs = await fs.readdir(work);
    const mv = dirs.find(x => x.startsWith('mv-')), dancer = dirs.find(x => x.startsWith('dancer-'));
    assert.ok(mv && dancer, dirs.join(','));
    const {argv, spec} = JSON.parse(await fs.readFile(path.join(work, mv, 'args.json'), 'utf8'));
    assert.equal(argv[argv.indexOf('--quality') + 1], 'preview'); assert.equal(argv[argv.indexOf('--dancer-dir') + 1], path.join(work, dancer));
    assert.deepEqual([spec.char, spec.ver, spec.motion, spec.seconds, spec.pct, spec.samples, spec.compW, spec.compH], ['c1', 'v1', 'dance', 6, 50, 16, 540, 960]);
    assert.deepEqual(spec.plan.map(p => [p.scene, p.start, p.end]), [['intro', 0, 2], ['move', 2, 4], ['end', 4, 6]]);
    assert.deepEqual(spec.springs, {skirt: [3, 0.4]}); assert.equal(spec.skirtDamp, 0.6); assert.equal(spec.text.titleEn, 'C1'); assert.equal('preset' in spec.palette, false);
    const t = JSON.parse(await fs.readFile(path.join(work, 't.json'), 'utf8'));
    assert.deepEqual(t.cuts.map(c => c.count), [60, 60, 60]); assert.equal(t.grade, false);
    const [v] = (await api('GET', '/api/shoots')).json;
    assert.deepEqual(v.short.faceHits, [{cut: 0, frames: 1}]); assert.deepEqual(v.short.stages, []); assert.equal(v.short.music.look, 'graphic');
    assert.equal(v.terms.level, 'ok');

    // 文字だけ直す: 重ねの作業は新しく、踊る人の作業(dancer-)はそのまま
    const cur = (await api('GET', '/api/shorts/' + id)).json;
    assert.equal((await api('PUT', '/api/shorts/' + id, {...cur, music: {...cur.music, graphic: {...cur.music.graphic, text: {...cur.music.graphic.text, title: '別の名前'}}}})).status, 200);
    await api('POST', '/api/jobs', {type: 'short', shortId: id});
    await s.server.jobs.whenIdle();
    const dirs2 = await fs.readdir(work);
    assert.equal(dirs2.find(x => x.startsWith('dancer-')), dancer);
    assert.notEqual(dirs2.find(x => x.startsWith('mv-')), mv);
    assert.equal(dirs2.filter(x => x.startsWith('mv-')).length, 1, '使わなくなった重ねの作業は消える');

    // スカートの中が見える: 秒を付けて失敗にする
    const cur2 = (await api('GET', '/api/shorts/' + id)).json;
    await api('PUT', '/api/shorts/' + id, {...cur2, music: {...cur2.music, graphic: {...cur2.music.graphic, text: {...cur2.music.graphic.text, title: 'EXPOSE'}}}});
    const j3 = await api('POST', '/api/jobs', {type: 'short', shortId: id});
    await s.server.jobs.whenIdle();
    const failed = await s.server.jobs.get(j3.json.id);
    assert.equal(failed.state, 'failed'); assert.match(failed.error, /スカートの中が見える.*1 秒/);
  } finally { await s.close(); }
});

test('spec: カットの word と wipe を渡し、表情の note は渡さない', () => {
  const short = {cuts: [{scene: 'intro', seconds: 2}, {scene: 'move', seconds: 2, word: 'A / B', wipe: 'slab'}],
    music: {bpm: 128, seed: 3, audioStart: 1.5, graphic: graphicBody({cues: [{from: 0, to: 1, expr: {happy: 1}, note: 'メモ'}]})}};
  const spec = graphicSpec({short, motionId: 'm', cast: {charId: 'c', verId: 'v'}, audio: {file: 'song.m4a'}, q: GRAPHIC_QUALITIES.final});
  assert.deepEqual(spec.plan, [{scene: 'intro', start: 0, end: 2}, {scene: 'move', start: 2, end: 4, wipe: 'slab', word: 'A / B'}]);
  assert.deepEqual(spec.cues, [{from: 0, to: 1, expr: {happy: 1}}]);
  assert.deepEqual([spec.audio, spec.audioStart, spec.bpm, spec.seconds, spec.pct, spec.samples, spec.compW], ['song.m4a', 1.5, 128, 4, 100, 64, 1080]);
});

test('本物の stage-studio の feat/graphic-mv(環境変数 CHARASTA_REAL_GRAPHIC_MV)があれば、--catalog と --plan-only の形を確かめる', {skip: !process.env.CHARASTA_REAL_GRAPHIC_MV || !(await fs.stat(path.join(process.env.CHARASTA_REAL_GRAPHIC_MV, 'tools/make_graphic_mv.py')).catch(() => null))}, async () => {
  const dir = process.env.CHARASTA_REAL_GRAPHIC_MV, tmp = await tempDir(), file = path.join(tmp, 'spec.json');
  const cat = JSON.parse(execFileSync(findPython() ?? 'python', [path.join(dir, 'tools', 'make_graphic_mv.py'), '--catalog'], {encoding: 'utf8'}));
  assert.ok(cat.find(x => x.id === 'face').passes.includes('face'));
  await fs.writeFile(file, JSON.stringify({seconds: 18, bpm: 120, seed: 0}));
  const r = JSON.parse(execFileSync(findPython() ?? 'python', [path.join(dir, 'tools', 'make_graphic_mv.py'), '--plan-only', '--spec', file], {encoding: 'utf8'}));
  assert.equal(r.plan.length, 9); assert.equal(r.plan[0].scene, 'intro'); assert.equal(r.plan.at(-1).scene, 'end');
  assert.deepEqual(graphicWords(r.plan.map(p => ({scene: p.scene})), cat), r.plan.map(p => p.words), 'JS と Python の言葉の配り方が同じ');
});

// ---- 割り直し ----
async function resplitSetup(dir = null) {
  const stage = dir ?? await graphicStage(), s = await startServer({stageStudioDir: stage, env: FAKE_ENV}), lib = s.server.jobs.lib;
  const api = async (method, url, body) => { const r = await fetch(s.base + url, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)}); return {status: r.status, json: await r.json().catch(() => null)}; };
  await lib.createCharacter({id: 'c1', name: 'いち'});
  await lib.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({a: 1})});
  await lib.importMotion({id: 'dance', data: await fs.readFile(SAMPLE_VRMA), label: 'ダンス(練習)', license: {holder: 'h', summary: '改変可', redistribution: false}});
  const made = await api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', stages: ['concert'], seconds: 8, music: {look: 'graphic'}});
  return {s, lib, api, stage, made};
}

test('割り直し: 10 秒から 6 秒に縮めても 400 にならず、表情は新しい並びから作り直し、手で足した表情は長さの中だけ残る', async () => {
  const {s, api, made} = await resplitSetup();
  try {
    const id = made.json.id;
    assert.equal(made.json.music.look, 'graphic');
    const a = await api('POST', `/api/shorts/${id}/beat-cuts`, {seconds: 10, look: 'graphic'});
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.deepEqual(a.json.short.cuts.map(c => c.scene), ['intro', 'move', 'face', 'feel', 'end']);
    const auto10 = a.json.short.music.graphic.cues;
    assert.ok(auto10.some(c => c.to === 10), '10 秒の END の表情がある');
    const user = [{from: 8, to: 9.5, expr: {happy: 1}, note: '後ろ'}, {from: 4.5, to: 5.2, expr: {surprised: 1}, note: '中'}, {from: 5, to: 8, expr: {sad: 1}, note: 'またぐ'}];
    const sh = a.json.short;
    const put = await api('PUT', '/api/shorts/' + id, {...sh, music: {...sh.music, graphic: {...sh.music.graphic, cues: [...auto10, ...user]}}});
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const b = await api('POST', `/api/shorts/${id}/beat-cuts`, {seconds: 6, look: 'graphic'});
    assert.equal(b.status, 200, JSON.stringify(b.json));
    const cues = b.json.short.music.graphic.cues, secs = b.json.short.cuts.reduce((x, c) => x + c.seconds, 0);
    assert.equal(Math.round(secs * 1e6) / 1e6, 6);
    assert.ok(cues.every(c => c.to <= 6 && c.from < 6), JSON.stringify(cues));
    assert.deepEqual(b.json.short.cuts.map(c => c.scene), ['intro', 'move', 'end']);
    assert.ok(!cues.some(c => c.note === '後ろ'), '後ろの表情は消える');
    assert.ok(cues.some(c => c.note === '中'), '中の表情は残る');
    assert.deepEqual(cues.find(c => c.note === 'またぐ'), {from: 5, to: 6, expr: {sad: 1}, note: 'またぐ'}, 'またぐ表情は終わりを詰める');
    assert.ok(!cues.some(c => c.to === 10 || (c.from === 8 && c.expr.happy === 0.8)), '前の長さの既定の表情は残らない');
    assert.ok(cues.some(c => c.from === 4 && c.to === 6), '新しい END の表情');
    // 既定の値の API は保存済みの新しい並びで作る
    const d = await api('GET', `/api/shorts/${id}/graphic-defaults?preset=pop`);
    assert.equal(d.status, 200); assert.ok(d.json.cues.every(c => c.to <= 6), JSON.stringify(d.json.cues));
    // 文字や色は割り直しても残る
    assert.equal(b.json.short.music.graphic.text.title, 'いち');
    // 保存した 6 秒のまま、書き出しの前の確かめも通る
    const cur = (await api('GET', '/api/shorts/' + id)).json;
    assert.equal((await api('PUT', '/api/shorts/' + id, cur)).status, 200);
  } finally { await s.close(); }
});

test('割り直し: 曲の拍は beats.py を 1 回走らせた結果を spec.beats で make_graphic_mv.py に渡す', async () => {
  const stage = await graphicStage();
  const {s, lib, api, made} = await resplitSetup(stage);
  try {
    const file = path.join(s.libraryDir, 'song.wav');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', file]);
    const audio = await lib.importAudio({name: 'song.wav', data: await fs.readFile(file)});
    const id = made.json.id;
    assert.equal((await api('PUT', '/api/shorts/' + id, {...made.json, audioId: audio.id, audioPublic: true})).status, 200);
    const r = await api('POST', `/api/shorts/${id}/beat-cuts`, {seconds: 8, audioStart: 2});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.source, 'audio'); assert.equal(r.json.detectedBpm, 120);
    const spec = JSON.parse(await fs.readFile(path.join(stage, 'tools', 'plan-spec.json'), 'utf8'));
    assert.equal(spec.beats.length, 80); assert.equal(spec.beats[0], 0.25); assert.equal('audio' in spec, false, 'audio を渡すと拍をもう一度求める'); assert.equal(spec.bpm, 120);
  } finally { await s.close(); }
});

test('場面の言葉は 1 語ずつ 16 文字まで。ffmpeg が失敗しても色は LibraryError', async () => {
  const ids = CATALOG.map(c => c.id), w16 = 'あ'.repeat(16), w17 = 'あ'.repeat(17);
  assert.equal(graphicCutBody({scene: 'move', seconds: 2, word: `${w16}/${w16}/${w16}`}, ids).word, `${w16}/${w16}/${w16}`);
  assert.throws(() => graphicCutBody({scene: 'move', seconds: 2, word: `${w16}/${w17}`}, ids), e => e.code === 'bad-input' && /2 語目/.test(e.message));
  assert.throws(() => graphicCutBody({scene: 'move', seconds: 2, word: w17}, ids), e => e.code === 'bad-input');
  const dir = await tempDir(), thumb = path.join(dir, 'thumb.png');
  await fs.writeFile(thumb, 'これは画像ではない');
  await assert.rejects(charaPalette(thumb), e => e.code === 'bad-input' && /ffmpeg/.test(e.message));
});

test('重ね: grade が false(グラフィック)なら色味もビネットも付けない', async () => {
  const {compositionHtml} = await import('../lib/short-compose.mjs');
  const t = {title: 'た', style: 'dance', seconds: 3, fps: 30, cuts: [{id: 'a', count: 30, captions: [], direction: {transition: 'none', transitionFrames: 0, seed: 1, transitionSeed: 1}}]};
  const on = compositionHtml(t), off = compositionHtml({...t, grade: false});
  assert.match(on, /#vignette\{[^}]*radial-gradient/); assert.match(on, /filter:contrast/);
  assert.match(off, /#vignette\{[^}]*background:none/); assert.doesNotMatch(off, /filter:contrast/);
});
