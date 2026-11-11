// VRoid 形式の検査(docs/vroid-format.md)。VRM 1.0 の JSON だけを読み、VRoid Studio のモデルと中身の作りが同じかを項目ごとに確かめる。
// profileOf: VRM の JSON から、検査に使う形(メッシュ、材質の種類、キー、プリセット、骨、揺れもの、コライダー、MToon)を取り出す。
// referenceOf: 手本の VRM(VRoid 公式サンプル)の形を何体か受け、共通の値と範囲を手本にまとめる(studio/vroid/reference.json)。
// checkVroid: 形を手本と比べ、項目ごとに ok / warn / ng と理由を返す。

// 材質の名前から部品の種類を決める。VRoid の材質は N00_000_00_Face_00_SKIN (Instance) のような名前
export const PART_KINDS = ['FaceMouth', 'EyeWhite', 'EyeIris', 'EyeHighlight', 'EyeExtra', 'FaceEyeline', 'FaceEyelash', 'FaceBrow', 'FaceSkin', 'BodySkin', 'Cloth', 'HairBack', 'Hair'];
export const MATERIAL_RE = /^[NF]\d{2}_\d{3}(_\d{2})?_[A-Za-z]+_\d{2}_(SKIN|FACE|EYE|CLOTH|HAIR)(_\d{2})?$/;
export const cleanName = n => String(n ?? '').replace(/\s*\(Instance\)\s*$/, '');
export function partOf(materialName) {
  const n = cleanName(materialName);
  for (const k of ['FaceMouth', 'EyeWhite', 'EyeIris', 'EyeHighlight', 'EyeExtra', 'FaceEyeline', 'FaceEyelash', 'FaceBrow', 'HairBack']) if (n.includes(`_${k}_`)) return k;
  if (/_Face_\d{2}_SKIN$/.test(n)) return 'FaceSkin';
  if (/_Body_\d{2}_SKIN$/.test(n)) return 'BodySkin';
  if (/_CLOTH$/.test(n)) return 'Cloth';
  if (/_HAIR(_\d{2})?$/.test(n)) return 'Hair';
  return null;
}
// メッシュの名前の頭: Face (merged).baked → Face
// 頭の語のあとは数字、空白、点、終わりのどれか(Hairpin などを髪に数えない)
export const meshRole = name => (/^(Face|Body|Hair)\d*(?=[ .]|$)/.exec(String(name ?? '')) ?? [])[1] ?? null;
export const PRESETS = ['neutral', 'blink', 'blinkLeft', 'blinkRight', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh'];
// 揺れもののひもの種類。VRoid はひもの名前(VRM 0 の comment)を Hair、Skirt、Bust などにし、1.0 への変換で -<UUID> が付く
export const springKind = (name, first) => (/^(Hair|Skirt|Bust|Sleeve|TopsUpperArm|Hood|HoodString|Tie|Ribbon|Accessory)/.exec(String(name ?? '')) ?? [])[1]
  ?? (/^J_Sec_Hair/.test(first) ? 'Hair' : /Skirt/.test(first) ? 'Skirt' : /Bust/.test(first) ? 'Bust' : 'Other');

const round = (x, d = 4) => (typeof x === 'number' ? +x.toFixed(d) : x);

export function profileOf(js) {
  const vrm = js.extensions?.VRMC_vrm, sb = js.extensions?.VRMC_springBone, nodes = (js.nodes ?? []).map(n => n.name ?? '');
  const acc = i => js.accessors?.[i];
  const meshes = (js.meshes ?? []).map(m => {
    const prims = (m.primitives ?? []).map(p => ({material: cleanName(js.materials?.[p.material]?.name), tris: Math.round((p.indices != null ? acc(p.indices)?.count : acc(p.attributes?.POSITION)?.count) / 3) || 0}));
    return {name: m.name ?? '', role: meshRole(m.name), tris: prims.reduce((t, p) => t + p.tris, 0), morphs: m.extras?.targetNames ?? m.primitives?.[0]?.extras?.targetNames ?? [], materials: [...new Set(prims.map(p => p.material))]};
  });
  const materials = (js.materials ?? []).map(m => {
    const mt = m.extensions?.VRMC_materials_mtoon;
    return {name: cleanName(m.name), part: partOf(m.name), alpha: m.alphaMode ?? 'OPAQUE', mtoon: mt ? {shift: round(mt.shadingShiftFactor ?? 0), toony: round(mt.shadingToonyFactor ?? 0.9), outlineMode: mt.outlineWidthMode ?? 'none', outlineWidth: round(mt.outlineWidthFactor ?? 0, 6), rimFresnel: round(mt.parametricRimFresnelPowerFactor ?? 5), rimLift: round(mt.parametricRimLiftFactor ?? 0), gi: round(mt.giEqualizationFactor ?? 0.9)} : null};
  });
  const meshOfNode = n => js.meshes?.[js.nodes?.[n]?.mesh];
  const presets = Object.fromEntries(PRESETS.map(p => {
    const e = vrm?.expressions?.preset?.[p];
    return [p, (e?.morphTargetBinds ?? []).map(b => ({key: (meshOfNode(b.node)?.extras?.targetNames ?? [])[b.index], weight: round(b.weight, 3), mesh: meshRole(meshOfNode(b.node)?.name)}))];
  }));
  const human = Object.fromEntries(Object.entries(vrm?.humanoid?.humanBones ?? {}).map(([k, v]) => [k, nodes[v.node]]));
  const springs = (sb?.springs ?? []).map(s => {
    const first = nodes[s.joints?.[0]?.node] ?? '', j0 = s.joints?.[0] ?? {};
    return {name: s.name ?? '', kind: springKind(s.name, first), joints: (s.joints ?? []).map(j => nodes[j.node]), stiffness: round(j0.stiffness ?? 1), drag: round(j0.dragForce ?? 0.5), gravity: round(j0.gravityPower ?? 0), radius: round(j0.hitRadius ?? 0), colliderGroups: s.colliderGroups?.length ?? 0};
  });
  const colliders = {};
  for (const c of sb?.colliders ?? []) { const n = nodes[c.node]; colliders[n] = (colliders[n] ?? 0) + 1; }
  return {vrm: vrm ? '1.0' : js.extensions?.VRM ? '0.0' : null, meshes, materials, presets, human, lookAt: vrm?.lookAt?.type ?? null,
    adjust: nodes.filter(n => /^J_Adj_/.test(n)), secondary: nodes.filter(n => /^J_Sec_/.test(n)), springs, colliders,
    tris: meshes.reduce((t, m) => t + m.tris, 0), images: (js.images ?? []).length};
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const span = xs => (xs.length ? [Math.min(...xs), Math.max(...xs)] : null);

// 手本は 1.26 の AvatarSample A、B、C を想定する。キーと骨の名前は全員で同じであることを確かめてから使う
export function referenceOf(profiles, from = []) {
  const [first] = profiles;
  const face = p => p.meshes.find(m => m.role === 'Face');
  const morphs = face(first)?.morphs ?? [];
  for (const p of profiles) if (JSON.stringify(face(p)?.morphs) !== JSON.stringify(morphs)) throw new Error('手本どうしで Fcl のキーが違う');
  const presets = Object.fromEntries(PRESETS.map(k => [k, first.presets[k].map(b => b.key)]));
  const human = first.human;
  for (const p of profiles) for (const [k, v] of Object.entries(p.human)) if (human[k] && human[k] !== v) throw new Error(`手本どうしで骨の名前が違う: ${k}`);
  const colliders = {};
  for (const p of profiles) for (const [n, c] of Object.entries(p.colliders)) colliders[n] = Math.max(colliders[n] ?? 0, c);
  const mtoon = {};
  for (const kind of PART_KINDS) {
    const ms = profiles.flatMap(p => p.materials.filter(m => m.part === kind && m.mtoon).map(m => m.mtoon));
    if (ms.length) mtoon[kind] = Object.fromEntries(['shift', 'toony', 'outlineWidth', 'rimFresnel', 'rimLift', 'gi'].map(f => [f, median(ms.map(m => m[f]))]).concat([['outlineMode', ms[0].outlineMode]]));
  }
  const springs = {};
  for (const kind of ['Hair', 'Skirt', 'Bust', 'Sleeve', 'TopsUpperArm']) {
    const ss = profiles.flatMap(p => p.springs.filter(s => s.kind === kind));
    if (ss.length) springs[kind] = {stiffness: span(ss.map(s => s.stiffness)), drag: span(ss.map(s => s.drag)), gravity: span(ss.map(s => s.gravity)), radius: span(ss.map(s => s.radius)), joints: span(ss.map(s => s.joints.length))};
  }
  return {from, morphs, presets, human, adjust: [...new Set(profiles.flatMap(p => p.adjust))], lookAt: first.lookAt, colliders, mtoon, springs,
    facePartsRequired: ['FaceMouth', 'EyeIris', 'EyeHighlight', 'FaceSkin'], tris: span(profiles.map(p => p.tris))};
}

const item = (id, label, level, detail) => ({id, label, level, detail});
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

export function checkVroid(p, ref) {
  const out = [];
  // 1. メッシュは Face、Body、Hair の 3 つ
  const roles = p.meshes.map(m => m.role), extra = p.meshes.filter(m => !m.role).map(m => m.name);
  const missing = ['Face', 'Body', 'Hair'].filter(r => !roles.includes(r));
  const twice = ['Face', 'Body', 'Hair'].filter(r => roles.filter(x => x === r).length > 1);
  out.push(item('meshes', 'メッシュは Face・Body・Hair の 3 つ', missing.length ? 'ng' : extra.length || twice.length ? 'warn' : 'ok',
    missing.length ? `無い: ${missing.join('、')}` : twice.length ? `同じ役のメッシュが 2 つ以上: ${twice.join('、')}${extra.length ? `、ほかのメッシュ: ${extra.join('、')}` : ''}` : extra.length ? `ほかのメッシュ: ${extra.join('、')}` : p.meshes.map(m => `${m.name} ${m.tris}`).join('、')));
  // 2. 材質の名前と置き場所
  const badName = p.materials.filter(m => !MATERIAL_RE.test(m.name)).map(m => m.name);
  out.push(item('material-names', '材質の名前が VRoid の決まり（N00_000_00_Face_00_SKIN など）', badName.length ? 'ng' : 'ok', badName.length ? `合わない: ${badName.slice(0, 8).join('、')}${badName.length > 8 ? ` ほか ${badName.length - 8}` : ''}` : `${p.materials.length} 個`));
  const where = {Face: ['FaceMouth', 'EyeWhite', 'EyeIris', 'EyeHighlight', 'EyeExtra', 'FaceEyeline', 'FaceEyelash', 'FaceBrow', 'FaceSkin'], Body: ['BodySkin', 'Cloth', 'HairBack'], Hair: ['Hair']};
  const misplaced = p.meshes.filter(m => m.role).flatMap(m => m.materials.filter(n => { const k = partOf(n); return k && !where[m.role].includes(k); }).map(n => `${n} が ${m.role}`));
  out.push(item('material-place', '部品の材質が決まったメッシュにある（顔の部品は Face、服と体は Body、髪は Hair）', misplaced.length ? 'ng' : 'ok', misplaced.join('、') || 'すべて合う'));
  // 3. 顔の部品
  const faceMesh = p.meshes.find(m => m.role === 'Face'), faceParts = new Set((faceMesh?.materials ?? []).map(partOf));
  const lack = ref.facePartsRequired.filter(k => !faceParts.has(k));
  out.push(item('face-parts', '顔の部品の板（口の中、虹彩、ハイライト、顔の肌）', lack.length ? 'ng' : 'ok', lack.length ? `無い: ${lack.join('、')}` : [...faceParts].join('、')));
  // 4. Fcl のキー
  const morphs = faceMesh?.morphs ?? [], miss = ref.morphs.filter(k => !morphs.includes(k)), more = morphs.filter(k => !ref.morphs.includes(k));
  const sameOrder = JSON.stringify(morphs) === JSON.stringify(ref.morphs);
  out.push(item('fcl-keys', `Face のシェイプキーが VRoid の ${ref.morphs.length} 個と同じ名前と順`, miss.length ? 'ng' : !sameOrder || more.length ? 'warn' : 'ok',
    miss.length ? `無い ${miss.length} 個: ${miss.slice(0, 10).join('、')}${miss.length > 10 ? ' …' : ''}` : more.length ? `余分: ${more.join('、')}` : !sameOrder ? '順が違う' : `${morphs.length} 個`));
  // 5. プリセット
  const badPreset = PRESETS.filter(k => { const want = ref.presets[k] ?? [], got = p.presets[k] ?? []; return got.length !== want.length || want.some((key, i) => got[i]?.key !== key || got[i]?.weight !== 1 || got[i]?.mesh !== 'Face'); });
  out.push(item('presets', '表情の 14 プリセットが Fcl のキーを 1 つずつ 100% で呼ぶ', badPreset.length ? 'ng' : 'ok', badPreset.length ? `合わない: ${badPreset.map(k => `${k}(${(p.presets[k] ?? []).map(b => b.key).join('+') || '無し'})`).join('、')}` : '14 個'));
  // 6. 視線
  const eyes = ['leftEye', 'rightEye'].map(k => p.human[k]), eyeOk = eyes.every(n => ref.adjust.includes(n));
  out.push(item('look-at', '視線は目の骨(J_Adj_L/R_FaceEye)の回転', p.lookAt === ref.lookAt && eyeOk ? 'ok' : 'ng', `lookAt ${p.lookAt ?? '無し'}、目の骨 ${eyes.map(n => n ?? '無し').join('・')}`));
  // 7. 骨の名前
  const badBones = Object.entries(ref.human).filter(([k, v]) => p.human[k] && p.human[k] !== v).map(([k, v]) => `${k}: ${p.human[k]}（手本 ${v}）`);
  const lackBones = Object.keys(ref.human).filter(k => !p.human[k]);
  out.push(item('bones', 'Humanoid の骨の名前が J_Bip（手本と同じ）', badBones.length ? 'ng' : lackBones.length ? 'warn' : 'ok', badBones.length ? badBones.slice(0, 6).join('、') + (badBones.length > 6 ? ` ほか ${badBones.length - 6}` : '') : lackBones.length ? `無い骨: ${lackBones.join('、')}` : `${Object.keys(p.human).length} 本`));
  // 8. 揺れ骨
  const joints = p.springs.flatMap(s => s.joints), notSec = [...new Set(joints.filter(n => !/^J_Sec_/.test(n)))];
  const hair = p.springs.filter(s => s.kind === 'Hair');
  out.push(item('spring-names', '揺れ骨の名前が J_Sec_（髪は J_Sec_Hair）', notSec.length ? 'ng' : hair.length ? 'ok' : 'warn', notSec.length ? `J_Sec_ でない ${notSec.length} 本: ${notSec.slice(0, 6).join('、')}` : `ひも ${p.springs.length}（髪 ${hair.length}）`));
  const off = [];
  for (const s of p.springs) {
    const r = ref.springs[s.kind]; if (!r) continue;
    for (const f of ['stiffness', 'drag', 'gravity']) if (s[f] < r[f][0] - 0.05 || s[f] > r[f][1] + 0.05) off.push(`${s.kind} ${s.joints[0]} の ${f} ${s[f]}（手本 ${r[f].join('〜')}）`);
  }
  out.push(item('spring-values', '揺れものの硬さ、抵抗、重力が手本の範囲', off.length ? 'warn' : 'ok', off.slice(0, 6).join('、') + (off.length > 6 ? ` ほか ${off.length - 6}` : '') || '範囲内'));
  // 9. コライダー
  const collLack = Object.entries(ref.colliders).filter(([n]) => !p.colliders[n]).map(([n]) => n);
  const collDiff = Object.entries(ref.colliders).filter(([n, c]) => p.colliders[n] && p.colliders[n] !== c).map(([n, c]) => `${n} ${p.colliders[n]}（手本 ${c}）`);
  const legs = collLack.every(n => /UpperLeg/.test(n));
  out.push(item('colliders', 'コライダーの骨と球の数が手本と同じ', collLack.length && !legs ? 'ng' : collLack.length || collDiff.length ? 'warn' : 'ok',
    [collLack.length ? `無い: ${collLack.join('、')}` : '', collDiff.length ? `数が違う: ${collDiff.join('、')}` : ''].filter(Boolean).join('。') || `${Object.keys(p.colliders).length} 本の骨`));
  // 10. MToon
  const mdiff = [];
  for (const m of p.materials) {
    const r = ref.mtoon[m.part]; if (!r || !m.mtoon) continue;
    if (!near(m.mtoon.shift, r.shift, 0.1)) mdiff.push(`${m.name} の影の位置 ${m.mtoon.shift}（手本 ${r.shift}）`);
    if (!near(m.mtoon.toony, r.toony, 0.1)) mdiff.push(`${m.name} の影のぼかし ${m.mtoon.toony}（手本 ${r.toony}）`);
  }
  const noMtoon = p.materials.filter(m => !m.mtoon).map(m => m.name);
  out.push(item('mtoon', 'MToon の影の値が VRoid と同じ（輪郭線は見ない）', noMtoon.length ? 'ng' : mdiff.length ? 'warn' : 'ok', noMtoon.length ? `MToon でない: ${noMtoon.join('、')}` : mdiff.slice(0, 6).join('、') + (mdiff.length > 6 ? ` ほか ${mdiff.length - 6}` : '') || 'すべて近い'));
  // 11. 三角形の数
  const top = ref.tris[1];
  out.push(item('triangles', `三角形の数が VRoid と同じくらい（手本 ${ref.tris.join('〜')}）`, p.tris <= top * 1.5 ? 'ok' : 'warn', `${p.tris}`));
  return out;
}

export const summary = items => ({ok: items.filter(i => i.level === 'ok').length, warn: items.filter(i => i.level === 'warn').length, ng: items.filter(i => i.level === 'ng').length, total: items.length});
