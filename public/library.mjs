// ライブラリ: スタイルのタブ、キャラのカード(4 工程の進み具合、スタイルの札、タグ。生き物は動きの名前)、判断待ちの帯、新しいキャラ、ごみ箱へのリンク(docs/screens.md)。
import {h, getJSON, send} from './dom.mjs';
import {METHODS, enc, mb, thumb} from './shared.mjs';
import {can} from './capabilities.mjs';
import {confirmDialog, moveToTrash, trashIcon} from './confirm.mjs';
import {RESTYLE_WARNING, STYLE_IDS, STYLE_TABS, bandText, filterByStyleTab, isCreature, loadStyleTab, motionNames, motionSummary, pickStyleTab, saveStyleTab, styleChip, styleChoices, styleLabel, styleStepsBox, styleTabCounts} from './char-style.mjs';

const STAGE_ROWS = [['create', 'つくる'], ['motion', '動き'], ['expression', '表情'], ['finish', '仕上げ']];
const STAGE_TEXT = {done: 'できている', doing: '途中', none: 'まだ'};

const deleteButton = (c, reload) => h('button', {type: 'button', class: 'icon-btn', 'aria-label': `${c.name} を削除`, onclick: async () => { if (await moveToTrash({kind: 'character', charId: c.id}, c.name)) reload(); }}, trashIcon());

// 生き物のカード: 4 工程の棒と完成モデルの数は出さない(VRM の工程なので)。絵は透明の背景なので暗い地に収めて出し、動きの名前を 1 行
function creatureCard(c, reload) {
  const open = `#model/${enc(c.id)}`, names = motionNames(c.creature);
  return h('article', {class: 'char-card creature-card', 'data-char': c.id},
    h('a', {class: 'char-pic', href: open, tabindex: '-1', 'aria-hidden': 'true'}, thumb(c.thumb, '', 'char-thumb creature-thumb')),
    h('div', {class: 'char-body'},
      h('a', {class: 'char-title', href: open}, h('span', {class: 'char-name'}, c.name), h('span', {class: 'mono muted char-ver'}, c.latest?.id ?? '版なし')),
      h('div', {class: 'char-tags', 'aria-label': 'スタイルとタグ'}, styleChip('creature'), (c.tags ?? []).map(t => h('span', {class: 'tag', title: t}, t))),
      h('div', {class: 'char-foot'},
        h('a', {class: 'char-model creature-motions', href: open, title: names.join('、') || null}, motionSummary(c.creature) ?? (c.versionCount ? '動きの記録なし' : '版なし')),
        deleteButton(c, reload))));
}

function charCard(c, stageHref, reload) {
  if (isCreature(c)) return creatureCard(c, reload);
  const open = stageHref(c.versionCount ? 'motion' : 'create', c);
  return h('article', {class: 'char-card', 'data-char': c.id},
    h('a', {class: 'char-pic', href: open, tabindex: '-1', 'aria-hidden': 'true'}, thumb(c.thumb, '', 'char-thumb')),
    h('div', {class: 'char-body'},
      h('a', {class: 'char-title', href: open}, h('span', {class: 'char-name'}, c.name), h('span', {class: 'mono muted char-ver'}, c.latest?.id ?? '版なし')),
      h('div', {class: 'stages'}, STAGE_ROWS.map(([k, label]) => h('a', {class: 'stage-cell', href: stageHref(k, c), title: `${label}: ${STAGE_TEXT[c.stages[k]]}`, 'aria-label': `${label}: ${STAGE_TEXT[c.stages[k]]}`},
        h('span', {class: 'bar ' + c.stages[k], 'aria-hidden': 'true'})))),
      h('div', {class: 'char-tags', 'aria-label': 'スタイルとタグ'}, styleChip(c.style), (c.tags ?? []).map(t => h('span', {class: 'tag', title: t}, t))),
      h('div', {class: 'char-foot'},
        h('a', {class: 'char-model', href: stageHref('model', c)}, `完成モデル ${c.finished.length}`),
        deleteButton(c, reload))));
}

function waitBand(w) {
  return h('a', {class: 'wait-band', href: `#studio/${enc(w.charId)}/${enc(w.studioId)}/${enc('req:' + w.step)}`},
    h('span', {class: 'chip act'}, '判断待ち'),
    h('span', {class: 'wait-text'}, `${w.charName} ${w.text.slice(0, 18)}`),
    h('span', {class: 'muted'}, `候補 ${w.candidates} 枚`));
}

