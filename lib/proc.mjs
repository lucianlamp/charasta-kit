// 起動した外部コマンドを、その子ごと止める。Windows の child.kill() は子のプロセスを残すので、taskkill で PID の木を止める(自分が起動した PID だけ)
import {spawnSync} from 'node:child_process';

export function stopPid(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* 既に終わっている */ } }
}

export function stopTree(child) {
  if (child.pid) stopPid(child.pid);
  else child.kill();
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
