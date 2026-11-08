// きゃらすたの画面の本体: 上部バーと、URL の # から画面を選ぶ部分(docs/screens.md)。
//   #chars(既定) ライブラリ、#jobs 今の画面のままジョブの引き出しを開く(画面ではない)
//   #create/<キャラ>[/<版>] つくる、#motions[/<キャラ>[/<版>]] 動き、#expression/<キャラ> 表情(今の表情づくりへ移る)
//   #studio/<キャラ>/<表情づくり>[/<工程>] 表情、#finish/<キャラ>[/<表情づくり>] 仕上げ
//   #face/<キャラ>[/<版>] 表情(シェイプキー方式の版の確認)
//   #gallery 動画ギャラリー、#mv/<キャラ>[/<版>] ダンス MV のショートを作って #short/<ID> へ移る、#shorts ショートの一覧、#short/<ID> カット表の編集
//   #trash ごみ箱。#model/<キャラ>[/<版>] 完成モデル。#model/<キャラ>/<版>/export と #char/<キャラ> は完成モデルへ移す(前の URL)
//   生き物のキャラ(docs/creature.md)は #model が生き物のページ。VRM の工程の画面(つくる、動き、表情、仕上げ、MV)は短い案内とキャラのページへのリンクだけ
import {h, getJSON} from './dom.mjs';
import {enc, thumb, sortVersions, jobActive, jobRow} from './shared.mjs';
import {showLibrary} from './library.mjs';
import {showCreate} from './create.mjs';
import {showMotion} from './motion.mjs';
import {showStudio, showStudioStart} from './studio.mjs';
import {showFaceCheck} from './face-check.mjs';
import {showFinish} from './finish.mjs';
import {showModel} from './model.mjs';
import {showTrash} from './trash.mjs';
import {showGallery} from './gallery.mjs';
import {showShorts, showShort} from './short.mjs';
import {startDanceShort} from './short-dance.mjs';
import {showCreature} from './creature.mjs';
import {isCreature, styleLabel} from './char-style.mjs';

const main = document.getElementById('main'), bar = document.getElementById('appbar'), phoneNav = document.getElementById('phoneNav');
const STAGES = [['create', '1', 'つくる'], ['motion', '2', '動き'], ['expression', '3', '表情'], ['finish', '4', '仕上げ']];
// VRM が前提の画面。生き物のキャラでは開かない
const VRM_PAGES = {create: 'つくる', motions: '動き', expression: '表情', studio: '表情', face: '表情', finish: '仕上げ', mv: 'ダンス MV'};
const chosenVer = {}, chosenStudio = {};   // キャラごとに、画面を移っても保つ版と表情づくり
const store = {   // 最後に見たキャラ。残せない環境でも動く
  get() { try { return localStorage.getItem('charasta.char'); } catch { return null; } },
  set(id) { try { localStorage.setItem('charasta.char', id); } catch { /* 残せなくても困らない */ } },
};

// 生き物のキャラは、VRM の工程を指す先もキャラのページ(#model)にする
const stageHref = (stage, c) => {
  if (c && isCreature(c) && stage !== 'model') stage = 'model';
  if (!c) return '#' + {create: 'create', motion: 'motions', expression: 'expression', finish: 'finish', model: 'model', mv: 'mv'}[stage];
  const id = enc(c.id), ver = chosenVer[c.id] ?? c.latest?.id, v = ver ? '/' + enc(ver) : '', s = chosenStudio[c.id] ? '/' + enc(chosenStudio[c.id]) : '';
  return {create: `#create/${id}${v}`, motion: `#motions/${id}${v}`, expression: s ? `#studio/${id}${s}` : `#expression/${id}`, finish: `#finish/${id}${s}`, model: `#model/${id}${v}`, mv: `#mv/${id}${v}`}[stage];
};

