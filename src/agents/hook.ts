// Stop-hook entry: parse the agent payload, run verify, apply the loop cap, render agent output.
import type { AgentInstaller, Config, RunReport, State } from '../contract.ts';
import { cappedMessage, summarize } from './summary.ts';

export interface HookDeps {
  verify(root: string, opts: { deep?: boolean; all?: boolean }): Promise<RunReport>;
  loadConfig(root: string): Promise<Config>;
  readState(root: string): Promise<State>;
  writeState(root: string, s: State): Promise<void>;
}

async function defaultDeps(): Promise<HookDeps> {
  const [{ verify }, { loadConfig }, { readState, writeState }] = await Promise.all([
    import('../core/verify.ts'),
    import('../core/config.ts'),
    import('../core/state.ts'),
  ]);
  return { verify, loadConfig, readState, writeState };
}

/** Agents flag a stop that follows a hook-forced continuation (Claude/Codex/Gemini `stop_hook_active`,
 *  Cursor `loop_count`). An explicit "not a continuation" starts a fresh chain, so the count resets. */
function isFreshTurn(payload: Record<string, unknown>): boolean {
  return payload.stop_hook_active === false || payload.loop_count === 0;
}

export async function runHookWith(
  installer: AgentInstaller,
  stdin: string,
  root: string,
  deps?: HookDeps,
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
    const d = deps ?? (await defaultDeps());
    const [config, state] = await Promise.all([d.loadConfig(root), d.readState(root)]);
    let blocks = isFreshTurn(payload) ? 0 : state.consecutiveBlocks;
    const report = await d.verify(root, {});
    let capped = false;
    if (!report.blocking) blocks = 0;
    else if (blocks < config.loopCap) blocks++;
    else {
      capped = true;
      blocks = 0;
    }
    await d.writeState(root, { ...state, consecutiveBlocks: blocks });
    if (capped) process.stderr.write(cappedMessage(report) + '\n'); // loud even where the agent has no message channel
    if (installer.hookOutput) return installer.hookOutput(report, capped);
    return { stdout: summarize(report, true) + '\n', exitCode: 0 };
  } catch (e) {
    // Never break the agent session: allow the stop and surface the error.
    process.stderr.write(`truthgate hook error (stop allowed): ${(e as Error).stack ?? e}\n`);
    return { stdout: '', exitCode: 0 };
  } finally {
    console.log = log;
  }
}
