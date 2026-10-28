import { stringify } from 'smol-toml';
import type { AgentInstaller } from '../contract.ts';
import { commands, decisionOutput, hookCommand, json, mcp, rules, skills } from './common.ts';
import { blockReason, cappedMessage } from './summary.ts';

export const gemini: AgentInstaller = {
  id: 'gemini',
  enforces: true,
  async plan() {
    return [
      ...(await skills('.gemini/skills')),
      ...(await commands('.gemini/commands', '.toml', (c) => stringify({ description: c.description, prompt: c.body }) + '\n')),
      {
        path: '.gemini/settings.json',
        action: 'merge',
        // AfterAgent timeout is in ms (default 60 s, too short for npx + a 60 s verify budget).
        content: json({
          mcpServers: { truthgate: mcp },
          hooks: { AfterAgent: [{ matcher: '*', hooks: [{ name: 'truthgate', type: 'command', command: hookCommand('gemini'), timeout: 300000 }] }] },
        }),
        note: 'MCP + AfterAgent hook',
      },
      rules('GEMINI.md'),
    ];
  },
  hookOutput(report, capped) {
    if (capped) return { stdout: JSON.stringify({ decision: 'allow', systemMessage: cappedMessage(report) }) + '\n', exitCode: 0 };
    if (report.blocking) return decisionOutput('deny', blockReason(report));
    return { stdout: JSON.stringify({ decision: 'allow' }) + '\n', exitCode: 0 };
  },
};
