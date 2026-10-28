import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const quote = (a: string) => (/^[\w\-.:/\\=@+,]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

/** True on win32 when `cmd` is not a directly spawnable .exe/.com (e.g. npx.cmd, gradle.bat). */
function needsShell(cmd: string): boolean {
  if (process.platform !== 'win32' || /\.(exe|com)$/i.test(cmd)) return false;
  if (/[\\/]/.test(cmd)) return !existsSync(`${cmd}.exe`);
  const dirs = (process.env.PATH ?? '').split(delimiter);
  return !dirs.some((d) => d && (existsSync(join(d, `${cmd}.exe`)) || existsSync(join(d, `${cmd}.com`))));
}

/** Spawn with an args array; .cmd/.bat tools on Windows go through cmd.exe with quoted args. */
export function spawnTool(command: string[], opts: SpawnOptions = {}): ChildProcess {
  const [cmd, ...args] = command;
  if (!cmd) throw new Error('empty command');
  // POSIX: own process group, so killTree reaches grandchildren (uv run -> python, go run -> binary).
  const posixGroup = process.platform !== 'win32';
  if (needsShell(cmd)) return spawn([cmd, ...args].map(quote).join(' '), { ...opts, shell: true, windowsHide: true });
  return spawn(cmd, args, { detached: posixGroup, ...opts, windowsHide: true });
}

/** Kill a process and everything it started (launchers such as `uv run` or a custom `go run` leave grandchildren).
 *  Windows (all seen live with `uv run python`): `taskkill /t` can take ~5 s, so callers don't await it, but it must
 *  find the parent alive or the python under uv.exe is orphaned at full CPU. So the direct child is killed only after
 *  taskkill exits, and the taskkill handle stays referenced: if this process exited first, libuv's kill-on-close job
 *  would end uv.exe before the sweep (python escapes that job). Exit is delayed until the sweep ends. */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    const tk = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    tk.on('exit', () => child.kill('SIGKILL')).on('error', () => child.kill('SIGKILL'));
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not start or timed out. */
  error?: string;
}

/** Run a command to completion. Never throws. */
export function exec(command: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;
    try {
      child = spawnTool(command, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, stdout, stderr, error: (e as Error).message });
    }
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ code: null, stdout, stderr, error: `timed out after ${opts.timeoutMs} ms` });
    }, opts.timeoutMs ?? 120_000);
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: `cannot start ${command[0]}: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** `available()` helper: true if `command` runs and exits 0, else a reason. */
export async function probe(command: string[], what: string, cwd?: string): Promise<true | string> {
  const r = await exec(command, { cwd, timeoutMs: 30_000 });
  return r.code === 0 ? true : `toolchain missing: ${what} (${r.error ?? (r.stderr.trim().split('\n')[0] || `exit ${r.code}`)})`;
}
