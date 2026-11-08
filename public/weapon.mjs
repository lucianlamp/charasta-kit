// ビューアの武器: 手の骨に付ける見た目だけの武器。骨にも揺れにも触らない。
// 握る位置と向きは VRMA の剣の解き方(vrma-pipeline の sword_grip.py の fist_geometry)と同じで、指を閉じた拳の穴を通す。
// 大きさは身長に対する割合。計算は配列のままなので、ブラウザなしで試験できる。THREE は呼ぶ側が渡す。

// label: ボタンの文字。hand: 持つ手。both: もう一方の手が近いときは柄をその手の拳へ向ける。tilt: 柄が手のひらを斜めに横切る量
// 下の数は身長に対する割合で、length が全長、grip が握る位置から下端までの長さ。値は Explosive の FBX の武器を weapon_def.py で読んだもの
// (片手剣、杖、弓は素材の長さと握り。両手剣の素材は身長の 1.13 倍で床へ入るので縮めてある。tilt 0.2 は動画の剣の解き方と同じ)
export const WEAPONS = {
  none: {label: 'なし'},
  sword2h: {label: '両手剣', hand: 'right', both: true, tilt: 0.2, length: 0.74, grip: 0.14, hilt: 0.2, wide: 0.045},
  sword: {label: '片手剣', hand: 'right', tilt: 0.4, length: 0.6, grip: 0.055, hilt: 0.11, wide: 0.04},
  staff: {label: '杖', hand: 'right', tilt: 0.4, length: 0.68, grip: 0.25},
  bow: {label: '弓と矢', hand: 'left', tilt: 0.22, length: 0.95, grip: 0.475},
};
const ARROW = {length: 0.52, grip: 0};   // 弓のとき右手に持つ矢。指の向きへ伸びる

const FLEX = {Proximal: 75, Intermediate: 100, Distal: 65};   // 拳の指の曲がり(度)。sword_grip.py の FIST_FLEX と同じ
const JOINTS = ['Proximal', 'Intermediate', 'Distal'], FINGERS = ['Index', 'Middle', 'Ring', 'Little'];

