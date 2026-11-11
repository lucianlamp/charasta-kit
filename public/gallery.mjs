// 動画ギャラリー: 全キャラの撮った動画、ショート、MV の一覧(docs/screens.md)。カードを押すとその場で再生する。試しからは本番を積める(前の MV の試しは mv ジョブの previewOf)。
import {h, getJSON, send} from './dom.mjs';
import {pendingRow, when, watchJobs} from './shared.mjs';
import {moveToTrash} from './confirm.mjs';
import {mvEstimateSec} from './mv-plan.mjs';
import {isCreature} from './char-style.mjs';

const KINDS = [['all', 'すべて'], ['short', 'ショート'], ['mv', 'MV'], ['preview', '試し'], ['shoot', '撮った動画']];
const kindOf = s => s.kind !== 'mv' && s.kind !== 'short' ? 'shoot' : s.quality === 'preview' ? 'preview' : s.kind;
const CHIP = {mv: 'MV', short: 'ショート', preview: '試し'};
const minutes = sec => `約 ${Math.max(1, Math.round(sec / 60))} 分`;
export const isMvJob = j => j.type === 'mv' || j.type === 'short';

// 動画 1 本のカード。reload: 消したあとの読み直し。queued: 本番を積んだジョブを渡す。finals: 本番を書き出した試しの ID
export function videoCard(s, {reload, queued, finals = new Set()}) {
  const kind = kindOf(s), url = s.url, ratio = s.aspect.replace(':', ' / ');
  const box = h('div', {class: 'vid-pic', style: `aspect-ratio:${ratio}`});
  let video = null;
  const play = () => {
    video = h('video', {controls: true, playsinline: true, autoplay: true, src: url, poster: s.posterUrl});
    box.replaceChildren(video);
  };
  const release = () => { if (video) { video.pause(); video.removeAttribute('src'); video.load(); } };
  box.append(h('button', {type: 'button', class: 'vid-play', 'aria-label': '再生する', onclick: play}, h('img', {src: s.posterUrl, alt: '', loading: 'lazy'}), h('span', {class: 'vid-time mono'}, `${s.seconds.toFixed(1)} 秒`)));
  const msg = h('span', {class: 'muted'}), final = h('button', {type: 'button', class: 'primary'}, '本番で書き出す');
  final.onclick = async () => {
    final.disabled = true; msg.className = 'muted'; msg.textContent = '送っている…';
    try { queued(await send('POST', '/api/jobs', s.kind === 'short' ? {type: 'short', shortId: s.short.id, quality: 'final', previewOf: s.id} : {type: 'mv', charId: s.charId, previewOf: s.id})); msg.textContent = '受け付けた'; final.remove(); }
    catch (e) { msg.className = 'err'; msg.textContent = '始められない: ' + e.message; final.disabled = false; }
  };
  const name = [s.motionLabel ?? 'モーションなし', s.lineText].filter(Boolean).join('・');
  const scenes = (s.mv ?? s.short)?.stageLabels.join('、'), sceneCount = (s.mv ?? s.short)?.stages.length;
  return h('article', {class: 'vid-card', 'data-shoot': s.id, 'data-kind': kind}, box,
    h('div', {class: 'vid-body'},
      h('div', {class: 'vid-title'}, kind === 'shoot' ? null : h('span', {class: kind === 'preview' ? 'chip' : 'chip act'}, kind === 'short' && s.short?.style === 'dance' ? 'ダンス MV' : CHIP[kind]), h('span', {}, name)),
      h('div', {class: 'muted'}, [s.charName, s.verId, when(s.createdAt)].filter(Boolean).join('・')),
      scenes ? h('div', {class: 'muted'}, scenes) : null,
      s.terms?.tag ? h('div', {class: 'limit warn'}, s.terms.tag) : null,
      s.short?.credit ? h('div', {class: 'muted'}, `投稿の説明に「${s.short.credit}」と書く`) : null,
      kind === 'preview' && !finals.has(s.id) ? h('div', {class: 'form-stack'}, final, h('span', {class: 'muted'}, `${s.kind === 'short' ? '今のカット表' : '同じカット割り'}で描き直す。${minutes(mvEstimateSec('final', s.seconds, sceneCount))}`)) : null,
      msg,
      h('div', {class: 'vid-foot'},
        h('a', {class: 'link', href: url, download: `${s.charId}-${s.verId}-${s.motionId ?? 'nomotion'}-${s.id}.mp4`}, 'ダウンロード'),
        h('button', {type: 'button', class: 'quiet', onclick: async () => {
          if (await moveToTrash({kind: 'shoot', charId: s.charId, id: s.id}, [name, s.aspect].join('・'), {before: release, onFail: () => { if (video) video.src = url; }})) await reload();
        }}, '削除'))));
}

// 一覧を作り直す前に、再生中の動画を放す(Windows は開いたファイルのフォルダを移せない)
export function dropVideos(box) {
  for (const v of box.querySelectorAll('video')) { v.pause(); v.removeAttribute('src'); v.load(); }
}

export const finalsOf = list => new Set(list.flatMap(s => (s.mv ?? s.short)?.previewOf ? [(s.mv ?? s.short).previewOf] : []));

export async function showGallery({main, ov, alive, jobsChanged, stageHref}) {
  let all = await getJSON('/api/shoots'), kind = 'all', char = '';
  const grid = h('div', {class: 'vid-grid'}), pending = h('div', {class: 'pending-list'});
  const reload = async () => { all = await getJSON('/api/shoots'); render(); };
  const watcher = watchJobs({filter: isMvJob, alive, onJobs: jobs => pending.replaceChildren(...jobs.map(pendingRow)), onDone: async () => { await reload(); jobsChanged(); }});
  const queued = job => { watcher.queued(job); jobsChanged(); };
  function render() {
    const finals = finalsOf(all), list = all.filter(s => (kind === 'all' || kindOf(s) === kind) && (!char || s.charId === char));
    dropVideos(grid);
    grid.replaceChildren(...(list.length ? list.map(s => videoCard(s, {reload, queued, finals})) : [h('p', {class: 'muted'}, all.length ? 'この条件の動画は無い。' : '撮った動画がここに並ぶ。まだない。')]));
  }
  const btns = KINDS.map(([k, label]) => h('button', {type: 'button', class: 'seg-btn', 'aria-pressed': String(k === kind), onclick: e => {
    kind = k; btns.forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); render(); }}, label));
  const pick = h('select', {'aria-label': 'キャラ'}, h('option', {value: ''}, 'すべてのキャラ'), ov.chars.map(c => h('option', {value: c.id}, c.name)));
  pick.onchange = () => { char = pick.value; render(); };
  const first = ov.chars.find(c => c.latest && !isCreature(c));   // ダンス MV は VRM のキャラだけ
  main.replaceChildren(h('div', {class: 'library'},
    h('div', {class: 'lib-head'}, h('h1', {}, '動画'), h('a', {class: 'button primary', href: '#shorts'}, 'ショートの一覧'), first ? h('a', {class: 'button outline', href: stageHref('mv', first)}, 'ダンス MV を作る') : null),
    h('div', {class: 'vid-filter'}, h('div', {class: 'seg five'}, btns), pick),
    pending, grid));
  render();
  await watcher.poll();
}



