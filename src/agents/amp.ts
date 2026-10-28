import type { AgentInstaller } from '../contract.ts';
import { json, mcp, rules, skills } from './common.ts';

// Instruct-only: Amp's agent.end plugin event can continue a turn, but truthgate v0.1 ships no plugin.
export const amp: AgentInstaller = {
  id: 'amp',
  enforces: false,
  async plan() {
    return [
      ...(await skills('.agents/skills')),
      { path: '.amp/settings.json', action: 'merge', content: json({ 'amp.mcpServers': { truthgate: mcp } }) },
      rules('AGENTS.md'),
    ];
  },
  manualSteps: ['Amp asks before running workspace MCP servers: approve it with `amp mcp approve truthgate`.'],
};
