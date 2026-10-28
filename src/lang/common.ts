import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FunctionCaller, Lang, Spec } from '../contract.ts';
import { exec } from '../runner/proc.ts';
import { openShim } from '../runner/shim.ts';

/** Bundled template file. Same relative depth from src/lang/ and dist/lang/, so this works in both. */
export const bundledTemplate = (lang: Lang, file: string) => fileURLToPath(new URL(`../../src/lang/${lang}/templates/${file}`, import.meta.url));

export function splitTarget(spec: Spec): { file: string; name: string } {
  const i = spec.target.lastIndexOf('::');
  if (i < 0) throw new Error(`target "${spec.target}" must be file::name`);
  return { file: spec.target.slice(0, i), name: spec.target.slice(i + 2) };
}

/** Spec id as a file/module-safe name. */
export const safeId = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '_');

/** Argument names, in order, for the function or op `fn`. */
export function argOrder(spec: Spec, fn: string): string[] {
  return Object.keys(spec.ops?.find((o) => o.name === fn)?.inputs ?? spec.inputs);
}

/** spec.shim.command with {root}/{shim} substituted, or `dflt`; plus the cwd to run it in. */
export function shimCommand(spec: Spec, root: string, shim: string, dflt: string[]): { command: string[]; cwd: string } {
  if (!spec.shim) return { command: dflt, cwd: root };
  const sub = (s: string) => s.replaceAll('{root}', root).replaceAll('{shim}', shim);
  const cwd = spec.shim.cwd ? (isAbsolute(spec.shim.cwd) ? spec.shim.cwd : resolve(root, sub(spec.shim.cwd))) : root;
  return { command: spec.shim.command.map(sub), cwd };
}

/** The user's saved copy of a generic shim if present, else the bundled one. */
export const genericShim = (root: string, saved: string, lang: Lang, file: string) => (existsSync(join(root, saved)) ? join(root, saved) : bundledTemplate(lang, file));

/** Error raised by `open()` when the shim cannot be set up; the runner reports it as UNVERIFIED. */
export class SetupError extends Error {}

export const missingShim = (spec: Spec, path: string) =>
  new SetupError(`shim missing: run \`npx truthgate shim ${spec.id}\` and save it to ${path}`);

/** Run a build step, then `run(stdout)` as the shim: a direct child (not `go run`/`cargo run`), so the
 *  deadline can kill it at once. `tmp` (if given) is removed on close or on a failed build. */
export async function buildThenRun(
  build: string[],
  cwd: string,
  run: (stdout: string) => string[] | undefined,
  opts: { tmp?: string; env?: NodeJS.ProcessEnv; what: string },
): Promise<FunctionCaller> {
  const cleanup = () => (opts.tmp ? rm(opts.tmp, { recursive: true, force: true }) : Promise.resolve());
  const r = await exec(build, { cwd, env: opts.env, timeoutMs: 300_000 });
  const command = r.code === 0 ? run(r.stdout) : undefined;
  if (!command) {
    await cleanup();
    const all = (r.error ?? `${r.stderr}\n${r.stdout}`).split('\n').map((l) => l.trim()).filter(Boolean);
    const errs = all.filter((l) => /error/i.test(l));
    throw new SetupError(`${opts.what} failed: ${(errs.length ? errs : all).slice(0, 3).join(' | ') || `exit ${r.code}`}`);
  }
  const caller = openShim(command, cwd, { env: opts.env });
  return {
    ...caller,
    async close() {
      await caller.close();
      await cleanup();
    },
  };
}
