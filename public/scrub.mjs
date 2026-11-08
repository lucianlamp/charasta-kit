// 再生のバーのつまみ。つまみを握っている間はビューアを止めて(hold)、動かすたびにその時刻の姿勢へ置く。離したら、握る前の再生か停止へ戻す。
// 握り始めと終わりは pointer だけに頼らない: iPhone の Safari では pointerdown が来ないことがあるので、最初の input でも握る。
// 離すのは change、pointerup、touchend のどれか早いもの(縦に流れて pointercancel や touchcancel になっても戻る)。
// viewer() は window.viewer(読み込み前は null)を返す。show(秒) は時刻の表示を直す。
export function attachScrub(range, viewer, show) {
  let held = false, resume = false;
  const grab = () => {
    const v = viewer();
    if (held || !v) return;
    held = true; resume = !!v.hold; v.hold = true;
    for (const t of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) globalThis.addEventListener?.(t, release, {once: true});
  };
  function release() {
    if (!held) return;
    held = false;
    const v = viewer();
    if (v) v.hold = resume;
  }
  range.addEventListener('pointerdown', grab);
  range.addEventListener('touchstart', grab, {passive: true});
  range.addEventListener('input', () => {
    grab();
    const t = Number(range.value);
    viewer()?.seek(t);
    show(t);
  });
  for (const t of ['change', 'pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur']) range.addEventListener(t, release);
  return {get held() { return held; }, get playing() { return held ? !resume : null; }};
}
