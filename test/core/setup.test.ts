import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId } from '../../src/contract.ts';
import { globalAgents, setupGlobal, setupProject } from '../../src/setup.ts';
import { put, repo } from './helpers.ts';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', input: '' });

/** Runs setup non-interactively. `hypothesis` answers the Hypothesis question; the pre-commit question takes its default. */
async function run(root: string, agents: AgentId[], opts: { dryRun?: boolean; hypothesis?: boolean } = {}) {
  const lines: string[] = [];
  const io = {
    log: (s: string) => lines.push(s),
    confirm: async (m: string, d: boolean) => (m.includes('Hypothesis') ? !!opts.hypothesis : d),
    dryRun: opts.dryRun,
  };
  const done = await setupProject(root, agents, io);
  return [...lines, done].join('\n') + '\n';
}

test('setup is the bare command only: no init subcommand, no prompt without a terminal', async () => {
  const root = await repo();
  assert.match(cli(root, 'init').stderr, /unknown command "init"/);
  const bare = cli(root);
  assert.equal(bare.status, 2);
  assert.match(bare.stdout, /set up: this project or globally/);
});

test('dry run writes nothing', async () => {
  const root = await repo({ 'a.txt': 'x' });
  const out = await run(root, ['claude'], { dryRun: true });
  assert.match(out, /would create \.truthgate\/\.gitignore/);
  assert.match(out, /Dry run/);
  assert.ok(!existsSync(join(root, '.truthgate')));
  assert.ok(!existsSync(join(root, '.claude')));
});

test('an instruct-only agent gets the pre-commit hook by default, and setup says so', async () => {
  const root = await repo({ 'a.txt': 'x' });
  const out = await run(root, ['amp']);
  assert.match(out, /amp: instruct-only/);
  assert.match(out, /pre-commit hook/);
  assert.equal(await readFile(join(root, '.truthgate/.gitignore'), 'utf8'), 'state.json\nlast-run.json\n');
  assert.match(await readFile(join(root, '.git/hooks/pre-commit'), 'utf8'), /truthgate verify/);
  const again = await run(root, ['amp']); // idempotent
  assert.doesNotMatch(again, /^(create|merge|update) /m);
  assert.match(again, /and at every commit \(pre-commit hook\)/); // already installed: still a gate
});

test('R1-N4: no commit gate promised when the existing hook is not sh', async () => {
  const root = await repo({ 'a.txt': 'x' });
  const py = '#!/usr/bin/env python3\nprint("mine")\n';
  await put(root, '.git/hooks/pre-commit', py);
  const out = await run(root, ['amp']);
  assert.match(out, /amp: instruct-only/);
  assert.doesNotMatch(out, /at every commit/);
  assert.equal(await readFile(join(root, '.git/hooks/pre-commit'), 'utf8'), py);
  assert.match(await run(await repo({ 'a.txt': 'x' }), ['amp']), /and at every commit \(pre-commit hook\)/);
});

test('setup records the baseline at HEAD (once), so commits before the first verify are still checked', async () => {
  const root = await repo({ 'a.txt': 'x' });
  assert.doesNotMatch(await run(root, ['claude'], { dryRun: true }), /Recorded the truthgate baseline/);
  assert.match(await run(root, ['claude']), /Recorded the truthgate baseline at \w{7} \(HEAD\)/);
  assert.doesNotMatch(await run(root, ['claude']), /Recorded the truthgate baseline/);
  assert.match(cli(root, 'status').stdout, /Baseline: \w{7} \(auto\)/);
});

test('an enforcing agent skips the pre-commit hook by default', async () => {
  const root = await repo({ 'a.txt': 'x' });
  await run(root, ['claude']);
  assert.ok(!existsSync(join(root, '.git/hooks/pre-commit')));
});

test('Hypothesis goes only into a project environment (uv or .venv), never the system Python', async () => {
  const root = await repo({ 'pkg/a.py': 'x = 1\n', 'pyproject.toml': '[project]\nname = "p"\n' });
  const sys = await run(root, ['claude'], { dryRun: true, hypothesis: true });
  assert.doesNotMatch(sys, /would run/);
  assert.match(sys, /no uv\.lock or \.venv to add Hypothesis to/);
  await put(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python', '');
  assert.match(await run(root, ['claude'], { dryRun: true, hypothesis: true }), /would run: .*\.venv.* -m pip install hypothesis, then set python\.native .*commit \.truthgate\/config\.json/);
  await put(root, 'uv.lock', '');
  assert.match(await run(root, ['claude'], { dryRun: true, hypothesis: true }), /would run: uv add --dev hypothesis/);
  assert.doesNotMatch(await run(root, ['claude'], { dryRun: true }), /would run/); // declined
});

test('a non-Python repo with stray .py scripts: no Hypothesis offer, no config written, verify not blocked', async () => {
  const root = await repo({ 'src/app.ts': 'export const x = 1;\n', 'scripts/tool.py': 'x = 1\n' });
  assert.doesNotMatch(await run(root, ['claude'], { hypothesis: true }), /Hypothesis/);
  assert.ok(!existsSync(join(root, '.truthgate/config.json')));
  assert.equal(cli(root, 'verify').status, 0);
});

test('global setup writes user-level config, hooks marked --global, idempotent, never runs agent CLIs on another home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tg-home-'));
  await mkdir(join(home, '.cursor'));
  assert.deepEqual(globalAgents(home).detected, ['cursor']);
  const io = (lines: string[]) => ({ log: (s: string) => lines.push(s), confirm: async () => true });
  const first: string[] = [];
  await setupGlobal(home, ['cursor', 'claude'], io(first));
  assert.match(await readFile(join(home, '.cursor/hooks.json'), 'utf8'), /truthgate hook --agent cursor --global/);
  assert.ok(existsSync(join(home, '.cursor/skills/truthgate-spec/SKILL.md')));
  assert.match(first.join('\n'), /would run: claude mcp add/);
  const again: string[] = [];
  await setupGlobal(home, ['cursor', 'claude'], io(again));
  assert.doesNotMatch(again.join('\n'), /^(create|merge) /m);
});
