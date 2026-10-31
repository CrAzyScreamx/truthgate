// Shared pieces for the per-agent installers. Paths/payloads are documented in docs/agents.md.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AgentId, FileChange } from '../contract.ts';

const assets = fileURLToPath(new URL('../../assets/', import.meta.url));
export const SKILLS = ['truthgate-spec', 'truthgate-shim', 'truthgate-verdicts'];
export const COMMANDS = ['truthgate-verify', 'truthgate-review'];

export const hookCommand = (id: AgentId, global = false) => `npx -y truthgate hook --agent ${id}${global ? ' --global' : ''}`;

const mcpArgs = ['-y', 'truthgate', 'mcp'];
// ponytail: agents spawn MCP servers without a shell, and npx is npx.cmd on Windows, so wrap it
// in cmd /c there. The written config is per-machine; teammates on other OSes rerun setup.
export const mcp: { command: string; args: string[] } =
  process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...mcpArgs] } : { command: 'npx', args: mcpArgs };

export const json = (o: unknown) => JSON.stringify(o, null, 2) + '\n';

export const RULES = `## truthgate
This repo checks agent-written code against property specs with truthgate.
- Before changing logic that has a clear contract, write or update a spec in \`.truthgate/specs/\` (skill: truthgate-spec). A spec counts as soon as it exists.
- Never edit or delete an existing spec to get a pass: truthgate reports every spec edit to the user. Never run \`truthgate accept\`; that is the user's call.
- Before you say you are done, run \`npx -y truthgate verify\` (or the truthgate MCP \`verify\` tool) and act on the verdicts (skill: truthgate-verdicts).
- FALSIFIED means fix the code. Never weaken specs, skip tests or delete assertions to get a pass.
- Report verdicts exactly as worded: TESTED is not "proven", and UNVERIFIED is not a pass.
`;

/** User-scope rules (every project): the same contract, not worded as one repo's. */
export const GLOBAL_RULES = RULES.replace(
  'This repo checks agent-written code against property specs with truthgate.',
  'truthgate checks agent-written code against property specs. In git repos:',
);

/** Rules as an appended block in a shared file, or as our own file when `frontmatter` is given. */
export function rules(path: string, frontmatter?: string, text = RULES): FileChange {
  return frontmatter === undefined
    ? { path, action: 'append-block', content: text }
    : { path, action: 'create', content: `---\n${frontmatter}\n---\n\n${text}` };
}

export async function skills(dir: string): Promise<FileChange[]> {
  return Promise.all(SKILLS.map(async (name) => ({
    path: `${dir}/${name}/SKILL.md`,
    action: 'create' as const,
    content: await readFile(`${assets}skills/${name}/SKILL.md`, 'utf8'),
  })));
}

export async function readCommand(name: string): Promise<{ raw: string; description: string; body: string }> {
  const raw = (await readFile(`${assets}commands/${name}.md`, 'utf8')).replace(/\r\n/g, '\n');
  const m = /^---\ndescription: (.*)\n---\n\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`assets/commands/${name}.md: missing description frontmatter`);
  return { raw, description: m[1]!, body: m[2]! };
}

/** One file per command under `dir`; `render` maps the asset to the agent's format. */
export async function commands(
  dir: string,
  ext: string,
  render: (c: { raw: string; description: string; body: string }) => string = (c) => c.raw,
): Promise<FileChange[]> {
  return Promise.all(COMMANDS.map(async (name) => ({
    path: `${dir}/${name}${ext}`,
    action: 'create' as const,
    content: render(await readCommand(name)),
  })));
}

/** Stop-hook JSON for agents that use Claude-style `{"decision":"block","reason"}`. */
export function decisionOutput(block: string, reason: string): { stdout: string; exitCode: number } {
  return { stdout: JSON.stringify({ decision: block, reason }) + '\n', exitCode: 0 };
}
