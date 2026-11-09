// 動きの「つくる」の動画の区間の部品と、確認の欄(元の動画と並べた比較を見て、取り込むか捨てる)。docs/video-to-vrma.md
import {h, getJSON, send} from './dom.mjs';

// 手元の動画を送る。入力はヘッダに入れるので encodeURIComponent する(サーバーは decodeURIComponent で戻す)
async function postFile(file, params) {
  const r = await fetch('/api/video-motions', {method: 'POST', body: file, headers: {'content-type': 'application/octet-stream',
    'x-filename': encodeURIComponent(file.name), 'x-params': encodeURIComponent(JSON.stringify(params))}});
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw Error(j?.error || `${r.status} ${text}`);
  return j;
}

// 動画の区間の部品(public/recipe-motion.mjs)。o は GET /api/video-motions。対象の版は上部バーで選んだ版。
// 区間が 1 つのときだけ queue(label) で video-motion ジョブを積む(2 つ以上のときは、先に作って確認待ちの結果を区間に使う)
export function videoFields({char, verId, o}, onChange = () => {}) {
  const url = h('input', {type: 'url', inputmode: 'url', placeholder: 'https://…', 'aria-label': '動画の URL'});
  const file = h('input', {type: 'file', accept: 'video/*,.mkv', 'aria-label': '手元の動画'});
  const unmirror = h('input', {type: 'checkbox'});
  const speed = h('input', {type: 'number', step: '0.05', min: String(o.speed[0]), max: String(o.speed[1]), value: '1', 'aria-label': '動画の速さ'});
  // 変換の方法。exmr は RGB MoCap の ExMR(既定)、mediapipe は vrma-pipeline。奥行きと両手の間隔は mediapipe だけの条件
  // engines に exmr が無い(キット、docs/edition.md)ときは ExMR を出さない
  // sam3d(SAM 3D Body)は既定にしない。engines.sam3d が使えるときだけ出す
  const engines = o.engines ?? {mediapipe: o.available}, exmr = 'exmr' in engines, sam3d = !!engines.sam3d;
  const engine = h('select', {'aria-label': '変換の方法'},
    exmr ? h('option', {value: 'exmr', disabled: !engines.exmr}, 'RGB MoCap の ExMR（指まで。教育・研究・非営利の条件のモデル）') : null,
    sam3d ? h('option', {value: 'sam3d'}, 'SAM 3D Body（指まで。NVIDIA の GPU 専用。SAM License の重みを自分で取って使う）') : null,
    h('option', {value: 'mediapipe', disabled: !engines.mediapipe}, 'MediaPipe（vrma-pipeline）'));
  engine.value = o.defaultEngine ?? 'mediapipe';
  const depthOff = h('input', {type: 'checkbox'});
  const bodyFix = h('input', {type: 'checkbox'});
  const grip = h('input', {type: 'number', step: '1', min: '0', max: '100', placeholder: '使わない', 'aria-label': '両手の間隔'});
  const sync = () => { const mp = engine.value === 'mediapipe'; depthOff.disabled = !mp; bodyFix.disabled = engine.value !== 'exmr'; if (bodyFix.disabled) bodyFix.checked = false; grip.disabled = !mp || depthOff.checked; if (grip.disabled) grip.value = ''; if (!mp) depthOff.checked = false; };
  depthOff.onchange = sync; engine.onchange = sync; sync();
  const start = h('input', {type: 'number', step: '0.01', min: '0', value: '0', 'aria-label': '開始の秒'});
  const end = h('input', {type: 'number', step: '0.01', min: '0', placeholder: '最後まで', 'aria-label': '終了の秒'});
  const crop = h('input', {placeholder: '幅:高さ:左:上', 'aria-label': '切り抜き'});
  const rights = h('textarea', {rows: '3', maxlength: '500', required: true, placeholder: '例: 自分で撮った動画。例: YouTube の○○さんの動画で、個人の確認だけに使う', 'aria-label': '権利のメモ'});
  const queue = async label => {
    const picked = file.files[0], link = url.value.trim();
    if (!char || !verId) throw new Error('キャラの版を選ぶ（動画はその体に合わせて作る）');
    if (!!picked === !!link) throw new Error('動画は URL か手元のファイルのどちらか 1 つを指定する');
    if (!rights.value.trim()) throw new Error('権利のメモを書く');
    const params = {charId: char.id, verId, rights: rights.value, engine: engine.value, unmirror: unmirror.checked, handBodyFix: bodyFix.checked || undefined, speed: speed.value, depthOpt: !depthOff.checked, grip: grip.value || undefined, trimStart: start.value, trimEnd: end.value || undefined,
      crop: crop.value.trim(), label: label || ''};
    const job = picked ? await postFile(picked, params) : await send('POST', '/api/jobs', {type: 'video-motion', url: link, ...params});
    url.value = ''; file.value = '';
    return job;
  };
  const name = () => (file.files[0]?.name ?? url.value.trim()) || '（動画を選ぶ）';
  for (const el of [url, file]) el.addEventListener('change', onChange);
  const el = h('div', {class: 'form-stack', id: 'videoMotionPanel'},
    o.available ? null : h('p', {class: 'err'}, `vrma-pipeline が見つからない（設定の vrmaPipelineDir: ${o.pipelineDir ?? 'なし'}）`),
    h('fieldset', {}, h('legend', {}, '動画の URL か手元のファイル'), h('div', {class: 'stack-small'}, url, file)),
    h('div', {class: 'seg'}, h('label', {}, '開始の秒', start), h('label', {}, '終了の秒', end)),
    h('label', {}, '変換の方法', engine),
    h('label', {}, '権利のメモ（必須）', rights),
    h('details', {}, h('summary', {}, `細かい条件（ミラー、速さ、切り抜き、${exmr ? '手のめり込み、' : ''}奥行き、両手の間隔）`),
      h('div', {class: 'form-stack'},
        h('label', {class: 'check'}, unmirror, 'ミラーを解除する（左右を反転する）'),
        h('label', {}, '動画の速さ（スローの動画なら 0.6 のように、実際の何倍速かを書く）', speed),
        h('label', {}, '切り抜き（ほかの人や小窓を除く。空なら全体）', crop),
        exmr ? h('label', {class: 'check'}, bodyFix, '手と腕が体にめり込むコマを直す（ExMR のとき。この版の体に合わせて腕を外へ出す。22 秒の動画で約 22 分増える）') : null,
        h('label', {class: 'check'}, depthOff, '全身の奥行き最適化を切る（MediaPipe のとき。剣など振りの速さを優先するとき）'),
        h('label', {}, '両手の間隔 cm（MediaPipe のとき。両手で持つ物があるとき。ダンスでは空のまま）', grip),
        h('p', {class: 'muted'}, `${char ? `${char.name}（${verId ?? '版なし'}）の体に合わせて VRMA を作る。ほかのキャラでも再生はできるが、足や手の位置がずれる。` : ''}${o.maxClipSec} 秒まで。URL の動画は「作る」を押したときだけ取りに行く。作ったモーションは個人利用として記録し、確認の欄で「取り込む」を押すまで一覧に入らない。ラベルは下の欄（空ならファイル名）。`))));
  return {el, queue, name, available: o.available && !!verId};
}

