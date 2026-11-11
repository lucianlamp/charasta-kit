// モーションを作る画面の動画の区間の部品と、確認のモーダルの中身(元の動画と並べた比較を見て、取り込むか捨てる)。docs/video-to-vrma.md
import {h, send} from './dom.mjs';

// 手元の動画を送る。入力はヘッダに入れるので encodeURIComponent する(サーバーは decodeURIComponent で戻す)
async function postFile(file, params) {
  const r = await fetch('/api/video-motions', {method: 'POST', body: file, headers: {'content-type': 'application/octet-stream',
    'x-filename': encodeURIComponent(file.name), 'x-params': encodeURIComponent(JSON.stringify(params))}});
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw Error(j?.error || `${r.status} ${text}`);
  return j;
}

// 動画の区間の部品(public/recipe-motion.mjs)。o は GET /api/video-motions。対象のバージョンは上部バーで選んだバージョン。
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
    if (!char || !verId) throw new Error('キャラのバージョンを選ぶ（動画はその体に合わせて作る）');
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
        exmr ? h('label', {class: 'check'}, bodyFix, '手と腕が体にめり込むコマを直す（ExMR のとき。このバージョンの体に合わせて腕を外へ出す。22 秒の動画で約 22 分増える）') : null,
        h('label', {class: 'check'}, depthOff, '全身の奥行き最適化を切る（MediaPipe のとき。剣など振りの速さを優先するとき）'),
        h('label', {}, '両手の間隔 cm（MediaPipe のとき。両手で持つ物があるとき。ダンスでは空のまま）', grip),
        h('p', {class: 'muted'}, `${char ? `${char.name}（${verId ?? 'バージョンなし'}）の体に合わせて VRMA を作る。ほかのキャラでも再生はできるが、足や手の位置がずれる。` : ''}${o.maxClipSec} 秒まで。URL の動画は「作る」を押したときだけ取りに行く。作ったモーションは個人利用として記録し、確認待ちの結果を見比べて「取り込んで次へ」を押すまで一覧に入らない。ラベルは下の欄（空ならファイル名）。`))));
  // 下書きに残す値と、読み直したときに戻す(public/motion-create.mjs)。手元のファイルはブラウザの決まりで戻せないので残さない
  const save = () => ({url: url.value, start: start.value, end: end.value, engine: engine.value, rights: rights.value, unmirror: unmirror.checked, speed: speed.value,
    crop: crop.value, depthOff: depthOff.checked, bodyFix: bodyFix.checked, grip: grip.value});
  const load = v => {
    for (const [el, x] of [[url, v.url], [start, v.start], [end, v.end], [rights, v.rights], [speed, v.speed], [crop, v.crop]]) if (x != null) el.value = x;
    if ([...engine.options].some(op => op.value === v.engine && !op.disabled)) engine.value = v.engine;
    unmirror.checked = !!v.unmirror; depthOff.checked = !!v.depthOff;
    sync();
    if (!bodyFix.disabled) bodyFix.checked = !!v.bodyFix;
    if (!grip.disabled && v.grip != null) grip.value = v.grip;
  };
  // 区間の帯に出す長さ。終了の秒が無ければ分からない
  const seconds = () => end.value === '' ? null : Math.max(0, Number(end.value) - Number(start.value || 0));
  return {el, queue, name, save, load, seconds, available: o.available && !!verId};
}

// 確認待ちの結果 1 件を、確認のモーダルの中身にする(public/motion-review.mjs の形)。比較の動画は左が元の動画、右がキャラに当てた VRMA
export function videoReview(j) {
  const r = j.result;
  const video = h('video', {controls: true, loop: true, muted: true, playsinline: true, src: r.compareUrl, 'aria-label': '元の動画とキャラに当てた結果の比較'});
  const slow = h('button', {type: 'button', class: 'toggle', 'aria-pressed': 'false', onclick: () => {
    const on = slow.getAttribute('aria-pressed') !== 'true'; slow.setAttribute('aria-pressed', String(on)); video.playbackRate = on ? 0.5 : 1;
  }}, '0.5 倍で見る');
  return {id: j.id, kind: '動画', label: r.label, motionId: 'video-' + j.id, api: `/api/video-motions/${encodeURIComponent(j.id)}`,
    media: h('figure', {class: 'review-video'}, video,
      h('figcaption', {class: 'review-media-foot'}, h('span', {class: 'muted'}, '左が元の動画、右がキャラに当てた結果。'), slow, h('a', {class: 'link', href: r.compareUrl, target: '_blank'}, '大きく開く'))),
    facts: [['長さ', `${Number(r.durationSec).toFixed(1)} 秒、${r.frames} コマ`], ['自動の判定', `${r.quality ?? '不明'}（目安。動画を見て決める）`], ['合わせた体', `${r.charName}（${r.verId}）`]],
    tag: {text: r.license?.summary ?? '', warn: true}, rightsNote: r.license?.rightsNote ?? ''};
}
