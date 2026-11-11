// VRM 1.0 の meta(作者と利用条件)を、ゲーム用の書き出しで埋める(docs/game-export.md の「meta」)。
// 値の出どころは 3 つ。character.json の vrmMeta(ユーザーが入れた値)、バージョンの model.vrm の meta(仮の値を除く)、記録(キャラの name、バージョンの ID)か VRM 1.0 の既定値。
// 作者名は vrmMeta か model.vrm にあるものだけを使い、無ければ作らずに「未記入」を書いて missing に載せる。
export const PLACEHOLDER = '__CHARAKIT_REVIEW__';
export const DEFAULT_LICENSE_URL = 'https://vrm.dev/licenses/1.0/';

// 画面と PATCH /api/characters/<id> の vrmMeta が受け取る欄。値は列挙か型
export const USAGE_FIELDS = {
  commercialUsage: ['personalNonProfit', 'personalProfit', 'corporation'],
  allowRedistribution: 'boolean',
  modification: ['prohibited', 'allowModification', 'allowModificationRedistribution'],
  avatarPermission: ['onlyAuthor', 'everyone', 'explicitlyLicensedPerson'],
  creditNotation: ['required', 'unnecessary'],
  licenseUrl: 'url',
};
export const META_KEYS = ['authors', ...Object.keys(USAGE_FIELDS)];
// VRM 1.0 の既定値のうち、最も制限の強い側
export const DEFAULT_USAGE = {commercialUsage: 'personalNonProfit', allowRedistribution: false, modification: 'prohibited', avatarPermission: 'onlyAuthor', creditNotation: 'required', licenseUrl: DEFAULT_LICENSE_URL};
export const NO_AUTHOR = '未記入';

export const isPlaceholder = v => (typeof v === 'string' && v.includes(PLACEHOLDER)) || (Array.isArray(v) && v.some(isPlaceholder));
const PLACEHOLDER_NAME = {name: 'Motion review', version: 'undefined'};
const usable = v => v != null && v !== '' && !(Array.isArray(v) && !v.length) && !isPlaceholder(v);

// character.json の vrmMeta を確かめて、きれいにして返す。null と空は null(消す)。誤りは Error(呼び出し側が bad-input にする)
export function checkVrmMeta(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('vrmMeta は連想配列');
  const bad = Object.keys(v).filter(k => !META_KEYS.includes(k));
  if (bad.length) throw new Error(`vrmMeta に入れられない項目: ${bad.join(', ')}（入れてよいのは ${META_KEYS.join(' / ')}）`);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (val == null) continue;
    if (k === 'authors') {
      if (!Array.isArray(val) || val.length > 8 || val.some(a => typeof a !== 'string')) throw new Error('authors は文字列の配列（8 人まで）');
      const names = val.map(a => a.trim()).filter(Boolean);
      if (names.some(a => a.length > 100)) throw new Error('authors の名前は 100 文字まで');
      if (isPlaceholder(names)) throw new Error('authors に仮の値は入れられない');
      if (names.length) out.authors = names;
    } else if (USAGE_FIELDS[k] === 'boolean') {
      if (typeof val !== 'boolean') throw new Error(`${k} は true か false`);
      out[k] = val;
    } else if (USAGE_FIELDS[k] === 'url') {
      if (typeof val !== 'string' || !/^https?:\/\/\S{1,290}$/.test(val.trim())) throw new Error(`${k} は http(s) の URL`);
      out[k] = val.trim();
    } else {
      if (!USAGE_FIELDS[k].includes(val)) throw new Error(`${k} は ${USAGE_FIELDS[k].join(' / ')}`);
      out[k] = val;
    }
  }
  return Object.keys(out).length ? out : null;
}

// json の VRMC_vrm.meta を埋める(json を書き換える)。戻りは {meta, sources, missing, defaulted}
//   sources: 欄ごとの出どころ(vrmMeta / model / record / default)、missing: 作れなかった欄、defaulted: 既定値を書いた欄
export function fillMeta(json, {vrmMeta = null, charName = '', verId = ''} = {}) {
  const vrm = json.extensions?.VRMC_vrm;
  if (!vrm) throw new Error('VRMC_vrm が無い（VRM 1.0 ではない）');
  const base = vrm.meta ?? {}, mine = vrmMeta ?? {};
  const sources = {}, missing = [], defaulted = [];
  // 仮の値を含む欄は元の meta から落とす
  const meta = Object.fromEntries(Object.entries(base).filter(([k, v]) => !isPlaceholder(v) && !(k in PLACEHOLDER_NAME && v === PLACEHOLDER_NAME[k])));
  if (usable(mine.authors)) { meta.authors = mine.authors; sources.authors = 'vrmMeta'; }
  else if (usable(meta.authors)) sources.authors = 'model';
  else { meta.authors = [NO_AUTHOR]; sources.authors = 'default'; missing.push('authors'); }
  if (usable(meta.name)) sources.name = 'model';
  else { meta.name = charName || verId || NO_AUTHOR; sources.name = 'record'; }
  if (usable(meta.version)) sources.version = 'model';
  else { meta.version = verId || '1'; sources.version = 'record'; }
  for (const k of Object.keys(USAGE_FIELDS)) {
    if (mine[k] !== undefined) { meta[k] = mine[k]; sources[k] = 'vrmMeta'; }
    else if (meta[k] !== undefined) sources[k] = 'model';
    else { meta[k] = DEFAULT_USAGE[k]; sources[k] = 'default'; defaulted.push(k); }
  }
  vrm.meta = meta;
  return {meta, sources, missing, defaulted};
}
