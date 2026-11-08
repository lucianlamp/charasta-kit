// 接地中の足を床に留める IK（docs/foot-ik.md）。モーションはキャラ共通の VRMA なので、再生の前にキャラごとの計画を作る。
//   buildFootPlan: クリップを 1/30 秒ごとに当てて足の動きを読み、接地の区間と、毎コマの足首の目標・hips を下げる量を決める
//   applyFootPlan: 再生中の 1 コマで、その時刻の目標へ脚を 2 本の骨の IK で解く（時刻で引くので、飛ばしても繰り返しても同じ姿勢になる）
// 骨は正規化した骨（AnimationMixer が動かす骨）を直す。vrm.update の前に当て、揺れ骨は直した姿勢を見る。
// three は相対パスで読む（ブラウザでは importmap の three と同じ URL、Node のテストでもそのまま読める）。
import * as THREE from '../vendor/three.module.js';

export const FPS = 30;
const SIDES = ['left', 'right'];
// 横の情報（contacts.json）の信頼度: 入る値と出る値
const CONF_ENTER = 0.6, CONF_EXIT = 0.4;
// 足の高さと速さからの判定（脚の長さ 0.6 m の体の値。脚の長さに比例させる）: 接地の高さからの差（m）、水平の速さ（m/s）。
// 足を上げる高さは数 cm しかない動きが多く、振り出しの足も低いので、速さで見分ける
const LEG_UNIT = 0.6, HEIGHT_ENTER = 0.02, HEIGHT_EXIT = 0.035, SPEED_ENTER = 0.35, SPEED_EXIT = 0.5;
const FLOOR_MAX = 0.06;           // 床として認める高さの最大（同じく 0.6 m の体の値）。これより上で止まっている足は、足を上げたまま保つ動き
const MIN_ON = 4, MIN_ON_SIDECAR = 2, MAX_GAP = 2;   // 接地の区間の最短のコマ数（高さからの判定、横の情報。走りの接地は 3 コマほど）、埋める切れ目のコマ数
const BLEND = 6;                 // 接地の外で、足を元の動きへ戻すコマ数
const REACH = 0.99;              // 脚を伸ばしてよい長さ（上の骨 + 下の骨に対する割合）
const MAX_DROP = 0.05;           // hips を下げる最大（脚の長さに対する割合）
const DROP_SMOOTH = 5;           // hips を下げる量をならす幅（コマ）
const SEAM = 0.05;               // 最初と最後の足の差がこれ以下（脚の長さに対する割合）なら、継ぎ目のない繰り返しとして扱う
const SEAM_RAMP = 30;            // 接地のままの継ぎ目のずれを抜くコマ数
const MIN_BONE = 1e-4;           // これより短い骨は解けない（m）
const SIDECAR_SLACK = 3;         // 横の情報とクリップのコマの数の差の許容（これより違えば別の動きの情報）

// クリップのコマの数。長さは 1/30 秒の倍数より少しだけ短く入っていることがあるので、小さい値を足してから切り捨てる
const frameCount = duration => Math.floor(duration * FPS + 1e-3) + 1;

// 値が enter 以下で入り、exit を超えると出る（小さいほど接地に近い値を渡す）
export function hysteresis(values, enter, exit) {
  let on = false;
  return values.map(v => (on = on ? v <= exit : v <= enter));
}
// true の区間の [最初のコマ, 最後のコマ] の一覧
export function spansOf(on) {
  const spans = [];
  for (let i = 0, s = -1; i <= on.length; i++) {
    if (on[i] && s < 0) s = i;
    if (!on[i] && s >= 0) { spans.push([s, i - 1]); s = -1; }
  }
  return spans;
}
// maxGap コマ以下の切れ目を埋めてから、minOn コマ未満の区間を捨てる
export function cleanSpans(on, minOn = MIN_ON, maxGap = MAX_GAP) {
  const out = [...on], spans = spansOf(out);
  for (let k = 1; k < spans.length; k++) if (spans[k][0] - spans[k - 1][1] - 1 <= maxGap) out.fill(true, spans[k - 1][1], spans[k][0]);
  for (const [s, e] of spansOf(out)) if (e - s + 1 < minOn) out.fill(false, s, e + 1);
  return out;
}

