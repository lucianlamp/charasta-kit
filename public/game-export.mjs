// 「ゲーム用に書き出す」の欄(docs/game-export.md)。版の VRM から、ゲームに入れる軽い VRM と、その場で動く VRMA を作るジョブを積み、
// 書き出しの結果(三角形、primitive、meta の出どころ、モーションの記録)と各ファイルの落とし口を並べる。作者と利用条件は character.json の vrmMeta に保存する。
import {h, getJSON, send} from './dom.mjs';
import {enc, when} from './shared.mjs';

const USAGE = {
  commercialUsage: ['商用利用', {personalNonProfit: '個人の非営利のみ', personalProfit: '個人の営利まで', corporation: '法人も可'}],
  modification: ['改変', {prohibited: '禁止', allowModification: '改変可', allowModificationRedistribution: '改変と再配布も可'}],
  avatarPermission: ['アバターとして使える人', {onlyAuthor: '作者だけ', everyone: '誰でも', explicitlyLicensedPerson: '許可した人'}],
  creditNotation: ['クレジット表記', {required: '必要', unnecessary: '不要'}],
};
const SOURCE = {vrmMeta: '入力した値', model: 'model.vrm の値', record: '記録から', default: '既定値(最も制限が強い側)'};
const FIELD = {authors: '作者', allowRedistribution: '再配布', licenseUrl: 'ライセンスの URL', name: '名前', version: '版', ...Object.fromEntries(Object.entries(USAGE).map(([k, [label]]) => [k, label]))};
const url = (c, v) => `/api/characters/${enc(c)}/versions/${enc(v)}/game-exports`;
const num = n => Number(n).toLocaleString('ja-JP');
let timer = null;

