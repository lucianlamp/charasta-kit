// 表情の確認(docs/expression-studio.md の「シェイプキー方式の版の確認」): 版の顔の方式、プリセット 14 個、Fcl_ のキーのスライダー、視線、版どうしの比較、
// 確かめの撮影。作るのは with-kimi スキルで、この画面は見るだけ(版の VRM を変えない)。
import {h, getJSON, send} from './dom.mjs';
import {enc, when, sortVersions, viewerFrame, viewerReady} from './shared.mjs';

const METHOD = {shapekey: 'シェイプキー方式(Fcl_ のキー)', atlas: '顔画像の方式', other: 'そのほかの顔'};
const PRESET_LABEL = {neutral: 'ふだん', blink: 'まばたき', blinkLeft: '左まばたき', blinkRight: '右まばたき', happy: '笑顔', angry: '怒り', sad: '悲しみ', relaxed: '安らぎ', surprised: '驚き', aa: 'あ', ih: 'い', ou: 'う', ee: 'え', oh: 'お'};
const GROUPS = [['ALL', '全部'], ['BRW', '眉'], ['EYE', '目'], ['MTH', '口'], ['HA', '歯']];
const SETS = [['grid', '格子と表情'], ['keys', 'キー別'], ['motion', 'モーション']];
const KINDS = {grid: [['expr', '表情'], ['mouth', '口の形'], ['gaze', '視線'], ['eg', '表情と視線'], ['grid', '角度の表']], keys: [['key', 'キー']], motion: [['motion', 'コマ']]};
const faceUrl = (c, v) => `/api/characters/${enc(c)}/versions/${enc(v)}/face`;
const LOOK = /^look(Left|Right|Up|Down)$/;
const shortKey = k => k.replace(/(^|\+)[^+]*?Fcl_/g, '$1');   // 材質の前置きと Fcl_ を除いた表示の名前(前置きは lib/face-check.mjs の fclName)
let timer = null;

// ビューアの中の顔を、画面の状態にする。表情の自動の動きは切り、視線はカメラを追わせない
async function prepare(v, doc) {
  await v.prepareShot({motion: null});
  for (const id of ['autoBlink', 'autoExpr']) { const c = doc.getElementById(id); if (c) c.checked = false; }
  v.vrm.lookAt.target = null; v.shotExpression('neutral'); v.face(.5);
  const em = v.vrm.expressionManager, update = em.update.bind(em), ms = [];
  v.vrm.scene.traverse(o => { if (o.isMesh && o.morphTargetDictionary) ms.push(o); });
  const state = {preset: null, keys: {}};
  em.update = () => {
    // 視線が表情で動く版(lookAt.type: expression)は look の 4 つを lookAt が置くので、消さない
    for (const e of em.expressions) if (e.expressionName !== state.preset && !LOOK.test(e.expressionName)) em.setValue(e.expressionName, 0);
    if (state.preset && em.getExpression(state.preset)) em.setValue(state.preset, 1);
    for (const m of ms) m.morphTargetInfluences.fill(0);   // 割り当ての無いキーは update が戻さない
    update();
    for (const m of ms) for (const [k, w] of Object.entries(state.keys)) { const i = m.morphTargetDictionary[k]; if (i != null) m.morphTargetInfluences[i] = w; }
  };
  return {state};
}

