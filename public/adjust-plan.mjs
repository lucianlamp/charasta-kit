// 体型と揺れものの直し(docs/adjust.md)の値と計算。画面(public/adjust.mjs、ビューアの下見)とサーバー(lib/adjust.mjs)が同じものを使う。DOM も import も使わない。
//   体型: 値の範囲と、書き換える道具(tools/vrm/body_shape.py)へ渡す引数
//   揺れもの: VRMC_springBone の spring を、名前から人の言葉の組(髪、スカート、リボンなど)に分け、組ごとの値から joint ごとの値を決める

// 体型の値。unit は画面の単位、tool は body_shape.py の引数の鍵、scale は画面の値から道具の値への倍率(cm -> m)
export const BODY_FIELDS = [
  {key: 'head', label: '頭の大きさ', unit: '倍', min: 0.85, max: 1.15, step: 0.01, neutral: 1, tool: 'head', scale: 1},
  {key: 'neck', label: '首の長さ', unit: 'cm', min: -2, max: 2, step: 0.1, neutral: 0, tool: 'neck', scale: 0.01},
  {key: 'shoulder', label: '肩幅(片側)', unit: 'cm', min: -3, max: 3, step: 0.1, neutral: 0, tool: 'shoulder', scale: 0.01},
  {key: 'arm', label: '腕の太さ', unit: '倍', min: 0.7, max: 1.2, step: 0.01, neutral: 1, tool: 'arm', scale: 1},
  {key: 'waist', label: '腰回り', unit: '倍', min: 0.8, max: 1.2, step: 0.01, neutral: 1, tool: 'waist', scale: 1},
  {key: 'leg', label: '脚の太さ', unit: '倍', min: 0.7, max: 1.2, step: 0.01, neutral: 1, tool: 'leg', scale: 1},
];
export const BODY_NEUTRAL = Object.fromEntries(BODY_FIELDS.map(f => [f.key, f.neutral]));

const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n;

// 画面・API の体型の値を確かめる。省いた鍵は変えない。誤りは Error(呼び出し側が bad-input にする)
export function checkBody(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('体型は {頭の大きさ などの鍵: 数} で渡す');
  const out = {...BODY_NEUTRAL};
  for (const [k, v] of Object.entries(body)) {
    const f = BODY_FIELDS.find(x => x.key === k);
    if (!f) throw Error(`体型の鍵 ${k} は無い(${BODY_FIELDS.map(x => x.key).join('、')})`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < f.min || v > f.max) throw Error(`${f.label}は ${f.min} から ${f.max}${f.unit === '倍' ? ' 倍' : ' ' + f.unit}`);
    out[k] = round(v);
  }
  return out;
}

export const bodyChanged = body => BODY_FIELDS.some(f => Math.abs((body?.[f.key] ?? f.neutral) - f.neutral) > 1e-9);

// body_shape.py の引数。変える値だけ
export const bodyArgs = body => BODY_FIELDS.filter(f => Math.abs(body[f.key] - f.neutral) > 1e-9).flatMap(f => ['--' + f.tool, String(round(body[f.key] * f.scale, 5))]);

const fmt = (f, v) => f.unit === '倍' ? `${v.toFixed(2)} 倍` : `${v > 0 ? '+' : ''}${v.toFixed(1)} cm`;
// 変えた値の 1 行(版の「変えたこと」の下書き)。例「頭の大きさ 0.94 倍、肩幅(片側) -1.2 cm」
export const bodySummary = body => BODY_FIELDS.filter(f => Math.abs((body[f.key] ?? f.neutral) - f.neutral) > 1e-9).map(f => `${f.label} ${fmt(f, body[f.key])}`).join('、');

// ---- 揺れもの ----

// 組の種類。上から順に、spring の名前と最初の joint の節点の名前に当てる。語は単語の頭でだけ当てる(CoatSkirt はスカートではなく上着のすそ)
const word = s => new RegExp(`(?:^|[^a-z])(?:${s})`, 'i');
export const SPRING_KINDS = [
  {key: 'coat', label: '上着のすそ', re: word('coat|jacket|tops|parka|hood')},
  {key: 'bust', label: '胸', re: word('bust|breast')},
  {key: 'hair', label: '髪', re: /髪|前髪|(?:^|[^a-z])(?:hair|bang|ahoge|fringe|ponytail|twintail|braid|sidelock)/i},
  {key: 'skirt', label: 'スカート', re: /スカート|(?:^|[^a-z])skirt/i},
  {key: 'sleeve', label: '袖', re: /袖|(?:^|[^a-z])(?:sleeve|cuff)/i},
  {key: 'ribbon', label: 'リボン', re: /リボン|(?:^|[^a-z])(?:ribbon|bow(?!l)|necktie|tie(?!r))/i},
  {key: 'tail', label: 'しっぽ', re: /しっぽ|尻尾|(?:^|[^a-z])tail/i},
  {key: 'ear', label: '耳', re: /(?:^|[^a-z])ear(?!ring)|耳/i},
  {key: 'cloth', label: '布', re: /布|(?:^|[^a-z])(?:flap|cloth|apron|cape|mantle|scarf|shawl|veil)/i},
  {key: 'accessory', label: '飾り', re: /(?:^|[^a-z])(?:acc|accessory|chain|strap|belt|charm|earring|tassel)/i},
];
export const OTHER_KIND = {key: 'other', label: 'その他'};

