// 体型と揺れもの(#adjust/<キャラ>[/<バージョン>]、仕上げの工程の中の画面。docs/adjust.md)。
//   左(広い画面)はビューア。つまみを動かすと、読み込んだ VRM のまま下見する(window.viewer.bodyPreview、springPreview)。直す前と直した後を切り替えて見る
//   右は 体型 / 揺れもの / Claude に依頼する の札。保存はジョブ adjust で、いつも新しいバージョンを作る(元のバージョンは変えない)
//   値と計算は public/adjust-plan.mjs(サーバーと同じもの)。DOM は showAdjust を呼んだときだけ使う
import {h, getJSON, send} from './dom.mjs';
import {AGENT, enc, when, viewerFrame, viewerReady, watchJobs, pendingRow, sortVersions} from './shared.mjs';
import {confirmDialog} from './confirm.mjs';
import {BODY_FIELDS, BODY_NEUTRAL, SPRING_FIELDS, bodyChanged, bodySummary, springJointValues, springsChanged, springSummary} from './adjust-plan.mjs';

export const AREAS = {body: '体型', springs: '揺れもの', other: 'その他'};
export const REQUEST_STATE = {waiting: '対応待ち', working: '作業中', done: '完了', declined: '見送り'};
const TABS = () => [['body', '体型'], ['springs', '揺れもの'], ['ask', `${AGENT.ni}依頼する`]];

// まだ無いバージョン ID(v<バージョンの数 + 1>-adjust、重なれば -2、-3 …)
export function nextVersionId(versions) {
  const ids = new Set(versions.map(v => v.id)), base = `v${versions.length + 1}-adjust`;
  for (let i = 1; ; i++) { const id = i === 1 ? base : `${base}-${i}`; if (!ids.has(id)) return id; }
}

// 変えた組の joint ごとの値をまとめる(ビューアの springPreview に渡す)
export function springPreviewValues(groups, springs) {
  return Object.assign({}, ...springsChanged(groups, springs).map(g => springJointValues(g, springs[g.key])));
}

