// 画面どうしで共有する小さな道具。
// 要素を作る小さな道具。文字は textContent で入れる（ファイル名やメモに < が入っても崩れない）
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
export const getJSON = url => fetch(url).then(async r => { if (!r.ok) throw Error(`${url}: ${r.status} ${await r.text().catch(() => '')}`); return r.json(); });
// 本文を JSON で送る。失敗はサーバーの {error} の文で投げる
export async function send(method, url, body) {
  const r = await fetch(url, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw Error(j?.error || `${r.status} ${text}`);
  return j;
}
export const fmtSec = s => s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
export function elapsedText(j) {
  if (!j.startedAt) return '';
  const end = j.finishedAt ? new Date(j.finishedAt) : new Date();
  return fmtSec(Math.max(0, Math.round((end - new Date(j.startedAt)) / 1000)));
}
