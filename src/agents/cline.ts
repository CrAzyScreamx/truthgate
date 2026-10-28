import type { AgentInstaller } from '../contract.ts';
import { json, mcp, rules, skills } from './common.ts';

// Instruct-only: no documented hook can block completion. Workflow file format is unconfirmed, so no commands.
export const cline: AgentInstaller = {
  id: 'cline',
  enforces: false,
  async plan() {
    return [...(await skills('.cline/skills')), rules('.clinerules/truthgate.md')];
  },
  manualSteps: [
    'Cline reads MCP servers only from its global settings. In the MCP Servers panel choose "Configure", then add:\n' +
      json({ mcpServers: { truthgate: { ...mcp, disabled: false, autoApprove: [] } } }).trimEnd(),
  ],
};