// contacts.json（左右のかかと・爪先の信頼度 0〜1）から、足ごとの {heel, toe}（コマごとの true/false）を作る
export function contactsFromSidecar(sidecar, n) {
  const one = k => hysteresis(Array.from({length: n}, (_, i) => 1 - sidecar.frames[Math.min(i, sidecar.frames.length - 1)][k]), 1 - CONF_ENTER, 1 - CONF_EXIT);
  return {left: {heel: one(0), toe: one(1)}, right: {heel: one(2), toe: one(3)}};
}
// キャラに当てた足の高さと速さから判定する。heel・toe は {height: 休めの姿勢からの高さ（m）, speed: 水平の速さ（m/s）} のコマごとの配列、
// leg は脚の長さ（m）。接地の高さは、遅いコマの高さの中央の値（体つきで足が浮いたり沈んだりする分を除く）。
// 休めの姿勢から FLOOR_MAX より離れたコマは数えない（足を上げたまま保つ間を床と取り違えて、上げた足を床へ押し下げないため）
export function contactsFromHeight({heel, toe}, leg) {
  const k = leg / LEG_UNIT;
  const one = ({height, speed}) => {
    const slow = height.filter((h, i) => speed[i] <= SPEED_ENTER * k && Math.abs(h) <= FLOOR_MAX * k).sort((a, b) => a - b), floor = slow[slow.length >> 1] ?? 0;
    let on = false;
    return height.map((h, i) => {
      const d = Math.abs(h - floor);
      return (on = on ? d <= HEIGHT_EXIT * k && speed[i] <= SPEED_EXIT * k : d <= HEIGHT_ENTER * k && speed[i] <= SPEED_ENTER * k);
    });
  };
  return {heel: one(heel), toe: one(toe)};
}

