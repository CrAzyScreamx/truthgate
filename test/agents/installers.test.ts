import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { applyChanges, installers } from '../../src/agents/index.ts';
import type { AgentId } from '../../src/contract.ts';
import { report } from './report.ts';

const tmp = () => mkdtemp(join(tmpdir(), 'tg-inst-'));
const read = (root: string, p: string) => readFile(join(root, p), 'utf8');


const enforcing: AgentId[] = ['claude', 'codex', 'gemini', 'copilot', 'cursor'];

test('every installer plans relative forward-slash paths, applies, and is idempotent', async () => {
  for (const inst of Object.values(installers)) {
    const root = await tmp();
    const changes = await inst.plan(root);
    assert.ok(changes.length >= 4, inst.id);
    for (const c of changes) assert.ok(!c.path.includes('\\') && !c.path.startsWith('/') && !c.path.includes(':'), c.path);
    assert.ok(changes.some((c) => c.path.endsWith('truthgate-verdicts/SKILL.md')), `${inst.id} skills`);
    await applyChanges(root, changes, false);
    const again = await applyChanges(root, await inst.plan(root), false);
    for (const line of again) assert.match(line, /^skip .* \(up to date\)$/, `${inst.id}: ${line}`);
    assert.equal(inst.enforces, enforcing.includes(inst.id));
    assert.equal(typeof inst.hookOutput === 'function', inst.enforces, `${inst.id} hookOutput`);
  }
});

test('shared files from several agents merge into one', async () => {
  const root = await tmp();
  for (const id of ['codex', 'amp', 'opencode'] as const) await applyChanges(root, await installers[id].plan(root), false);
  const agents = await read(root, 'AGENTS.md');
  assert.equal(agents.split('truthgate:begin').length, 2);
  for (const id of ['claude', 'copilot'] as const) await applyChanges(root, await installers[id].plan(root), false);
  assert.ok(JSON.parse(await read(root, '.mcp.json')).mcpServers.truthgate.command);
});

test('stop hooks and MCP configs are wired with the truthgate commands', async () => {
  const root = await tmp();
  for (const id of enforcing) await applyChanges(root, await installers[id].plan(root), false);
  const claude = JSON.parse(await read(root, '.claude/settings.json'));
  assert.equal(claude.hooks.Stop[0].hooks[0].command, 'npx -y truthgate hook --agent claude');
  const codexHooks = JSON.parse(await read(root, '.codex/hooks.json'));
  assert.equal(codexHooks.hooks.Stop[0].hooks[0].commandWindows, 'cmd /c npx -y truthgate hook --agent codex');
  const codexToml = parseToml(await read(root, '.codex/config.toml')) as { mcp_servers: { truthgate: { args: string[] } } };
  assert.ok(codexToml.mcp_servers.truthgate.args.includes('mcp'));
  const gemini = JSON.parse(await read(root, '.gemini/settings.json'));
  assert.equal(gemini.hooks.AfterAgent[0].hooks[0].command, 'npx -y truthgate hook --agent gemini');
  assert.ok(gemini.mcpServers.truthgate);
  const cmd = parseToml(await read(root, '.gemini/commands/truthgate-approve.toml')) as { prompt: string; description: string };
  assert.match(cmd.prompt, /npx truthgate approve/);
  assert.ok(cmd.description);
  const copilot = JSON.parse(await read(root, '.github/hooks/truthgate.json'));
  assert.equal(copilot.version, 1);
  assert.equal(copilot.hooks.agentStop[0].powershell, 'npx -y truthgate hook --agent copilot');
  const cursor = JSON.parse(await read(root, '.cursor/hooks.json'));
  assert.equal(cursor.hooks.stop[0].command, 'npx -y truthgate hook --agent cursor');
  assert.match(await read(root, '.cursor/rules/truthgate.mdc'), /^---\ndescription: .*\nalwaysApply: true\n---/);
  assert.doesNotMatch(await read(root, '.cursor/commands/truthgate-verify.md'), /^---/);
  const mcpCmd = JSON.parse(await read(root, '.cursor/mcp.json')).mcpServers.truthgate;
  assert.deepEqual([mcpCmd.command, ...mcpCmd.args].slice(-4), ['npx', '-y', 'truthgate', 'mcp']);
});

test('instruct-only agents: manual MCP steps and own rules files', async () => {
  assert.match(installers.windsurf.manualSteps![0]!, /mcp_config\.json[\s\S]*"truthgate"/);
  assert.match(installers.cline.manualSteps![0]!, /"truthgate"/);
  const root = await tmp();
  await applyChanges(root, await installers.kiro.plan(root), false);
  assert.match(await read(root, '.kiro/steering/truthgate.md'), /^---\ninclusion: always\n---/);
  await applyChanges(root, await installers.windsurf.plan(root), false);
  assert.match(await read(root, '.devin/rules/truthgate.md'), /^---\ntrigger: always_on\n---/);
  await applyChanges(root, await installers.opencode.plan(root), false);
  assert.equal(JSON.parse(await read(root, 'opencode.json')).mcp.truthgate.type, 'local');
});

test('hookOutput: block / capped / pass per agent', () => {
  const out = (id: AgentId, blocking: boolean, capped = false) => installers[id].hookOutput!(report(blocking), capped);
  for (const id of ['claude', 'codex', 'copilot'] as const) {
    const b = JSON.parse(out(id, true).stdout);
    assert.equal(b.decision, 'block');
    assert.match(b.reason, /FALSIFIED sort\.basic\/sorted.*counterexample: \{"xs":\[1,0\]\}/);
    assert.equal(out(id, false).stdout, '');
    assert.notEqual(JSON.parse(out(id, true, true).stdout || '{}').decision, 'block');
  }
  assert.match(JSON.parse(out('claude', true, true).stdout).systemMessage, /STILL FAILING/);
  assert.equal(JSON.parse(out('gemini', true).stdout).decision, 'deny');
  assert.equal(JSON.parse(out('gemini', false).stdout).decision, 'allow');
  assert.equal(JSON.parse(out('gemini', true, true).stdout).decision, 'allow');
  assert.match(JSON.parse(out('cursor', true).stdout).followup_message, /FALSIFIED/);
  assert.deepEqual(JSON.parse(out('cursor', true, true).stdout), {});
  assert.deepEqual(JSON.parse(out('cursor', false).stdout), {});
  for (const id of enforcing) assert.equal(out(id, true).exitCode, 0);
});
