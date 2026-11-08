// つくる: キャラの版、作り方の記録、きゃらくるのプロジェクト(読むだけ)、版の取り込み(docs/ui.md、ADR 0001)。新しいキャラはライブラリから作る。
import {h, getJSON, send} from './dom.mjs';
import {METHODS, enc, fmtDate, sortVersions, thumb, viewerHref} from './shared.mjs';
import {moveToTrash} from './confirm.mjs';
import {can, missingNote} from './capabilities.mjs';

export async function showCreate({main, ov, char, verId, reload}) {
  if (!char) { main.replaceChildren(h('div', {class: 'empty page-empty'}, 'キャラがまだない。ライブラリの「新しいキャラ」から始める。')); return; }
  const projects = await getJSON('/api/charakuru/projects').catch(() => []);
  const linkedName = p => ov.chars.filter(c => c.projects.includes(p.id)).map(c => c.name);
  const card = p => projectCard(p, linkedName(p));
  const mine = projects.filter(p => char.projects.includes(p.id)), others = projects.filter(p => !char.projects.includes(p.id));
  main.replaceChildren(h('div', {class: 'work'},
    h('section', {class: 'center page-body'},
      versionsTable(char, verId, reload), methodRecord(char),
      h('section', {class: 'stack', 'aria-labelledby': 'projs'},
        h('div', {class: 'page-head'}, h('h2', {id: 'projs'}, 'きゃらくるのプロジェクト'), can(ov, 'charakuru') ? h('a', {class: 'button outline', href: ov.charakuruUrl, target: '_blank'}, 'きゃらくるを開く') : null),
        missingNote(ov, ['charakuru'], 'きゃらくるのアプリの場所が未設定'),
        projects.length ? mine.map(card) : h('div', {class: 'empty small'}, `プロジェクトを読めない（${ov.charakuruUrl}）。設定の charakuruApp を見る。`),
        others.length ? h('details', {}, h('summary', {}, `ほかのプロジェクト（${others.length}）`), h('div', {class: 'stack'}, others.map(card))) : null)),
    h('aside', {class: 'pane pane-right', 'aria-label': '版の取り込み'}, importVersion(char, projects))));
}

// 今のキャラの作り方の記録。記録が無ければ「記録なし」と出す(推測しない)
function methodRecord(c) {
  const sel = h('select', {'aria-label': '作り方'}, h('option', {value: ''}, '記録なし'), METHODS.map(([k, label]) => h('option', {value: k}, label)));
  sel.value = c.method ?? '';
  const msg = h('span', {class: 'muted'});
  sel.onchange = async () => {
    msg.className = 'muted'; msg.textContent = '残している…';
    try { await send('PATCH', '/api/characters/' + enc(c.id), {method: sel.value || null}); msg.textContent = '残した'; }
    catch (e) { msg.className = 'err'; msg.textContent = '残せない: ' + e.message; }
  };
  return h('div', {class: 'method-record'}, h('span', {}, `${c.name} の作り方`), sel, msg);
}

function projectCard(p, names) {
  return h('section', {class: 'card-box project', 'data-project': p.id},
    h('div', {class: 'project-head'},
      h('h2', {}, p.name || p.id, ' ', h('span', {class: 'mono muted'}, p.id.slice(0, 8))),
      names.length ? h('span', {class: 'muted'}, names.join('、') + ' につながっている') : null),
    p.progress ? h('ol', {class: 'kit-steps'}, p.progress.map(s => h('li', {class: s.done ? 'done' : ''}, h('span', {class: 'bar ' + (s.done ? 'done' : 'none'), 'aria-hidden': 'true'}), s.label)))
      : h('div', {class: 'muted'}, '工程を読めない（project.charakit が無いか読めない）'),
    h('div', {class: 'muted'}, [p.savedAt ? '保存 ' + fmtDate(p.savedAt) : null, p.hasReview ? 'review.vrm あり' : 'review.vrm なし'].filter(Boolean).join('・')));
}

