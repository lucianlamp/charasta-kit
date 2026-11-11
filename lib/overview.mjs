// ライブラリの画面の集計(docs/screens.md): 4 工程の進み具合、完成モデル、判断待ちの依頼、きゃらくるのプロジェクトの進み具合。
// 記録に無いことは推測しない。出し方を変えるときは docs/screens.md の表も直す。
import fs from 'node:fs/promises';
import path from 'node:path';
import {EMOTIONS, isCreature} from './library.mjs';
import {readGlbJson} from './glb.mjs';

// glb の JSON チャンクだけを読んで、中身のある表情の名前を返す(モデル全体は読まない)。読めなければ空
export async function vrmExpressions(file) {
  try {
    const preset = (await readGlbJson(file)).extensions?.VRMC_vrm?.expressions?.preset ?? {};
    return Object.entries(preset).filter(([, d]) => d.morphTargetBinds?.length || d.materialColorBinds?.length || d.textureTransformBinds?.length).map(([k]) => k);
  } catch { return []; }
}

// 4 工程の進み具合。'done' できている、'doing' 途中、'none' まだ。adjusted は体型と揺れもの(adjust.json を持つバージョン)で作ったバージョンの数
export function stageProgress({versions, method = null, projects = 0, motions, expressions = [], studios = [], adjusted = 0}) {
  const emotions = EMOTIONS.filter(e => expressions.includes(e)).length;
  return {
    create: versions ? 'done' : method || projects ? 'doing' : 'none',
    motion: versions && motions ? 'done' : 'none',   // モーションは全キャラ共通なので、キャラごとに言えるのは当てられるかどうかだけ
    expression: emotions === EMOTIONS.length ? 'done' : emotions || studios.length ? 'doing' : 'none',
    // 仕上げ: 「バージョンにする」を押した、体型と揺れもので作ったバージョンがある、または表情づくりが 1 つも無く取り込んだバージョンをそのまま使う(残る作業が無い)なら done
    finish: studios.some(s => s.versions.length) || adjusted ? 'done' : studios.some(s => s.prototypes) ? 'doing' : !studios.length && versions ? 'done' : 'none',
  };
}

// 完成モデル: 仕上げで「バージョンにする」を押したバージョンと、最新バージョン。新しい順
export function finishedVersions(ch, studios) {
  const promoted = new Set(studios.flatMap(s => s.versions));
  return [...ch.versions].filter(v => promoted.has(v.id) || v.id === ch.latestVersion).sort((a, b) => (b.order ?? 0) - (a.order ?? 0))
    .map(v => ({id: v.id, kind: v.kind ?? 'vrm', label: v.label, note: v.note, thumb: v.thumb, model: v.model, modelLite: v.modelLite, creature: v.creature ?? null, sizeBytes: v.sizeBytes, promoted: promoted.has(v.id), latest: v.id === ch.latestVersion}));
}

// きゃらくるのプロジェクトの工程(project.json を読むだけ)。判定はキットの public/journey.mjs に合わせる
export function projectProgress(p) {
  const adopted = Object.values(p.imageLibrary?.slots ?? {}).filter(s => s.adopted).length;
  const weighted = p.mode === 'assembled' && ['weighted', 'springs'].includes(p.workflow?.phase);
  return [
    {key: 'images', label: '画像素材', done: adopted >= 8},
    {key: 'candidates', label: '3D 候補', done: ['head', 'body'].every(s => p.production?.candidates?.[s]?.length)},
    {key: 'materials', label: '素材化', done: p.production?.phase === 'assembled'},
    {key: 'rig', label: 'リグ', done: weighted},
    {key: 'springs', label: '揺れもの', done: weighted && p.workflow.phase === 'springs'},
    {key: 'vrm', label: 'VRM', done: !!p.reviewVRM},
  ];
}

export async function overview(lib, studio, {charakuruUrl}) {
  const [motions, list] = await Promise.all([lib.listMotions(), lib.listCharacters()]), chars = [], waiting = [];
  // キャラごとの読み込みは並べて進める(小さなファイルが多く、1 つずつ待つと遅い)。並びは listCharacters の順のまま
  const loaded = await Promise.all(list.map(({id}) => Promise.all([lib.getCharacter(id, {brief: true}), studio.list(id)])));
  for (const [i, {id}] of list.entries()) {
    const [ch, studios] = loaded[i];
    const latest = ch.versions.find(v => v.id === ch.latestVersion) ?? ch.versions.at(-1) ?? null;
    const projects = [...new Set([...ch.versions.map(v => v.source?.charakuruProject), ...studios.map(s => s.source?.type === 'charakuru' ? s.source.project : null)].filter(Boolean))];
    let adjusted = 0;   // 体型と揺れものの直しで作ったバージョンは adjust.json を持つ
    for (const v of ch.versions) if (await fs.access(path.join(lib.charDir(id), 'versions', v.id, 'adjust.json')).then(() => true, () => false)) adjusted++;
    const creature = isCreature(ch), expressions = latest && !creature ? await vrmExpressions(path.join(lib.charDir(id), 'versions', latest.id, 'model.vrm')) : [];
    chars.push({id, name: ch.name, note: ch.note, tags: ch.tags, style: ch.style, kind: creature ? 'creature' : 'vrm', creature: creature ? latest?.creature ?? null : null, method: ch.method ?? null, latest: latest && {id: latest.id, label: latest.label},
      thumb: latest?.thumb ?? [...ch.versions].reverse().find(v => v.thumb)?.thumb ?? null, versionCount: ch.versions.length, lineCount: ch.lines.length,
      stages: stageProgress({versions: ch.versions.length, method: ch.method, projects: projects.length, motions: motions.length, expressions, studios, adjusted}),
      finished: finishedVersions(ch, studios), projects,
      studios: studios.map(s => ({id: s.id, versions: s.versions, createdAt: s.createdAt})).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))});
    for (const s of studios) for (const r of (await studio.read(id, s.id)).requests) {
      if (r.state !== '候補あり') continue;
      const pending = r.candidates.filter(c => c.state === '候補');
      waiting.push({charId: id, charName: ch.name, studioId: s.id, requestId: r.id, step: r.step, text: r.text, target: r.target, candidates: pending.length, thumb: pending[0] ? studio.url(id, s.id, pending[0].file) : null});
    }
  }
  return {chars, waiting, motionCount: motions.length, charakuruUrl};
}
