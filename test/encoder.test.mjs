// H.264 の書き出し: まず NVENC、失敗したら libx264。NVENC が無い機械でも通る(ffmpeg は要る)。
// 最後のテストの NVENC との比べは、NVENC で書けないと飛ばす。CHARASTA_REQUIRE_NVENC=1 なら飛ばさず失敗にする。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {h264Args, hwEncoder, runH264, vtQuality} from '../lib/encoder.mjs';
import {encodeArgs} from '../lib/shoot.mjs';
import {cutArgs} from '../lib/video-motion.mjs';
import {tempDir} from './helpers.mjs';

// 偽の ctx。fail に並べた順に ffmpeg の実行を失敗させ(stopped は例外に付く印)、書きかけの出力も残す
function fakeCtx(out, fails = []) {
  const calls = [], logs = [];
  return {calls, logs, log: s => logs.push(s), run: async (cmd, args, opts) => {
    calls.push({cmd, encoder: args[args.indexOf('-c:v') + 1], opts});
    await fs.writeFile(out, 'partial');
    const f = fails[calls.length - 1];
    if (f) throw Object.assign(new Error('ffmpeg が失敗した: ' + f.msg), {stopped: !!f.stopped});
  }};
}
const NV = {CHARASTA_HW_ENCODER: 'h264_nvenc'};   // 機械に NVENC が無くても、GPU 側を先に試す手順を確かめる
const argsFor = encoder => ['-y', ...h264Args(encoder, 18), 'o.mp4'];
const exists = f => fs.stat(f).then(() => true, () => false);

