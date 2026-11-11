// 使える機能の確認(サーバーの /api/overview の capabilities。lib/capabilities.mjs)。道具の場所が未設定の機能は、押しても失敗するだけなので理由を出す。
import {h} from './dom.mjs';

const LABEL = {blender: 'Blender', charakuru: 'きゃらくる', expressionStudio: '表情づくり（きゃらくると Blender）', stageStudio: 'stage-studio（ステージの描画）',
  hyperframes: 'HyperFrames（文字と演出）', motionbricks: 'MotionBricks', voicevox: 'VOICEVOX', ffmpeg: 'ffmpeg', python: 'Python'};

// 情報が無い(古いサーバーなど)ときは使えるとみなして、隠さない
export const can = (ov, key) => ov?.capabilities?.[key]?.available ?? true;

// keys のうち使えないものがあれば、設定のキーつきの注意の段落を返す。全部使えるなら null
export function missingNote(ov, keys, lead = '次の設定が無いので、この機能は使えない') {
  const miss = keys.filter(k => !can(ov, k));
  if (!miss.length) return null;
  return h('p', {class: 'err', role: 'status'}, `${lead}: ` + miss.map(k => `${LABEL[k] ?? k}（設定の ${ov.capabilities[k].setting ?? k}）`).join('、'));
}