// ---- ジョブの引き出し(上部バーのボタンから開く) ----
const JOB_ROWS = 8;
let jobTimer = null;
const jobCount = h('span', {}, '0'), jobList = h('div', {class: 'jobs-box'});
const jobsButton = h('button', {type: 'button', class: 'jobs-link', 'aria-expanded': 'false', onclick: () => setDrawer(drawer.hidden)},
  h('span', {class: 'dot running', 'aria-hidden': 'true'}), h('span', {class: 'jobs-word'}, 'ジョブ '), jobCount);
const drawer = h('aside', {class: 'jobs-drawer', 'aria-label': 'ジョブ', hidden: true, onclick: e => { if (e.target.closest('a')) setDrawer(false); }}, jobList);
function setDrawer(open) {
  drawer.hidden = !open; jobsButton.setAttribute('aria-expanded', String(open));
  if (open) refreshJobs();
}
async function refreshJobs() {
  clearTimeout(jobTimer);
  const jobs = await getJSON('/api/jobs').catch(e => { jobList.replaceChildren(h('div', {class: 'err'}, 'ジョブを読めない: ' + e.message)); return null; });
  if (!jobs) return;
  const active = jobs.filter(jobActive).length;
  jobCount.textContent = active;
  jobsButton.classList.toggle('idle', !active);
  if (!drawer.hidden) jobList.replaceChildren(...(jobs.length ? jobs.slice(0, JOB_ROWS).map(jobRow) : [h('div', {class: 'empty small'}, 'ジョブはまだない')]));
  if (active) jobTimer = setTimeout(refreshJobs, 4000);
}

let menuClose = null;   // 開いている切り替えの欄を、外を押して閉じる
document.addEventListener('click', e => {
  menuClose?.(e);
  if (!drawer.hidden && !drawer.contains(e.target) && !jobsButton.contains(e.target)) setDrawer(false);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !drawer.hidden) setDrawer(false); });
addEventListener('blur', () => { if (document.activeElement?.tagName === 'IFRAME' && !drawer.hidden) setDrawer(false); });   // ビューアの中を押すと親には click が来ない

