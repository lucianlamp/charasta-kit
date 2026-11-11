// ステージの画面(#stages[/<シーン>]): stage-studio のシーンの一覧と、選んだシーンの大きい絵、使えるもの、使っているショートと MV(docs/screens.md の「ステージ」)。
//   シーンは読むだけ。新しいシーンは「新しいステージを頼む」でエージェントに頼む(docs/stages.md、/api/stage-requests)
//   一覧は GET /api/stages(lib/stages.mjs の stageOverview)
//   DOM は showStages を呼んだときだけ使う(テストが読み込める)
import {h, getJSON, send} from './dom.mjs';
import {confirmDialog} from './confirm.mjs';
import {AGENT, enc, thumb, when} from './shared.mjs';
import {can, missingNote} from './capabilities.mjs';
import {KIND_LABEL, camerasFor} from './short-camera.mjs';
import {STYLE_LABEL} from './short-direct.mjs';

// 使っている動画の数の 1 行。無ければ「まだ使っていない」
export function usageText(stage) {
  const parts = [stage.shorts.length ? `ショート ${stage.shorts.length} 本` : '', stage.mvs.length ? `MV ${stage.mvs.length} 本` : ''].filter(Boolean);
  return parts.length ? parts.join('・') : 'まだ使っていない';
}

// 使えるもの: 動画の種類ごとのカメラの数(public/short-camera.mjs)。カメラはシーンで変わらないので、どのシーンも同じ表になる。
// creature: 生き物を使えるか(キットは使えない)
export const stageSupports = creature => ['talk', 'walk', ...(creature ? ['creature'] : []), 'dance'].map(kind => ({kind, label: KIND_LABEL[kind], cameras: camerasFor(kind).length}));

// ショートの行の 2 行目: 型と、歩く 1 テイクか
const shortNote = s => [s.style === 'dance' ? 'ダンス MV' : STYLE_LABEL[s.style] ?? s.style, s.take ? KIND_LABEL.walk : null, when(s.updatedAt)].filter(Boolean).join('・');

function detail(stage, ov) {
  const pic = stage.thumb ? h('img', {class: 'stage-big', src: stage.thumb, alt: `${stage.label} のサムネイル`}) : h('div', {class: 'stage-big none'}, 'サムネイルなし');
  const uses = [
    ...stage.shorts.map(s => h('a', {class: 'stage-use', href: `#short/${enc(s.id)}`},
      h('span', {class: 'chip'}, 'ショート'), h('span', {class: 'stage-use-text'}, h('span', {}, s.title || s.id), h('span', {class: 'muted'}, shortNote(s))))),
    ...stage.mvs.map(m => h('a', {class: 'stage-use', href: '#gallery'},
      h('span', {class: 'chip'}, m.quality === 'preview' ? 'MV の試し' : 'MV'), h('span', {class: 'stage-use-text'}, h('span', {}, [m.charName ?? m.charId, m.verId].filter(Boolean).join('・')), h('span', {class: 'muted'}, when(m.createdAt))))),
  ];
  return h('section', {class: 'stage-detail', 'aria-label': `${stage.label} の詳しい情報`},
    h('div', {class: 'stage-detail-head'}, h('h2', {}, stage.label), h('span', {class: 'mono muted'}, stage.id)),
    h('div', {class: 'stage-big-box'}, pic),
    stage.thumb ? null : h('p', {class: 'muted'}, 'このステージにはまだ見本の絵がない。'),
    h('h3', {}, '使えるもの'),
    h('dl', {class: 'stage-supports'}, stageSupports(can(ov, 'creature')).flatMap(x => [h('dt', {}, x.label), h('dd', {}, `カメラ ${x.cameras} 種`)])),
    h('p', {class: 'muted'}, 'カメラの種類はどのステージでも同じ。'),
    h('h3', {}, `使っている動画（${usageText(stage)}）`),
    uses.length ? h('div', {class: 'stage-uses'}, uses) : h('p', {class: 'empty small'}, 'このステージを使うショートと MV はまだない。'));
}

