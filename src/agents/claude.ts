import type { AgentInstaller } from '../contract.ts';
import { commands, decisionOutput, hookCommand, json, mcp, rules, skills } from './common.ts';
import { blockReason, cappedMessage, specEditMessage } from './summary.ts';

export const claude: AgentInstaller = {
  id: 'claude',
  enforces: true,
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
};