// 2 本の骨の IK。股関節 hip、膝 knee、足首 ankle を、足首が target に来るように曲げる。
// 膝は今の曲がる面のまま曲げ伸ばしし、そのあと脚全体を股関節まわりに最小の回転で向ける。bend は膝が前へ曲がる軸（体の左）で、
// 脚がほぼまっすぐで面が定まらないとき（STRAIGHT 以下）はこの軸へ寄せる（わずかな曲がりの向きのまま曲げると、膝が後ろへ折れる）。
// 返す upper・lower はワールドの回転の差（左から掛ける）。脚の長さを超える target には届く所まで伸ばす。
const V = Array.from({length: 6}, () => new THREE.Vector3()), STRAIGHT = 0.15;
export function solveLeg(hip, knee, ankle, target, bend, out = {upper: new THREE.Quaternion(), lower: new THREE.Quaternion()}) {
  const [u, v, n, side, moved, ht] = V;
  u.subVectors(knee, hip); v.subVectors(ankle, knee);
  const l1 = u.length(), l2 = v.length();
  ht.subVectors(target, hip);
  const d = THREE.MathUtils.clamp(ht.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2);
  // 上の骨の延長と下の骨の間の角度（0 で脚がまっすぐ）
  const bendAngle = Math.PI - Math.acos(THREE.MathUtils.clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  n.crossVectors(u, v).divideScalar(l1 * l2);   // 長さは膝の曲がりの sin
  const sin = n.dot(bend);
  if (sin < STRAIGHT) n.addScaledVector(bend, STRAIGHT - sin);
  u.normalize(); n.addScaledVector(u, -n.dot(u)).normalize();
  side.crossVectors(n, u);
  moved.copy(u).multiplyScalar(Math.cos(bendAngle)).addScaledVector(side, Math.sin(bendAngle));   // 曲げたあとの下の骨の向き
  out.lower.setFromUnitVectors(v.normalize(), moved);
  moved.multiplyScalar(l2).addScaledVector(u, l1).normalize();
  out.upper.setFromUnitVectors(moved, ht.normalize());
  out.lower.premultiply(out.upper);
  return out;
}

// クリップを骨へ直接当てるための一覧（AnimationMixer を通さないので、再生中のアクションに触らない）
function clipSamplers(root, clip) {
  const out = [];
  for (const track of clip.tracks) {
    const {nodeName, propertyName} = THREE.PropertyBinding.parseTrackName(track.name);
    if (propertyName !== 'position' && propertyName !== 'quaternion') continue;
    const node = THREE.PropertyBinding.findNode(root, nodeName);
    if (node) out.push({node, prop: propertyName, at: track.createInterpolant()});
  }
  return out;
}
const smooth = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

// 1 本の足の毎コマの足首の目標。接地の区間は足を置いた点を留めて足の裏を床へ、区間の外は元の動きへ戻す。
// loop（継ぎ目のない繰り返し）は、最後のコマが最初のコマへつながるようにする
function footTargets(f, flags, n, minOn, loop) {
  const spans = spansOf(cleanSpans(flags.heel.map((h, i) => h || flags.toe[i]), minOn));
  const target = new Float32Array(n * 3);
  const put = (i, x, y, z) => { target[i * 3] = x; target[i * 3 + 1] = y; target[i * 3 + 2] = z; };
  const clearance = i => Math.min(f.ankleClear[i], f.toeClear[i]);
  // 足首と爪先の水平の差。かかとを上げて爪先で立つ間も、曲がって足の向きが変わる間も、足を置いた点は動かさず、足首をこの差の分だけ離す
  const reach = i => [f.toe[i].x - f.ankle[i].x, f.toe[i].z - f.ankle[i].z];
  for (const [s, e] of spans) {
    let heel = flags.heel[s], lx = heel ? f.ankle[s].x : f.toe[s].x, lz = heel ? f.ankle[s].z : f.toe[s].z;
    for (let i = s; i <= e; i++) {
      const wantHeel = flags.heel[i] || !flags.toe[i];
      if (wantHeel !== heel) {   // 足を置いた点をかかとと爪先で入れ替える（足首の目標はつながる）
        const [px, pz] = reach(i - 1), sign = wantHeel ? -1 : 1;
        lx += sign * px; lz += sign * pz; heel = wantHeel;
      }
      const [vx, vz] = reach(i);
      put(i, heel ? lx : lx - vx, f.ankle[i].y - clearance(i), heel ? lz : lz - vz);
    }
  }
  // 終わりまで続く接地の区間は、最後のコマが最初のコマの足の位置に来るように区間ごとずらす（留めた点は動かないので滑らない）。
  // クリップ全体が 1 つの区間なら最初のコマも同じ区間でずらせないので、終わりの SEAM_RAMP コマで少しずつ抜く
  const last = spans.at(-1), closes = loop && last?.[1] === n - 1;
  if (closes) {
    const [x0, z0] = spans[0][0] === 0 ? [target[0], target[2]] : [f.ankle[0].x, f.ankle[0].z];
    const dx = x0 - target[(n - 1) * 3], dz = z0 - target[(n - 1) * 3 + 2];
    const whole = last[0] === 0, start = whole ? Math.max(0, n - 1 - SEAM_RAMP) : last[0];
    for (let i = start; i < n; i++) {
      const w = whole ? smooth((i - start) / (n - 1 - start)) : 1;
      target[i * 3] += dx * w; target[i * 3 + 2] += dz * w;
    }
  }
  // 区間の外: 前の区間の終わりのずれを数コマで抜き、次の区間の始めのずれへ数コマで入る。足の裏が床より下なら上げる
  const offset = i => [target[i * 3] - f.ankle[i].x, target[i * 3 + 1] - f.ankle[i].y, target[i * 3 + 2] - f.ankle[i].z];
  const free = (a, b) => {
    const from = a > 0 ? offset(a - 1) : closes ? offset(n - 1) : [0, 0, 0];
    const to = b < n - 1 ? offset(b + 1) : loop && spans.length ? offset(0) : [0, 0, 0];
    const blend = Math.min(BLEND, Math.ceil((b - a + 1) / 2)) + 1;
    for (let i = a; i <= b; i++) {
      const w0 = 1 - smooth((i - a + 1) / blend), w1 = 1 - smooth((b - i + 1) / blend);
      const d = from.map((x, k) => x * w0 + to[k] * w1);
      put(i, f.ankle[i].x + d[0], f.ankle[i].y + Math.max(d[1], -clearance(i)), f.ankle[i].z + d[2]);
    }
  };
  let next = 0;
  for (const [s, e] of spans) { if (s > next) free(next, s - 1); next = e + 1; }
  if (next < n) free(next, n - 1);
  return {target, spans};
}

// 接地の情報（contacts.json の中身。無ければ null）とキャラの体から計画を作る。骨の姿勢は作る前の姿勢へ戻す
export function buildFootPlan(vrm, clip, sidecar = null) {
  const h = vrm.humanoid, node = name => h.getNormalizedBoneNode(name);
  const hips = node('hips'), legs = {};
  if (!hips) return null;
  for (const side of SIDES) {
    const b = {upper: node(side + 'UpperLeg'), lower: node(side + 'LowerLeg'), foot: node(side + 'Foot'), toes: node(side + 'Toes')};
    if (!b.upper || !b.lower || !b.foot) return null;
    legs[side] = b;
  }
  const saved = Object.values(h.normalizedHumanBones).map(({node: b}) => [b, b.position.clone(), b.quaternion.clone()]);
  const restore = () => { for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q); } hips.updateWorldMatrix(true, true); };
  const world = o => o.getWorldPosition(new THREE.Vector3());
  h.resetNormalizedPose(); hips.updateWorldMatrix(true, true);
  const rest = {};
  for (const side of SIDES) {
    const b = legs[side], a = world(b.upper), k = world(b.lower), c = world(b.foot);
    const thigh = a.distanceTo(k), shin = k.distanceTo(c);
    if (Math.min(thigh, shin) < MIN_BONE) { restore(); return null; }
    rest[side] = {ankleY: c.y, toeY: b.toes ? world(b.toes).y : c.y, length: thigh + shin};
  }
  const samplers = clipSamplers(vrm.scene, clip), n = frameCount(clip.duration);
  const feet = {};
  for (const side of SIDES) feet[side] = {ankle: [], toe: [], hip: [], ankleClear: [], toeClear: []};
  for (let i = 0; i < n; i++) {
    const t = Math.min(i / FPS, clip.duration);
    for (const s of samplers) s.node[s.prop].fromArray(s.at.evaluate(t));
    hips.updateWorldMatrix(true, true);
    for (const side of SIDES) {
      const b = legs[side], f = feet[side], ankle = world(b.foot), toe = b.toes ? world(b.toes) : ankle.clone();
      f.ankle.push(ankle); f.toe.push(toe); f.hip.push(world(b.upper));
      f.ankleClear.push(ankle.y - rest[side].ankleY); f.toeClear.push(toe.y - rest[side].toeY);
    }
  }
  restore();

  const speedOf = path => path.map((p, i) => { const q = path[Math.max(0, i - 1)]; return Math.hypot(p.x - q.x, p.z - q.z) * FPS; });
  const flags = sidecar ? contactsFromSidecar(sidecar, n) : Object.fromEntries(SIDES.map(side => {
    const f = feet[side];
    return [side, contactsFromHeight({heel: {height: f.ankleClear, speed: speedOf(f.ankle)}, toe: {height: f.toeClear, speed: speedOf(f.toe)}}, rest[side].length)];
  }));
  // 最初と最後の足の差が小さいモーションは、繰り返しの継ぎ目で足が跳ばないように目標を閉じる
  const loop = n > 1 && SIDES.every(side => {
    const f = feet[side], gap = SEAM * rest[side].length;
    return f.ankle[0].distanceTo(f.ankle[n - 1]) <= gap && f.toe[0].distanceTo(f.toe[n - 1]) <= gap;
  });
  const plan = {source: sidecar ? 'contacts' : 'height', fps: FPS, frames: n, loop, hips, legs, spans: {}, target: {}, drop: new Float32Array(n), maxDrop: 0, pulled: 0};
  for (const side of SIDES) {
    const r = footTargets(feet[side], flags[side], n, sidecar ? MIN_ON_SIDECAR : MIN_ON, loop);
    plan.target[side] = r.target; plan.spans[side] = r.spans;
  }
  limitReach(plan, feet, rest);
  return plan;
}