test('h264Args: libx264 は crf をそのまま、NVENC は cq = crf + 5 でキーフレームは 250 コマごと', () => {
  assert.deepEqual(h264Args('libx264', 18), ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high']);
  const n = h264Args('h264_nvenc', 20);
  assert.equal(n[n.indexOf('-cq') + 1], '25'); assert.equal(n[n.indexOf('-g') + 1], '250'); assert.ok(!n.includes('-crf'));
});

test('h264Args: VideoToolbox は -q:v の品質で、crf が上がると品質を下げる。hwEncoder は環境変数で決め打ちできる', async () => {
  const v = h264Args('h264_videotoolbox', 18);
  assert.equal(v[v.indexOf('-q:v') + 1], '65'); assert.equal(v[v.indexOf('-g') + 1], '250'); assert.ok(!v.includes('-crf') && !v.includes('-cq'));
  assert.equal(vtQuality(20), 61); assert.equal(vtQuality(100), 1);
  assert.equal(await hwEncoder({CHARASTA_HW_ENCODER: 'h264_videotoolbox'}), 'h264_videotoolbox'); assert.equal(await hwEncoder({CHARASTA_HW_ENCODER: 'none'}), null);
});

test('hwEncoder: ffmpeg が無ければ GPU 無し(null)。runH264 は最初から libx264 で書く', async () => {
  const env = {CHARASTA_FFMPEG: path.join(await tempDir(), 'no-such-ffmpeg')};
  assert.equal(await hwEncoder(env), null);
  const out = path.join(await tempDir(), 'o.mp4'), ctx = fakeCtx(out);
  assert.equal(await runH264(ctx, argsFor, {out}, env), 'libx264'); assert.deepEqual(ctx.calls.map(c => c.encoder), ['libx264']);
});

test('encodeArgs と cutArgs: encoder を渡すと映像のエンコーダーだけ変わり、色のタグ・長さ・出力はそのまま', () => {
  const base = {frames: 'F', fps: 30, seconds: 4, out: 'O.mp4'};
  const cpu = encodeArgs(base), gpu = encodeArgs({...base, encoder: 'h264_nvenc'});
  assert.ok(cpu.includes('libx264')); assert.ok(gpu.includes('h264_nvenc') && !gpu.includes('libx264'));
  for (const a of [cpu, gpu]) { assert.equal(a[a.indexOf('-colorspace') + 1], 'bt709'); assert.equal(a[a.indexOf('-frames:v') + 1], '120'); assert.equal(a.at(-1), 'O.mp4'); }
  const cut = {input: 'in.mp4', out: 'o.mp4', fps: '60/1', speed: 1, trimStart: 0, trimEnd: null, crop: '', unmirror: false};
  const c0 = cutArgs(cut), c1 = cutArgs({...cut, encoder: 'h264_nvenc'});
  assert.ok(c0.includes('libx264') && !c0.includes('h264_nvenc')); assert.ok(c1.includes('h264_nvenc') && !c1.includes('libx264'));
  assert.equal(c1[c1.indexOf('-cq') + 1], '23'); assert.equal(c1.at(-1), 'o.mp4'); assert.equal(c1[c1.indexOf('-pix_fmt') + 1], 'yuv420p');
});

test('runH264: NVENC で書けたら 1 回で終わり、出力はそのまま残る', async () => {
  const out = path.join(await tempDir(), 'o.mp4'), ctx = fakeCtx(out);
  assert.equal(await runH264(ctx, argsFor, {out}, NV), 'h264_nvenc');
  assert.deepEqual(ctx.calls.map(c => c.encoder), ['h264_nvenc']); assert.equal(await exists(out), true); assert.deepEqual(ctx.logs, []);
});

test('runH264: NVENC が失敗したら書きかけを消して libx264 で書き直し、ログに残す', async () => {
  const out = path.join(await tempDir(), 'o.mp4'), ctx = fakeCtx(out, [{msg: 'OpenEncodeSessionEx failed'}]);
  assert.equal(await runH264(ctx, argsFor, {out}, NV), 'libx264');
  assert.deepEqual(ctx.calls.map(c => c.encoder), ['h264_nvenc', 'libx264']);
  assert.match(ctx.logs.join(''), /NVENC で書けなかったので libx264 で書き直す: .*OpenEncodeSessionEx/);
  assert.equal(await fs.readFile(out, 'utf8'), 'partial');   // 2 回目が書いたもの
});

test('runH264: 止めた(stopped)ときは書き直さず、書きかけも消す', async () => {
  const out = path.join(await tempDir(), 'o.mp4'), ctx = fakeCtx(out, [{msg: '時間切れ', stopped: true}]);
  await assert.rejects(runH264(ctx, argsFor, {out}, NV), /時間切れ/);
  assert.deepEqual(ctx.calls.map(c => c.encoder), ['h264_nvenc']); assert.equal(await exists(out), false); assert.deepEqual(ctx.logs, []);
});

test('runH264: libx264 も失敗したらその例外を投げ、書きかけを消す。CHARASTA_ENCODER=cpu は最初から libx264', async () => {
  const dir = await tempDir(), out = path.join(dir, 'o.mp4');
  const both = fakeCtx(out, [{msg: 'a'}, {msg: 'b'}]);
  await assert.rejects(runH264(both, argsFor, {out}, NV), /b/);
  assert.deepEqual(both.calls.map(c => c.encoder), ['h264_nvenc', 'libx264']); assert.equal(await exists(out), false);
  const cpu = fakeCtx(out);
  assert.equal(await runH264(cpu, argsFor, {out}, {CHARASTA_ENCODER: 'cpu'}), 'libx264');
  assert.deepEqual(cpu.calls.map(c => c.encoder), ['libx264']);
});

test('runH264: timeoutMs が関数なら走らせるたびに呼ぶ(書き直しの残り時間を測り直す)', async () => {
  const out = path.join(await tempDir(), 'o.mp4'), ctx = fakeCtx(out, [{msg: 'x'}]); let n = 0;
  await runH264(ctx, argsFor, {out, timeoutMs: () => 1000 * ++n}, NV);
  assert.deepEqual(ctx.calls.map(c => c.opts.timeoutMs), [1000, 2000]);
});

test('両エンコーダーで書いたファイル: 色のタグが同じで、キーフレームの間隔も 250 コマ以内', async t => {
  const dir = await tempDir(), src = path.join(dir, 's.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=12', '-pix_fmt', 'yuv420p', src]);
  const tags = {};
  for (const encoder of ['libx264', 'h264_nvenc']) {
    const out = path.join(dir, encoder + '.mp4');
    const tagArgs = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf', 'format=yuv420p', ...h264Args(encoder, 18), ...tagArgs, out]);
    if (r.status !== 0) {
      if (encoder === 'h264_nvenc' && process.env.CHARASTA_REQUIRE_NVENC !== '1') { t.diagnostic('NVENC で書けないので比べない: ' + String(r.stderr).trim().split(/\r?\n/).at(-1)); continue; }
      throw new Error(`${encoder} で書けない: ${String(r.stderr).trim()}`);   // CHARASTA_REQUIRE_NVENC=1 なら NVENC もここで失敗にする
    }
    const probe = (...a) => execFileSync('ffprobe', ['-v', 'error', ...a, out], {encoding: 'utf8'}).trim();
    tags[encoder] = probe('-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_primaries,color_transfer,color_range,pix_fmt,profile', '-of', 'csv=p=0');
    const keys = probe('-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0').split(/\r?\n/).filter(l => l.includes(',K')).map(l => Number(l.split(',')[0]));
    const gap = Math.max(...[...keys, 12].map((k, i, a) => i ? k - a[i - 1] : k));   // 終端(12 秒)を足す: キーフレームが先頭の 1 枚だけでも落ちるように
    assert.ok(gap <= 250 / 30 + 0.01, `${encoder} のキーフレーム間隔 ${gap} 秒`);
  }
  if (tags.h264_nvenc) assert.equal(tags.h264_nvenc, tags.libx264);
});
