// 利用条件の判定をここにまとめる。記録(motion.json の license、音声に書いた条件)から、画面の札と動画の扱いを決める。
// 止めはしない。公開できない動画も撮れて、札と注意の欄で知らせる(docs/shoot.md)。
// 公開できないと読める書き方と、公開できるかが怪しい書き方。利用条件は人が書いた自由文なので、表記の違いを広めに拾う
const PERSONAL = /個人利用|私的利用/, NO_PUBLIC = /公開(不可|禁止|できない)|非公開/, CAUTION = /二次利用禁止|商用利用不可/;

// 公開できないと読める書き方なら、札の言葉を返す
const noPublic = s => PERSONAL.test(s ?? '') ? '個人利用のみ' : NO_PUBLIC.test(s ?? '') ? '公開不可' : null;

// モーションの札。評価用と個人利用は動画も公開できないので注意の色にする(warn)
export function limitOf(m) {
  const l = m.license;
  if (!l) return {text: '利用条件の記録なし', warn: false};
  if (l.evaluationOnly) return {text: '評価用のみ', warn: true};
  const no = noPublic(l.summary);
  if (no) return {text: no, warn: true};
  if (CAUTION.test(l.summary ?? '')) return {text: '利用に制限あり', warn: false};
  return {text: l.redistribution ? '二次配布 可' : '二次配布 不可', warn: false};
}

// 動画の扱い。level: no(公開できない)、check(公開する前に確かめる)、ok(公開を止める記録が無い)。
// motion: motion.json の形。audio: {name, summary, publishOk}。summary は人が書いた音声の利用条件で、無ければ空。
// publishOk は画面で「公開してよい」を選んだときだけ true。自由文だけでは ok にしない(読み違えて公開しないため)
const LEVELS = ['ok', 'check', 'no'], TAGS = {ok: null, check: '公開前に確認する', no: '公開できない'};
// 保存された記録の terms を今の札の文にする。level が分かる記録は level から文を出し(札の文を直しても古い動画が追いつく)、level の無い古い記録だけ保存された文のまま
export const currentTerms = terms => (terms && LEVELS.includes(terms.level) ? {...terms, tag: TAGS[terms.level]} : terms);
export function videoTerms({motion = null, audio = null} = {}) {
  const notes = [];
  let level = 'ok';
  const note = (lv, text) => { notes.push({level: lv, text}); if (LEVELS.indexOf(lv) > LEVELS.indexOf(level)) level = lv; };
  if (motion) {
    const name = motion.label || motion.name || motion.id, l = motion.license, limit = limitOf(motion);
    if (limit.warn) note('no', `${name} は${limit.text}。この動画は公開できない。`);
    else if (!l?.summary) note('check', `${name} は利用条件の記録が無い。公開する前に権利を確認する。`);
    else if (CAUTION.test(l.summary)) note('check', `${name}: ${l.summary}。公開する前に条件を確認する。`);
    else note('ok', `${name}: ${l.summary}${l.holder ? `（${l.holder}）` : ''}`);
  }
  if (audio) {
    if (noPublic(audio.summary)) note('no', `音声 ${audio.name} は${noPublic(audio.summary)}。この動画は公開できない。`);
    else if (CAUTION.test(audio.summary ?? '')) note('check', `音声 ${audio.name}: ${audio.summary}。公開する前に条件を確認する。`);
    else if (!audio.publishOk) note('check', audio.summary ? `音声 ${audio.name}: ${audio.summary}。公開してよいと選ばれていないので、公開する前に確認する。` : `音声 ${audio.name} は利用条件の記録が無い。公開する前に権利を確認する。`);
    else note('ok', `音声 ${audio.name}: 公開してよいと選んだ${audio.summary ? `（${audio.summary}）` : ''}`);
  }
  return {level, tag: TAGS[level], notes};
}
