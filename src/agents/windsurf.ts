import type { AgentInstaller } from '../contract.ts';
import { commands, json, mcp, rules, skills, GLOBAL_RULES } from './common.ts';

// Windsurf is now Devin Desktop: `.devin/` is preferred, `.windsurf/` is legacy. Post-response hooks cannot block.
const MCP_STEP = [
  'Windsurf/Devin reads MCP servers only from user config. Add this to ' +
    (process.platform === 'win32' ? '%APPDATA%\\devin\\mcp_config.json' : '~/.config/devin/mcp_config.json') +
    ':\n' + json({ mcpServers: { truthgate: mcp } }).trimEnd(),
];

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
  manualSteps: MCP_STEP,
  homeDir: '.codeium/windsurf',
  async globalPlan() {
    return [
      ...(await skills('.config/devin/skills')),
      ...(await commands('.codeium/windsurf/global_workflows', '.md')),
      rules('.devin/global_rules.md', undefined, GLOBAL_RULES),
    ];
  },
  // ponytail: Devin's docs give two different user MCP files; print instead of guessing.
  globalManualSteps: MCP_STEP,
};
