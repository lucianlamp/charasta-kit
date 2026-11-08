// zip(.charakit)から 1 つのメンバーを読み出す。読むだけ。node:zlib の inflateRaw を使う。
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import {promisify} from 'node:util';

const inflateRaw = promisify(zlib.inflateRaw);

// 末尾の End of Central Directory から中央ディレクトリを読む(zip64 は扱わない)。
export async function readZipMember(zipPath, member) {
  const fh = await fs.open(zipPath, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('zip の終端が見つからない: ' + zipPath);
    const count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOff === 0xffffffff) throw new Error('zip64 は未対応');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('zip の中央ディレクトリが壊れている');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20), nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (name !== member) continue;
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, localOff);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip のローカルヘッダが壊れている');
      const dataOff = localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = Buffer.alloc(csize);
      await fh.read(data, 0, csize, dataOff);
      if (method === 0) return data;
      if (method === 8) return await inflateRaw(data);
      throw new Error('未対応の zip 圧縮方式: ' + method);
    }
    throw new Error(`zip の中に ${member} が無い`);
  } finally { await fh.close(); }
}