// 新しいキャラ: スタイルと作り方を選んでキャラの記録を作り、きゃらくるのアプリを開く。制作はきゃらくるの依頼文から Claude が進める
// スタイルは必須。選ぶまで「作り始める」を押せない
// 生き物は 3D の作り方を隠し、きゃらくるを開かずに記録だけ作ってキャラのページへ移る。版は scripts/import-creature.mjs で取り込む
function newCharacter(ov, stageHref) {
  let method = 'tripo';   // 顔の仕上がりは Tripo Studio の方がよかったので、既定にする
  let style = null, setReady = () => {};
  const steps = styleStepsBox();
  const choices = styleChoices(style, s => { style = s; steps.set(s); methodField.hidden = s === 'creature'; setReady(); });
  const id = h('input', {placeholder: '例: chara5', 'aria-label': 'キャラ ID'}), name = h('input', {placeholder: '例: キャラ5', 'aria-label': '名前'});
  const box = h('div', {class: 'stack-small'});
  const render = () => box.replaceChildren(...METHODS.map(([k, label, note]) => h('button', {type: 'button', class: 'choice', 'aria-pressed': String(k === method), onclick: () => { method = k; render(); }},
    h('span', {class: 'choice-name'}, label), h('span', {class: 'muted'}, note))));
  render();
  const methodField = h('fieldset', {}, h('legend', {}, '3D の作り方'), box);
  return confirmDialog({
    title: '新しいキャラを作る', confirm: '作り始める', tone: 'primary',
    setup: ({setDisabled}) => { setReady = () => setDisabled(!style); setReady(); },
    body: [h('div', {class: 'form-stack'},
      h('fieldset', {class: 'style-field'}, h('legend', {}, 'スタイル'),
        h('p', {class: 'muted'}, `あとから変えられるが、${RESTYLE_WARNING}。${STYLE_IDS.includes('creature') ? '版を取り込んだあとは、生き物とほかのスタイルのあいだでは変えられない。' : ''}`), choices.box, steps.box),
      methodField,
      h('label', {}, 'キャラ ID（英小文字・数字・ハイフン）', id), h('label', {}, '名前', name))],
    run: async () => {
      if (!style) throw Error(`スタイル(${STYLE_IDS.map(styleLabel).join('、')}のどれか)を選ぶ`);   // キットには生き物が無い(public/app.mjs が STYLE_IDS から外す)
      if (!id.value.trim() || !name.value.trim()) throw Error('ID と名前を入れる');
      if (style === 'creature') {   // きゃらくるは VRM の作り方なので開かない
        try {
          const c = await send('POST', '/api/characters', {id: id.value.trim(), name: name.value.trim(), style});
          location.hash = `#model/${enc(c.id)}`;
        } catch (e) { throw Error('作れない: ' + e.message); }
        return;
      }
      const opened = can(ov, 'charakuru') ? open(ov.charakuruUrl, '_blank') : null;   // 押した操作の中で開く(あとからだとブラウザに止められる)
      try {
        const c = await send('POST', '/api/characters', {id: id.value.trim(), name: name.value.trim(), style, method});
        location.hash = stageHref('create', {id: c.id});
      } catch (e) { opened?.close(); throw Error('作れない: ' + e.message); }
    },
  });
}

// スタイルのタブ(role=tab)、その下の 1 行(すべてでは出さない)、カードの欄。選んだタブはブラウザに覚える
function styleTabs(chars, stageHref, reload) {
  const counts = styleTabCounts(chars);
  const band = h('p', {class: 'style-band'}), panel = h('div', {class: 'style-panel', role: 'tabpanel', id: 'stylePanel'});
  const buttons = STYLE_TABS.map(([k, label]) => h('button', {type: 'button', role: 'tab', class: 'style-tab', id: 'styleTab-' + k, 'aria-controls': 'stylePanel', 'data-tab': k,
    onclick: () => select(k), onkeydown: e => move(e, k)}, h('span', {}, label), h('span', {class: 'style-tab-count mono'}, String(counts[k]))));
  // 覚えるのは人が選んだタブだけ。起動時に自動で決めたタブは覚えない
  function select(k, focus = false, remember = true) {
    if (remember) saveStyleTab(k);
    for (const b of buttons) { const on = b.dataset.tab === k; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); }
    panel.setAttribute('aria-labelledby', 'styleTab-' + k);
    const text = bandText(k, chars);
    band.hidden = !text; band.textContent = text ?? '';
    const list = filterByStyleTab(chars, k);
    panel.replaceChildren(list.length ? h('div', {class: 'char-grid'}, list.map(c => charCard(c, stageHref, reload)))
      : h('div', {class: 'empty'}, chars.length ? 'このスタイルのキャラはまだない。' : 'キャラがまだない。「新しいキャラ」から始める。'));
  }
  // 左右の矢印、Home、End でタブを移る(WAI-ARIA のタブの作法)
  function move(e, k) {
    const i = STYLE_TABS.findIndex(([x]) => x === k), n = STYLE_TABS.length;
    const j = {ArrowRight: (i + 1) % n, ArrowLeft: (i + n - 1) % n, Home: 0, End: n - 1}[e.key];
    if (j === undefined) return;
    e.preventDefault(); select(STYLE_TABS[j][0], true);
  }
  select(pickStyleTab(loadStyleTab(), counts), false, false);
  return [h('div', {class: 'style-tabs', role: 'tablist', 'aria-label': 'スタイル'}, buttons), band, panel];
}

export async function showLibrary({main, ov, stageHref, reload}) {
  const trash = await getJSON('/api/trash').catch(() => null);
  main.replaceChildren(h('div', {class: 'library'},
    h('div', {class: 'lib-head'}, h('h1', {}, 'キャラ'), h('button', {type: 'button', class: 'primary', onclick: () => newCharacter(ov, stageHref)}, '新しいキャラ')),
    ov.waiting.map(waitBand),
    styleTabs(ov.chars, stageHref, reload),
    trash ? h('div', {class: 'lib-trash'}, h('a', {href: '#trash'}, `ごみ箱 ${trash.count} 件、合計 ${mb(trash.totalBytes)}`)) : null));
}
