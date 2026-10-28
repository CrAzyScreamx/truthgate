import type { AgentInstaller } from '../contract.ts';
import { commands, json, mcp, rules, skills } from './common.ts';

// Instruct-only: OpenCode plugins see `session.idle` but cannot block the stop.
export const opencode: AgentInstaller = {
  id: 'opencode',
  enforces: false,
  async plan() {
    return [
      ...(await skills('.opencode/skills')),
      ...(await commands('.opencode/commands', '.md')),
      {
        path: 'opencode.json',
        action: 'merge',
        content: json({
          $schema: 'https://opencode.ai/config.json',
          mcp: { truthgate: { type: 'local', command: [mcp.command, ...mcp.args], enabled: true } },
        }),
      },
      rules('AGENTS.md'),
    ];
  },
};
