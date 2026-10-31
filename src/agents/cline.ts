import type { AgentInstaller } from '../contract.ts';
import { json, mcp, rules, skills, GLOBAL_RULES } from './common.ts';

// Instruct-only: no documented hook can block completion. Workflow file format is unconfirmed, so no commands.
const MCP_STEP =
  'Cline reads MCP servers only from its global settings. In the MCP Servers panel choose "Configure", then add:\n' +
  json({ mcpServers: { truthgate: { ...mcp, disabled: false, autoApprove: [] } } }).trimEnd();

export const cline: AgentInstaller = {
  id: 'cline',
  enforces: false,
  async plan() {
    return [...(await skills('.cline/skills')), rules('.clinerules/truthgate.md')];
  },
  manualSteps: [MCP_STEP],
  homeDir: '.cline',
  async globalPlan() {
    return [
      ...(await skills('.cline/skills')),
      rules('.cline/rules/truthgate.md', undefined, GLOBAL_RULES),
      {
        path: '.cline/data/settings/cline_mcp_settings.json',
        action: 'merge',
        content: json({ mcpServers: { truthgate: { ...mcp, disabled: false, autoApprove: [] } } }),
        note: 'Cline CLI',
      },
    ];
  },
  globalManualSteps: [`Cline IDE extension: ${MCP_STEP}`],
};