// 脚が届かないコマ: hips を少し下げ、それでも届かなければ目標を元の足の位置の方へ寄せる。
// 届く長さは REACH か、元の動きの脚の長さの大きい方（元の動きで伸び切っている脚を、それ以上縮めない）
function limitReach(plan, feet, rest) {
  const {frames: n, loop, target, drop} = plan, need = new Float32Array(n);
  const maxDrop = MAX_DROP * Math.min(rest.left.length, rest.right.length);
  const reach = (side, i) => Math.max(rest[side].length * REACH, feet[side].hip[i].distanceTo(feet[side].ankle[i]));
  for (let i = 0; i < n; i++) {
    for (const side of SIDES) {
      const R = reach(side, i), hip = feet[side].hip[i], t = target[side];
      const d2 = (hip.x - t[i * 3]) ** 2 + (hip.z - t[i * 3 + 2]) ** 2;
      const want = d2 >= R * R ? maxDrop : hip.y - t[i * 3 + 1] - Math.sqrt(R * R - d2);
      need[i] = Math.max(need[i], Math.min(maxDrop, want));
    }
  }
  // 前後の DROP_SMOOTH コマの最大をとってからならす（急に腰が落ちない）。繰り返しは最後のコマが最初のコマと同じ時刻なので、輪にして見る
  const ring = n - 1;
  const near = (a, i) => loop ? Array.from({length: DROP_SMOOTH * 2 + 1}, (_, k) => a[(i + k + (ring - 1) * DROP_SMOOTH) % ring])
    : a.subarray(Math.max(0, i - DROP_SMOOTH), i + DROP_SMOOTH + 1);
  const wide = need.map((_, i) => Math.max(...near(need, i)));
  for (let i = 0; i < n; i++) {
    const part = near(wide, i);
    drop[i] = part.reduce((a, b) => a + b, 0) / part.length;
    plan.maxDrop = Math.max(plan.maxDrop, drop[i]);
  }
  const p = new THREE.Vector3(), hip = new THREE.Vector3(), o = new THREE.Vector3(), m = new THREE.Vector3();
  for (const side of SIDES) {
    const t = target[side];
    for (let i = 0; i < n; i++) {
      const R = reach(side, i);
      hip.copy(feet[side].hip[i]); hip.y -= drop[i];
      p.fromArray(t, i * 3); o.copy(feet[side].ankle[i]);
      if (p.distanceTo(hip) <= R) continue;
      let lo = 0, hi = 1;   // 目標から元の足の位置へ、届く所までの割合
      for (let k = 0; k < 10; k++) { const c = (lo + hi) / 2; if (m.lerpVectors(p, o, c).distanceTo(hip) > R) lo = c; else hi = c; }
      p.lerp(o, hi).toArray(t, i * 3); plan.pulled++;
    }
  }
}

