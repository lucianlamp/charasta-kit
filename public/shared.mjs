// 画面どうしで共有するもの: 保管場所の URL、札、作り方の表、ジョブの行と読み直し、iframe のビューア。DOM は呼ばれたときだけ使う(テストが読み込める)。
import {h, getJSON, elapsedText} from './dom.mjs';
import {editionLabels} from './edition.mjs';

export const enc = encodeURIComponent;
export const libUrl = (...parts) => '/lib/' + parts.map(enc).join('/');
export const viewerHref = (charId, verId, lineId) => '/viewer?' + new URLSearchParams({char: charId, ...(verId && {ver: verId}), ...(lineId && {line: lineId})});
export const fmtDate = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('ja-JP'); };
export const when = s => s ? new Date(s).toLocaleString('ja-JP', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
export const mb = n => (n / 1048576).toFixed(1) + ' MB';
export const sortVersions = c => [...(c.versions || [])].sort((a, b) => (b.order ?? 0) - (a.order ?? 0));   // 新しい順

// 3D の作り方: [鍵, 名前, 説明]。キットでは public/app.mjs が /api/overview の labels の表に入れ替える(public/edition.mjs)
export const METHODS = editionLabels('full').methods;

export function thumb(src, alt, cls = 'thumb') {
  if (!src) return h('div', {class: cls + ' none'}, 'なし');
  const img = h('img', {class: cls, src, alt, loading: 'lazy'});
  img.onerror = () => img.replaceWith(h('div', {class: cls + ' none'}, 'なし'));
  return img;
}

// ---- ジョブ ----
const FRAMING = {face: '顔', upper: '上半身'};
export const JOB_STATE = {queued: '待ち', running: '実行中', done: '完了', failed: '失敗'};
const JOB_LABEL = {voice: '声', video: '動画', shoot: '撮る', mv: 'MV', short: 'ショート', 'short-draft': 'ショートの下書き', 'short-figures': 'ショートの図', 'motion-gen': 'モーションを作る', 'video-motion': '動画から作る', 'motion-text': '文章から作る', 'studio-front': '表情づくり: 正面を撮る', 'studio-build': '表情づくり: 組み立て',
  'studio-video': '表情づくり: 中割り', 'studio-checks': '表情づくり: 確かめ', 'face-check': '版の顔の確かめ', 'game-export': 'ゲーム用の書き出し'};
const FACE_SET = {grid: '格子と表情', keys: 'キー別', motion: 'モーション'};
const REVIEW = {waiting: '確認待ち', imported: '取り込んだ', discarded: '捨てた'};
export const jobActive = j => j.state === 'queued' || j.state === 'running';
const jobWhat = j => j.type === 'voice' ? `「${j.input?.text ?? ''}」` : j.type === 'video' ? `${j.input?.lineId ?? ''}・${FRAMING[j.input?.framing] || j.input?.framing || ''}`
  : j.type === 'shoot' ? [j.input?.motionId ?? 'モーションなし', j.input?.aspect, j.input?.quality].join('・')
  : j.type === 'short' ? [j.input?.short?.title, j.input?.quality === 'final' ? '本番' : '試し'].join('・')
  : j.type === 'short-draft' || j.type === 'short-figures' ? j.input?.label ?? ''
  : j.type === 'mv' ? [j.input?.motionId, (j.input?.stages ?? []).join(' + '), j.input?.quality === 'final' ? '本番' : '試し'].join('・')
  : j.type === 'motion-gen' || j.type === 'video-motion' || j.type === 'motion-text' ? j.input?.label ?? ''
  : j.type === 'game-export' ? [j.input?.verId, ...(j.input?.motions ?? [])].join('・')
  : j.type === 'face-check' ? h('a', {href: `#face/${enc(j.input?.charId)}/${enc(j.input?.verId)}`}, [j.input?.verId, FACE_SET[j.input?.set], j.input?.motionId].filter(Boolean).join('・'))
  : h('a', {href: `#studio/${enc(j.input?.charId)}/${enc(j.input?.studioId)}`}, j.input?.studioId ?? '');
// ジョブ short-figures の結果の文
export const figuresReport = r => [`図を ${r.made.length} 枚作った`, ...r.failed.map(f => `カット ${f.cut} は失敗: ${f.error}`), ...r.skipped.map(f => `カット ${f.cut} は入れなかった: ${f.reason}`)].join('。');
export function jobRow(j) {
  return h('div', {class: 'job', 'data-job': j.id, 'data-state': j.state},
    h('div', {class: 'job-top'}, h('span', {class: 'dot ' + j.state, 'aria-hidden': 'true'}), h('span', {class: 'job-name'}, JOB_LABEL[j.type] || j.type, ': ', jobWhat(j)),
      h('span', {class: 'mono muted'}, elapsedText(j))),
    h('div', {class: 'muted'}, [JOB_STATE[j.state] || j.state, j.step].filter(Boolean).join('・')),
    j.error ? h('div', {class: 'err'}, j.error) : null,
    j.type === 'short-figures' && j.state === 'done' && j.result ? h('div', {class: 'muted'}, figuresReport(j.result)) : null,
    j.type === 'motion-gen' && j.state === 'done' && j.result ? h('div', {class: 'muted'}, `${Number(j.result.durationSec).toFixed(1)} 秒、${j.result.frames} コマ、進んだ距離 ${Number(j.result.travelM).toFixed(1)} m`) : null,
    j.type === 'motion-text' && j.state === 'done' && j.result ? h('div', {class: 'muted'}, `候補 ${j.result.candidates?.length ?? 0} 本、${Number(j.result.durationSec).toFixed(1)} 秒、${REVIEW[j.result.review] ?? ''}`) : null,
    j.type === 'video-motion' && j.state === 'done' && j.result ? h('div', {class: 'muted'}, `${Number(j.result.durationSec).toFixed(1)} 秒、${j.result.frames} コマ、${REVIEW[j.result.review] ?? ''}`) : null);
}

// 一覧の先頭に出す仮の行: 作っている途中のものと、この画面で見ていて失敗したもの
const DOING = {shoot: '撮っている', mv: '書き出している', short: '書き出している', video: '撮っている', voice: '声を作っている'};
export function pendingRow(j) {
  return h('div', {class: 'pending-row', 'data-job': j.id, 'data-state': j.state},
    h('span', {}, j.state === 'failed' ? '失敗: ' : `${DOING[j.type] ?? '作っている'}: `, jobWhat(j)),
    h('span', {class: 'muted'}, [JOB_STATE[j.state], j.step, elapsedText(j)].filter(Boolean).join('・')),
    j.error ? h('span', {class: 'err'}, j.error) : null);
}

// filter を通ったジョブを見張り、動いている間は 3 秒ごとに読み直す。完了すると onDone、読むたびに onJobs(仮の行に出すジョブ)を呼ぶ。alive が false になったら止まる
export function watchJobs({filter = () => true, limit = 6, alive, onDone, onJobs}) {
  const seen = new Map(), watched = new Set();
  let timer = null;
  async function poll() {
    clearTimeout(timer);
    if (!alive()) return;
    let active = true;
    try {
      const mine = (await getJSON('/api/jobs')).filter(filter).slice(0, limit);
      const finished = mine.some(j => j.state === 'done' && seen.has(j.id) && seen.get(j.id) !== 'done');
      mine.forEach(j => { seen.set(j.id, j.state); if (jobActive(j)) watched.add(j.id); });
      active = mine.some(jobActive);
      onJobs?.(mine.filter(j => jobActive(j) || (j.state === 'failed' && watched.has(j.id))));
      if (finished) await onDone?.();
    } catch (e) { console.error(e); }
    if (active && alive()) timer = setTimeout(poll, 3000);
  }
  return {poll, queued: job => { seen.set(job.id, job.state); watched.add(job.id); poll(); }};
}

// 音声ファイルを送って保管場所の記録を返す(撮るときと MV のとき)
export async function uploadAudio(file) {
  const r = await fetch('/api/audio', {method: 'POST', headers: {'x-filename': enc(file.name)}, body: file}), j = await r.json();
  if (!r.ok) throw Error(j.error);
  return j;
}

// ---- iframe のビューア(/viewer?embed=1)。動きと完成モデルの画面が使う ----
export function viewerFrame(charId, verId, extra = {}) {
  return h('iframe', {class: 'viewer-frame', title: 'キャラのビューア', src: '/viewer?' + new URLSearchParams({char: charId, ver: verId, embed: '1', ...extra})});
}
// 読み込みが済んだ window.viewer を返す
export function viewerReady(frame) {
  return new Promise(resolve => {
    const look = () => { if (!frame.isConnected) return; const v = frame.contentWindow?.viewer; if (v?.vrm) resolve(v); else setTimeout(look, 100); };
    look();
  });
}
