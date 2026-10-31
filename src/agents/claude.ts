import type { AgentInstaller } from '../contract.ts';
import { commands, decisionOutput, hookCommand, json, mcp, rules, skills, GLOBAL_RULES } from './common.ts';
import { blockReason, cappedMessage, specEditMessage } from './summary.ts';

export const claude: AgentInstaller = {
  id: 'claude',
  enforces: true,
  hookFile: '.claude/settings.json',
  async plan() {
    return [
      ...(await skills('.claude/skills')),
      ...(await commands('.claude/commands', '.md')),
      { path: '.mcp.json', action: 'merge', content: json({ mcpServers: { truthgate: { type: 'stdio', ...mcp } } }) },
      rules('CLAUDE.md'),
      {
        path: '.claude/settings.json',
        action: 'merge',
        // Claude runs command hooks through sh / Git Bash (PowerShell fallback), so plain npx works on Windows.
        content: json({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCommand('claude'), timeout: 300 }] }] } }),
        note: 'Stop hook',
      },
    ];
  },
  hookOutput(report, capped) {
    if (capped) return { stdout: JSON.stringify({ systemMessage: cappedMessage(report) }) + '\n', exitCode: 0 };
    if (report.blocking) return decisionOutput('block', blockReason(report));
    const edits = specEditMessage(report);
    return { stdout: edits ? JSON.stringify({ systemMessage: edits }) + '\n' : '', exitCode: 0 };
  },
  homeDir: '.claude',
  async globalPlan() {
    return [
      ...(await skills('.claude/skills')),
      ...(await commands('.claude/commands', '.md')),
      rules('.claude/CLAUDE.md', undefined, GLOBAL_RULES),
      {
        path: '.claude/settings.json',
        action: 'merge',
        content: json({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCommand('claude', true), timeout: 300 }] }] } }),
        note: 'global Stop hook',
      },
    ];
  },
  // ~/.claude.json is Claude Code's own state file (rewritten constantly): register through its CLI.
  globalExec: [['claude', 'mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'truthgate', '--', mcp.command, ...mcp.args]],
};
