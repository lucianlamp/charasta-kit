// 揺れ骨の刻み: 画面の 1 回の dt を、モーションを進める秒と揺れ骨を進める秒の組へ分ける。
// springParts(dt, rest, inGap) -> {parts: [{dt, spring}], rest, inGap, gap}
//   rest: 次の揺れの 1 歩までに済んだ秒、inGap: 前の dt も GAP_DT を超えた
//   parts を順に進める。spring 0 の組はモーションだけ。gap は揺れを続きから解かずに戻す印
// 1 回の dt を進める回数は SPRING_MAX までにする（1 回ごとに mixer、足の IK、vrm.update が走る）。
// 超えたら dt を等分する。そのコマの揺れは 1/60 秒の刻みより粗くなるが、遅い端末で処理が処理を呼ばない。
// GAP_DT を超える dt が続くときは、最初の 1 回だけ gap にする（処理の遅れで戻し続けないため）。
export const SPRING_DT = 1 / 60, SPRING_MAX = 3, GAP_DT = 0.25;
const EPS = 1e-9;

export function springParts(dt, rest = 0, inGap = false) {
  const over = dt > GAP_DT;
  if (over && !inGap) return {parts: [{dt, spring: 0}], rest: 0, inGap: true, gap: true};
  const n = Math.floor((rest + dt + EPS) / SPRING_DT);
  if (n > SPRING_MAX) {
    return {parts: Array.from({length: SPRING_MAX}, () => ({dt: dt / SPRING_MAX, spring: (rest + dt) / SPRING_MAX})), rest: 0, inGap: over, gap: false};
  }
  const parts = [];
  let left = dt, done = rest;
  for (let i = 0; i < n; i++) { const part = SPRING_DT - done; parts.push({dt: part, spring: SPRING_DT}); left -= part; done = 0; }
  if (left <= EPS && n) return {parts, rest: 0, inGap: over, gap: false};
  left = Math.max(left, 0);
  parts.push({dt: left, spring: 0});
  return {parts, rest: done + left, inGap: over, gap: false};
}