const fieldText = (f, v) => f.unit === '倍' ? `${Number(v).toFixed(2)} 倍` : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} cm`;

function slider({label, value, min, max, step, text, hint, onInput}) {
  const out = h('span', {class: 'mono adjust-value'}, text(value));
  const r = h('input', {type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label});
  r.oninput = () => { out.textContent = text(Number(r.value)); onInput(Number(r.value)); };
  const row = h('div', {class: 'adjust-slider'}, h('div', {class: 'adjust-slider-head'}, h('span', {}, label), out), r, hint ? h('span', {class: 'muted small'}, hint) : null);
  row.set = v => { r.value = String(v); out.textContent = text(v); };
  return row;
}

export async function showAdjust({main, char, verId, alive, jobsChanged}) {
  if (!char) { main.replaceChildren(h('div', {class: 'empty page-empty'}, 'キャラがまだない。')); return; }
  const c = await getJSON('/api/characters/' + enc(char.id));
  const ver = c.versions.find(v => v.id === verId);
  if (!ver) { main.replaceChildren(h('div', {class: 'empty page-empty'}, `${c.name} にはバージョンがまだない。つくるの画面で取り込む。`)); return; }
  const [info, motions] = await Promise.all([getJSON(`/api/characters/${enc(c.id)}/versions/${enc(ver.id)}/adjust`), getJSON('/api/motions').catch(() => [])]);
  const groups = info.springs.groups;
  let body = {...BODY_NEUTRAL}, springs = {}, before = false, tab = 'body', viewer = null;

  // ---- ビューア ----
  const frame = viewerFrame(c.id, ver.id, motions[0] ? {motion: motions[0].id} : {});
  const apply = () => {
    if (!viewer) return;
    viewer.bodyPreview(before || !bodyChanged(body) ? null : body);
    viewer.springPreview(before ? null : springPreviewValues(groups, springs));
  };
  const look = h('div', {class: 'chips', role: 'group', 'aria-label': '見比べ'}, [['after', '直した後'], ['before', '直す前']].map(([k, label]) =>
    h('button', {type: 'button', class: 'chip-btn', 'data-look': k, 'aria-pressed': String(k === 'after'), onclick: () => {
      before = k === 'before'; look.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.look === k))); apply();
    }}, label)));
  const motionSel = motions.length ? h('select', {'aria-label': 'モーション', onchange: e => viewer?.play(e.target.value)}, motions.map(m => h('option', {value: m.id}, m.label || m.name || m.id))) : null;
  const foot = h('div', {class: 'stage-foot adjust-foot'}, look,
    motionSel ? h('label', {class: 'adjust-motion'}, h('span', {class: 'muted'}, 'モーション'), motionSel) : h('span', {class: 'muted'}, 'モーションの画面でモーションを追加すると、揺れをモーションで見られる'),
    h('span', {class: 'muted adjust-note'}, '下見は近い見た目。保存すると新しいバージョンのファイルに書き込む。'));

  // ---- 体型 ----
  const bodyRows = BODY_FIELDS.map(f => slider({label: f.label, value: f.neutral, min: f.min, max: f.max, step: f.step, text: v => fieldText(f, v),
    onInput: v => { body = {...body, [f.key]: v}; apply(); syncSave(); }}));
  const bodyReset = h('button', {type: 'button', onclick: () => { body = {...BODY_NEUTRAL}; bodyRows.forEach((r, i) => r.set(BODY_FIELDS[i].neutral)); apply(); syncSave(); }}, '体型を元に戻す');
  const bodyBox = info.body.available ? h('div', {class: 'form-stack'}, h('p', {class: 'muted'}, '腕、腰、脚の太さは長さを変えない。首と肩幅は cm で、肩幅は片側の量。'), bodyRows, bodyReset)
    : h('p', {class: 'err', role: 'status'}, '体型はこのバージョンでは直せない: ' + info.body.reason);

  // ---- 揺れもの ----
  const springRows = [];
  const springBox = info.springs.available ? h('div', {class: 'form-stack'}, h('p', {class: 'muted'}, '組ごとの値。根元と先などの差は、元の比のまま保つ。'),
    groups.map(g => {
      const rows = SPRING_FIELDS.map(f => slider({label: f.label, value: g.values[f.key], min: f.min, max: Math.max(f.max, g.values[f.key]), step: f.step, hint: f.hint, text: v => Number(v).toFixed(2),
        onInput: v => { springs = {...springs, [g.key]: {...g.values, ...springs[g.key], [f.key]: v}}; apply(); syncSave(); }}));
      springRows.push([g, rows]);
      return h('details', {class: 'adjust-group', open: groups.length <= 2}, h('summary', {}, `${g.label}（${g.count} 本）`), h('div', {class: 'form-stack'}, rows));
    }),
    h('button', {type: 'button', onclick: () => { springs = {}; springRows.forEach(([g, rows]) => rows.forEach((r, i) => r.set(g.values[SPRING_FIELDS[i].key]))); apply(); syncSave(); }}, '揺れものを元に戻す'))
    : h('p', {class: 'err', role: 'status'}, '揺れものはこのバージョンでは直せない: ' + info.springs.reason);

  // ---- 新しいバージョンとして保存 ----
  const summary = h('p', {class: 'adjust-summary'});
  const verInput = h('input', {value: nextVersionId(c.versions), 'aria-label': 'バージョンの ID', autocomplete: 'off'});
  const labelInput = h('input', {placeholder: '空なら「体型を直した」など', maxlength: '60', 'aria-label': '見出し'});
  const latest = h('input', {type: 'checkbox', checked: true});
  const msg = h('p', {class: 'muted', role: 'status'}), save = h('button', {type: 'button', class: 'primary big'}, '新しいバージョンとして保存');
  const pending = h('div', {class: 'pending-list'});
  function syncSave() {
    const text = [bodySummary(body), springSummary(groups, springs)].filter(Boolean).join('。');
    summary.textContent = text ? `変えたこと: ${text}` : 'まだ何も変えていない。つまみを動かすと、ここに変えたことが出る。';
    save.disabled = !text;
  }
  const watcher = watchJobs({filter: j => j.type === 'adjust' && j.input?.charId === c.id, limit: 3, alive, onJobs: jobs => pending.replaceChildren(...jobs.map(pendingRow)),
    onDone: async () => {
      jobsChanged();
      const done = (await getJSON('/api/jobs')).find(j => j.type === 'adjust' && j.input?.charId === c.id && j.state === 'done');
      if (done?.result) msg.replaceChildren(...[`バージョン ${done.result.verId} を作った。`, h('a', {href: `#adjust/${enc(c.id)}/${enc(done.result.verId)}`}, '新しいバージョンを開く'),
        done.result.warnings?.length ? h('span', {class: 'err'}, ' ' + done.result.warnings.join('。')) : null].filter(Boolean));
    }});
  save.onclick = async () => {
    save.disabled = true; msg.className = 'muted'; msg.textContent = '送っている…';
    try {
      const job = await send('POST', '/api/jobs', {type: 'adjust', charId: c.id, verId: ver.id, newVerId: verInput.value.trim(), label: labelInput.value.trim(), latest: latest.checked,
        ...(bodyChanged(body) && {body: Object.fromEntries(BODY_FIELDS.filter(f => body[f.key] !== f.neutral).map(f => [f.key, body[f.key]]))}),
        springs: Object.fromEntries(springsChanged(groups, springs).map(g => [g.key, springs[g.key]]))});
      msg.textContent = `受け付けた。バージョン ${job.input.newVerId} を作っている（元のバージョン ${ver.id} はそのまま）。`;
      watcher.queued(job); jobsChanged();
    } catch (e) { msg.className = 'err'; msg.textContent = '保存できない: ' + e.message; save.disabled = false; }
  };
  const saveBox = h('section', {class: 'form-stack sep', 'aria-label': '新しいバージョンとして保存'}, h('h2', {}, '新しいバージョンとして保存'), summary,
    h('details', {}, h('summary', {}, 'バージョンの ID と見出し'), h('div', {class: 'form-stack'}, h('label', {}, 'バージョンの ID', verInput), h('label', {}, '見出し', labelInput))),
    h('label', {class: 'check'}, latest, '最新バージョンにする'), save, msg, pending);

  // ---- Claude に依頼する ----
  const askBox = h('div', {class: 'form-stack'});
  async function renderAsk(note = null) {
    const {requests} = await getJSON('/api/adjust-requests?char=' + enc(c.id));
    const area = h('select', {'aria-label': 'どこを直すか'}, Object.entries(AREAS).map(([k, v]) => h('option', {value: k}, v)));
    area.value = tab === 'springs' ? 'springs' : 'body';
    const text = h('textarea', {rows: '4', maxlength: '1000', placeholder: '例: 走るとスカートがめくれすぎる。もう少し重くしてほしい。'});
    const shot = h('input', {type: 'checkbox', checked: true}), m = h('p', {class: 'muted', role: 'status'}, note ?? ''), go = h('button', {type: 'button', class: 'primary'}, '依頼する');
    go.onclick = async () => {
      if (!text.value.trim()) { m.className = 'err'; m.textContent = '直してほしいことを書く'; return; }
      go.disabled = true; m.className = 'muted'; m.textContent = '送っている…';
      try {
        const r = await send('POST', '/api/adjust-requests', {charId: c.id, verId: ver.id, area: area.value, text: text.value});
        let failed = null;
        if (shot.checked && viewer) {
          const blob = await (await fetch(viewer.snapshot())).blob();
          const up = await fetch(`/api/adjust-requests/${enc(r.id)}/shot`, {method: 'POST', body: blob});
          if (!up.ok) failed = (await up.json().catch(() => ({}))).error ?? String(up.status);
        }
        await renderAsk(failed ? `依頼は送った。絵は送れなかった: ${failed}` : `依頼を送った。${AGENT.ga}直して新しいバージョンを作ると、ここに返事が出る。`);
      } catch (e) { m.className = 'err'; m.textContent = '送れない: ' + e.message; go.disabled = false; }
    };
    askBox.replaceChildren(
      h('p', {class: 'muted'}, `つまみで直せないことや、どう直せばよいか分からないことを書くと、${AGENT.ga}直して新しいバージョンを作る。`),
      h('label', {}, 'どこを直すか', area), h('label', {}, '直してほしいこと', text),
      h('label', {class: 'check'}, shot, '今のビューアの絵を付ける'), h('div', {class: 'actions'}, go), m,
      h('h2', {}, `依頼したこと（${requests.length}）`),
      requests.length ? h('ul', {class: 'adjust-req-list'}, requests.map(r => requestRow(r, c, () => renderAsk()))) : h('p', {class: 'empty small'}, 'まだ依頼していない。'));
  }

  // ---- 札と組み立て ----
  const right = h('div', {class: 'form-stack'});
  const tabs = h('div', {class: 'chips', role: 'group', 'aria-label': '直すもの'}, TABS().map(([k, label]) => h('button', {type: 'button', class: 'chip-btn', 'data-tab': k, 'aria-pressed': String(k === tab),
    onclick: () => { tab = k; tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === k))); renderRight(); }}, label)));
  function renderRight() {
    if (tab === 'ask') { right.replaceChildren(askBox); renderAsk(); return; }
    right.replaceChildren(tab === 'body' ? bodyBox : springBox, saveBox);
  }
  syncSave(); renderRight();
  const others = sortVersions(c).filter(v => v.id !== ver.id).length;
  main.replaceChildren(h('div', {class: 'work adjust-work'},
    h('section', {class: 'center'}, h('div', {class: 'stage'}, frame), foot),
    h('aside', {class: 'pane pane-right', 'aria-label': '体型と揺れもの'},
      h('div', {class: 'page-head'}, h('h1', {}, '体型と揺れもの'), h('span', {class: 'mono muted'}, ver.id)),
      h('p', {class: 'muted'}, `${c.name} のバージョン ${ver.id} を元に直す。保存すると新しいバージョンになり、このバージョンは変わらない。${others ? 'ほかのバージョンは上の切り替えで選ぶ。' : ''}`),
      tabs, right)));
  viewerReady(frame).then(v => { viewer = v; apply(); });   // 画面に入れたあとに待つ(入れる前は待たずに終わる)
  await watcher.poll();
}