const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion(), qd = new THREE.Quaternion();
const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3(), pt = new THREE.Vector3(), bend = new THREE.Vector3();
const solved = {upper: new THREE.Quaternion(), lower: new THREE.Quaternion()};

// 計画の time 秒の姿勢へ脚を直す。weight 0〜1（クロスフェードの間は弱める）。
// 返す関数で骨を元へ戻す。AnimationMixer は値が変わらない骨を書き直さないので、直したままにすると次のコマの「元の動き」が崩れる。
export function applyFootPlan(plan, time, weight = 1) {
  if (!plan || weight <= 0) return null;
  const f = Math.min(Math.max(time, 0) * plan.fps, plan.frames - 1), i0 = Math.floor(f), i1 = Math.min(i0 + 1, plan.frames - 1), a = f - i0;
  const {hips, legs} = plan, y0 = hips.position.y, undo = [];
  hips.position.y -= (plan.drop[i0] * (1 - a) + plan.drop[i1] * a) * weight;
  // 脚がまっすぐなときの曲げる軸（体の左）。VRM 0 は hips の向きが体の向きと 180 度違うので、左右の脚の位置から求める
  bend.subVectors(legs.left.upper.getWorldPosition(pa), legs.right.upper.getWorldPosition(pb)).normalize();
  for (const side of SIDES) {
    const b = legs[side], t = plan.target[side];
    b.foot.updateWorldMatrix(true, false);
    b.upper.getWorldPosition(pa); b.lower.getWorldPosition(pb); b.foot.getWorldPosition(pc);
    pt.set(t[i0 * 3] * (1 - a) + t[i1 * 3] * a, t[i0 * 3 + 1] * (1 - a) + t[i1 * 3 + 1] * a, t[i0 * 3 + 2] * (1 - a) + t[i1 * 3 + 2] * a).lerp(pc, 1 - weight);
    if (pt.distanceToSquared(pc) < 1e-8) continue;
    undo.push([b.upper, b.upper.quaternion.clone()], [b.lower, b.lower.quaternion.clone()], [b.foot, b.foot.quaternion.clone()]);
    solveLeg(pa, pb, pc, pt, bend, solved);
    const parent = b.upper.parent.getWorldQuaternion(qa), upper = b.upper.getWorldQuaternion(qb), lower = b.lower.getWorldQuaternion(qc), foot = b.foot.getWorldQuaternion(qd);
    upper.premultiply(solved.upper); lower.premultiply(solved.lower);
    b.upper.quaternion.copy(parent).invert().multiply(upper);
    b.lower.quaternion.copy(upper).invert().multiply(lower);
    b.foot.quaternion.copy(lower).invert().multiply(foot);   // 足の向きは元の動きのまま
  }
  hips.updateWorldMatrix(false, true);
  return () => {
    hips.position.y = y0;
    for (const [node, q] of undo) node.quaternion.copy(q);
    hips.updateWorldMatrix(false, true);
  };
}