export async function showFaceCheck({main, char, verId, alive, jobsChanged}) {
  clearTimeout(timer);
  if (!char || !verId) { main.replaceChildren(h('div', {class: 'empty page-empty'}, '版がまだない。')); return; }
  const charId = char.id;
  let info = await getJSON(faceUrl(charId, verId)), other = null, set = 'grid', kind = 'expr';
  const motions = await getJSON('/api/motions').catch(() => []);
  const frames = [], stage = h('div', {class: 'face-stage'}), checksBox = h('section', {class: 'stack', id: 'faceChecks'}), msg = h('span', {class: 'muted'});
  const look = {yaw: 0, pitch: 0};
  const state = {preset: 'neutral', keys: {}};

  async function each(fn) {
    for (const f of frames) if (f.ctl) await fn(f.ctl, f.v);
  }
  async function push() {
    await each((c, v) => {
      c.state.preset = state.preset; c.state.keys = state.keys;
      v.vrm.lookAt.yaw = look.yaw; v.vrm.lookAt.pitch = look.pitch;
      for (let i = 0; i < 2; i++) v.step(1 / 60);
    });
  }
  function addFrame(ver) {
    const el = viewerFrame(charId, ver), f = {el, ver};
    frames.push(f);
    const hold = h('figure', {class: 'face-frame', 'data-ver': ver}, h('div', {class: 'face-view'}, el), h('figcaption', {class: 'mono'}, ver));
    stage.append(hold);
    viewerReady(el).then(async v => { f.ctl = await prepare(v, el.contentDocument); f.v = v; await push(); }).catch(e => { msg.className = 'err'; msg.textContent = `${ver} を読めない: ${e.message}`; });
  }
  // ---- 左 ----
  const presetBtns = info.presets.map(p => h('button', {type: 'button', class: 'chip-btn', 'data-preset': p.name, 'aria-pressed': String(p.name === state.preset), title: p.keys.join('、') || '割り当てなし', disabled: !p.bound && p.name !== 'neutral',
    onclick: () => { state.preset = p.name; for (const b of presetBtns) b.setAttribute('aria-pressed', String(b === presetBtns[info.presets.indexOf(p)])); push(); }}, PRESET_LABEL[p.name]));
  const gazeSlider = (label, key, max) => {
    const out = h('span', {class: 'mono'}, '0°'), r = h('input', {type: 'range', min: -max, max, value: 0, step: 1, 'aria-label': label});
    r.oninput = () => { look[key] = Number(r.value); out.textContent = r.value + '°'; push(); };
    return h('label', {class: 'face-slider'}, h('span', {}, label), r, out);
  };
  const cmp = h('select', {'aria-label': '比べる版'}, h('option', {value: ''}, 'なし'), sortVersions(char).filter(v => v.id !== verId).map(v => h('option', {value: v.id}, v.id)));
  cmp.onchange = () => { if (frames[1]) { frames.pop(); stage.lastChild.remove(); } other = cmp.value || null; if (other) addFrame(other); };
  const resetBtn = h('button', {type: 'button'}, 'キーを戻す');
  resetBtn.onclick = () => { state.keys = {}; for (const s of sliders) { s.r.value = 0; s.out.textContent = '0'; } push(); };

  // ---- 右: キーのスライダー ----
  const sliders = [];
  const keyRow = k => {
    const out = h('span', {class: 'mono'}, '0'), r = h('input', {type: 'range', min: 0, max: 100, value: 0, step: 1, 'aria-label': k, 'data-key': k});
    r.oninput = () => { const w = Number(r.value) / 100; out.textContent = r.value; if (w) state.keys[k] = w; else delete state.keys[k]; push(); };
    sliders.push({k, r, out});
    return h('label', {class: 'face-slider key'}, h('span', {class: 'mono'}, shortKey(k)), r, out);
  };
  const keysBox = info.keys.length ? GROUPS.map(([g, label], i) => {
    const mine = info.keys.filter(k => k.includes(`Fcl_${g}_`));
    return mine.length ? h('details', {open: i < 3}, h('summary', {}, `${label}(${mine.length})`), mine.map(keyRow)) : null;
  }) : h('div', {class: 'muted'}, 'この版に Fcl_ のキーは無い。プリセットと視線だけ確かめられる。');

  // ---- 確かめの撮影 ----
  const motionSel = h('select', {'aria-label': 'モーション'}, motions.map(m => h('option', {value: m.id}, m.label ?? m.name ?? m.id)));
  let jobs = [];
  function poll(busy) {
    clearTimeout(timer);
    if (busy && alive()) timer = setTimeout(() => { if (alive()) renderChecks(); }, 3000);
  }
  // ジョブを先に読む(撮り終えた直後に、古い撮影と「終わった」が組になるのを避ける)。読めないときは読み直しを続ける(サーバーの再起動)
  async function renderChecks() {
    try {
      jobs = (await getJSON('/api/jobs')).filter(j => j.type === 'face-check' && j.input.charId === charId && j.input.verId === verId);
      info = await getJSON(faceUrl(charId, verId));
    } catch (e) { msg.className = 'err'; msg.textContent = '読み直せない: ' + e.message; poll(true); return; }
    if (!alive()) return;
    if (msg.className === 'err' && msg.textContent.startsWith('読み直せない')) { msg.className = 'muted'; msg.textContent = ''; }
    drawChecks();
  }
  function drawChecks() {
    const active = s => jobs.find(j => j.input.set === s && (j.state === 'queued' || j.state === 'running'));
    const latest = jobs.find(j => j.input.set === set), failed = latest?.state === 'failed' ? latest : null;   // 一覧は新しい順
    const cur = info.checks[set], kinds = KINDS[set];
    if (!kinds.some(k => k[0] === kind)) kind = kinds[0][0];
    const list = (cur?.images ?? []).filter(i => i.kind === kind);
    const run = h('button', {type: 'button', class: 'primary', disabled: !!active(set) || (set === 'keys' && !info.keys.length) || (set === 'motion' && (!motions.length || info.vrm === 0))}, active(set) ? (active(set).step ?? '撮っている') : cur ? '撮り直す' : '撮る');
    run.onclick = async () => {
      run.disabled = true; msg.className = 'muted'; msg.textContent = '';
      try { await send('POST', '/api/jobs', {type: 'face-check', charId, verId, set, ...(set === 'motion' ? {motionId: motionSel.value} : {})}); jobsChanged(); await renderChecks(); }
      catch (e) { msg.className = 'err'; msg.textContent = '積めない: ' + e.message; run.disabled = false; }
    };
    checksBox.replaceChildren(...[
      h('div', {class: 'page-head'}, h('h2', {}, `確かめの撮影(${verId})`)),
      h('div', {class: 'chips', role: 'group', 'aria-label': '撮影の種類'}, SETS.map(([k, label]) => h('button', {type: 'button', class: 'chip-btn', 'data-set': k, 'aria-pressed': String(k === set), onclick: () => { set = k; drawChecks(); }}, info.checks[k] ? `${label} ${info.checks[k].count}` : label))),
      h('div', {class: 'actions'}, set === 'motion' ? motionSel : null, run, msg),
      set === 'motion' && info.vrm === 0 ? h('div', {class: 'muted'}, 'VRM 0 の版はモーションで撮れない(前後が逆になる)。VRM 1 へ変換して版にしてから撮る。') : null,
      cur ? h('div', {class: 'muted'}, [when(cur.at), cur.motionId ? `モーション ${cur.motionId}` : null, set !== 'motion' ? null : cur.hair ? `髪が顔の内側へ入る頂点 最大 ${cur.hair.worstVerts}、深さ ${cur.hair.maxDepthMm} mm` : '髪は測れなかった'].filter(Boolean).join('・')) : null,
      failed ? h('div', {class: 'err'}, failed.error) : null,
      kinds.length > 1 ? h('div', {class: 'chips', role: 'group', 'aria-label': '撮影の中の分類'}, kinds.map(([k, label]) => { const n = (cur?.images ?? []).filter(i => i.kind === k).length;
        return h('button', {type: 'button', class: 'chip-btn', 'aria-pressed': String(k === kind), onclick: () => { kind = k; drawChecks(); }}, n ? `${label} ${n}` : label); })) : null,
      list.length ? h('div', {class: 'thumbs checks'}, list.map(i => h('a', {href: i.url, target: '_blank'}, h('img', {src: i.url, loading: 'lazy', alt: i.name}), h('span', {}, shortKey(i.key ?? i.name))))) : h('div', {class: 'empty small'}, 'まだ撮っていない。')].filter(Boolean));
    poll(jobs.some(j => j.state === 'queued' || j.state === 'running'));
  }

  main.replaceChildren(h('div', {class: 'work'},
    h('aside', {class: 'pane pane-left pane-steps', 'aria-label': '顔の情報と操作'},
      h('h1', {}, '表情の確認'),
      h('div', {class: 'stack-small'}, h('div', {}, h('span', {class: 'tag ' + (info.method === 'shapekey' ? 'yes' : ''), 'data-method': info.method}, METHOD[info.method])),
        h('div', {class: 'muted'}, [info.vrm === 0 ? 'VRM 0.x' : null, `キー ${info.keys.length} 個`, info.lookAt ? `視線 ${info.lookAt === 'bone' ? '目の骨' : '表情'}` : null].filter(Boolean).join('・'))),
      h('h2', {}, 'プリセット'), h('div', {class: 'chips face-presets'}, presetBtns),
      h('h2', {}, '視線'), gazeSlider('左右', 'yaw', 30), gazeSlider('上下', 'pitch', 20),
      h('h2', {}, '比べる'), h('label', {}, '比べる版', cmp),
      info.method !== 'shapekey' ? h('a', {href: `#expression/${enc(charId)}`}, '表情づくりへ') : null),
    h('section', {class: 'center page-body'}, stage, checksBox),
    h('aside', {class: 'pane pane-right', 'aria-label': 'シェイプキー'}, h('div', {class: 'page-head'}, h('h2', {}, 'シェイプキー'), resetBtn), keysBox)));
  addFrame(verId);   // viewerReady は画面に載った iframe を待つので、載せてから足す
  await renderChecks();
}
