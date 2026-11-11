// ショートの頼みごと(編集画面の「Claude に依頼する」)を読む・片付ける。scripts/short-asks.mjs と test/short-asks.test.mjs が使う
// 頼みごとは ask と askedAt がそろったもの。カットごと(cut は 1 から)と、ショート全体(cut は null)がある

const pending = x => !!(x?.askedAt && x.ask?.trim());

// 対応待ちの頼みごとを、カットの中身の要約と一緒に並べる
export function pendingAsks(short) {
  const out = [];
  if (pending(short)) out.push({shortId: short.id, title: short.title, cut: null, ask: short.ask, askedAt: short.askedAt});
  (short.cuts ?? []).forEach((c, i) => {
    if (pending(c)) out.push({shortId: short.id, title: short.title, cut: i + 1, ask: c.ask, askedAt: c.askedAt,
      now: {who: c.who ?? '', text: c.text ?? '', telop: c.telop ?? '', camera: c.camera, stage: c.stage}});
  });
  return out.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}

// 直したあとに呼ぶ。返事を残して頼みごとを外し、カットは確認を外して人の見直しへ戻す。ショートは書き換えた写しを返す
export function resolveAsk(short, {cut = null, reply, now = new Date()}) {
  if (!reply?.trim()) throw new Error('返事（何をしたか）が要る');
  const next = structuredClone(short), target = cut == null ? next : next.cuts?.[cut - 1];
  if (!target) throw new Error(`カット ${cut} が無い`);
  if (!pending(target)) throw new Error(cut == null ? '全体への依頼は対応待ちではない' : `カット ${cut} の依頼は対応待ちではない`);
  target.reply = reply.trim(); target.repliedAt = now.toISOString();
  delete target.ask; delete target.askedAt;
  if (cut != null) delete target.ok;
  return next;
}
