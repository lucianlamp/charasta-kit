// モーションを作る画面(#motions/<キャラ>[/<バージョン>]/new。docs/screens.md)。左に区間の並びと「区間を追加」、中央にビューアと区間の時間の帯、
// 右に選んだ区間の設定とラベルと作るボタン。区間の部品と作るジョブは public/recipe-motion.mjs。結果は確認待ちに入り、モーションの画面のモーダルで見てから取り込む。
import {h, getJSON} from './dom.mjs';
import {enc, viewerFrame, viewerReady} from './shared.mjs';
import {recipeEditor} from './recipe-motion.mjs';
import {playBar, toggles, weaponPick} from './motion.mjs';

export async function showMotionCreate({main, ov, char, verId, alive, jobsChanged}) {
  const motions = await getJSON('/api/motions');
  const frame = char && verId ? viewerFrame(char.id, verId) : null;
  const caption = h('div', {class: 'stage-caption'});
  // 選んだ区間の元の動きをキャラに当てる。作る前の区間は見られないことを出す
  let shown = 0;
  const onSelect = async p => {
    const mine = ++shown;
    caption.textContent = p.note ?? '';
    if (!frame || p.note) return;
    const v = await viewerReady(frame);
    if (mine !== shown) return;
    try { await (p.motion ? v.play(p.motion) : v.playCandidate(p.record)); } catch (e) { caption.textContent = '再生できない: ' + e.message; }
  };
  const kit = ov.edition === 'kit';
  const ed = await recipeEditor({motions, queued: () => jobsChanged(), onSelect, char, verId, kit, ov});
  const back = `#motions/${char ? enc(char.id) + (verId ? '/' + enc(verId) : '') : ''}`;
  const center = h('section', {class: 'center', 'aria-label': 'ビューア'},
    h('div', {class: 'stage'}, frame ?? h('div', {class: 'empty'}, 'このキャラにはバージョンがまだない。つくるの画面で取り込む。')));
  if (frame) center.append(playBar(frame, alive, weaponPick(frame), toggles(frame)));
  center.append(h('div', {class: 'stage-foot'}, caption), ed.strip);
  main.replaceChildren(h('div', {class: 'create-page'},
    h('div', {class: 'create-head'},
      h('a', {class: 'button quiet back-link', href: back}, '‹ モーションへ戻る'),
      h('h1', {}, 'モーションを作る'),
      char ? h('span', {class: 'muted'}, `${char.name}（${verId ?? 'バージョンなし'}）に当てて確かめる`) : null,
      h('span', {class: 'grow'}),
      h('span', {class: 'muted'}, '下書きは自動で残る（手元の動画のファイルは選び直す）')),
    h('div', {class: 'work motion-create'},
      h('section', {class: 'pane pane-left', 'aria-label': '区間の並び'},
        h('div', {class: 'pane-head'}, h('h2', {}, '区間の並び'), h('span', {class: 'muted'}, '上から順につなぐ')),
        ed.list, h('h3', {class: 'small-head'}, '区間を追加'), ed.adder, ed.help),
      center,
      h('section', {class: 'pane pane-right', 'aria-label': '選んだ区間の設定'}, ed.settings, ed.footer))));
  ed.start();
}
