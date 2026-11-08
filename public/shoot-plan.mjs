// 撮影の長さとカメラの計算。撮る画面のプレビュー、tools/shoot.mjs、lib/shoot.mjs が同じものを使う。THREE も DOM も使わない(テストが読み込める)。
export const MAX_SECONDS = 180, DEFAULT_SECONDS = 5;
export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;   // 音声ファイルの大きさの上限。server.mjs の MAX_BODY と揃える

// 動画の長さ(秒)。モーションがあれば モーション × 繰り返し。セリフの方が長ければセリフまで伸ばす(モーションは繰り返す)。
// モーションが無ければ、指定の長さ、無ければセリフと音声の長い方、どれも無ければ 5 秒。
// 音声は、モーションのある動画の長さを変えない(長い音声は動画の長さで切る)。
export function shootSeconds({motionSec = 0, loops = 1, seconds = 0, lineSec = 0, audioSec = 0}) {
  const raw = motionSec > 0 ? Math.max(motionSec * loops, lineSec) : seconds > 0 ? Math.max(seconds, lineSec) : Math.max(lineSec, audioSec) || DEFAULT_SECONDS;
  return Math.min(raw, MAX_SECONDS);
}

const tanHalf = fov => Math.tan(fov * Math.PI / 360);
export const distanceFor = (frameH, fov) => frameH / (2 * tanHalf(fov));

// 全身: 測った点が全部枠に入るカメラの高さ(cy)と距離(dist)を返す。
// points は追従の基準(hips の真下)からの相対の {x, y, z, rx, ry}。rx、ry は点のまわりに取る余白(頭の大きさなど)。床(y = 0)も枠に入れる。
export function fitFull(points, {fov, aspect, margin = 0.03, cy: fixedCy}) {
  let top = 0, bottom = 0;
  for (const p of points) { top = Math.max(top, p.y + p.ry); bottom = Math.min(bottom, p.y - p.ry); }
  const cy = fixedCy ?? (top + bottom) / 2, tv = tanHalf(fov) * (1 - margin), th = tv * aspect;
  let dist = 0;
  for (const p of points) dist = Math.max(dist, p.z + Math.max((Math.abs(p.y - cy) + p.ry) / tv, (Math.abs(p.x) + p.rx) / th));
  return {cy, dist};
}

// 全身のカメラの距離の道筋。dists は時刻ごとに全身が入る距離。前後 reach 秒の最大を取ってからならすので、どのコマでも入り、広がる動きの前に引き始める
export function zoomTrack(times, dists, reach = 0.8) {
  const near = (i, half, f) => times.flatMap((t, j) => Math.abs(t - times[i]) <= half + 1e-6 ? [f(j)] : []);
  const held = times.map((_, i) => Math.max(...near(i, reach, j => dists[j])));
  return times.map((t, i) => { const v = near(i, reach / 2, j => held[j]); return [t, v.reduce((a, b) => a + b, 0) / v.length, 0, 0]; });
}

// 上半身と顔: 頭の骨からの高さのずれ(dy)と枠の高さ(frameH)を返す。頭の大きさと胴の長さから決めるので、頭の大きいチビでも同じ構図になる。
// body: {headTop: 頭の骨から頭のてっぺんまで, headH: 首から頭のてっぺんまで, torso: 頭の骨から hips まで}
export function frameHead(framing, body, aspect) {
  const {headTop, headH, torso} = body;
  if (framing === 'face') {
    const frameH = headH * Math.max(1.5, 1.15 / aspect);
    return {frameH, dy: headTop - headH / 2 - frameH * 0.03};
  }
  const frameH = (headTop + torso) * 1.2;
  return {frameH, dy: headTop + frameH * 0.06 - frameH / 2};
}

// 頭の道筋をならす([t, x, y, z] の並び)。half は前後の幅(秒)。細かい揺れをカメラに写さない
export function smoothTrack(track, half) {
  return track.map(([t]) => {
    const near = track.filter(p => Math.abs(p[0] - t) <= half), n = near.length;
    return [t, ...[1, 2, 3].map(i => near.reduce((a, p) => a + p[i], 0) / n)];
  });
}
// 道筋の時刻 t の位置(前後の点の間を直線でつなぐ)
export function trackAt(track, t) {
  const i = track.findIndex(p => p[0] > t);
  if (i < 0) return track.at(-1).slice(1);
  if (i === 0) return track[0].slice(1);
  const a = track[i - 1], b = track[i], k = (t - a[0]) / (b[0] - a[0]);
  return [1, 2, 3].map(j => a[j] + (b[j] - a[j]) * k);
}
