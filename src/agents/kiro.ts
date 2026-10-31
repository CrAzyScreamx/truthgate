import type { AgentInstaller } from '../contract.ts';
import { json, mcp, rules, skills, GLOBAL_RULES } from './common.ts';

// Instruct-only: Kiro has a Stop hook, but its blocking semantics differ between the IDE and CLI docs.
export const kiro: AgentInstaller = {
  id: 'kiro',
  enforces: false,
  async plan() {
    return [
      ...(await skills('.kiro/skills')),
      { path: '.kiro/settings/mcp.json', action: 'merge', content: json({ mcpServers: { truthgate: { ...mcp, disabled: false } } }) },
      rules('.kiro/steering/truthgate.md', 'inclusion: always'),
    ];
  },
  homeDir: '.kiro',
  async globalPlan() {
    return [
      ...(await skills('.kiro/skills')),
      { path: '.kiro/settings/mcp.json', action: 'merge', content: json({ mcpServers: { truthgate: { ...mcp, disabled: false } } }) },
      rules('.kiro/steering/truthgate.md', 'inclusion: always', GLOBAL_RULES),
    ];
  },
};
