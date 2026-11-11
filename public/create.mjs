// つくる: キャラのバージョン、作り方の記録、きゃらくるのプロジェクト(読むだけ)、バージョンの取り込み(小さなモーダル。docs/screens.md、ADR 0001)。新しいキャラはライブラリから作る。
import {h, getJSON, send} from './dom.mjs';
import {METHODS, enc, fmtDate, sortVersions, thumb, viewerHref} from './shared.mjs';
import {moveToTrash} from './confirm.mjs';
import {can, missingNote} from './capabilities.mjs';
import {formDialog} from './dialog.mjs';

export async function showCreate({main, ov, char, verId, reload}) {
  if (!char) { main.replaceChildren(h('div', {class: 'empty page-empty'}, 'キャラがまだない。ライブラリの「新しいキャラ」から始める。')); return; }
  const projects = await getJSON('/api/charakuru/projects').catch(() => []);
  const linkedName = p => ov.chars.filter(c => c.projects.includes(p.id)).map(c => c.name);
  const card = p => projectCard(p, linkedName(p));
  const mine = projects.filter(p => char.projects.includes(p.id)), others = projects.filter(p => !char.projects.includes(p.id));
  // 取り込みの欄は右に置かず、バージョンの表の見出しの横(バージョンが無ければ表の場所)のボタンからモーダルで開く。右の欄は作らない
  main.replaceChildren(h('div', {class: 'work'},
    h('section', {class: 'center page-body'},
      versionsTable(char, verId, reload, () => openImportVersion(char, projects)), methodRecord(char),
      h('section', {class: 'stack', 'aria-labelledby': 'projs'},
        h('div', {class: 'page-head'}, h('h2', {id: 'projs'}, 'きゃらくるのプロジェクト'), can(ov, 'charakuru') ? h('a', {class: 'button outline', href: ov.charakuruUrl, target: '_blank'}, 'きゃらくるを開く') : null),
        missingNote(ov, ['charakuru'], 'きゃらくるのアプリの場所が未設定'),
        projects.length ? mine.map(card) : h('div', {class: 'empty small'}, `プロジェクトを読めない（${ov.charakuruUrl}）。設定の charakuruApp を見る。`),
        others.length ? h('details', {}, h('summary', {}, `ほかのプロジェクト（${others.length}）`), h('div', {class: 'stack'}, others.map(card))) : null))));
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
    h('div', {class: 'muted'}, [p.savedAt ? '保存 ' + fmtDate(p.savedAt) : null, p.hasReview ? 'VRM あり' : 'VRM なし'].filter(Boolean).join('・')));
}

function versionsTable(c, verId, reload, openImport) {
  const from = v => {
    const studio = c.studios.find(s => s.versions.includes(v.id));
    if (studio) return '表情づくり ' + studio.id;
    return v.source?.charakuruProject ? 'きゃらくる ' + v.source.charakuruProject.slice(0, 8) : 'ファイル';
  };
  const rows = sortVersions(c);
  return h('section', {class: 'stack', 'aria-labelledby': 'vers'}, h('div', {class: 'page-head'}, h('h1', {id: 'vers'}, `${c.name} のバージョン（${rows.length}）`),
    rows.length ? h('button', {type: 'button', class: 'outline', onclick: openImport}, 'バージョンを取り込む') : null),
    rows.length ? h('div', {class: 'table-wrap ver-table-wrap'}, h('table', {class: 'ver-table'},
      h('thead', {}, h('tr', {}, ['バージョン', '変えたこと', '取り込み元', '取り込み', ''].map(t => h('th', {scope: 'col'}, t)))),
      h('tbody', {}, rows.map(v => h('tr', {'aria-current': v.id === verId ? 'true' : null},
        h('td', {class: 'mono'}, h('a', {class: 'ver-cell', href: `#motions/${enc(c.id)}/${enc(v.id)}`}, thumb(v.thumb, '', 'mini'), v.id), v.id === c.latest?.id ? h('span', {class: 'tag'}, '最新') : null),
        h('td', {class: 'ver-note'}, v.label ? h('div', {}, v.label) : null, v.note ? h('div', {class: 'muted'}, v.note) : null),
        h('td', {class: 'muted ver-from', 'data-label': '取り込み元', title: v.source?.path ?? ''}, from(v)), h('td', {class: 'muted ver-date', 'data-label': '取り込み'}, fmtDate(v.importedAt)),
        h('td', {class: 'ver-ops'}, h('a', {class: 'link', href: viewerHref(c.id, v.id), target: '_blank'}, 'ビューア'),
          h('button', {type: 'button', class: 'quiet', 'aria-label': `バージョン ${v.id} を削除`, onclick: async () => { if (await moveToTrash({kind: 'version', charId: c.id, id: v.id}, `${c.name} ${v.id}`)) reload(); }}, '削除')))))))
      : h('div', {class: 'empty small ver-empty'}, h('p', {}, 'バージョンがまだない。きゃらくるのプロジェクトから取り込む。'), h('button', {type: 'button', class: 'primary', onclick: openImport}, 'バージョンを取り込む')));
}