// ---- 上部バー ----
function renderBar(ov, stage, c, verId) {
  const brand = h('a', {class: 'brand', href: '#chars'}, h('img', {src: '/app/icon.svg', alt: '', width: '28', height: '28'}), 'きゃらすた');
  renderPhoneNav(stage, c);
  const gallery = h('a', {class: 'model-link', href: '#gallery', 'aria-current': /^#(gallery|short)/.test(location.hash) ? 'page' : null}, '動画');
  if (stage === 'none') { bar.replaceChildren(brand, h('div', {class: 'grow'}), gallery, jobsButton, drawer); return; }
  const close = () => { sw.open = false; };
  const creature = isCreature(c);
  const pickVersion = v => e => {   // 表情と仕上げの URL は版を持たないので、同じ URL のまま読み直す
    e.preventDefault(); close(); chosenVer[c.id] = v.id;
    const next = location.hash.startsWith('#face/') ? `#face/${enc(c.id)}/${enc(v.id)}` : stageHref(stage, c);
    if (next === location.hash) route(); else location.hash = next;
  };
  const sw = h('details', {class: 'switch'},
    h('summary', {'aria-label': 'キャラを切り替える'},
      thumb(c?.thumb, '', 'mini'),
      h('span', {class: 'who'}, h('span', {class: 'who-name'}, c?.name ?? 'キャラなし'), h('span', {class: 'mono who-ver'}, verId ?? '版なし'))),
    h('div', {class: 'menu'},
      h('div', {class: 'menu-head'}, 'キャラ'),
      ov.chars.map(x => h('a', {href: stageHref(stage, x), 'aria-current': x.id === c?.id ? 'true' : null, onclick: close}, thumb(x.thumb, '', 'mini'), x.name)),
      c?.versions?.length ? h('div', {class: 'menu-head'}, '版') : null,
      sortVersions(c ?? {}).map(v => h('a', {href: '#', 'aria-current': v.id === verId ? 'true' : null, onclick: pickVersion(v)},
        h('span', {class: 'mono'}, v.id), v.id === c.latest?.id ? h('span', {class: 'tag'}, '最新') : null)),
      // スマホには工程のタブが無いので、下のナビに無い 2 つの工程はここから入る(生き物には工程が無い)
      creature ? null : h('div', {class: 'menu-phone'}, h('div', {class: 'menu-head'}, '工程'), [['create', 'つくる'], ['finish', '仕上げ']].map(([id, label]) => h('a', {href: stageHref(id, c), onclick: close}, label)))));
  menuClose = e => { if (!sw.contains(e.target)) close(); };
  const tab = ([id, n, label]) => h('a', {class: 'tab', href: stageHref(id, c), 'aria-current': id === stage ? 'page' : null}, h('span', {class: 'mono n'}, n), h('span', {}, label));
  // 生き物は 4 工程のタブを出さず、キャラのページへのリンクだけ
  bar.replaceChildren(brand, sw, creature ? h('div', {class: 'grow'}) : h('nav', {class: 'tabs', 'aria-label': '工程'}, STAGES.map(tab)),
    h('a', {class: 'model-link', href: stageHref('model', c), 'aria-current': stage === 'model' ? 'page' : null}, creature ? 'キャラのページ' : '完成モデル'), gallery, jobsButton, drawer);
}

// スマホの下のナビ。ジョブは上部バーの引き出し、つくると仕上げはキャラの切り替えの欄とライブラリのカードから入る
// 生き物のキャラでは、動きと表情を出さない(VRM の工程なので)
function renderPhoneNav(stage, c) {
  const link = (href, label, on) => h('a', {href, 'aria-current': on ? 'page' : null}, label);
  const creature = isCreature(c);
  phoneNav.replaceChildren(link('#chars', 'ライブラリ', stage === 'none'),
    creature ? null : link(stageHref('motion', c), '動き', stage === 'motion'), creature ? null : link(stageHref('expression', c), '表情', stage === 'expression'),
    link(stageHref('model', c), creature ? 'キャラ' : '完成モデル', stage === 'model'), link('#gallery', '動画', /^#(gallery|short)/.test(location.hash)));
}

// 生き物のキャラで VRM の画面を開いたときの案内
function creatureNotice(char, page) {
  return h('div', {class: 'page-empty route-notice'},
    h('h1', {}, `${char.name} は${styleLabel('creature')}のキャラ`),
    h('p', {}, `${VRM_PAGES[page]}の画面は VRM のキャラ(スタンダードとチビ)だけで使う。${styleLabel('creature')}は Blender の骨と動きで作り、scripts/import-creature.mjs で取り込む。`),
    h('a', {class: 'button primary', href: '#model/' + enc(char.id)}, 'キャラのページへ戻る'));
}

// ---- 画面の切り替え ----
let token = 0;
async function route(e) {
  if (location.hash === '#jobs') {   // 今の画面のまま引き出しを開く。URL は今の画面へ戻す(e が無ければ最初に開いた URL)
    history.replaceState(null, '', (e && new URL(e.oldURL).hash) || '#chars');
    setDrawer(true);
    if (e) return;
  }
  const mine = ++token, alive = () => mine === token;
  const [page = '', a, b, c] = location.hash.slice(1).split('/').map(s => { try { return decodeURIComponent(s); } catch { return s; } });
  if (page === 'char') { location.replace('#model/' + enc(a)); return; }
  if (page === 'model' && c === 'export') { location.replace(`#model/${enc(a)}/${enc(b)}`); return; }
  try {
    const ov = await getJSON('/api/overview');
    if (!alive()) return;
    const pick = id => ov.chars.find(x => x.id === id) ?? null;
    const stage = {create: 'create', motions: 'motion', expression: 'expression', studio: 'expression', face: 'expression', finish: 'finish', model: 'model', mv: 'mv'}[page] ?? 'none';
    if (a && stage !== 'none' && !pick(a)) throw Error(`キャラ ${a} が無い`);
    // VRM の画面をキャラ ID なしで開いたときは、生き物でないキャラを選ぶ(覚えたキャラが生き物なら最初の VRM のキャラ)
    const vrmPage = Object.hasOwn(VRM_PAGES, page), stored = pick(store.get());
    const char = stage === 'none' ? null : pick(a) ?? (vrmPage && isCreature(stored) ? ov.chars.find(x => !isCreature(x)) ?? stored : stored) ?? (vrmPage ? ov.chars.find(x => !isCreature(x)) : null) ?? ov.chars[0] ?? null;
    if (char) {
      store.set(char.id);
      char.versions = (await getJSON('/api/characters/' + enc(char.id))).versions;
      if (['create', 'motions', 'model', 'face', 'mv'].includes(page) && b) chosenVer[char.id] = b;
      if (['studio', 'finish'].includes(page) && b) chosenStudio[char.id] = b;
      if (chosenVer[char.id] && !char.versions.some(v => v.id === chosenVer[char.id])) delete chosenVer[char.id];   // 消した版や、無い版の URL は最新の版へ戻す
      if (!chosenStudio[char.id] && char.studios.length) chosenStudio[char.id] = char.studios.at(-1).id;
    }
    if (char && isCreature(char) && vrmPage) {   // VRM が前提の画面は開かない(サーバーも断る)
      renderBar(ov, 'model', char, chosenVer[char.id] ?? char.latest?.id ?? null);
      refreshJobs();
      if (alive()) main.replaceChildren(creatureNotice(char, page));
      scrollTo(0, 0);
      return;
    }
    if (page === 'expression' && char?.latest) {   // Fcl_ のキーを持つ版は作り直す工程が無いので、確認の画面へ
      const ver = chosenVer[char.id] ?? char.latest.id, face = await getJSON(`/api/characters/${enc(char.id)}/versions/${enc(ver)}/face`).catch(() => null);
      if (face?.method === 'shapekey') { location.replace(`#face/${enc(char.id)}/${enc(ver)}`); return; }
    }
    if (page === 'expression' && char && chosenStudio[char.id]) { location.replace(`#studio/${enc(char.id)}/${enc(chosenStudio[char.id])}`); return; }
    const verId = char ? chosenVer[char.id] ?? char.latest?.id ?? null : null;
    renderBar(ov, stage, char, verId);
    refreshJobs();
    // 読み込みの途中で別の画面へ移ったら、古い画面の描画を捨てる
    const ctx = {main: {replaceChildren: (...nodes) => { if (alive()) main.replaceChildren(...nodes); }}, ov, char, verId, alive, jobsChanged: refreshJobs, stageHref, reload: route};
    if (page === 'create') await showCreate(ctx);
    else if (page === 'motions') await showMotion(ctx);
    else if (page === 'expression') await showStudioStart(ctx);
    else if (page === 'studio') await showStudio(ctx, b, c);
    else if (page === 'face') await showFaceCheck(ctx);
    else if (page === 'finish') await showFinish(ctx, char && chosenStudio[char.id]);
    else if (page === 'model') await (char && isCreature(char) ? showCreature(ctx) : showModel(ctx));
    else if (page === 'trash') await showTrash(ctx);
    else if (page === 'gallery') await showGallery(ctx);
    else if (page === 'mv') await startDanceShort(ctx);
    else if (page === 'shorts') await showShorts(ctx);
    else if (page === 'short') await showShort(ctx, a);
    else await showLibrary(ctx);
  } catch (e) { if (alive()) main.replaceChildren(h('div', {class: 'empty page-empty'}, '読み込みに失敗: ' + e.message)); console.error(e); }
  if (alive()) scrollTo(0, 0);
}
addEventListener('hashchange', route);
route();
