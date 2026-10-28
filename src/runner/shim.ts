import { createInterface } from 'node:readline';
import type { CallResult, FunctionCaller } from '../contract.ts';
import { killTree, spawnTool } from './proc.ts';

/** The shim itself failed (could not start, died, timed out, broke protocol). Reported as UNVERIFIED. */
export class ShimError extends Error {}

type Reply = { out?: unknown; error?: string; kind?: string };

/**
 * Long-lived JSON Lines shim process. One request at a time (the runners are sequential).
 * The first request has no own timeout (it may include a compile step; the runner's deadline bounds it);
 * later requests time out after `callTimeoutMs`. Non-protocol stdout lines (user prints) are ignored.
 */
export function openShim(command: string[], cwd: string, opts: { callTimeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): FunctionCaller {
  const callTimeoutMs = opts.callTimeoutMs ?? 10_000;
  const child = spawnTool(command, { cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let log = '';
  let dead: string | null = null;
  let answered = false;
  let pending: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;

  const fail = (why: string) => {
    const tail = log.trim().split('\n').slice(-5).join(' | ');
    dead ??= tail ? `${why}: ${tail}` : why;
    pending?.reject(new ShimError(dead));
    pending = null;
  };
  child.stderr!.on('data', (d) => (log = (log + d).slice(-4000)));
  child.stdin!.on('error', () => {});
  child.on('error', (e) => fail(`cannot start ${command[0]}: ${e.message}`));
  child.on('exit', (code) => fail(`shim exited (code ${code})`));
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {}
    if (pending && msg && typeof msg === 'object' && ('out' in msg || 'error' in msg)) {
      const p = pending;
      pending = null;
      answered = true;
      p.resolve(msg as Reply);
    } else log = (log + line + '\n').slice(-4000);
  });

  const send = (msg: object): Promise<Reply> =>
    new Promise<Reply>((resolve, reject) => {
      if (dead) return reject(new ShimError(dead));
      const timer = answered
        ? setTimeout(() => {
            fail(`shim call timed out after ${callTimeoutMs} ms`);
            killTree(child);
          }, callTimeoutMs)
        : undefined;
      pending = {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      child.stdin!.write(JSON.stringify(msg) + '\n');
    });

  const control = async (op: 'reset' | 'state') => {
    const r = await send({ op });
    if ('error' in r) throw new ShimError(`shim ${op} failed: ${r.error}`);
    return r.out;
  };

  return {
    async call(fn, input): Promise<CallResult> {
      const r = await send({ op: 'call', fn, input });
      if (!('error' in r)) return { ok: true, out: r.out ?? null };
      return { ok: false, kind: r.kind === 'rejected' ? 'rejected' : 'crash', error: String(r.error) };
    },
    reset: async () => void (await control('reset')),
    state: () => control('state'),
    async close() {
      dead ??= 'closed';
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
      child.stdin!.end();
      const exited = new Promise((r) => child.once('exit', r));
      const t = setTimeout(() => killTree(child), 2000);
      await exited;
      clearTimeout(t);
    },
  };
}
