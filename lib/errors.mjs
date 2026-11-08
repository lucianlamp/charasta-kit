// 画面と CLI に返すエラー。code は 'bad-input'(400)、'not-found'(404) など。lib/library.mjs からも同じものを出す
export class LibraryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
