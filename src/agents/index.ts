import type { AgentId, AgentInstaller } from '../contract.ts';
import { amp } from './amp.ts';
import { claude } from './claude.ts';
import { cline } from './cline.ts';
import { codex } from './codex.ts';
import { copilot } from './copilot.ts';
import { cursor } from './cursor.ts';
import { gemini } from './gemini.ts';
import { runHookWith } from './hook.ts';
import { kiro } from './kiro.ts';
import { opencode } from './opencode.ts';
import { windsurf } from './windsurf.ts';

export { installPreCommit } from './precommit.ts';
export { applyChanges } from './apply.ts';

export const installers: Record<AgentId, AgentInstaller> = {
  claude, codex, gemini, copilot, cursor, amp, windsurf, opencode, cline, kiro,
};

export function runHook(agent: AgentId, stdin: string, root: string): Promise<{ stdout: string; exitCode: number }> {
  return runHookWith(installers[agent], stdin, root);
}
