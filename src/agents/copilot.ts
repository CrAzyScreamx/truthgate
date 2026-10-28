import type { AgentInstaller } from '../contract.ts';
import { commands, decisionOutput, hookCommand, json, mcp, rules, skills } from './common.ts';
import { blockReason } from './summary.ts';

const server = { type: 'stdio', ...mcp };

export const copilot: AgentInstaller = {
  id: 'copilot',
  enforces: true,
  async plan() {
    const hook = hookCommand('copilot');
    return [
      ...(await skills('.github/skills')),
      ...(await commands('.github/prompts', '.prompt.md')),
      { path: '.mcp.json', action: 'merge', content: json({ mcpServers: { truthgate: server } }), note: 'Copilot CLI' },
      { path: '.vscode/mcp.json', action: 'merge', content: json({ servers: { truthgate: server } }), note: 'VS Code' },
      rules('.github/copilot-instructions.md'),
      {
        path: '.github/hooks/truthgate.json',
        action: 'merge',
        content: json({ version: 1, hooks: { agentStop: [{ type: 'command', bash: hook, powershell: hook, cwd: '.', timeoutSec: 300 }] } }),
        note: 'agentStop hook',
      },
    ];
  },
  manualSteps: ['Copilot cloud agent: MCP servers are set in the repo settings (Copilot > MCP servers), not in a file. Add truthgate there if you use it.'],
  hookOutput(report, capped) {
    // No documented message channel when allowing; the capped summary goes to stderr via runHook.
    if (report.blocking && !capped) return decisionOutput('block', blockReason(report));
    return { stdout: '', exitCode: 0 };
  },
};