// 確認待ちのジョブを box に出す。changed() は取り込み・捨てるのあとで呼ぶ
export async function showReviews(box, changed) {
  const {waiting} = await getJSON('/api/video-motions');
  box.replaceChildren(...waiting.map(j => reviewCard(j, changed)));
}

function reviewCard(j, changed) {
  const r = j.result, id = encodeURIComponent(j.id);
  const label = h('input', {maxlength: '100', value: r.label, 'aria-label': 'ラベル'});
  const motionId = h('input', {value: 'video-' + j.id, 'aria-label': 'モーション ID'});
  const msg = h('span', {class: 'muted'});
  const act = async (fn, busy) => {
    buttons.forEach(b => { b.disabled = true; }); msg.className = 'muted'; msg.textContent = busy;
    try { await fn(); await changed(); }
    catch (e) { msg.className = 'err'; msg.textContent = e.message; buttons.forEach(b => { b.disabled = false; }); }
  };
  const take = h('button', {class: 'primary', onclick: () => act(() => send('POST', `/api/video-motions/${id}/import`, {label: label.value.trim(), motionId: motionId.value.trim()}), '取り込み中…')}, '取り込む');
  const drop = h('button', {onclick: () => act(() => send('POST', `/api/video-motions/${id}/discard`), '捨てている…')}, '捨てる');
  const buttons = [take, drop];
  return h('section', {class: 'form-stack sep video-review', 'data-review': j.id},
    h('h2', {}, '確かめて取り込む'),
    h('div', {class: 'video'}, h('video', {controls: true, loop: true, muted: true, playsinline: true, src: r.compareUrl}), h('span', {class: 'muted'}, '左が元の動画、右がキャラに当てた VRMA。'), h('a', {href: r.compareUrl, target: '_blank'}, '大きく開く')),
    h('div', {class: 'muted'}, `${r.charName}（${r.verId}）の体に合わせた。${Number(r.durationSec).toFixed(1)} 秒、${r.frames} コマ、パイプラインの判定 ${r.quality ?? '不明'}（目安。動画を見て決める）`),
    h('div', {class: 'limit warn'}, r.license?.summary ?? ''),
    h('div', {class: 'muted'}, '権利のメモ: ' + (r.license?.rightsNote ?? '')),
    h('label', {}, 'ラベル', label), h('label', {}, 'モーション ID', motionId),
    h('div', {class: 'seg'}, take, drop), msg);
}
