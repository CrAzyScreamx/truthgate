// Stop-hook entry: parse the agent payload, run verify, apply the loop cap, render agent output.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentInstaller, Config, RunReport, Spec, State } from '../contract.ts';
import { git } from '../core/diff.ts';
import { DEFAULT_CONFIG } from '../core/config.ts';
import { cappedMessage, specEditMessage, summarize } from './summary.ts';

export interface HookDeps {
  verify(root: string, opts: { deep?: boolean; all?: boolean }): Promise<RunReport>;
  loadConfig(root: string): Promise<Config>;
  loadSpecs(root: string): Promise<Spec[]>;
  readState(root: string): Promise<State>;
  writeState(root: string, s: State): Promise<void>;
}

async function defaultDeps(): Promise<HookDeps> {
  const [{ verify }, { loadConfig }, { loadSpecs }, { readState, writeState }] = await Promise.all([
    import('../core/verify.ts'),
    import('../core/config.ts'),
    import('../core/spec.ts'),
    import('../core/state.ts'),
  ]);
  return { verify, loadConfig, loadSpecs, readState, writeState };
}

/** Agents flag a stop that follows a hook-forced continuation (Claude/Codex/Gemini `stop_hook_active`,
 *  Cursor `loop_count`). An explicit "not a continuation" starts a fresh chain, so the count resets. */
function isFreshTurn(payload: Record<string, unknown>): boolean {
  return payload.stop_hook_active === false || payload.loop_count === 0;
}

const emptyReport = (blocking: boolean, warning: string): RunReport =>
  ({ verdicts: [], tamper: [], warnings: [warning], specChanges: [], changedFiles: [], blocking, durationMs: 0 });

/** Spec/config problems are under the agent's control (a bad spec or config.json), so they block
 *  like a failure instead of silently allowing the stop. Any error from loading specs/config counts
 *  (even EISDIR, whose message names no file); from verify, a SpecError or a `.truthgate/` path does. */
const isUserError = (e: unknown) =>
  e instanceof Error &&
  (e.name === 'SpecError' || /\.truthgate[\\/]/.test(e.message) || /\.truthgate[\\/]/.test(String((e as NodeJS.ErrnoException).path ?? '')));

const userErrorReport = (e: unknown) =>
  emptyReport(true, `truthgate could not run: ${(e as Error).message}. Fix the spec/config; do not delete specs to get past this.`);

/** A global (user-scope) hook fires in every project. It acts only in a git repo that uses truthgate
 *  (has `.truthgate/specs/`) and has no project-level truthgate hook for this agent (that one runs instead).
 *  Returns the repo root to verify, or undefined to allow the stop silently. */
export async function globalRoot(installer: AgentInstaller, cwd: string): Promise<string | undefined> {
  const top = (await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
  if (!top || !existsSync(join(top, '.truthgate', 'specs'))) return undefined;
  const own = installer.hookFile ? await readFile(join(top, installer.hookFile), 'utf8').catch(() => '') : '';
  return own.includes('truthgate hook') ? undefined : top;
}

export async function runHookWith(
  installer: AgentInstaller,
  stdin: string,
  root: string,
  deps?: HookDeps,
  global = false,
): Promise<{ stdout: string; exitCode: number }> {
  const log = console.log;
  console.log = console.error; // stdout is the agent protocol; keep stray logs out of it
  try {
    let payload: Record<string, unknown> = {};
    try {
      const p: unknown = JSON.parse(stdin || '{}');
      if (p && typeof p === 'object' && !Array.isArray(p)) payload = p as Record<string, unknown>;
    } catch {
      // unknown/empty payload: still verify
    }
    if (global) {
      // Project dir: payload cwd (Claude, Codex, Gemini, Copilot), Cursor's workspace_roots (its global hooks
      // run from ~/.cursor), the agent's env var, else our own cwd.
      const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
      const cwd = [payload.cwd, roots[0], process.env.CLAUDE_PROJECT_DIR, process.env.GEMINI_PROJECT_DIR]
        .find((p): p is string => typeof p === 'string' && existsSync(p)) ?? root;
      const top = await globalRoot(installer, cwd);
      if (!top) return output(installer, { ...emptyReport(false, ''), warnings: [] }, false);
      root = top;
    }
    const d = deps ?? (await defaultDeps());
    const state = await d.readState(root);
    let loopCap = DEFAULT_CONFIG.loopCap;
    let report: RunReport;
    let loading = true;
    try {
      loopCap = (await d.loadConfig(root)).loopCap;
      await d.loadSpecs(root);
      loading = false;
      report = await d.verify(root, {});
    } catch (e) {
      if (!loading && !isUserError(e)) throw e;
      report = userErrorReport(e);
    }
    let blocks = isFreshTurn(payload) ? 0 : state.consecutiveBlocks;
    let capped = false;
    if (!report.blocking) blocks = 0;
    else if (blocks < loopCap) blocks++;
    else {
      capped = true;
      blocks = 0;
      report = { ...report, warnings: [...report.warnings, `loop cap reached: ${loopCap} blocked stops in a row`] };
    }
    await d.writeState(root, { ...state, consecutiveBlocks: blocks });
    if (capped) process.stderr.write(cappedMessage(report) + '\n'); // loud even where the agent has no message channel
    else if (!report.blocking && report.specChanges.length) process.stderr.write(specEditMessage(report) + '\n');
    return output(installer, report, capped);
  } catch (e) {
    // Never break the agent session on our own crash: allow the stop, and say so loudly.
    process.stderr.write(`truthgate hook internal error (stop allowed): ${(e as Error).stack ?? e}\n`);
    try {
      return output(installer, emptyReport(true, `truthgate internal error, stop allowed: ${(e as Error).message}`), true);
    } catch {
      return { stdout: '', exitCode: 0 };
    }
  } finally {
    console.log = log;
  }
}

function output(installer: AgentInstaller, report: RunReport, capped: boolean): { stdout: string; exitCode: number } {
  if (installer.hookOutput) return installer.hookOutput(report, capped);
  return { stdout: summarize(report, true) + '\n', exitCode: 0 };
}
