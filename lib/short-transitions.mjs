// カットの境の転換を、前後のコマから 1 コマずつ作る。入出力は RGB 24 bit の配列。乱数は種付きで、同じ入力には同じコマを返す。
//   HyperFrames のエンジンのシェーダー経路は 1 秒あたり約 20 秒かかり、転換の間は文字も消える。先に動画へ焼き込むと文字の直しで作り直さずに済む
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const inOut = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const noise = n => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };

// 2 枚を横につないで動かす。radius は横方向のブラーの半径(コマの幅に対する割合)
function push(from, to, out, w, h, p, radiusAt, seed, jitter) {
  const t = inOut(p), shift = t * w, radius = Math.round(radiusAt * w), line = new Float64Array((w * 2 + 1) * 3), strip = new Uint8Array(w * 2 * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w * 3, wobble = jitter ? Math.round((noise(Math.floor(y / 12) + seed) - 0.5) * jitter * Math.sin(Math.PI * p) * w) : 0;
    strip.set(from.subarray(row, row + w * 3), 0); strip.set(to.subarray(row, row + w * 3), w * 3);
    for (let c = 0; c < 3; c++) { line[c] = 0; }
    for (let x = 0; x < w * 2; x++) for (let c = 0; c < 3; c++) line[(x + 1) * 3 + c] = line[x * 3 + c] + strip[x * 3 + c];
    for (let x = 0; x < w; x++) {
      const at = clamp(Math.round(x + shift + wobble), 0, w * 2 - 1), a = Math.max(0, at - radius), b = Math.min(w * 2 - 1, at + radius), n = b - a + 1;
      for (let c = 0; c < 3; c++) out[row + x * 3 + c] = (line[(b + 1) * 3 + c] - line[a * 3 + c]) / n;
    }
  }
}

function flash(from, to, out, p) {
  const src = p < 0.5 ? from : to, white = Math.sin(Math.PI * p);
  for (let i = 0; i < out.length; i++) out[i] = src[i] + (255 - src[i]) * Math.min(1, white * 1.25);
}

// 横の帯をずらし、色を分け、帯ごとに前後のコマが入れ替わる
function glitch(from, to, out, w, h, p, seed, frame) {
  const strength = Math.sin(Math.PI * p), rows = Math.max(8, Math.round(h / 34)), rowH = Math.ceil(h / rows);
  for (let k = 0; k < rows; k++) {
    const n = seed + k * 3.1 + frame * 7.7, active = noise(n) < 0.35 + 0.6 * strength, dx = active ? Math.round((noise(n + 1) - 0.5) * 0.5 * w * strength) : 0, split = active ? Math.round(0.03 * w * strength * (noise(n + 2) + 0.3)) : 0;
    const src = noise(n + 3) < p ? to : from;
    for (let y = k * rowH; y < Math.min(h, (k + 1) * rowH); y++) {
      const row = y * w * 3;
      for (let x = 0; x < w; x++) {
        const at = (x + dx + w) % w, o = row + x * 3;
        out[o] = src[row + ((at + split) % w) * 3];
        out[o + 1] = src[row + at * 3 + 1];
        out[o + 2] = src[row + ((at - split + w) % w) * 3 + 2];
      }
    }
  }
}

// 中心へ向かう放射のブラーで奥へ抜ける
function zoom(from, to, out, w, h, p) {
  const t = inOut(p), src = t < 0.5 ? from : to, base = t < 0.5 ? 1 + t * 1.6 : 0.6 + (t - 0.5) * 0.8, blur = Math.sin(Math.PI * p) * 0.22, taps = 16, cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < taps; i++) {
        const s = 1 / (base * (1 + blur * i / (taps - 1))), sx = clamp(Math.round(cx + (x - cx) * s), 0, w - 1), sy = clamp(Math.round(cy + (y - cy) * s), 0, h - 1), o = (sy * w + sx) * 3;
        r += src[o]; g += src[o + 1]; b += src[o + 2];
      }
      const o = (y * w + x) * 3;
      out[o] = r / taps; out[o + 1] = g / taps; out[o + 2] = b / taps;
    }
  }
}

function dissolve(from, to, out, p) {
  const t = inOut(p);
  for (let i = 0; i < out.length; i++) out[i] = from[i] + (to[i] - from[i]) * t;
}

// 黒を挟む。場所や時間が変わるときのゆっくりの転換
function fade(from, to, out, p) {
  const src = p < 0.5 ? from : to, k = Math.abs(1 - 2 * p);
  for (let i = 0; i < out.length; i++) out[i] = src[i] * k * k;
}

// kind の 1 コマを out へ書く。p は 0 から 1
export function transitionFrame(kind, from, to, out, {width: w, height: h, p, seed = 0, frame = 0}) {
  if (kind === 'whip') push(from, to, out, w, h, p, 0.03 + 0.1 * Math.sin(Math.PI * p), seed, 0.03);
  else if (kind === 'slide') push(from, to, out, w, h, p, 0.015 * Math.sin(Math.PI * p), seed, 0);
  else if (kind === 'flash') flash(from, to, out, p);
  else if (kind === 'glitch') glitch(from, to, out, w, h, p, seed, frame);
  else if (kind === 'zoom') zoom(from, to, out, w, h, p);
  else if (kind === 'fade') fade(from, to, out, p);
  else dissolve(from, to, out, p);
  return out;
}