// 揺れの値。stiffness: 揺れにくさ、dragForce: 止まりやすさ、gravityPower: 重さ(下へ引く力)
export const SPRING_FIELDS = [
  {key: 'stiffness', label: '揺れにくさ', min: 0, max: 4, step: 0.05, limit: 10, hint: '大きいほど元の形へ早く戻る'},
  {key: 'dragForce', label: '止まりやすさ', min: 0, max: 1, step: 0.01, limit: 1, hint: '大きいほど揺れがすぐ止まる'},
  {key: 'gravityPower', label: '重さ', min: 0, max: 2, step: 0.05, limit: 10, hint: '大きいほど下へ垂れる'},
];

export function springKind(spring, nodes) {
  const first = nodes?.[spring.joints?.[0]?.node]?.name ?? '';
  const text = `${spring.name ?? ''} ${first}`;
  return SPRING_KINDS.find(k => k.re.test(text)) ?? OTHER_KIND;
}

const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// glTF の JSON から揺れものの組を作る。組は SPRING_KINDS の順(その他は最後)。
// [{key, label, springs: [spring の番号], count: spring の数, joints: [{node, name, stiffness, dragForce, gravityPower}], values: {各値の中央値}}]
export function springGroups(json) {
  const springs = json?.extensions?.VRMC_springBone?.springs ?? [], nodes = json?.nodes ?? [];
  const groups = new Map();
  springs.forEach((s, i) => {
    const kind = springKind(s, nodes);
    if (!groups.has(kind.key)) groups.set(kind.key, {key: kind.key, label: kind.label, springs: [], joints: []});
    const g = groups.get(kind.key);
    g.springs.push(i);
    for (const j of s.joints ?? []) g.joints.push({node: j.node, name: nodes[j.node]?.name ?? '', stiffness: j.stiffness ?? 1, dragForce: j.dragForce ?? 0.5, gravityPower: j.gravityPower ?? 0});
  });
  const order = [...SPRING_KINDS, OTHER_KIND].map(k => k.key);
  return [...groups.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    .map(g => ({...g, count: g.springs.length, values: Object.fromEntries(SPRING_FIELDS.map(f => [f.key, round(median(g.joints.map(j => j[f.key])), 3)]))}));
}

// 組の値(画面のつまみ)から joint ごとの値を決める。組の中の差(根元が硬く先が柔らかい、など)を保つため、元の中央値が 0 でなければ
// 比で掛け、0 なら値をそのまま入れる。範囲は SPRING_FIELDS の limit で切る。答え: {節点の番号: {stiffness, dragForce, gravityPower}}
export function springJointValues(group, values) {
  const out = {};
  for (const j of group.joints) {
    out[j.node] = Object.fromEntries(SPRING_FIELDS.map(f => {
      const want = values?.[f.key], rep = group.values[f.key];
      if (want == null) return [f.key, j[f.key]];
      const v = rep > 1e-6 ? j[f.key] * want / rep : want;
      return [f.key, round(Math.min(f.limit, Math.max(0, v)), 4)];
    }));
  }
  return out;
}

// 画面・API の揺れものの値を確かめる: {組の鍵: {stiffness?, dragForce?, gravityPower?}}。誤りは Error
export function checkSprings(springs = {}) {
  if (!springs || typeof springs !== 'object' || Array.isArray(springs)) throw Error('揺れものは {組の鍵: {stiffness, dragForce, gravityPower}} で渡す');
  const keys = [...SPRING_KINDS, OTHER_KIND].map(k => k.key), out = {};
  for (const [k, v] of Object.entries(springs)) {
    if (!keys.includes(k)) throw Error(`揺れものの組 ${k} は無い(${keys.join('、')})`);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error(`揺れもの ${k} の値は {stiffness, dragForce, gravityPower}`);
    out[k] = {};
    for (const [f, x] of Object.entries(v)) {
      const field = SPRING_FIELDS.find(s => s.key === f);
      if (!field) throw Error(`揺れもの ${k} の値 ${f} は無い(stiffness、dragForce、gravityPower)`);
      if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > field.limit) throw Error(`揺れもの ${k} の ${field.label}は 0 から ${field.limit}`);
      out[k][f] = round(x, 4);
    }
  }
  return out;
}

// 値が元と違う組だけ
export const springsChanged = (groups, springs) => groups.filter(g => springs?.[g.key] && SPRING_FIELDS.some(f => springs[g.key][f.key] != null && Math.abs(springs[g.key][f.key] - g.values[f.key]) > 1e-9));

// 変えた組の 1 行。例「髪 揺れにくさ 0.80→1.20」
export const springSummary = (groups, springs) => springsChanged(groups, springs).map(g =>
  `${g.label} ` + SPRING_FIELDS.filter(f => springs[g.key][f.key] != null && Math.abs(springs[g.key][f.key] - g.values[f.key]) > 1e-9)
    .map(f => `${f.label} ${g.values[f.key].toFixed(2)}→${springs[g.key][f.key].toFixed(2)}`).join('、')).join('。');

// glTF の JSON の VRMC_springBone を書き換える(JSON だけ。頂点と骨は変えない)。答え: 変えた joint の数
export function applySprings(json, springs) {
  const list = json?.extensions?.VRMC_springBone?.springs ?? [];
  let n = 0;
  for (const g of springsChanged(springGroups(json), springs)) {
    const vals = springJointValues(g, springs[g.key]);
    for (const i of g.springs) for (const j of list[i].joints) {
      const v = vals[j.node];
      if (!v) continue;
      Object.assign(j, v); n++;
    }
  }
  return n;
}
