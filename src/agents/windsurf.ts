import type { AgentInstaller } from '../contract.ts';
import { commands, json, mcp, rules, skills } from './common.ts';

// Windsurf is now Devin Desktop: `.devin/` is preferred, `.windsurf/` is legacy. Post-response hooks cannot block.
export const windsurf: AgentInstaller = {
  id: 'windsurf',
  enforces: false,
  async plan() {
    return [
      ...(await skills('.devin/skills')),
      ...(await commands('.devin/workflows', '.md')),
      rules('.devin/rules/truthgate.md', 'trigger: always_on'),
    ];
  },
  manualSteps: [
    'Windsurf/Devin reads MCP servers only from user config. Add this to ' +
      (process.platform === 'win32' ? '%APPDATA%\devin\mcp_config.json' : '~/.config/devin/mcp_config.json') +
      ':\n' + json({ mcpServers: { truthgate: mcp } }).trimEnd(),
  ],
};
