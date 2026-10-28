import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config, Spec, Verdict, VerdictKind } from '../contract.ts';
import { exec } from '../runner/proc.ts';
import type { RunSpecFn } from './index.ts';

const ROCQ_BANNED = /\b(Admitted|admit|Axioms?|Parameters?)\b/;
const DAFNY_BANNED = /\bassume\b|\{\s*:\s*axiom\b|\{\s*:\s*verify\s+false\s*\}/;
const CLOSED = 'Closed under the global context';

interface Exec {
  code: number;
  out: string;
  err: string;
  missing?: true;
  timedOut?: true;
}

const pathKey = (env: NodeJS.ProcessEnv) => Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';

/** Absolute path of `tool` on env's PATH, or null when it isn't installed. */
export function findTool(tool: string, env: NodeJS.ProcessEnv): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const d of (env[pathKey(env)] ?? '').split(path.delimiter))
    for (const e of exts) if (d && existsSync(path.join(d, tool + e))) return path.join(d, tool + e);
  return null;
}

/** `exec` (kills the process tree on timeout) with a resolved exe, so "not installed" is unambiguous. */
export async function run(tool: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, deadline: number): Promise<Exec> {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) return { code: -1, out: '', err: '', timedOut: true };
  const exe = findTool(tool, env);
  if (!exe) return { code: -1, out: '', err: '', missing: true };
  const r = await exec([exe, ...args], { cwd, env, timeoutMs });
  if (r.error?.startsWith('timed out')) return { code: -1, out: r.stdout, err: r.stderr, timedOut: true };
  return { code: r.code ?? -1, out: r.stdout, err: r.error ? `${r.stderr}
${r.error}` : r.stderr };
}

/** process.env with the prover's directory (config may give the dir or the exe) prepended to PATH. */
export function withProverPath(prover: string | undefined): NodeJS.ProcessEnv {
  if (!prover) return process.env;
  const dir = path.resolve(/^(rocq|dafny)(\.exe)?$/i.test(path.basename(prover)) ? path.dirname(prover) : prover);
  const key = pathKey(process.env);
  const old = process.env[key];
  return { ...process.env, [key]: old ? dir + path.delimiter + old : dir };
}

/** Remove (possibly nested) comments, keeping newlines. Strings are lexed so `"(*"` can't hide code. */
export function stripComments(src: string, open: string, close: string, line?: string): string {
  let out = '';
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inStr && c === '\\' && open === '/*') {
      out += src.slice(i, i + 2); // Dafny escape; Rocq escapes "" which the toggle already handles
      i++;
      continue;
    }
    if (c === '"' && (depth === 0 || open === '(*')) inStr = !inStr; // Rocq lexes strings inside comments too
    else if (!inStr && src.startsWith(open, i)) {
      depth++;
      i += open.length - 1;
      out += ' '.repeat(open.length);
      continue;
    } else if (!inStr && depth > 0 && src.startsWith(close, i)) {
      depth--;
      i += close.length - 1;
      out += ' '.repeat(close.length);
      continue;
    } else if (!inStr && depth === 0 && line && src.startsWith(line, i)) {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += depth > 0 && c !== '\n' ? ' ' : c;
  }
  return out;
}

function banned(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  if (!m) return null;
  return `'${m[0]}' at line ${text.slice(0, m.index).split('\n').length}`;
}

function firstError(e: Exec): string {
  const lines = (e.err + '\n' + e.out).split(/\r?\n/);
  const i = lines.findIndex((l) => /error/i.test(l));
  if (i < 0) return lines.find((l) => l.trim())?.trim() ?? `exit code ${e.code}`;
  const loc = lines[i - 1]?.match(/line (\d+)/);
  return (loc ? `line ${loc[1]}: ` : '') + lines[i]!.trim();
}

/** Ok, or the UNVERIFIED reason. */
type Audit = { ok: true; detail: string } | { ok: false; reason: string };

