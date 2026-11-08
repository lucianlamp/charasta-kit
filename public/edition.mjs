// 版の種類(edition)ごとの画面の名前(docs/edition.md)。full: 作者の版(既定)、kit: 配るキット。
// サーバー(lib/edition.mjs)が /api/overview の labels に入れ、画面は public/app.mjs がそれを使う。DOM も import も使わない(サーバーとテストが読み込める)
export const EDITIONS = ['full', 'kit'];

// agent: 頼みごとを受けるエージェントの呼び方(助詞付き)。キットは Codex でも Claude Code でも使うので「エージェント」
// methods: 3D の作り方 [鍵, 名前, 説明]。styles: キャラのスタイルの名前(ID は同じ)。shortStyles: ショートの型の名前。newShortStyle: 「新しいショート」で作る型
const FULL = {
  methods: [
    ['tripo', 'Tripo（本家）', 'きゃらくる標準の手順。Tripo Studio で候補・再テクスチャ・自動リグ。顔の出来はこちらがよい。'],
    ['kimi', 'Kimi', 'Tripo Studio の代わりに Kimi と Blender で進める。Tripo のクレジットを使わない。'],
  ],
  styles: {standard: 'スタンダード', chibi: 'チビ', creature: '生き物'},
  shortStyles: {trivia: '雑学', drama: 'ドラマ', pop: '派手', news: 'ニュース', dance: 'ダンス MV'},
  newShortStyle: 'trivia',
  agent: {name: 'Claude', ga: 'Claude が', ni: 'Claude に', no: 'Claude の', he: 'Claude への', wo: 'Claude を'},
};
// キットのショートは対話型とダンス MV の 2 つ。対話型は型 drama の演出(落ち着いた転換と字幕)をそのまま使い、名前だけを変える。
// キットに生き物(creature)のスタイルは無い(使える機能の creature も使えない。docs/edition.md)
const KIT = {
  methods: [['tripo', 'きゃらくる（Tripo Studio）', 'Tripo Studio で候補・再テクスチャ・自動リグを進める。']],
  styles: {standard: 'スタンダード体型', chibi: 'チビ体型'},
  shortStyles: {drama: '対話型', dance: 'ダンス MV'},
  newShortStyle: 'drama',
  agent: {name: 'エージェント', ga: 'エージェントが', ni: 'エージェントに', no: 'エージェントの', he: 'エージェントへの', wo: 'エージェントを'},
};

// 毎回新しい物を返す(画面が書き換えても元の表は変わらない)
export const editionLabels = edition => structuredClone(edition === 'kit' ? KIT : FULL);