function requestRow(r, c, reload) {
  const cancel = r.state === 'waiting' ? h('button', {type: 'button'}, '取り下げる') : null;
  if (cancel) cancel.onclick = () => confirmDialog({title: '依頼を取り下げる', body: [h('p', {}, '依頼と付けた絵を消す。戻せない。')], confirm: '取り下げる',
    run: () => send('DELETE', `/api/adjust-requests/${enc(r.id)}`)}).then(ok => ok && reload());
  const link = r.state === 'done' && r.newVersion ? h('a', {class: 'button', href: `#adjust/${enc(c.id)}/${enc(r.newVersion)}`}, `バージョン ${r.newVersion} を見る`) : null;
  return h('li', {class: 'stage-req'},
    h('div', {class: 'stage-req-head'}, h('span', {class: `chip state-${r.state}`}, REQUEST_STATE[r.state] ?? r.state), h('strong', {}, AREAS[r.area] ?? r.area), h('span', {class: 'mono muted'}, r.verId), h('span', {class: 'muted'}, when(r.createdAt))),
    h('p', {class: 'stage-req-desc'}, r.text),
    r.shotUrl ? h('div', {class: 'stage-req-refs'}, h('a', {href: r.shotUrl, target: '_blank', rel: 'noopener'}, h('img', {src: r.shotUrl, alt: '依頼したときの見た目', loading: 'lazy'}))) : null,
    r.reply ? h('div', {class: 'stage-req-reply'}, h('span', {class: 'muted'}, `返事（${when(r.repliedAt)}）`), h('p', {}, r.reply)) : null,
    link || cancel ? h('div', {class: 'stage-req-actions'}, link, cancel) : null);
}