export function gameExportPanel(char, ver, {jobsChanged = () => {}} = {}) {
  const body = h('div', {class: 'stack-small'}, h('p', {class: 'muted', role: 'status'}, '書き出しを読んでいる…'));
  const box = h('details', {class: 'check-box game-export'}, h('summary', {}, 'ゲーム用に書き出す'), body);
  let exports = [], motions = [], jobs = [], vrmMeta = char.vrmMeta ?? {}, msg = h('span', {class: 'muted', role: 'status'});
  const form = {motions: new Set(), target: '20000', skirt: '1.5,0.6,0.3', hair: ''};

  async function load() {
    try {
      [exports, motions, jobs] = await Promise.all([getJSON(url(char.id, ver.id)), motions.length ? motions : getJSON('/api/motions'), getJSON('/api/jobs')]);
      jobs = jobs.filter(j => j.type === 'game-export' && j.input.charId === char.id && j.input.verId === ver.id);
      vrmMeta = (await getJSON('/api/characters/' + enc(char.id))).vrmMeta ?? {};
    } catch (e) { body.replaceChildren(h('p', {class: 'err'}, '読めない: ' + e.message)); return; }
    draw();
    clearTimeout(timer);
    if (jobs.some(j => j.state === 'queued' || j.state === 'running') && box.isConnected) timer = setTimeout(load, 3000);
  }

  const springsOf = () => {
    const out = {};
    for (const key of ['skirt', 'hair']) {
      const text = form[key].trim();
      if (!text) continue;
      const v = text.split(',').map(Number);
      if (v.length !== 3 || v.some(Number.isNaN)) throw Error(`${key} は「硬さ,抵抗,重力」の数 3 つ`);
      out[key] = v;
    }
    return out;
  };

  function draw() {
    const active = jobs.find(j => j.state === 'queued' || j.state === 'running'), failed = jobs[0]?.state === 'failed' ? jobs[0] : null;
    const run = h('button', {type: 'button', class: 'primary', disabled: !!active}, active ? `${active.step}…` : '書き出す');
    run.onclick = async () => {
      run.disabled = true; msg.className = 'muted'; msg.textContent = '';
      try {
        await send('POST', '/api/jobs', {type: 'game-export', charId: char.id, verId: ver.id, motions: [...form.motions], target: Number(form.target), springs: springsOf()});
        jobsChanged(); await load();
      } catch (e) { msg.className = 'err'; msg.textContent = '積めない: ' + e.message; run.disabled = false; }
    };
    const text = (key, label, extra = {}) => h('label', {}, label, h('input', {type: 'text', value: form[key], oninput: e => { form[key] = e.target.value; }, ...extra}));
    body.replaceChildren(...[
      h('p', {class: 'muted'}, 'primitive をまとめ、三角形を減らし、揺れものを硬くし、画像を縮めた VRM と、選んだモーションの hips の水平の動きを消した VRMA を、この版の game/ に新しく作る。元の VRM は変えない。'),
      h('fieldset', {class: 'stack-small'}, h('legend', {}, 'モーション(その場にする)'),
        h('div', {class: 'chips'}, motions.map(m => h('label', {class: 'chip-btn'}, h('input', {type: 'checkbox', checked: form.motions.has(m.id), onchange: e => { e.target.checked ? form.motions.add(m.id) : form.motions.delete(m.id); }}), m.label || m.name || m.id)))),
      h('div', {class: 'actions'}, text('target', '目標の三角形', {inputmode: 'numeric', size: 8}), text('skirt', 'skirt(硬さ,抵抗,重力)', {size: 14}), text('hair', 'hair(空なら変えない)', {size: 14})),
      h('div', {class: 'actions'}, run, msg),
      failed ? h('p', {class: 'err'}, failed.error) : null,
      metaForm(),
      exports.length ? h('div', {class: 'stack-small'}, exports.map(exportView)) : h('p', {class: 'muted'}, 'この版の書き出しはまだない。')].filter(Boolean));
  }

  // 作者と利用条件。足りない欄はここで入れて vrmMeta に保存し、もう一度書き出す
  function metaForm() {
    const authors = h('input', {type: 'text', value: (vrmMeta.authors ?? []).join(', '), placeholder: '作者名(カンマ区切り)', 'aria-label': '作者'});
    const selects = Object.entries(USAGE).map(([k, [label, opts]]) => h('label', {}, label, h('select', {'data-key': k}, h('option', {value: ''}, '指定しない(model か既定値)'),
      Object.entries(opts).map(([v, t]) => h('option', {value: v, selected: vrmMeta[k] === v}, t)))));
    const redist = h('select', {'data-key': 'allowRedistribution'}, h('option', {value: ''}, '指定しない'), h('option', {value: 'true', selected: vrmMeta.allowRedistribution === true}, '再配布してよい'), h('option', {value: 'false', selected: vrmMeta.allowRedistribution === false}, '再配布不可'));
    const save = h('button', {type: 'button'}, '保存');
    save.onclick = async () => {
      const meta = {};
      const names = authors.value.split(',').map(s => s.trim()).filter(Boolean);
      if (names.length) meta.authors = names;
      for (const s of selects.map(l => l.querySelector('select'))) if (s.value) meta[s.dataset.key] = s.value;
      if (redist.value) meta.allowRedistribution = redist.value === 'true';
      try { await send('PATCH', '/api/characters/' + enc(char.id), {vrmMeta: Object.keys(meta).length ? meta : null}); msg.className = 'muted'; msg.textContent = '作者と利用条件を保存した。次の書き出しから使う'; }
      catch (e) { msg.className = 'err'; msg.textContent = '保存できない: ' + e.message; }
    };
    return h('details', {}, h('summary', {}, '作者と利用条件(meta)'),
      h('div', {class: 'stack-small'}, h('label', {}, '作者', authors), selects, h('label', {}, '再配布', redist), save));
  }

  function exportView(e) {
    const a = e.measure.after, b = e.measure.before, d = e.steps.decimate, meta = e.steps.meta;
    const row = (label, ...cells) => h('tr', {}, h('th', {scope: 'row'}, label), ...cells.map(c => h('td', {}, c)));
    return h('section', {class: 'card-box game-export-result', 'data-export': e.exportId},
      h('h3', {class: 'mono'}, e.exportId, ' ', h('span', {class: 'muted'}, when(e.createdAt))),
      h('table', {class: 'check-table'},
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, '元'), h('th', {}, '書き出し'))),
        h('tbody', {},
          row('三角形', num(b.triangles), `${num(a.triangles)}(目標 ${num(d.target)}${d.reached ? ' に届いた' : ' に届かない'})`),
          row('primitive', b.primitives, a.primitives), row('材質', b.materials, a.materials), row('表情', b.expressions, a.expressions), row('揺れものの joint', b.springJoints, a.springJoints),
          row('ファイル', `${(b.bytes / 1e6).toFixed(1)} MB`, `${(a.bytes / 1e6).toFixed(1)} MB`))),
      d.note ? h('p', {class: 'err'}, d.note) : null,
      h('ul', {class: 'check-list'}, e.steps.springs.map(s => h('li', {}, `揺れもの ${s.rule}: ${s.joints} joint を ${s.before.map(v => v.join('/')).join('、') || '(合うものなし)'} から ${s.after.join('/')}(硬さ/抵抗/重力)に`))),
      h('details', {}, h('summary', {}, `meta${meta.missing.length ? '(足りない欄あり)' : ''}`),
        h('ul', {class: 'check-list'}, Object.entries(meta.sources).map(([k, s]) => h('li', {class: meta.missing.includes(k) ? 'err' : ''}, `${FIELD[k] ?? k}: ${JSON.stringify(meta.values[k])} (${SOURCE[s]}${meta.missing.includes(k) ? '。未記入。上の欄で入れて、もう一度書き出す' : ''})`)))),
      ...e.warnings.map(w => h('p', {class: 'err'}, w)),
      h('div', {class: 'actions'}, h('a', {class: 'button', href: e.modelUrl, download: 'model-game.vrm'}, 'model-game.vrm'),
        ...e.motions.map(m => m.url ? h('a', {class: 'button', href: m.url, download: `${m.motionId}.vrma`, title: `水平の道のり ${m.removedTravel} m を消した。始点から終点の差 ${m.startToEnd} m、上下の幅 ${m.vertical} m`}, `${m.motionId}.vrma`) : h('span', {class: 'tag no'}, `${m.motionId}: ${m.skipped}`)),
        ...e.motions.filter(m => m.license && (m.license.redistribution === false || m.license.evaluationOnly)).map(m => h('span', {class: 'tag no'}, `${m.motionId}: ${m.license.evaluationOnly ? '評価専用' : '再配布不可'}`))));
  }

  load();
  return box;
}
