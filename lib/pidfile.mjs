// 保管場所の server.pid: 動いているサーバーの PID。起動したら書き、終わるときに自分の PID のときだけ消す。
// Windows で外から止められた(Stop-Process、taskkill)ときは消えずに残るが、次の起動で書き直す。
// 止める側は、この PID のプロセスが本当に node server.mjs かを確かめてから止める(番号は使い回されるため)。
import fs from 'node:fs';
import path from 'node:path';

export const pidPath = dir => path.join(dir, 'server.pid');

export function writePidFile(dir, pid = process.pid) {
  fs.writeFileSync(pidPath(dir), `${pid}\n`);
}

export function removePidFile(dir, pid = process.pid) {
  try {
    if (fs.readFileSync(pidPath(dir), 'utf8').trim() === String(pid)) fs.unlinkSync(pidPath(dir));
  } catch { /* 無い、読めない: 何もしない */ }
}