const add = (a, b, k = 1) => a.map((x, i) => x + b[i] * k), sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0), len = a => Math.sqrt(dot(a, a)), unit = a => a.map(x => x / (len(a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// 休めの姿勢の手から握りを求める。rest: {hand, lowerArm, fingers: {Index: {Proximal: [x, y, z], ...}, ...}}(世界の座標、指は無くてもよい)、side: 'left' | 'right'
// tilt: 柄が手のひらを斜めに横切る量。答え: center(拳の穴の中心)、axis(柄の向き。小指から人差し指へ)、lie(拳が柄から寄る向き。指の方)、knuckle(中指の付け根)、fwd(指の向き)、palm(手のひらの向き)
export function handGrip(rest, side, tilt = 0.2) {
  const sign = side === 'left' ? 1 : -1, ok = FINGERS.every(f => JOINTS.every(j => rest.fingers?.[f]?.[j]));
  if (!ok) {   // 指の骨が無い体は、前腕の延長の手のひらの下を握る
    const fwd = unit(sub(rest.hand, rest.lowerArm)), reach = len(sub(rest.hand, rest.lowerArm));
    return {center: add(add(rest.hand, fwd, reach * 0.3), [0, -1, 0], reach * 0.1), axis: unit(cross(fwd, [0, sign, 0])), lie: fwd, knuckle: add(rest.hand, fwd, reach * 0.3), fwd, palm: [0, -1, 0]};
  }
  const fwd = unit(sub(rest.fingers.Middle.Proximal, rest.hand));
  let across = unit(sub(rest.fingers.Index.Proximal, rest.fingers.Little.Proximal));
  across = unit(add(across, fwd, -dot(across, fwd)));
  const palm = cross(fwd, across).map(x => x * sign), centres = [];
  for (const f of FINGERS) {
    const [a, b, c] = JOINTS.map(j => rest.fingers[f][j]), steps = [len(sub(b, a)), len(sub(c, b)), len(sub(c, b))];
    const pts = [a]; let flex = 0, at = a;
    steps.forEach((s, i) => {   // 手の面の中で指を順に曲げる
      flex += FLEX[JOINTS[i]] * Math.PI / 180;
      at = add(at, add(fwd.map(x => x * Math.cos(flex)), palm, Math.sin(flex)), s); pts.push(at);
    });
    centres.push(pts.reduce((s, p) => add(s, p, 1 / pts.length), [0, 0, 0]));
  }
  const axis = unit(add(across, fwd, tilt));
  return {center: centres.reduce((s, p) => add(s, p, 1 / centres.length), [0, 0, 0]), axis, lie: unit(add(fwd, axis, -dot(fwd, axis))), knuckle: rest.fingers.Middle.Proximal, fwd, palm};
}

// 武器の部品と、それぞれの手と置き方。hands: {left, right} は handGrip に渡す休めの姿勢の手
export function weaponParts(id, hands) {
  const w = WEAPONS[id];
  if (!w.hand) return [];
  const g = handGrip(hands[w.hand], w.hand, w.tilt), parts = [{id, hand: w.hand, center: g.center, axis: g.axis, lie: g.lie}];
  if (id === 'bow') {   // 素材の矢は手のひらの側へ少し傾く
    const r = handGrip(hands.right, 'right'), axis = unit(add(r.fwd, r.palm, 0.3));
    parts.push({id: 'arrow', hand: 'right', center: r.knuckle, axis, lie: unit(cross(axis, r.axis))});
  }
  return parts;
}

// 武器の見た目。座標は握る点が原点、+Y が刃先(杖の頭、弓の上端)、+X が刃の幅の向き(弓は的の方)
// height: 大きさの基準。hand: 柄の長さの基準。手の間隔は体が小さく見えても変わらないので、チビの体では height より大きい
export function buildWeapon(THREE, id, height, hand = height) {
  const w = WEAPONS[id] ?? ARROW, group = new THREE.Group(), L = w.length * height, below = w.grip * (w.hilt ? hand : height);
  group.name = 'weapon-' + id;
  const metal = new THREE.MeshStandardMaterial({color: 0xd5dbe3, metalness: 0.15, roughness: 0.4, flatShading: true});
  const dark = new THREE.MeshStandardMaterial({color: 0x3a2a20, roughness: 0.8}), gold = new THREE.MeshStandardMaterial({color: 0xc9a24a, metalness: 0.6, roughness: 0.4});
  const part = (geometry, material, y, x = 0) => { const m = new THREE.Mesh(geometry, material); m.position.set(x, y, 0); m.frustumCulled = false; group.add(m); return m; };
  if (id === 'sword' || id === 'sword2h') {
    const hilt = w.hilt * hand, wide = w.wide * height, thin = wide * 0.16, tip = wide * 1.6;
    const blade = L - w.hilt * height - tip, guard = -below + hilt, r = height * 0.009;
    part(new THREE.CylinderGeometry(r, r, hilt, 12), dark, -below + hilt / 2);
    part(new THREE.SphereGeometry(r * 1.9, 12, 8), gold, -below);
    part(new THREE.BoxGeometry(wide * 2.6, height * 0.012, height * 0.022), gold, guard);
    part(new THREE.CylinderGeometry(1, 1, blade, 4).scale(wide / 2, 1, thin), metal, guard + blade / 2);
    part(new THREE.ConeGeometry(1, tip, 4).scale(wide / 2, 1, thin), metal, guard + blade + tip / 2);
  } else if (id === 'staff') {
    const r = height * 0.0105;
    part(new THREE.CylinderGeometry(r, r * 0.8, L, 12), dark, L / 2 - below);
    part(new THREE.TorusGeometry(height * 0.03, r * 0.5, 8, 20), gold, L - below + height * 0.015);
    part(new THREE.OctahedronGeometry(height * 0.019), new THREE.MeshStandardMaterial({color: 0x53b8e8, emissive: 0x124a66, roughness: 0.25, flatShading: true}), L - below + height * 0.015);
  } else if (id === 'bow') {
    const half = L / 2, back = L * 0.11, curve = new THREE.CatmullRomCurve3([[-back, -half], [-back * 0.3, -half * 0.55], [0, 0], [-back * 0.3, half * 0.55], [-back, half]].map(([x, y]) => new THREE.Vector3(x, y, 0)));
    part(new THREE.TubeGeometry(curve, 40, height * 0.008, 8), dark, 0);
    part(new THREE.CylinderGeometry(height * 0.0012, height * 0.0012, L, 6), new THREE.MeshStandardMaterial({color: 0xe8e4d8}), 0, -back);
  } else if (id === 'arrow') {
    const r = height * 0.0035, tip = height * 0.03;
    part(new THREE.CylinderGeometry(r, r, L - tip, 8), dark, (L - tip) / 2);
    part(new THREE.ConeGeometry(r * 2.4, tip, 4), metal, L - tip / 2);
    part(new THREE.BoxGeometry(height * 0.022, height * 0.05, height * 0.001), new THREE.MeshStandardMaterial({color: 0xd9d4c8}), height * 0.03);
  }
  return group;
}
