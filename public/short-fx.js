// ショートの文字と演出。HyperFrames の合成の中で動く素のスクリプト(lib/short-compose.mjs が index.html へ埋め込む)。
//   window.SHORT(timeline)を読み、hf-seek の時刻 t の純粋な関数として SVG とカメラを描く。乱数は種付きで、時計は読まない
(function () {
  const D = window.SHORT, NS = 'http://www.w3.org/2000/svg', W = 1080, H = 1920;
  const svg = document.getElementById('fx'), cam = document.getElementById('cam');
  const FONT = {sans: 'ShortSans', round: 'ShortRound', serif: 'ShortSerif'};
  const STYLE = {
    trivia: {ring: '#19c8ff', read: '#ffe23c', em: 'url(#gPink)', band: 'url(#gBand)'},
    pop: {ring: '#ff3d9a', read: '#fff04a', em: 'url(#gPink)', band: 'url(#gBand)'},
    news: {ring: '#10203f', read: '#ffd23c', em: '#ff5a4f', band: '#10203f'},
    drama: {ring: '#000', read: '#fff', em: '#fff', band: '#000'},
  };
  const S = STYLE[D.style];
  // カメラごとの高さ。顔にかぶせず、安全域(上 180、下 380)の内側に置く。sticker は透過の図の [中心 x, 中心 y, 一辺]。hooked はフックの帯が上を占めるカットの位置で、sticker が帯にかかるカメラだけに置く
  const LAYOUT = {
    talk_bust: {telop: 985, caption: 1520, icon: 640, figure: [205, 640], sticker: [200, 620, 400], zoom: 1, origin: '50% 28%'}, talk_close: {telop: 1240, caption: 1530, icon: 1130, figure: [840, 1255], sticker: [800, 350, 440], hooked: [840, 1240, 400], zoom: 1, origin: '50% 35%'},
    talk_wide: {telop: 310, caption: 1510, icon: 640, figure: [830, 800], sticker: [850, 620, 460], zoom: 3, origin: '50% 33%'}, orbit: {telop: 310, caption: 1520, icon: 640, figure: [205, 640], sticker: [230, 620, 480], zoom: 1, origin: '50% 35%'},
    wide_push: {telop: 310, caption: 1510, icon: 640, figure: [830, 800], sticker: [840, 620, 460], zoom: 3, origin: '50% 33%'}, low_feet: {telop: 310, caption: 1500, icon: 700, figure: [830, 800], sticker: [840, 700, 460], zoom: 2, origin: '50% 40%'},
    // 対話のカメラは顔を上の 3 分の 1 に置くので、字幕は下の 3 分の 1 に入る
    close_who: {telop: 1100, caption: 1500, icon: 700, figure: [840, 1000], sticker: [830, 370, 440], hooked: [840, 1240, 400], zoom: 1, origin: '50% 33%'}, bust_who: {telop: 1100, caption: 1500, icon: 700, figure: [840, 1000], sticker: [830, 370, 440], hooked: [840, 1240, 400], zoom: 1, origin: '50% 33%'},
    face_who: {telop: 1100, caption: 1500, icon: 700, figure: [840, 1000], sticker: [830, 370, 440], hooked: [840, 1240, 400], zoom: 1, origin: '50% 33%'}, prop_close: {telop: 1100, caption: 1500, icon: 700, figure: [840, 1000], sticker: [830, 370, 440], hooked: [840, 1240, 400], zoom: 1, origin: '50% 45%'}, prop_line: {telop: 1100, caption: 1500, icon: 700, figure: [840, 1000], sticker: [830, 370, 440], hooked: [840, 1240, 400], zoom: 0, origin: '50% 45%'},
    // 枝の生き物の寄りは、生き物の頭が中央の高さ(y 約 950)に来て、上半分は明るい葉のぼけになる。図はそこへ大きく置く(左上の幹の上では見えなかった)
    crow_close: {telop: 985, caption: 1520, icon: 640, figure: [205, 640], sticker: [580, 560, 700], hooked: [580, 700, 520], zoom: 1, origin: '50% 28%'},
    over_shoulder: {telop: 1100, caption: 1500, icon: 700, figure: [840, 1000], sticker: [830, 370, 440], hooked: [840, 1240, 400], zoom: 1, origin: '50% 33%'}, two_shot: {telop: 1100, caption: 1500, icon: 700, figure: [840, 1000], sticker: [830, 370, 440], hooked: [840, 1240, 400], zoom: 1, origin: '50% 40%'}, pull_back: {telop: 1100, caption: 1500, icon: 700, figure: [840, 1000], sticker: [830, 370, 440], hooked: [840, 1240, 400], zoom: 0, origin: '50% 40%'},
  };
  const SLAM_SEC = 0.95, BAR = 130, END_BLACK = 0.3;   // BAR はドラマの上下の黒帯の高さ。頭と字幕にかからない幅
  const CAPTION = {size: 72, em: 1.3, leading: 1.32}, SAFE = {left: 60, right: 150};
  const actors = [];

  const el = (name, attrs, parent) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  const rng = seed => () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const spring = x => (x <= 0 ? 0 : 1 - Math.exp(-7 * x) * Math.cos(15 * x));   // 行き過ぎて戻るばね
  const easeOut = x => 1 - Math.pow(1 - clamp(x), 3), easeIn = x => Math.pow(clamp(x), 3);
  const add = (from, to, group, fn) => actors.push({from, to, group, fn});

  const defs = el('defs', {}, svg);
  const gradient = (id, stops, attrs = {x1: 0, y1: 0, x2: 0, y2: 1}) => { const g = el('linearGradient', {id, ...attrs}, defs); stops.forEach(([o, c, a]) => el('stop', {offset: o, 'stop-color': c, 'stop-opacity': a ?? 1}, g)); return g; };
  gradient('gGold', [[0, '#ffe84a'], [0.5, '#ffc21f'], [1, '#ff7a1e']]);
  gradient('gPink', [[0, '#ff9ae0'], [0.5, '#ff4fb0'], [1, '#ff2a78']]);
  gradient('gHot', [[0, '#ff4fa8'], [0.6, '#ff2f6d'], [1, '#ff8a1e']]);
  gradient('gWhite', [[0, '#ffffff'], [1, '#d7e6ff']]);
  gradient('gBand', [[0, '#ffffff'], [0.5, '#fffbe0'], [1, '#ffe11f']]);
  // 透過の図の縁と影。ぼかしは書き出しを遅くするので使わず、輪郭を太らせた形を白く塗り、ずらして暗い影にする
  const sticker = el('filter', {id: 'fSticker', x: '-5%', y: '-5%', width: '110%', height: '110%', 'color-interpolation-filters': 'sRGB'}, defs);
  el('feMorphology', {in: 'SourceAlpha', operator: 'dilate', radius: 7, result: 'fat'}, sticker);
  el('feOffset', {in: 'fat', dy: 7, result: 'low'}, sticker);
  el('feFlood', {'flood-color': '#0b1030', 'flood-opacity': 0.7, result: 'dark'}, sticker);
  el('feComposite', {in: 'dark', in2: 'low', operator: 'in', result: 'shade'}, sticker);
  el('feFlood', {'flood-color': '#fff', result: 'white'}, sticker);
  el('feComposite', {in: 'white', in2: 'fat', operator: 'in', result: 'rim'}, sticker);
  const stack = el('feMerge', {}, sticker);
  for (const n of ['shade', 'rim', 'SourceGraphic']) el('feMergeNode', {in: n}, stack);

  const layer = () => el('g', {}, svg);
  const LAYERS = {lines: layer(), particles: layer(), bars: layer(), insert: layer(), caption: layer(), telop: layer(), icons: layer(), slam: layer(), top: layer()};

  const ascii = c => c.charCodeAt(0) < 0x2000;
  const advance = c => (c === ' ' ? 0.3 : ascii(c) ? 0.64 : 1);

  // 文字列を並べる。stroke の太い順に重ねた層と、塗りの層に分けるので、隣の文字の縁が塗りの上に乗らない
  function textRun(parent, items, {font, weight = 900, strokes, fill}) {
    const layers = strokes.map(() => el('g', {}, parent)), top = el('g', {}, parent);
    const chars = items.map(it => {
      const nodes = strokes.map(([w, color], i) => {
        const n = el('text', {'text-anchor': 'middle', 'font-family': font, 'font-weight': weight, 'font-size': it.size, x: 0, y: 0, stroke: color, 'stroke-width': w * it.size, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', fill: color}, layers[i]);
        n.textContent = it.c; return n;
      });
      const face = el('text', {'text-anchor': 'middle', 'font-family': font, 'font-weight': weight, 'font-size': it.size, x: 0, y: 0, fill: it.fill ?? fill}, top);
      face.textContent = it.c;
      const all = [...nodes, face];
      return {
        it, face,
        place(x, y, s = 1, r = 0, o = 1) { const t = `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${r.toFixed(2)}) scale(${s.toFixed(3)})`; for (const n of all) { n.setAttribute('transform', t); n.setAttribute('opacity', o); } },
        text(c) { for (const n of all) n.textContent = c; },
      };
    });
    return {chars, top};
  }

  // 1 行に横へ並べた文字の中心の x
  function lineUp(items, center) {
    const total = items.reduce((s, it) => s + it.size * advance(it.c), 0);
    let x = center - total / 2;
    for (const it of items) { const w = it.size * advance(it.c); it.x = x + w / 2; x += w; }
  }

  // 光が走る層。塗りの層と同じ文字を、動く白い帯で重ねる
  function sweep(parent, items, id, y0, y1) {
    const g = gradient(id, [[0, '#fff', 0], [0.5, '#fff', 0.9], [1, '#fff', 0]], {gradientUnits: 'userSpaceOnUse', x1: 0, y1: y0, x2: 160, y2: y1});
    const layerG = el('g', {}, parent);
    for (const it of items) { const n = el('text', {'text-anchor': 'middle', 'font-family': it.font, 'font-weight': 900, 'font-size': it.size, fill: `url(#${id})`, x: it.x, y: it.y}, layerG); n.textContent = it.c; }
    return x => { g.setAttribute('x1', x); g.setAttribute('x2', x + 200); layerG.setAttribute('opacity', x < -260 || x > W + 60 ? 0 : 1); };
  }

  const star = (cx, cy, r) => { const k = r * 0.18; return `M${cx} ${cy - r}Q${cx + k} ${cy - k} ${cx + r} ${cy}Q${cx + k} ${cy + k} ${cx} ${cy + r}Q${cx - k} ${cy + k} ${cx - r} ${cy}Q${cx - k} ${cy - k} ${cx} ${cy - r}Z`; };

  // ---- 字幕 ----
  function karaokeCaption(cut, cap, index, L) {
    const g = el('g', {}, LAYERS.caption), thought = cut.direction.thought, palette = cut.who ? cut.whoColor : S.ring;
    const font = thought ? FONT.round : FONT.sans, size = CAPTION.size;
    const rows = [];
    let at = 0;
    for (const n of cap.lines) { rows.push(cap.chars.slice(at, at + n)); at += n; }
    const bottom = L.caption, step = size * CAPTION.leading, items = [];
    rows.forEach((row, r) => {
      const y = bottom - (rows.length - 1 - r) * step;
      const list = row.map(c => ({c: c.c, size: size * (c.em ? CAPTION.em : 1), y, em: c.em, fill: c.em ? S.em : thought ? '#d9ecff' : '#fff', from: c.from, to: c.to}));
      lineUp(list, W / 2);
      items.push(...list);
    });
    if (D.caption === 'band') {
      const widest = Math.max(...rows.map(r => r.length)) * size + 80, top = bottom - rows.length * step + 8;
      el('rect', {x: W / 2 - widest / 2, y: top, width: widest, height: rows.length * step + 22, fill: '#0b1530', opacity: 0.86, rx: 10}, g);
    }
    const strokes = D.caption === 'band' ? [] : [[0.42, palette], [0.24, '#050814']];
    const run = textRun(g, items, {font, strokes, fill: '#fff'});
    const wipe = gradient(`k${cut.index}_${index}`, [[0, S.read], [0, S.read], [0, '#fff'], [1, '#fff']], {x1: 0, y1: 0, x2: 1, y2: 0});
    const stops = wipe.children;
    add(cap.from, cap.to, g, t => {
      const a = t - cap.from, enter = 0.8 + 0.2 * spring(a * 2.6);
      g.setAttribute('transform', `translate(${W / 2} ${bottom}) scale(${enter.toFixed(3)}) translate(${-W / 2} ${-bottom})`);
      let active = false;
      for (const c of run.chars) {
        const it = c.it, done = t >= it.to, inside = t >= it.from && t < it.to && it.to > it.from;
        if (inside && !active && !it.em) { active = true; const p = (t - it.from) / (it.to - it.from); stops[1].setAttribute('offset', p); stops[2].setAttribute('offset', p); c.face.setAttribute('fill', `url(#${wipe.id})`); }
        else c.face.setAttribute('fill', it.em ? it.fill : done ? S.read : it.fill);
        const bump = it.em ? 1 + 0.16 * Math.exp(-8 * Math.max(0, t - it.from)) * (t >= it.from ? 1 : 0) : 1;
        c.place(it.x, it.y, bump);
      }
    });
  }

  // 控えめな字幕。セリフは話す人の色のゴシック、心の声は細い明朝で色を抜く。語りは生成りの明朝
  function quietCaption(cut, cap, L) {
    const g = el('g', {}, LAYERS.caption), thought = cut.direction.thought, size = thought ? 60 : 66, step = size * 1.36, rows = [];
    let at = 0;
    for (const n of cap.lines) { rows.push(cap.chars.slice(at, at + n).map(c => c.c).join('').replace(/[（）()]/g, '').replace(/。$/, '')); at += n; }
    const body = !thought && cut.who, spoken = rows.filter(Boolean), widest = Math.max(...spoken.map(r => [...r].length)) * (size + (thought ? 7 : 3));
    // 行数が変わっても文字の塊の中心を動かさない。下端は下から 380 px より上に収める
    const first = CAPTION_MIDDLE - (spoken.length - 1) * step / 2 + size * 0.36;
    el('rect', {x: W / 2 - widest / 2 - 34, y: first - size - 16, width: widest + 68, height: spoken.length * step + 26, rx: 16, fill: '#000', opacity: 0.5}, g);
    spoken.forEach((row, r) => {
      const line = el('text', {'text-anchor': 'middle', x: W / 2, y: first + r * step, 'font-family': body ? FONT.sans : FONT.serif, 'font-weight': body ? 700 : thought ? 500 : 500, 'font-size': size, 'letter-spacing': thought ? 7 : 3, fill: thought ? '#dcebf7' : cut.whoColor || '#f6f1e6', stroke: '#000', 'stroke-width': 11, 'paint-order': 'stroke fill', 'stroke-linejoin': 'round'}, g);
      line.textContent = row;
    });
    add(cap.from, cap.to, g, t => g.setAttribute('opacity', clamp((t - cap.from) / 0.25) * clamp((cap.to - t) / 0.2 + 0.2)));
  }

  const CAPTION_MIDDLE = 1440;
  // ドラマの名札: 字幕の上に出す。2 人の会話(side が左右)は字幕の色で分かるので出さない
  function dramaTag(cut, L) {
    if (!cut.who || !cut.captions.length || cut.side) return;
    const g = el('g', {}, LAYERS.caption), n = [...cut.who].length, width = n * 42 + 52, h = 62, y = L.caption - 200 - h, x = W / 2 - width / 2, from = cut.captions[0].from, to = cut.captions.at(-1).to;
    el('rect', {x, y, width, height: h, rx: 10, fill: cut.whoColor, opacity: cut.direction.thought ? 0.72 : 0.94}, g);
    const t = el('text', {x: x + width / 2, y: y + 45, 'text-anchor': 'middle', 'font-family': FONT.sans, 'font-weight': 700, 'font-size': 40, fill: '#16161f'}, g);
    t.textContent = cut.who;
    add(from, to, g, now => g.setAttribute('opacity', clamp((now - from) / 0.25) * clamp((to - now) / 0.2 + 0.2)));
  }

  function nameTag(cut, L) {
    if (!cut.who || !cut.captions.length) return;   // 声の無いカット(見合わせる、驚くだけ)には名札を出さない
    if (D.caption === 'quiet') return dramaTag(cut, L);
    const g = el('g', {}, LAYERS.caption), n = [...cut.who].length, width = n * 38 + 44, y = L.caption - 230;
    el('rect', {x: 60, y: y - 40, width, height: 58, rx: 12, fill: cut.whoColor}, g);
    const t = el('text', {x: 60 + width / 2, y: y + 2, 'text-anchor': 'middle', 'font-family': FONT.sans, 'font-weight': 900, 'font-size': 36, fill: '#fff', stroke: '#050814', 'stroke-width': 6, 'paint-order': 'stroke fill'}, g);
    t.textContent = cut.who;
    add(cut.start, cut.end, g, () => {});
  }

  // ---- テロップ ----
  function telopChars(text, size, number) {
    const list = [...text], items = [], n = number ? list.join('').indexOf(number) : -1, big = number ? [...number].length : 0;
    let index = 0;
    for (let i = 0; i < list.length; i++) {
      const inNumber = n >= 0 && [...text.slice(0, i)].length >= 0 && i >= [...text.slice(0, n)].length && i < [...text.slice(0, n)].length + big;
      items.push({c: list[i], size: inNumber ? size * 1.9 : size, number: inNumber, i: index++});
    }
    return items;
  }

  function exitFade(cut, t) { const left = cut.end - t; return left < 0.14 ? {o: clamp(left / 0.14), s: 1 + (0.14 - left) * 0.8} : {o: 1, s: 1}; }

  function popTelop(cut, L, type) {
    const g = el('g', {}, LAYERS.telop), start = cut.start + (cut.direction.slamAt != null ? cut.direction.slamAt + SLAM_SEC : 0.06), size = Math.min(90, 800 / Math.max(5, [...cut.telop].length));
    const items = telopChars(cut.telop, size, type === 'number' ? null : cut.direction.number);
    const y = L.telop + 40;
    items.forEach(it => { it.y = y; it.font = FONT.round; });
    lineUp(items, W / 2 - 30);
    const run = textRun(g, items, {font: FONT.round, strokes: [[0.42, '#19c8ff'], [0.25, '#0b1030']], fill: 'url(#gGold)'});
    run.chars.forEach(c => { if (c.it.number) c.face.setAttribute('fill', 'url(#gHot)'); });
    const shine = sweep(g, items, `sw${cut.index}`, y - 80, y + 20);
    const r = rng(cut.direction.seed), tilt = items.map(() => (r() - 0.5) * 7);
    add(start, cut.end, g, t => {
      const a = t - start, out = exitFade(cut, t);
      run.chars.forEach((c, i) => { const p = spring((a - 0.035 * i) * 1.5), o = a - 0.035 * i > 0 ? out.o : 0; c.place(c.it.x, c.it.y - (1 - p) * 70, (0.8 + 0.2 * p) * out.s, (1 - clamp(p)) * tilt[i] * 3, o); });
      shine(-300 + (a - 0.55) * 2600);
    });
  }

  const HOOK_Y = 285;
  // テロップに改行があれば 2 行にする。1 行目は白の前置き、2 行目は題で、題の字数から大きさを決める(12 字を 1 行にすると 63 px にしかならない)
  function hookTelop(cut, L) {
    const [kicker, main] = cut.telop.includes('\n') ? cut.telop.split('\n', 2).map(s => s.trim()) : ['', cut.telop];
    // キャラの胸を隠さないよう頭の上に置く。2 行の帯は高いので、前置きが上の安全域(180)と傾きで上がる右端に入らないよう下げる
    const g = el('g', {}, LAYERS.telop), start = cut.start + 0.04, y = HOOK_Y + (kicker ? 40 : 0), center = W / 2 - 45;
    const inner = el('g', {transform: `rotate(-5 ${center} ${y})`}, g), bandH = kicker ? 256 : 196;
    const band = el('g', {}, inner);
    el('rect', {x: -80, y: y - bandH / 2 - 10, width: W + 160, height: bandH + 20, fill: '#0b1030'}, band);
    el('rect', {x: -80, y: y - bandH / 2, width: W + 160, height: bandH, fill: S.band}, band);
    el('rect', {x: -80, y: y + bandH / 2 - 16, width: W + 160, height: 16, fill: '#ffcf1f'}, band);
    const len = [...main].length, size = kicker ? Math.min(104, 860 / Math.max(5, len)) : Math.min(96, 760 / Math.max(5, len)), small = Math.round(size * 0.72);
    const line = (text, px, at) => {
      const items = telopChars(text, px, cut.direction.number);
      items.forEach(it => { it.y = at; it.font = FONT.round; });
      const wide = items.reduce((w, it) => w + it.size * advance(it.c), 0);
      lineUp(items, Math.min(W / 2, W - SAFE.right - wide / 2 - 10));
      return items;
    };
    const top = kicker ? line(kicker, small, y - bandH / 2 + 22 + small * 0.86) : [];
    const items = line(main, size, kicker ? y + bandH / 2 - 34 - size * 0.14 : y + size * 0.36);
    const head = top.length ? textRun(inner, top, {font: FONT.round, strokes: [[0.4, '#0b1030']], fill: '#fff'}) : {chars: []};
    const body = textRun(inner, items, {font: FONT.round, strokes: [[0.46, '#19c8ff'], [0.27, '#0b1030']], fill: 'url(#gGold)'});
    body.chars.forEach(c => { if (c.it.number) { c.face.setAttribute('fill', 'url(#gHot)'); } });
    const run = {chars: [...head.chars, ...body.chars]};
    const shine = sweep(inner, items, `sw${cut.index}`, y - 90, y + 30);
    add(start, cut.end, g, t => {
      const a = t - start, out = exitFade(cut, t), b = easeOut(a / 0.16);
      band.setAttribute('transform', `translate(${center} 0) scale(${b.toFixed(3)} 1) translate(${-center} 0)`);
      g.setAttribute('opacity', out.o);
      run.chars.forEach((c, i) => { const p = spring((a - 0.1 - 0.03 * i) * 1.5), on = a - 0.1 - 0.03 * i > 0; c.place(c.it.x, c.it.y - (1 - p) * 34, (c.it.number ? 0.6 + 0.4 * p : 0.8 + 0.2 * p), 0, on ? 1 : 0); });
      shine(-300 + (a - 0.6) * 2600);
    });
  }

  // 数字は特大でカウントアップし、着いた所で弾む
  function numberTelop(cut, L) {
    if (!cut.direction.number) return popTelop(cut, L, 'pop');
    const g = el('g', {}, LAYERS.telop), start = cut.start + 0.08, number = cut.direction.number, y = L.telop + 110;
    const digits = /^[0-9.,]+$/.test(number), value = digits ? Number(number.replace(/,/g, '')) : 0, decimals = (number.split('.')[1] ?? '').length, figures = number.replace(/[^0-9]/g, '').length;
    const rest = cut.telop.replace(number, '');
    const size = Math.min(220, 620 / Math.max(1, [...number].length * 0.64));
    const items = [...number].map(c => ({c, size, y, font: FONT.sans, number: true}));
    lineUp(items, W / 2 - (rest ? 120 : 0));
    const run = textRun(g, items, {font: FONT.sans, strokes: [[0.2, '#ffffff'], [0.13, '#0b1030']], fill: 'url(#gHot)'});
    const label = rest ? textRun(g, [...rest].map((c, i) => ({c, size: 62, y, x: 0, i})), {font: FONT.round, strokes: [[0.42, '#19c8ff'], [0.25, '#0b1030']], fill: 'url(#gGold)'}) : null;
    if (label) { lineUp(label.chars.map(c => c.it), W / 2 + 190); }
    add(start, cut.end, g, t => {
      const a = t - start, out = exitFade(cut, t), count = digits ? value * easeOut(a / 0.65) : value;
      // カンマと小数点の位置は元の数字のまま、数字の所だけ差し替える
      const shown = [...(digits ? count.toFixed(decimals) : number).replace('.', '').padStart(figures, '0')];
      let next = 0;
      const digitsNow = [...number].map(c => (/[0-9]/.test(c) ? shown[next++] : c));
      const stamp = a > 0.65 ? 1 + 0.18 * Math.exp(-7 * (a - 0.65)) : 0.92;
      run.chars.forEach((c, i) => { if (digits && digitsNow[i]) c.text(digitsNow[i]); const p = spring(a * 1.6); c.place(c.it.x, c.it.y, (0.8 + 0.2 * p) * stamp * out.s, 0, out.o); });
      if (label) label.chars.forEach((c, i) => { const p = spring((a - 0.65 - 0.03 * i) * 1.5); c.place(c.it.x, c.it.y, 0.8 + 0.2 * p, 0, a > 0.65 + 0.03 * i ? out.o : 0); });
    });
  }

  function followTelop(cut, L) {
    const g = el('g', {}, LAYERS.telop), y = 1240, start = cut.start + 0.25, items = [...cut.telop].map(c => ({c, size: 70, y: y + 25, font: FONT.round}));
    lineUp(items, W / 2 + 30);
    const width = items.length * 70 + 170, pill = el('g', {}, g);
    el('rect', {x: W / 2 - width / 2, y: y - 66, width, height: 132, rx: 66, fill: '#0b1030'}, pill);
    el('rect', {x: W / 2 - width / 2 + 9, y: y - 57, width: width - 18, height: 114, rx: 57, fill: 'url(#gPink)'}, pill);
    const hx = W / 2 - width / 2 + 78, heart = el('path', {d: 'M0 16C-34-10-20-34 0-18C20-34 34-10 0 16Z', fill: '#fff'}, pill);
    const run = textRun(g, items, {font: FONT.round, strokes: [[0.2, '#a3124f']], fill: '#fff'});
    add(start, cut.end, g, t => {
      const a = t - start, p = spring(a * 1.3), beat = 1.2 + 0.2 * Math.abs(Math.sin(a * 4));
      pill.setAttribute('transform', `translate(${W / 2} ${y}) scale(${(0.8 + 0.2 * p).toFixed(3)}) translate(${-W / 2} ${-y})`);
      heart.setAttribute('transform', `translate(${hx} ${y}) scale(${beat.toFixed(3)})`);
      run.chars.forEach((c, i) => { const q = spring((a - 0.08 - 0.03 * i) * 1.5); c.place(c.it.x, c.it.y - (1 - q) * 30, 0.8 + 0.2 * q, 0, a > 0.08 + 0.03 * i ? 1 : 0); });
    });
  }

  function bandTelop(cut, L) {
    const g = el('g', {}, LAYERS.telop), y = L.telop, size = Math.min(68, 760 / Math.max(5, [...cut.telop].length));
    const width = [...cut.telop].length * size + 120;
    el('rect', {x: 0, y: y - 62, width: width + 60, height: 112, fill: '#10203f'}, g);
    el('rect', {x: 0, y: y - 62, width: 44, height: 112, fill: '#ff3b30'}, g);
    const t = el('text', {x: 76, y: y + 16, 'font-family': FONT.sans, 'font-weight': 900, 'font-size': size, fill: '#fff'}, g);
    t.textContent = cut.telop;
    add(cut.start, cut.end, g, now => { const a = now - cut.start, x = (1 - easeOut(a / 0.22)) * -(width + 80), o = clamp((cut.end - now) / 0.12); g.setAttribute('transform', `translate(${x.toFixed(1)} 0)`); g.setAttribute('opacity', o); });
  }

  function cinemaTelop(cut) {
    const g = el('g', {}, LAYERS.telop), t = el('text', {'text-anchor': 'middle', x: W / 2, y: 190, 'font-family': FONT.serif, 'font-weight': 500, 'font-size': 38, 'letter-spacing': 20, fill: '#f6f1e6', stroke: 'rgba(0,0,0,.5)', 'stroke-width': 4, 'paint-order': 'stroke fill'}, g);
    t.textContent = cut.telop;
    add(cut.start, cut.end, g, now => g.setAttribute('opacity', 0.86 * clamp((now - cut.start) / 0.6) * clamp((cut.end - now) / 0.4)));
  }

  const TITLE_Y = 290;   // 顔より上。寄りのカットで口にかからない
  // 大きな明朝の見出し。ドラマの頭で状況を見せる。最後のカットでは暗転の間だけ出す
  function titleTelop(cut, L) {
    const end = cut.direction.kind === 'end', from = end ? cut.end - END_BLACK : cut.start + 0.05, to = end ? cut.end : Math.min(cut.end - 0.05, from + 2.6), len = [...cut.telop].length, size = Math.min(end ? 96 : 76, 860 / Math.max(4, len)), y = end ? 980 : TITLE_Y;
    const g = el('g', {}, LAYERS.telop), width = len * (size + 8) + 80;
    el('rect', {x: W / 2 - width / 2, y: y - size - 26, width, height: size + 56, rx: 14, fill: '#000', opacity: 0.55}, g);
    const t = el('text', {'text-anchor': 'middle', x: W / 2 + 4, y, 'font-family': FONT.serif, 'font-weight': 700, 'font-size': size, 'letter-spacing': 8, fill: '#fbf5e8', stroke: '#000', 'stroke-width': 8, 'paint-order': 'stroke fill', 'stroke-linejoin': 'round'}, g);
    t.textContent = cut.telop;
    add(from, to, g, now => g.setAttribute('opacity', end ? 1 : clamp((now - from) / 0.2) * clamp((to - now) / 0.3)));
  }

  // ---- 飾り ----
  function speedLines(cut) {
    const center = [W / 2, 820], sets = [0, 1, 2].map(k => {
      const g = el('g', {}, LAYERS.lines), r = rng(cut.direction.seed + k * 977);
      for (let i = 0; i < 64; i++) {
        const a = r() * Math.PI * 2, inner = 620 + r() * 260, wide = 0.004 + r() * 0.012, outer = 1500;
        const pt = (ang, rad) => `${(center[0] + Math.cos(ang) * rad * 0.62).toFixed(1)} ${(center[1] + Math.sin(ang) * rad).toFixed(1)}`;
        el('path', {d: `M${pt(a, inner)}L${pt(a - wide, outer)}L${pt(a + wide, outer)}Z`, fill: '#fff', opacity: 0.85}, g);
      }
      return g;
    });
    const holder = el('g', {}, LAYERS.lines), dur = Math.min(1.1, cut.end - cut.start);
    sets.forEach(s => holder.appendChild(s));
    add(cut.start, cut.start + dur, holder, t => {
      const a = t - cut.start, pick = Math.floor(a * 15) % 3;
      sets.forEach((s, i) => s.setAttribute('display', i === pick ? 'inline' : 'none'));
      holder.setAttribute('opacity', clamp(a / 0.08) * clamp((dur - a) / 0.3));
    });
  }

  function particles(cut) {
    const g = el('g', {}, LAYERS.particles), r = rng(cut.direction.seed + 31), dots = [];
    for (let i = 0; i < 34; i++) dots.push({x: r() * W, y: 300 + r() * 1300, v: 40 + r() * 80, p: r() * 6.28, r: 3 + r() * 6, n: el('circle', {r: 1, fill: i % 3 ? '#fff6c8' : '#fff'}, g)});
    add(cut.start, cut.end, g, t => {
      const a = t - cut.start;
      for (const d of dots) { d.n.setAttribute('cx', (d.x + Math.sin(a * 1.4 + d.p) * 26).toFixed(1)); d.n.setAttribute('cy', (d.y - a * d.v).toFixed(1)); d.n.setAttribute('r', d.r); d.n.setAttribute('opacity', (0.35 + 0.45 * Math.abs(Math.sin(a * 2 + d.p))).toFixed(2)); }
    });
  }

  function sparkleBurst(cut, at, cx, cy, spread, count) {
    const g = el('g', {}, LAYERS.icons), r = rng(cut.direction.seed + 57), stars = [];
    for (let i = 0; i < count; i++) stars.push({x: cx + (r() - 0.5) * spread[0], y: cy + (r() - 0.5) * spread[1], s: 26 + r() * 40, d: 0.08 * i, n: el('path', {d: star(0, 0, 1), fill: '#fff6a0', stroke: '#ff9a1f', 'stroke-width': 0.05}, g)});
    add(at, Math.min(cut.end, at + 1.4), g, t => {
      const a = t - at;
      for (const s of stars) { const q = a - s.d, life = clamp(q / 0.5), scale = s.s * (q < 0 ? 0 : Math.sin(Math.PI * life)); s.n.setAttribute('transform', `translate(${s.x.toFixed(1)} ${s.y.toFixed(1)}) rotate(${(q * 50).toFixed(1)}) scale(${Math.max(0.001, scale).toFixed(2)})`); }
    });
  }

  function mark(cut, ch, L) {
    const g = el('g', {}, LAYERS.icons), at = cut.start + 0.3, size = 170;
    const place = ch === '？' ? [[880, L.icon, 12]] : [[150, L.icon, -12], [880, L.icon - 50, 10]];
    const runs = place.map(([x, y, r]) => ({x, y, r, run: textRun(g, [{c: ch, size, y: 0, x: 0}], {font: FONT.round, strokes: [[0.2, '#19c8ff'], [0.11, '#0b1030']], fill: 'url(#gGold)'})}));
    add(at, Math.min(cut.end, at + 1.3), g, t => {
      const a = t - at, out = clamp((Math.min(cut.end, at + 1.3) - t) / 0.15);
      for (const m of runs) { const p = spring(a * 1.4), wob = Math.sin(a * 7) * 5; m.run.chars[0].place(m.x, m.y - (1 - p) * 60, (0.8 + 0.2 * p), m.r + wob, out); }
    });
  }

  function flash(cut, color = '#fff') {
    const r = el('rect', {x: 0, y: 0, width: W, height: H, fill: color}, LAYERS.top);
    add(cut.start, cut.start + 0.22, r, t => r.setAttribute('opacity', 0.75 * (1 - (t - cut.start) / 0.22)));
  }

  // オチの 1 語を全画面で見せる
  function slam(cut) {
    const g = el('g', {}, LAYERS.slam), at = cut.start + cut.direction.slamAt, dur = SLAM_SEC, list = [...cut.direction.slamWord], size = Math.min(300, 830 / Math.max(2, list.length));
    el('rect', {x: 0, y: 0, width: W, height: H, fill: '#060a1e', opacity: 0.84}, g);
    const items = list.map(c => ({c, size, y: 950, font: FONT.sans}));
    lineUp(items, W / 2);
    const run = textRun(g, items, {font: FONT.sans, strokes: [[0.2, '#fff'], [0.12, '#0b1030']], fill: 'url(#gHot)'});
    add(at, at + dur, g, t => {
      const a = t - at, p = spring(a * 2.2), out = clamp((dur - a) / 0.1), s = 1.5 - 0.5 * p;
      g.setAttribute('opacity', out);
      run.chars.forEach(c => c.place(W / 2 + (c.it.x - W / 2) * s, 950 + size * 0.36 * s, s));
    });
  }

  // 図: 語の時刻に弾んで出て、少し浮いて、素早く消える
  function figurePop(g, x, y, at, to) {
    add(at, to, g, t => {
      const a = t - at, p = spring(a * 1.6), left = to - t, out = left < 0.14 ? left / 0.14 : 1;
      g.setAttribute('transform', `translate(${x} ${(y + Math.sin(a * 2.6) * 10).toFixed(1)}) rotate(${(Math.sin(a * 3.1) * 4).toFixed(2)}) scale(${((0.3 + 0.7 * p) * out).toFixed(3)})`);
    });
  }

  // 手動の図。丸く抜くので元の絵の背景は問わない
  function figureCard(cut, L) {
    const [x, y] = L.figure, r = 165, at = cut.figureAt, to = Math.min(cut.end - 0.05, at + 2.2), g = el('g', {}, LAYERS.insert), id = `fig${cut.index}`;
    el('circle', {r: r / 1}, el('clipPath', {id}, defs));
    el('circle', {r: r + 22, fill: '#0b1030'}, g);
    el('circle', {r: r + 13, fill: '#19c8ff'}, g);
    el('circle', {r: r + 5, fill: '#fff'}, g);
    el('image', {href: cut.figure, x: -r, y: -r, width: r * 2, height: r * 2, 'clip-path': `url(#${id})`, preserveAspectRatio: 'xMidYMid slice'}, g);
    figurePop(g, x, y, at, to);
  }

  // 透過の図。丸く抜かず、白い縁と影で背景から分ける
  function figureSticker(cut, L) {
    const [x, y, size] = (cut.telop && cut.direction.telopType === 'hook' && L.hooked) || L.sticker, at = cut.figureAt, to = Math.min(cut.end - 0.05, at + 2.2), g = el('g', {}, LAYERS.insert);
    el('image', {href: cut.figure, x: -size / 2, y: -size / 2, width: size, height: size, filter: 'url(#fSticker)'}, g);
    figurePop(g, x, y, at, to);
  }

  function insertCard(cut) {
    if (!cut.insert) return;
    const g = el('g', {}, LAYERS.insert), at = cut.start + 0.3, to = Math.min(cut.end - 0.1, at + 1.6), w = 300, h = 533, x = 680, y = 620;
    el('rect', {x: -w / 2 - 12, y: -h / 2 - 12, width: w + 24, height: h + 24, rx: 16, fill: '#fff'}, g);
    el('image', {href: cut.insert, x: -w / 2, y: -h / 2, width: w, height: h, preserveAspectRatio: 'xMidYMid slice'}, g);
    add(at, to, g, t => { const p = spring((t - at) * 1.5), o = clamp((to - t) / 0.12); g.setAttribute('transform', `translate(${x} ${y}) rotate(4) scale(${(0.8 + 0.2 * p).toFixed(3)})`); g.setAttribute('opacity', o); });
  }

  // ---- 全体 ----
  // 控えめな字幕は縁が細いので、下を暗くして読めるようにする
  if (D.caption === 'quiet') { gradient('gFoot', [[0, '#000', 0], [1, '#000', 0.72]]); el('rect', {x: 0, y: 1300, width: W, height: H - BAR - 1300, fill: 'url(#gFoot)'}, LAYERS.bars); }
  if (D.letterbox) { el('rect', {x: 0, y: 0, width: W, height: BAR, fill: '#000'}, LAYERS.bars); el('rect', {x: 0, y: H - BAR, width: W, height: BAR, fill: '#000'}, LAYERS.bars); }
  if (D.style === 'drama') {   // 言い終わりで即座に暗転する。文字は黒の上に残る
    const black = el('rect', {x: 0, y: 0, width: W, height: H, fill: '#000'}, LAYERS.bars);
    add(D.seconds - END_BLACK, D.seconds + 1, black, () => {});
  }
  if (D.series) {
    const g = el('g', {}, LAYERS.top), n = [...D.series].length, width = n * 36 + 40;
    el('rect', {x: SAFE.left, y: 188, width, height: 56, rx: 10, fill: '#0b1030', opacity: 0.82}, g);
    const t = el('text', {x: SAFE.left + width / 2, y: 228, 'text-anchor': 'middle', 'font-family': FONT.sans, 'font-weight': 900, 'font-size': 36, fill: '#fff'}, g);
    t.textContent = D.series;
  }
  // 進行バーは投稿先の画面にもあるので、既定では出さない。長い動画で欲しいときだけ timeline の progress を立てる
  const progress = D.progress ? 'visible' : 'hidden';
  el('rect', {x: 0, y: H - 10, width: W, height: 10, fill: '#fff', opacity: 0.22, visibility: progress}, LAYERS.top);
  const bar = el('rect', {x: 0, y: H - 10, width: W, height: 10, fill: D.style === 'drama' ? '#d8cdb8' : '#ff2d55', visibility: progress}, LAYERS.top);

  for (const cut of D.cuts) {
    const L = LAYOUT[cut.camera] ?? LAYOUT.talk_bust, d = cut.direction;
    if (D.caption === 'quiet') cut.captions.forEach(c => quietCaption(cut, c, L));
    else cut.captions.forEach((c, i) => karaokeCaption(cut, c, i, L));
    nameTag(cut, L);
    if (cut.telop) ({pop: popTelop, hook: hookTelop, number: numberTelop, follow: followTelop, band: bandTelop, cinema: cinemaTelop, title: titleTelop}[d.telopType] ?? popTelop)(cut, L, d.telopType);
    for (const e of d.effects) {
      if (e === 'speedlines') speedLines(cut);
      else if (e === 'particles') particles(cut);
      else if (e === 'sparkle') sparkleBurst(cut, cut.start + 0.2, W / 2, 900, [820, 900], 12);
      else if (e === 'question') mark(cut, '？', L);
      else if (e === 'exclaim') mark(cut, '！', L);
      else if (e === 'flash') flash(cut);
      else if (e === 'slam') slam(cut);
      else if (e === 'insert') insertCard(cut);
    }
    if (cut.figure) (cut.figureStyle === 'sticker' ? figureSticker : figureCard)(cut, L);
    if (cut.telop && d.telopType === 'hook') sparkleBurst(cut, cut.start + 0.3, 760, L.telop - 60, [640, 300], 5);
  }

  // カメラ: 常に少し動かす。引きのカットは大きく寄り、横にも少し流れる。強調語で跳ね、驚きで揺れる
  function camera(t) {
    const cut = D.cuts.find(c => t < c.end) ?? D.cuts[D.cuts.length - 1], d = cut.direction, L = LAYOUT[cut.camera] ?? LAYOUT.talk_bust, p = clamp((t - cut.start) / (cut.end - cut.start));
    let s = (D.letterbox ? 1 : 1.03) * (1 + d.kenburns * L.zoom * (d.pull ? 1 - p : p)), x = D.letterbox ? 0 : Math.sin(cut.start * 3 + p * 1.6) * 9 * L.zoom, y = 0;
    for (const m of cut.punches) { const a = t - m; if (a < 0) continue; s *= 1 + (a < 0.06 ? 0.08 * a / 0.06 : 0.08 * Math.exp(-9 * (a - 0.06)) * Math.cos(16 * (a - 0.06))); }
    if (d.effects.includes('shake')) { const a = t - cut.start, amp = 24 * Math.exp(-5 * a); x += amp * Math.sin(83 * a + d.seed % 7); y += amp * Math.sin(101 * a + d.seed % 11); }
    if (d.slamAt != null) { const a = t - cut.start - d.slamAt; if (a >= 0) { const amp = 16 * Math.exp(-7 * a); x += amp * Math.sin(83 * a); y += amp * Math.sin(101 * a); } }
    cam.style.transformOrigin = L.origin;
    cam.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${s.toFixed(4)})`;
  }

  function seek(t) {
    for (const a of actors) {
      const on = t >= a.from && t < a.to;
      a.group.setAttribute('display', on ? 'inline' : 'none');
      if (on) a.fn(t);
    }
    bar.setAttribute('width', (W * clamp(t / D.seconds)).toFixed(1));
    camera(t);
  }
  window.addEventListener('hf-seek', e => seek(e.detail.time));
  seek(0);
})();