// ---- 新しいステージの頼みごと(docs/stages.md)。作るのはエージェントで、画面は頼む・取り下げる・結果を見るだけ ----
export const REQUEST_STATE = {waiting: '対応待ち', working: '作業中', done: '完了', declined: '見送り'};
const MAX_REFS = 4, MAX_REF_BYTES = 8 * 1024 * 1024;   // lib/stage-requests.mjs と同じ

// 送る前に参考の絵を確かめる。問題が無ければ null
export function refsProblem(files) {
  if (files.length > MAX_REFS) return `参考の絵は ${MAX_REFS} 枚まで`;
  const big = files.find(f => f.size > MAX_REF_BYTES);
  if (big) return `${big.name} が大きすぎる（1 枚 ${MAX_REF_BYTES / 1048576} MB まで）`;
  const other = files.find(f => !/^image\/(png|jpeg|webp)$/.test(f.type));
  return other ? `${other.name} は PNG、JPEG、WebP ではない` : null;
}

async function uploadRef(id, file) {
  const r = await fetch(`/api/stage-requests/${enc(id)}/refs`, {method: 'POST', headers: {'x-filename': enc(file.name)}, body: file}), j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || String(r.status));
}

function requestForm(onSent) {
  const name = h('input', {maxlength: '40', placeholder: '例: 夏の浜辺', autocomplete: 'off'});
  const desc = h('textarea', {maxlength: '1000', rows: '5', placeholder: '例: 昼の砂浜。奥に海の家と岩場があり、波打ち際で踊れる広さがほしい。'});
  const count = h('span', {class: 'muted'}, '0 / 1000');
  const files = h('input', {type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true});
  const msg = h('p', {class: 'muted', role: 'status'}), go = h('button', {type: 'submit', class: 'primary'}, '依頼する'), close = h('button', {type: 'button'}, 'やめる');
  desc.oninput = () => { count.textContent = `${desc.value.length} / 1000`; };
  const form = h('form', {class: 'stage-req-form form-stack', hidden: true, 'aria-label': '新しいステージを依頼'},
    h('p', {class: 'muted'}, `作ってほしいステージを書いて送ると、${AGENT.ga}作ってステージの一覧に追加する。できたら下の「依頼したステージ」に返事が出る。`),
    h('label', {}, '名前', name),
    h('label', {}, h('span', {class: 'stage-req-label'}, 'どんな場所か', count), desc),
    h('label', {}, '参考の絵（任意。4 枚まで、1 枚 8 MB まで）', files),
    msg, h('div', {class: 'stage-req-actions'}, close, go));
  close.onclick = () => { form.hidden = true; };
  form.onsubmit = async e => {
    e.preventDefault();
    const picked = [...files.files], problem = !name.value.trim() ? '名前を書く' : !desc.value.trim() ? 'どんな場所かを書く' : refsProblem(picked);
    if (problem) { msg.className = 'err'; msg.textContent = problem; return; }
    go.disabled = true; msg.className = 'muted'; msg.textContent = '送っている…';
    try {
      const req = await send('POST', '/api/stage-requests', {label: name.value, description: desc.value});
      const failed = [];
      for (const f of picked) await uploadRef(req.id, f).catch(err => failed.push(`${f.name}(${err.message})`));
      onSent(failed.length ? `依頼は送った。送れなかった絵: ${failed.join('、')}` : null);
    } catch (err) { msg.className = 'err'; msg.textContent = '送れない: ' + err.message; go.disabled = false; }
  };
  return form;
}

