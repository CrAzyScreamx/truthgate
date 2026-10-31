import type { AgentInstaller } from '../contract.ts';
import { commands, hookCommand, json, mcp, rules, skills, GLOBAL_RULES } from './common.ts';
import { blockReason } from './summary.ts';

export const cursor: AgentInstaller = {
  id: 'cursor',
  enforces: true,
  hookFile: '.cursor/hooks.json',
  async plan() {
    return [
      ...(await skills('.cursor/skills')),
      ...(await commands('.cursor/commands', '.md', (c) => c.body)), // plain Markdown, no frontmatter
      { path: '.cursor/mcp.json', action: 'merge', content: json({ mcpServers: { truthgate: { type: 'stdio', ...mcp } } }) },
      rules('.cursor/rules/truthgate.mdc', 'description: truthgate verification rules\nalwaysApply: true'),
      // Cursor runs hook commands through PowerShell on Windows, so plain npx works.
      { path: '.cursor/hooks.json', action: 'merge', content: json({ version: 1, hooks: { stop: [{ command: hookCommand('cursor') }] } }), note: 'stop hook' },
    ];
  },
  hookOutput(report, capped) {
    // A non-empty followup_message is submitted as the next user message (the agent continues).
    const out = report.blocking && !capped ? { followup_message: blockReason(report) } : {};
    return { stdout: JSON.stringify(out) + '\n', exitCode: 0 };
  },
  homeDir: '.cursor',
  async globalPlan() {
    return [
      ...(await skills('.cursor/skills')),
      { path: '.cursor/mcp.json', action: 'merge', content: json({ mcpServers: { truthgate: { type: 'stdio', ...mcp } } }) },
      { path: '.cursor/hooks.json', action: 'merge', content: json({ version: 1, hooks: { stop: [{ command: hookCommand('cursor', true) }] } }), note: 'global stop hook' },
    ];
  },
  globalManualSteps: ['Cursor keeps user rules only in its UI: to make them always-on, paste this into Cursor Settings > Rules:\n' + GLOBAL_RULES.trimEnd()],
};