// 再生中のアクションの計画を順に当てる。layers: [{action, plan}]（フェードアウト中の前のアクション、今のアクションの順）。
// 重みは各アクションの今の重み（切り替えの間、前のアクションの直しが一度に消えて足が跳ばないように）。
// 返す関数は逆の順に骨を戻す（あとの計画は、前の計画が直した姿勢を覚えている）
export function applyFootLayers(layers) {
  const undos = [];
  for (const {action, plan} of layers) {
    const undo = applyFootPlan(plan, action.time, action.getEffectiveWeight());
    if (undo) undos.push(undo);
  }
  return () => { while (undos.length) undos.pop()(); };
}

// 横の情報がこのクリップのものとして使えるか。形、fps、コマの数を見る
const sidecarFits = (s, n) => s?.fps === FPS && Array.isArray(s.frames) && s.frames.length > 0 && Math.abs(s.frames.length - n) <= SIDECAR_SLACK
  && s.frames.every(c => Array.isArray(c) && c.length === 4 && c.every(x => Number.isFinite(x)));

// モーションの記録（/api/motions の 1 件）から計画を作る。その場のモーションは足が床を滑るのが動きそのものなので留めない。
// 横の情報が読めないか使えないときは、足の高さと速さの判定へ落とす（再生は止めない）
export async function footPlanFor(motion, vrm, clip) {
  // MotionBricks は generated.options.root、文章から作ったモーションは generated.root に書く(取り込み済みの記録は書き換えないので、読む側が両方を見る)
  if ((motion.generated?.root ?? motion.generated?.options?.root) === 'inplace') return null;
  const url = motion.contactsUrl;
  const sidecar = url ? await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null) : null;
  const usable = sidecarFits(sidecar, frameCount(clip.duration));
  if (url && !usable) console.warn(`${url} を使えないので、足の高さと速さで接地を判定する`);
  return buildFootPlan(vrm, clip, usable ? sidecar : null);
}