function requestRow(r, stages, reload) {
  const stage = stages.find(s => s.id === r.stageId);
  const cancel = r.state === 'waiting' ? h('button', {type: 'button'}, '取り下げる') : null;
  if (cancel) cancel.onclick = () => confirmDialog({title: `「${r.label}」を取り下げる`, body: [h('p', {}, '依頼と参考の絵を消す。戻せない。')], confirm: '取り下げる',
    run: () => send('DELETE', `/api/stage-requests/${enc(r.id)}`)}).then(ok => ok && reload());
  const link = r.state === 'done' && r.stageId ? h('a', {class: 'button', href: `#stages/${enc(r.stageId)}`}, stage ? `「${stage.label}」を見る` : 'できたステージを見る') : null;
  return h('li', {class: 'stage-req'},
    h('div', {class: 'stage-req-head'}, h('span', {class: `chip state-${r.state}`}, REQUEST_STATE[r.state] ?? r.state), h('strong', {}, r.label), h('span', {class: 'muted'}, when(r.createdAt))),
    h('p', {class: 'stage-req-desc'}, r.description),
    r.refs.length ? h('div', {class: 'stage-req-refs'}, r.refs.map((f, i) => h('a', {href: f.url, target: '_blank', rel: 'noopener'}, h('img', {src: f.url, alt: `参考の絵 ${i + 1}`, loading: 'lazy'})))) : null,
    r.reply ? h('div', {class: 'stage-req-reply'}, h('span', {class: 'muted'}, `返事（${when(r.repliedAt)}）`), h('p', {}, r.reply)) : null,
    link || cancel ? h('div', {class: 'stage-req-actions'}, link, cancel) : null);
}

export async function showStages({main, ov}, pickedId, sentNote = null) {
  const data = await getJSON('/api/stages');
  if (!data.configured) {
    const note = missingNote(ov, ['stageStudio']) ?? h('p', {class: 'err', role: 'status'}, 'stage-studio の場所が設定されていない（設定の stageStudioDir）');
    main.replaceChildren(h('div', {class: 'stages-page'}, h('div', {class: 'page-head'}, h('h1', {}, 'ステージ')), note));
    return;
  }
  const {requests} = await getJSON('/api/stage-requests');
  const picked = data.stages.find(s => s.id === pickedId) ?? data.stages[0];
  const reload = note => showStages({main, ov}, picked?.id, note);
  const form = requestForm(note => reload(note ?? '依頼を送った。').then(() => main.querySelector('.stage-reqs')?.scrollIntoView({block: 'start'})));
  const ask = h('button', {type: 'button', class: 'primary', 'aria-expanded': 'false'}, '新しいステージを依頼');
  ask.onclick = () => { form.hidden = !form.hidden; ask.setAttribute('aria-expanded', String(!form.hidden)); if (!form.hidden) form.querySelector('input')?.focus(); };
  const card = s => h('a', {class: 'stage-card', href: `#stages/${enc(s.id)}`, 'aria-current': s.id === picked.id ? 'true' : null},
    thumb(s.thumb, '', 'stage-thumb'),
    h('span', {class: 'stage-card-text'}, h('span', {class: 'stage-card-name'}, s.label), h('span', {class: 'mono muted'}, s.id), h('span', {class: 'muted'}, usageText(s))));
  const reqs = h('section', {class: 'stage-reqs', 'aria-label': '依頼したステージ'},
    h('h2', {}, `依頼したステージ（${requests.length}）`),
    sentNote ? h('p', {class: 'muted', role: 'status'}, sentNote) : null,
    requests.length ? h('ul', {class: 'stage-req-list'}, requests.map(r => requestRow(r, data.stages, () => reload()))) : h('p', {class: 'empty small'}, 'まだ依頼していない。'));
  main.replaceChildren(h('div', {class: 'stages-page'},
    h('div', {class: 'page-head'}, h('h1', {}, 'ステージ'), ask),
    form,
    picked ? [h('p', {class: 'muted'}, `ステージ ${data.stages.length} 個。ショートと MV の舞台に使う。`),
      h('div', {class: 'stages-body'},
        h('nav', {class: 'stage-list', 'aria-label': 'ステージ'}, data.stages.map(card)),
        detail(picked, ov))]
      : h('p', {class: 'empty'}, 'ステージがまだない。「新しいステージを依頼」で作ってもらえる。'),
    reqs));
}
