// ダンス MV(ショートの型 dance)の画面: 編集画面の「曲とシーン」の欄と、#mv/<キャラ>[/<バージョン>] からショートを作る入口。docs/shorts-dance-mv.md、docs/shorts-dance-mv.md の「ショート」。
//   シーンを選ぶボタンとカット割りの帯は、前の MV を撮る画面(public/mv.mjs、消した)のものを移した
import {getJSON, h, send} from './dom.mjs';
import {enc, optionName} from './shared.mjs';
import {missingNote} from './capabilities.mjs';
import {MAX_SECONDS} from './shoot-plan.mjs';
import {BEATS_PER_SHOT, DANCE_MUSIC_DEFAULTS, DANCE_SECONDS, GRAPHIC_PALETTES, GRAPHIC_QUALITIES, MV_QUALITIES, beatCutsBody, danceCutBounds, danceEdits, danceFieldsFor, danceShortBody, danceSplitOf, danceTotal, graphicCutsBody, graphicEstimateSec, graphicShares, graphicWords, looksSplitApart, mvCuts, mvEstimateSec, splitConditions, toggleStage} from './mv-plan.mjs';

const motionName = m => m.label || m.name || m.id;
const minutes = sec => `約 ${Math.max(1, Math.round(sec / 60))} 分`;
const number = (label, value, attrs, onInput) => {
  const i = h('input', {type: 'number', value: String(value), 'aria-label': label, ...attrs});
  i.oninput = () => onInput(Number(i.value), i.value);
  return h('label', {}, label, i);
};

