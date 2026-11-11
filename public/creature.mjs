// 生き物のキャラのページ(#model/<キャラ>[/<バージョン>] で、キャラが生き物のとき)。docs/creature.md、docs/creature.md
// 3D のビューアは載せない(/viewer は VRM だけ)。サムネイル、プロフィール、バージョンの一覧、動きの表、ショートから使う書き方を出す。
import {h, getJSON} from './dom.mjs';
import {enc, fmtDate, sortVersions, thumb} from './shared.mjs';
import {profilePanel} from './profile.mjs';
import {motionRows, takeCreatureExample} from './char-style.mjs';
import {checkPanel} from './version-check.mjs';

export async function showCreature({main, char, verId}) {
  const c = await getJSON('/api/characters/' + enc(char.id));
  const versions = sortVersions(c), ver = versions.find(v => v.id === verId) ?? versions[0] ?? null;
  const profile = profilePanel(c, {voice: false});
  main.replaceChildren(profile.box, h('div', {class: 'creature-page'},
    h('div', {class: 'creature-pic'}, thumb(ver?.thumb, `${c.name} のサムネイル`, 'creature-big')),
    h('div', {class: 'creature-info'},
      versionList(c, versions, ver),
      ver ? checkPanel(c, ver) : null,
      ver ? motionTable(ver) : null,
      usage(c))));
}

// バージョンの一覧: バージョン ID、ラベル、取り込んだ日。押すとそのバージョンの動きを出す
function versionList(c, versions, ver) {
  if (!versions.length) return h('section', {class: 'stack-small'}, h('h2', {}, 'バージョン'),
    h('p', {class: 'muted'}, 'バージョンがまだない。Blender で骨と動きを作り、node scripts/import-creature.mjs で取り込む。'),
    h('code', {}, `node scripts/import-creature.mjs --char ${c.id} --id v1 --label "..." --src <model.blend> --spec <creature.json> --latest`));
  return h('section', {class: 'stack-small'}, h('h2', {}, `バージョン（${versions.length}）`),
    h('div', {class: 'creature-versions'}, versions.map(v => h('a', {class: 'creature-ver', href: `#model/${enc(c.id)}/${enc(v.id)}`, 'aria-current': v.id === ver?.id ? 'true' : null},
      h('span', {class: 'mono'}, v.id), v.id === c.latestVersion ? h('span', {class: 'tag'}, '最新') : null,
      h('span', {class: 'creature-ver-label'}, v.label || ''), h('span', {class: 'muted'}, fmtDate(v.importedAt ?? v.createdAt))))),
    ver?.blend ? h('a', {class: 'file-link', href: ver.blend, download: `${c.id}-${ver.id}.blend`}, `${ver.id} の Blender のファイル`) : null);
}

// 動きの表: rest、fly、clips を [Action、始めのコマ、終わりのコマ] で。コマは creature.json の fps
function motionTable(ver) {
  const cr = ver.creature, rows = motionRows(cr);
  const facts = cr ? [cr.fps != null ? `${cr.fps} fps` : null, cr.scale != null ? `scale ${cr.scale}` : null, cr.yaw != null ? `yaw ${cr.yaw}` : null, cr.drop ? `drop ${cr.drop}` : null].filter(Boolean).join('・') : '';
  return h('section', {class: 'stack-small'}, h('h2', {}, `動き（${ver.id}）`),
    rows.length ? h('div', {class: 'table-wrap'}, h('table', {class: 'creature-motions-table'},
      h('thead', {}, h('tr', {}, ['動き', 'Action', '始め', '終わり'].map(t => h('th', {scope: 'col'}, t)))),
      h('tbody', {}, rows.map(r => h('tr', {}, h('th', {scope: 'row'}, r.name, r.key.startsWith('clips.') ? null : h('span', {class: 'mono muted'}, ` ${r.key}`)),
        h('td', {class: 'mono'}, r.action), h('td', {class: 'mono num'}, String(r.start)), h('td', {class: 'mono num'}, String(r.end)))))))
      : h('p', {class: 'muted'}, 'このバージョンには動きの記録が無い。'),
    facts ? h('p', {class: 'muted'}, `コマは ${facts}`) : null);
}

// ショートから使う: take.creature にキャラ ID で書く(docs/creature.md の新しい書き方)
function usage(c) {
  return h('details', {class: 'stack-small'}, h('summary', {}, '詳しい設定（開発用）'), h('h2', {}, 'ショートで使う'),
    h('p', {class: 'muted'}, 'short.json の take.creature にキャラ ID で書く。verId を省くと最新バージョン。perch は 0 以上の整数、path は [x, y, z] を 3 つ。yaw、flight、scale、drop も書けば上書きする。撮るときに、バージョンの model.blend と動きの値が入る。'),
    h('pre', {class: 'code-block'}, h('code', {}, `"creature": ${takeCreatureExample(c.id)}`)),
    h('p', {class: 'muted'}, 'カットの creature の tilt、down、stare は同じ名前の動きを使い、takeoff は caw と羽ばたくを使う。無い動きを使うカットは撮る前に断られる。'));
}