function versionsTable(c, verId, reload) {
  const from = v => {
    const studio = c.studios.find(s => s.versions.includes(v.id));
    if (studio) return '表情づくり ' + studio.id;
    return v.source?.charakuruProject ? 'きゃらくる ' + v.source.charakuruProject.slice(0, 8) : 'ファイル';
  };
  const rows = sortVersions(c);
  return h('section', {class: 'stack', 'aria-labelledby': 'vers'}, h('div', {class: 'page-head'}, h('h1', {id: 'vers'}, `${c.name} の版（${rows.length}）`)),
    rows.length ? h('div', {class: 'table-wrap'}, h('table', {},
      h('thead', {}, h('tr', {}, ['版', '変えたこと', '出どころ', '取り込み', ''].map(t => h('th', {scope: 'col'}, t)))),
      h('tbody', {}, rows.map(v => h('tr', {'aria-current': v.id === verId ? 'true' : null},
        h('td', {class: 'mono'}, h('a', {class: 'ver-cell', href: `#motions/${enc(c.id)}/${enc(v.id)}`}, thumb(v.thumb, '', 'mini'), v.id), v.id === c.latest?.id ? h('span', {class: 'tag'}, '最新') : null),
        h('td', {}, v.label ? h('div', {}, v.label) : null, v.note ? h('div', {class: 'muted'}, v.note) : null),
        h('td', {class: 'muted', title: v.source?.path ?? ''}, from(v)), h('td', {class: 'muted'}, fmtDate(v.importedAt)),
        h('td', {}, h('a', {class: 'link', href: viewerHref(c.id, v.id), target: '_blank'}, 'ビューア'),
          h('button', {type: 'button', class: 'quiet', 'aria-label': `版 ${v.id} を削除`, onclick: async () => { if (await moveToTrash({kind: 'version', charId: c.id, id: v.id}, `${c.name} ${v.id}`)) reload(); }}, '削除')))))))
      : h('div', {class: 'empty small'}, '版がまだない。「版を取り込む」の欄から入れる。'));
}

function importVersion(c, projects) {
  const usable = projects.filter(p => p.hasReview);
  const sel = h('select', {'aria-label': 'プロジェクト'}, usable.map(p => h('option', {value: p.id}, `${p.name || p.id}（${p.id.slice(0, 8)}）`)));
  const pre = usable.find(p => c.projects.includes(p.id));
  if (pre) sel.value = pre.id;
  const ver = h('input', {placeholder: '例: v5-new-outfit', 'aria-label': '版の ID'}), note = h('textarea', {rows: 3, 'aria-label': '変えたこと'});
  const latest = h('input', {type: 'checkbox'}), msg = h('span', {class: 'muted'}), go = h('button', {class: 'outline'}, '版として取り込む');
  go.disabled = !usable.length;
  go.onclick = async () => {
    if (!ver.value.trim() || !note.value.trim()) { msg.className = 'err'; msg.textContent = '版の ID と変えたことを入れる'; return; }
    go.disabled = true; msg.className = 'muted'; msg.textContent = '取り込み中…（スマホ用の軽い VRM も作る）';
    try {
      const r = await send('POST', `/api/characters/${enc(c.id)}/versions`, {project: sel.value, verId: ver.value.trim(), label: ver.value.trim(), note: note.value.trim(), latest: latest.checked});
      location.hash = `#create/${enc(c.id)}/${enc(r.version.id)}`;
    } catch (e) { msg.className = 'err'; msg.textContent = '取り込めない: ' + e.message; go.disabled = false; }
  };
  return h('section', {class: 'form-stack'}, h('h2', {}, '版を取り込む'),
    h('label', {}, 'プロジェクト（review.vrm のあるもの）', sel), h('label', {}, '版の ID', ver), h('label', {}, '変えたこと（必須）', note),
    h('label', {class: 'check'}, latest, '最新の版にする'), go, msg);
}
