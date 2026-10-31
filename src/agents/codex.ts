import { stringify } from 'smol-toml';
import type { AgentInstaller } from '../contract.ts';
import { decisionOutput, hookCommand, json, mcp, rules, skills, GLOBAL_RULES } from './common.ts';
import { blockReason, cappedMessage, specEditMessage } from './summary.ts';

export const codex: AgentInstaller = {
  id: 'codex',
  enforces: true,
  hookFile: '.codex/hooks.json',
  async plan() {
    const hook = hookCommand('codex');
    return [
      ...(await skills('.agents/skills')), // Codex has no project commands (custom prompts are user-scope and deprecated)
      { path: '.codex/config.toml', action: 'merge', content: stringify({ mcp_servers: { truthgate: mcp } }) + '\n' },
      rules('AGENTS.md'),
      {
        path: '.codex/hooks.json',
        action: 'merge',
        // The Windows hook shell is undocumented; cmd /c works with or without one.
        content: json({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hook, commandWindows: `cmd /c ${hook}`, timeout: 300 }] }] } }),
        note: 'Stop hook',
      },
    ];
  },
  manualSteps: ['Codex loads project config and hooks only for trusted projects: trust this repo, then review the truthgate hook with /hooks.'],
  hookOutput(report, capped) {
    // Plain-text stdout is invalid for Codex Stop hooks; always JSON or nothing.
    if (capped) return { stdout: JSON.stringify({ systemMessage: cappedMessage(report) }) + '\n', exitCode: 0 };
    if (report.blocking) return decisionOutput('block', blockReason(report));
    const edits = specEditMessage(report);
    return { stdout: edits ? JSON.stringify({ systemMessage: edits }) + '\n' : '', exitCode: 0 };
  },
  homeDir: '.codex',
  async globalPlan() {
    const hook = hookCommand('codex', true);
    return [
      ...(await skills('.agents/skills')),
      { path: '.codex/config.toml', action: 'merge', content: stringify({ mcp_servers: { truthgate: mcp } }) + '\n' },
      rules('.codex/AGENTS.md', undefined, GLOBAL_RULES),
      {
        path: '.codex/hooks.json',
        action: 'merge',
        content: json({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hook, commandWindows: `cmd /c ${hook}`, timeout: 300 }] }] } }),
        note: 'global Stop hook',
      },
    ];
  },
  globalManualSteps: ['Codex runs a new hook only after you trust it: open Codex and review the truthgate hook with /hooks.'],
};