// 編集画面の左の列の「曲とシーン」。s は画面のショート(拍から割ったあとも同じ物を中身ごと置き換える)。
//   audio: 曲の欄(音声ファイル、利用条件、公開してよい)。onSplit(short): 割ったショートで画面を置き換える。onPick(i): 帯のカットを選ぶ
export function dancePanel({s, id, options, motions, audio, save, touch, onSplit, onPick, onMotion}) {
  s.music ??= {...DANCE_MUSIC_DEFAULTS};
  const music = () => s.music, label = st => options.stages.find(x => x.id === st)?.label ?? st;
  let seconds = danceTotal(s.cuts) || DANCE_SECONDS.initial, last = null, picked = 0;
  const base = new WeakMap();   // カット → 拍から割ったときのステージ、カメラ、角度
  // 今のカットを「割ったときの値」として覚える。開いたときと、割ったあと
  function markSplit() {
    for (const c of s.cuts) base.set(c, danceSplitOf(c));
    last = s.cuts.length ? splitConditions(music(), seconds, s.audioId) : null;
  }
  const edits = c => danceEdits(c, base.get(c));
  const graphicCat = options.graphic ?? null, sceneLabel = id => graphicCat?.find(x => x.id === id)?.label ?? id ?? '場面未定';
  const graphicBox = h('fieldset', {class: 'form-stack', hidden: true}), qualityNote = h('p', {class: 'muted'});
  // 演出に合わせて欄を出し分ける(public/mv-plan.mjs の danceFieldsFor)
  function showLook() {
    const f = danceFieldsFor(music().look ?? 'plain');
    if (sceneBox.parentElement) sceneBox.parentElement.hidden = !f.scenes;
    graphicBox.hidden = !f.graphic;
    cutLenSel.hidden = sceneEveSel.hidden = !f.cutLength;
    qualityNote.textContent = f.graphic ? `試しは踊る人を半分の大きさで描き、${GRAPHIC_QUALITIES.preview.width}x${GRAPHIC_QUALITIES.preview.height} に縮める。本番は ${GRAPHIC_QUALITIES.final.width}x${GRAPHIC_QUALITIES.final.height}。文字と色だけの直しは重ねるからやり直す。場面の並びを変えたら、足りない踊る人のコマだけ描き足す。`
      : `試しは ${MV_QUALITIES.preview.width}x${MV_QUALITIES.preview.height} のコマ、本番は ${MV_QUALITIES.final.width}x${MV_QUALITIES.final.height}。カットを 1 つ直しても全カットを描き直す。テロップと転換だけの直しは描き直さない。`;
    if (f.graphic) renderGraphic();
  }
  // グラフィックの欄: 文字、言葉、色、表情、スカート。値は music.graphic(サーバーが lib/graphic-mv.mjs の graphicBody で確かめる)
  function renderGraphic() {
    if (!graphicCat) return;
    const g = music().graphic, gmsg = h('span', {class: 'muted', role: 'status'});
    const reset = h('button', {type: 'button', class: 'outline', onclick: async () => {
      reset.disabled = true; gmsg.textContent = '既定の値を求めている…';
      try {
        await save();
        const preset = ['pop', 'chara', 'mono'].includes(music().graphic?.palette?.preset) ? music().graphic.palette.preset : 'pop';
        music().graphic = await getJSON(`/api/shorts/${enc(id)}/graphic-defaults?preset=${preset}`);
        touch(); renderGraphic();
      } catch (e) { gmsg.className = 'err'; gmsg.textContent = '既定に戻せない: ' + e.message; reset.disabled = false; }
    }}, '既定に戻す');
    if (!g) { graphicBox.replaceChildren(h('legend', {}, 'グラフィック'), h('p', {class: 'muted'}, '「拍から割る」を押すと、キャラとモーションから文字、色、表情の既定が入る。'), h('div', {class: 'actions'}, reset, gmsg)); return; }
    const set = fn => { fn(g); touch(); };
    const field = (label, value, max, onInput, attrs = {}) => {
      const i = h('input', {type: 'text', value, maxlength: String(max), 'aria-label': label, ...attrs});
      i.oninput = () => set(() => onInput(i.value));
      return h('label', {}, label, i);
    };
    const words = graphicWords(s.cuts, graphicCat, g.text.words);
    const used = s.cuts.map((c, i) => (words[i].length ? `${i + 1} ${sceneLabel(c.scene)}: ${words[i].join(' / ')}` : null)).filter(Boolean);
    const colorInput = (label, get, put) => {
      const i = h('input', {type: 'color', value: get().toLowerCase(), 'aria-label': label});
      i.oninput = () => set(gg => { put(gg, i.value.toUpperCase()); gg.palette.preset = 'custom'; presetSel.value = 'custom'; });
      return h('label', {class: 'se-color'}, label, i);
    };
    const presetSel = h('select', {'aria-label': '色の組'}, [['pop', 'ポップ（試作の 5 色）'], ['chara', 'キャラの色（サムネイルから）'], ['mono', 'モノクロ'], ['custom', '自分で選ぶ']].map(([k, t]) => h('option', {value: k}, t)));
    presetSel.value = g.palette.preset;
    presetSel.onchange = async () => {
      const preset = presetSel.value;
      if (preset === 'custom') { set(gg => { gg.palette.preset = 'custom'; }); return; }
      if (preset === 'chara') {
        gmsg.textContent = 'サムネイルから色を取っている…';
        try { await save(); const d = await getJSON(`/api/shorts/${enc(id)}/graphic-defaults?preset=chara`); set(gg => { gg.palette = d.palette; }); gmsg.textContent = ''; }
        catch (e) { gmsg.className = 'err'; gmsg.textContent = '色を取れない: ' + e.message; }
      } else set(gg => { gg.palette = {preset, ...structuredClone(GRAPHIC_PALETTES[preset])}; });
      renderGraphic();
    };
    const cues = h('textarea', {rows: '5', class: 'mono', 'aria-label': '表情の時刻表（JSON）'}, JSON.stringify(g.cues, null, 1));
    const cueMsg = h('span', {class: 'muted'});
    cues.oninput = () => {
      try { const v = JSON.parse(cues.value); if (!Array.isArray(v)) throw new Error('配列にする'); set(gg => { gg.cues = v; }); cueMsg.className = 'muted'; cueMsg.textContent = ''; }
      catch (e) { cueMsg.className = 'err'; cueMsg.textContent = 'JSON が読めない: ' + e.message; }
    };
    const num = (label, value, attrs, put) => { const i = h('input', {type: 'number', value: String(value), 'aria-label': label, ...attrs}); i.oninput = () => { const v = Number(i.value); if (i.value !== '' && Number.isFinite(v)) set(gg => put(gg, v)); }; return h('label', {}, label, i); };
    graphicBox.replaceChildren(h('legend', {}, 'グラフィック'),
      h('p', {class: 'muted'}, '文字は絵の一部として重ねる（カットのテロップは使わない）。場面ごとの言葉はカットの欄でも直せる。'),
      h('div', {class: 'cut-grid'},
        field('名前', g.text.title, 24, v => { g.text.title = v; }),
        field('英字の名前', g.text.titleEn, 24, v => { g.text.titleEn = v; }, {pattern: '[ -~]*'}),
        field('クレジット', g.text.credit, 60, v => { g.text.credit = v; })),
      field('言葉（/ で区切る。言葉の枠のある場面へ順に配る）', g.text.words.join(' / '), 300, v => { g.text.words = v.split('/').map(x => x.trim()).filter(Boolean); }),
      used.length ? h('p', {class: 'muted'}, '今の配り方: ' + used.join('、')) : null,
      h('label', {}, '色の組', presetSel),
      h('div', {class: 'cut-grid'},
        ...g.palette.bg.map((c, k) => colorInput(`背景 ${k + 1}`, () => g.palette.bg[k], (gg, v) => { gg.palette.bg[k] = v; })),
        colorInput('差し色', () => g.palette.accent, (gg, v) => { gg.palette.accent = v; }),
        colorInput('文字', () => g.palette.ink, (gg, v) => { gg.palette.ink = v; }),
        colorInput('明るい地', () => g.palette.light, (gg, v) => { gg.palette.light = v; })),
      h('details', {}, h('summary', {}, '詳しい設定（開発用）'), h('div', {class: 'form-stack'},
        h('p', {class: 'muted'}, '表情は [{from, to, expr: {名前: 0〜1}, ease}]（秒）。名前はこのバージョンの VRM にあるものだけ。直すと踊る人を描き直す。'),
        cues, cueMsg,
        h('div', {class: 'cut-grid'},
          num('スカートの硬さ', g.skirt[0], {min: '0', max: '10', step: '0.1'}, (gg, v) => { gg.skirt[0] = v; }),
          num('スカートの抵抗', g.skirt[1], {min: '0', max: '1', step: '0.05'}, (gg, v) => { gg.skirt[1] = v; }),
          num('スカートの揺れの割合（skirtDamp）', g.skirtDamp, {min: '0', max: '1', step: '0.05'}, (gg, v) => { gg.skirtDamp = v; })))),
      h('div', {class: 'actions'}, reset, gmsg));
  }

  // シーン: 押した順に並ぶ。もう一度押すと外す
  const sceneBox = h('div', {class: 'mv-scenes'});
  function renderScenes() {
    const now = music().stages ?? [];
    sceneBox.replaceChildren(...options.stages.map(st => {
      const i = now.indexOf(st.id);
      return h('button', {type: 'button', class: 'mv-scene', 'aria-pressed': String(i >= 0), 'aria-label': `ステージ ${st.label}${i >= 0 ? `（${i + 1} 番目）` : ''}`, onclick: () => {
        const next = toggleStage(music().stages, st.id);
        if (next) music().stages = next; else delete music().stages;
        touch(); renderScenes(); render();
      }}, h('img', {src: st.thumb, alt: '', loading: 'lazy'}), i >= 0 ? h('span', {class: 'mv-order mono'}, String(i + 1)) : null, h('span', {class: 'mv-scene-name'}, st.label));
    }));
  }

  const motionSel = h('select', {'aria-label': '踊るモーション'}, music().motionId ? null : h('option', {value: ''}, '選ぶ'), motions.map(m => h('option', {value: m.id}, optionName(m, motionName(m)))));
  motionSel.value = music().motionId ?? '';
  motionSel.onchange = () => {
    if (!motionSel.value) return;
    music().motionId = motionSel.value;
    for (const c of s.cuts) c.motionId = motionSel.value;   // サーバーも全カットへ写す
    motionSel.querySelector('option[value=""]')?.remove();
    touch(); render(); onMotion();
  };
  const select = (text, list, key) => {
    const sel = h('select', {'aria-label': text}, list.map(([k, t]) => h('option', {value: String(k)}, t)));
    sel.value = String(music()[key] ?? (key === 'look' ? 'plain' : DANCE_MUSIC_DEFAULTS[key]));   // look の無い保存済みのショートは plain(新規は s.music の既定で anime)
    sel.onchange = () => {
      const before = music()[key];
      music()[key] = key === 'look' ? sel.value : Number(sel.value);
      if (key === 'look') {
        if (looksSplitApart(before ?? 'plain', sel.value) && s.cuts.length) {
          onSplit({...s, music: music(), cuts: []});   // カットの形が変わる(ステージとカメラ / 場面)ので空にして割り直す
          msg.className = 'muted'; msg.textContent = '演出を変えたので、カットを空にした。「拍から割る」を押す。';
        }
        showLook();
      }
      touch(); render();
    };
    return h('label', {}, text, sel);
  };
  const clamp = (key, lo, hi, round) => v => { if (!Number.isFinite(v) || v < lo || v > hi) return; music()[key] = round ? Math.round(v) : v; touch(); render(); };

  // 拍から割る: 先に保存し(サーバーは保存したショートを割る)、答えのショートで画面を置き換える
  const msg = h('span', {class: 'muted', role: 'status'});
  const splitBtn = h('button', {type: 'button', class: 'primary', onclick: async () => {
    if (!music().motionId) { msg.className = 'err'; msg.textContent = '踊るモーションを選ぶ'; return; }
    const isGraphic = music().look === 'graphic';
    if (!isGraphic && !music().stages?.length) { msg.className = 'err'; msg.textContent = 'ステージを 1 つ以上選ぶ'; return; }
    splitBtn.disabled = true; msg.className = 'muted'; msg.textContent = s.audioId ? '曲の拍を求めて割っている…（1 分ほどかかることがある）' : '拍から割っている…';
    try {
      await save();
      const r = await send('POST', `/api/shorts/${enc(id)}/beat-cuts`, isGraphic ? graphicCutsBody(music(), seconds) : beatCutsBody(music(), seconds));
      onSplit(r.short);
      markSplit(); renderGraphic();
      const n = s.cuts.length;
      msg.className = 'muted';
      msg.textContent = r.source === 'audio' ? `曲の拍から ${n} カットに割った${r.detectedBpm ? `（曲のテンポ 約 ${Math.round(r.detectedBpm)}）` : ''}。` : `テンポ ${music().bpm} で ${n} カットに割った。`;
    } catch (e) { msg.className = 'err'; msg.textContent = '割れない: ' + e.message; }
    splitBtn.disabled = false;
    render();
  }}, '拍から割る');

  // カット割りの帯。割ったあとは保存したカットの秒、まだ割っていなければテンポからの目安
  const strip = h('div', {class: 'mv-cuts se-dance-cuts', 'aria-label': 'カット割り'}), note = h('p', {class: 'muted'}), warn = h('p', {class: 'limit warn', hidden: true});
  function render(nowPicked = picked) {
    picked = nowPicked;
    const m = music(), cuts = s.cuts, used = new Set(cuts.map(c => c.stage)), isGraphic = m.look === 'graphic';
    const bands = cuts.length ? danceCutBounds(cuts).map((b, i) => ({...b, stage: cuts[i].stage, scene: cuts[i].scene, i})) : isGraphic ? [] : mvCuts({seconds, bpm: m.bpm, stages: m.stages ?? [], beatsPerShot: m.beatsPerShot, shotsPerScene: m.shotsPerScene});
    strip.replaceChildren(...bands.map(c => {
      const inner = [h('span', {}, isGraphic ? sceneLabel(c.scene) : c.stage ? label(c.stage) : 'ステージ未定'), h('span', {class: 'mono muted'}, `${(c.end - c.start).toFixed(1)}s`)];
      const style = `flex:${(c.end - c.start).toFixed(3)} 1 0`, title = `${c.start.toFixed(2)} から ${c.end.toFixed(2)} 秒`;
      return c.i == null ? h('div', {class: 'mv-cut todo', style, title}, ...inner)
        : h('button', {type: 'button', class: 'mv-cut', style, title, 'aria-label': `カット ${c.i + 1}（${title}）を選ぶ`, 'aria-pressed': String(c.i === picked), onclick: () => onPick(c.i)}, ...inner);
    }));
    const total = cuts.length ? danceTotal(cuts) : seconds, mo = motions.find(x => x.id === m.motionId);
    const unused = (m.stages ?? []).filter(x => !used.has(x)).map(label), changed = splitConditions(m, seconds, s.audioId) !== last;
    const shares = isGraphic ? graphicShares(cuts, graphicCat ?? []) : null, est = isGraphic ? qq => graphicEstimateSec(qq, total, shares) : qq => mvEstimateSec(qq, total, used.size || 1);
    note.textContent = [cuts.length ? `${cuts.length} カット、${total.toFixed(1)} 秒。試し ${minutes(est('preview'))}、本番 ${minutes(est('final'))}。` : isGraphic ? 'まだ割っていない。「拍から割る」で場面の並びを作る。' : 'まだ割っていない。帯はテンポからの目安。',
      !isGraphic && cuts.length && unused.length ? `短くて ${unused.join('、')} まで回らない。長くするか、カットを短くする。` : '',
      mo && total > mo.durationSec ? `モーションは ${mo.durationSec.toFixed(1)} 秒なので繰り返す。` : '',
      cuts.length && changed ? '条件を変えた。「拍から割る」を押すとカットに入る。' : ''].filter(Boolean).join('');
    const edited = cuts.flatMap((c, i) => (edits(c).length ? [i + 1] : []));
    warn.hidden = !edited.length;
    warn.textContent = edited.length ? `カット ${edited.join('、')} のステージ、カメラ、角度を手で直した。書き出しで止まることがある（stage-studio が手で直したカット表を受けないうちは）。戻すときは「拍から割る」を押す。` : '';
  }

  const cutLenSel = select('カットの長さ', BEATS_PER_SHOT.map(n => [n, `${n} 拍`]), 'beatsPerShot'), sceneEveSel = select('ステージの切り替え', [[1, 'カットごと'], [2, '2 カットごと']], 'shotsPerScene');   // グラフィックでは場面の並びが決めるので隠す
  const box = h('section', {class: 'se-sec', 'aria-label': '曲とステージ'}, h('h2', {}, '曲とステージ'),
    h('p', {class: 'muted'}, 'この型は声が無いので、送った曲が主な音になる。曲が無ければ、テンポから割った無音の動画になる。'),
    h('div', {class: 'form-stack'},
      h('label', {}, '踊るモーション', motionSel),
      h('fieldset', {}, h('legend', {}, 'ステージ（押した順に切り替わる）'), sceneBox),
      ...audio,
      number('長さ（秒）', seconds, {min: String(DANCE_SECONDS.min), max: String(MAX_SECONDS), step: '1'}, v => { if (v >= DANCE_SECONDS.min && v <= MAX_SECONDS) { seconds = v; render(); } }),
      number('曲の開始位置（秒）', music().audioStart ?? 0, {min: '0', max: '3600', step: '0.1'}, clamp('audioStart', 0, 3600)),
      select('演出', [['anime', 'アニメ調（トゥーン、リム、霞、ぼけ、光のにじみ。顔を正面寄りの寄りで撮る）'], ['cel', 'セル調（MToon の影の色で 3 段に塗り、輪郭線を付ける。カメラはアニメ調と同じ）'], ['plain', 'そのまま（前の見た目）'], ...(graphicCat ? [['graphic', 'グラフィック（切り抜いた踊る人、平らな色、大きな文字）']] : [])], 'look'),
      graphicBox,
      h('details', {}, h('summary', {}, '細かい条件（カット、テンポ）'), h('div', {class: 'form-stack'},
        cutLenSel, sceneEveSel,
        number('テンポ（BPM。曲があれば曲から求める）', music().bpm ?? 120, {min: '40', max: '240', step: '1'}, clamp('bpm', 40, 240, true)),
        number('カット割りの番号（変えるとカメラワークが変わる）', music().seed ?? 1, {min: '0', max: '9999', step: '1'}, clamp('seed', 0, 9999, true)))),
      h('div', {class: 'actions'}, splitBtn, msg),
      strip, note, warn,
      qualityNote));
  markSplit(); renderScenes(); showLook(); render();
  return {box, render, edits, markSplit, sceneLabel, renderGraphic};
}