function failed(tool: string, step: string, e: Exec): Audit {
  if (e.missing) return { ok: false, reason: `${tool} not installed` };
  if (e.timedOut) return { ok: false, reason: 'timeout' };
  return { ok: false, reason: `${tool} ${step} failed: ${firstError(e)}` };
}

async function auditRocq(file: string, theorem: string, config: Config, deadline: number): Promise<Audit> {
  if (!/^[A-Za-z_][\w']*$/.test(theorem)) return { ok: false, reason: `invalid theorem name '${theorem}'` };
  // Compile in a temp copy of the proof's .v siblings so no .vo/.glob lands in the working tree.
  const dir = path.dirname(file);
  const mod = path.basename(file, '.v');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'truthgate-rocq-'));
  try {
    for (const f of await fs.readdir(dir)) if (f.endsWith('.v')) await fs.copyFile(path.join(dir, f), path.join(tmp, f));
    const env = withProverPath(config.provers.rocq);
    const compiled = await run('rocq', ['compile', `${mod}.v`], tmp, env, deadline);
    if (compiled.code !== 0) return failed('rocq', 'compile', compiled);
    const check = 'truthgate_assumptions.v';
    await fs.writeFile(path.join(tmp, check), `Require ${mod}.\nPrint Assumptions ${mod}.${theorem}.\n`);
    const printed = await run('rocq', ['compile', check], tmp, env, deadline);
    if (printed.code !== 0) return failed('rocq', 'Print Assumptions', printed);
    if (printed.out.includes(CLOSED)) return { ok: true, detail: `rocq: ${theorem} closed under the global context` };
    const assumptions = printed.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Axioms:$/.test(l));
    return { ok: false, reason: `assumptions: ${assumptions.join('; ')}` };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

async function auditDafny(file: string, theorem: string, text: string, config: Config, deadline: number): Promise<Audit> {
  const name = theorem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`\\b(lemma|method|function|predicate)\\s+${name}\\b`).test(text))
    return { ok: false, reason: `theorem '${theorem}' not found in ${path.basename(file)}` };
  const r = await run('dafny', ['verify', path.basename(file)], path.dirname(file), withProverPath(config.provers.dafny), deadline);
  if (r.code !== 0) return failed('dafny', 'verify', r);
  return { ok: true, detail: `dafny: ${theorem} verified with no assumptions` };
}

export async function auditProof(
  spec: Spec,
  root: string,
  config: Config,
  deadline: number,
  runSpec: RunSpecFn,
): Promise<Verdict> {
  const start = Date.now();
  const verdict = (kind: VerdictKind, detail: string): Verdict => ({
    specId: spec.id,
    kind,
    detail,
    durationMs: Date.now() - start,
  });
  const p = spec.prove!;
  const base = path.resolve(root);
  const file = path.resolve(base, p.file);
  if (!file.startsWith(base + path.sep)) return verdict('UNVERIFIED', `proof file outside the repo: ${p.file}`);
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) return verdict('UNVERIFIED', `proof file not found: ${p.file}`);

  const stripped = p.tool === 'rocq' ? stripComments(text, '(*', '*)') : stripComments(text, '/*', '*/', '//');
  const bad = banned(stripped, p.tool === 'rocq' ? ROCQ_BANNED : DAFNY_BANNED);
  if (bad) return verdict('UNVERIFIED', `proof rejected: ${p.file} contains ${bad}`);

  const audit =
    p.tool === 'rocq'
      ? await auditRocq(file, p.theorem, config, deadline)
      : await auditDafny(file, p.theorem, stripped, config, deadline);
  if (!audit.ok) return verdict('UNVERIFIED', audit.reason);

  const vs = await runSpec(spec, root, { seed: config.seed, runs: spec.runs ?? config.defaultRuns, deadline, config });
  if (vs.length && vs.every((v) => v.kind === 'TESTED')) return verdict('PROVEN', `${audit.detail}; spec TESTED`);
  const kinds = [...new Set(vs.map((v) => v.kind))].join(', ') || 'no verdicts';
  return verdict('PROVEN_MODEL_ONLY', `${audit.detail}; spec not TESTED (${kinds})`);
}