// バージョンを取り込む小さなモーダル。成功したら #create/<キャラ>/<新しいバージョン> へ移る(画面を移るとモーダルは閉じる)
function openImportVersion(c, projects) {
  const usable = projects.filter(p => p.hasReview);
  const sel = h('select', {'aria-label': 'プロジェクト'}, usable.map(p => h('option', {value: p.id}, `${p.name || p.id}（${p.id.slice(0, 8)}）`)));
  const pre = usable.find(p => c.projects.includes(p.id));
  if (pre) sel.value = pre.id;
  const first = !c.versions.length;   // 最初のバージョンは ID と変えたことを省ける(ID は v1、変えたことは「最初の取り込み」)
  const ver = h('input', {placeholder: first ? '空なら v1' : '例: v5-new-outfit', 'aria-label': 'バージョンの ID'}), note = h('textarea', {rows: 3, placeholder: first ? '空なら「最初の取り込み」' : '', 'aria-label': '変えたこと'});
  const latest = h('input', {type: 'checkbox'}), msg = h('p', {class: 'muted', role: 'status'}), go = h('button', {type: 'button', class: 'primary'}, 'バージョンとして取り込む');
  const no = h('button', {type: 'button', onclick: e => e.currentTarget.closest('dialog').close()}, 'やめる');
  let busy = false, x = null;
  go.disabled = !usable.length;
  if (!usable.length) msg.textContent = projects.length ? 'VRM まで進んだプロジェクトがまだない。' : 'きゃらくるのプロジェクトを読めない。';
  go.onclick = async () => {
    if (!first && (!ver.value.trim() || !note.value.trim())) { msg.className = 'err'; msg.textContent = 'バージョンの ID と変えたことを入れる'; return; }
    const id = ver.value.trim() || 'v1', text = note.value.trim() || '最初の取り込み';
    busy = true; go.disabled = no.disabled = x.disabled = true; msg.className = 'muted'; msg.textContent = '取り込み中…（スマホ用の軽い VRM も作る）';
    try {
      const r = await send('POST', `/api/characters/${enc(c.id)}/versions`, {project: sel.value, verId: id, label: id, note: text, latest: latest.checked});
      busy = false;
      location.hash = `#create/${enc(c.id)}/${enc(r.version.id)}`;
    } catch (e) { busy = false; msg.className = 'err'; msg.textContent = '取り込めない: ' + e.message; go.disabled = no.disabled = x.disabled = false; }
  };
  ({x} = formDialog({title: 'バージョンを取り込む', busy: () => busy, body: [
    h('div', {class: 'form-stack'},
      h('label', {}, 'プロジェクト（VRM まで進んだもの）', sel), h('label', {}, 'バージョンの ID', ver), h('label', {}, first ? '変えたこと' : '変えたこと（必須）', note),
      h('label', {class: 'check'}, latest, '最新バージョンにする')),
    msg, h('div', {class: 'dialog-actions'}, no, go)]}));
  (usable.length ? sel : no).focus();
}