// #mv/<キャラ>[/<バージョン>]: そのキャラを出演者にしたダンス MV のショートを作り、#short/<ID> へ移る。
//   送る前に URL を #shorts に置き換えるので、読み直しても 2 本目はできない。送っている間にもう一度呼ばれても送らない
const creating = new Map();   // キャラ/バージョンごと。別のキャラの #mv が、送信中の別のキャラのショートに着地しないように
export async function startDanceShort({main, ov, char, verId, alive}) {
  history.replaceState(null, '', '#shorts');
  const wait = h('div', {class: 'empty page-empty', role: 'status'}, 'ダンス MV のショートを作っている…');
  if (!char || !verId) { main.replaceChildren(h('div', {class: 'empty page-empty'}, 'ダンス MV を作るには、バージョンのあるキャラが要る。')); return; }
  const note = missingNote(ov, ['stageStudio', 'blender'], 'ダンス MV を作るのに要る道具が未設定');
  if (note) { main.replaceChildren(h('div', {class: 'empty page-empty'}, note, h('a', {class: 'link', href: `#model/${enc(char.id)}/${enc(verId)}`}, '完成モデルへ戻る'))); return; }
  main.replaceChildren(wait);
  const slot = JSON.stringify([char.id, verId]);
  if (!creating.has(slot)) creating.set(slot, send('POST', '/api/dance-shorts', danceShortBody(char, verId)).finally(() => creating.delete(slot)));
  try {
    const made = await creating.get(slot);
    if (alive()) location.replace('#short/' + enc(made.id));   // 戻るで #mv に戻らない(戻ると作り直してしまう)
  } catch (e) {
    main.replaceChildren(h('div', {class: 'empty page-empty'}, h('p', {class: 'err'}, 'ダンス MV のショートを作れない: ' + e.message),
      h('a', {class: 'link', href: `#model/${enc(char.id)}/${enc(verId)}`}, '完成モデルへ戻る')));
  }
}
