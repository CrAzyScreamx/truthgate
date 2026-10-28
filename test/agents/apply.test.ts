import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyChanges, mergeInto, upsertBlock } from '../../src/agents/apply.ts';

const tmp = () => mkdtemp(join(tmpdir(), 'tg-apply-'));

test('mergeInto: adds keys, appends arrays without dupes, keeps user scalars', () => {
  const base = { a: 1, o: { x: 1 }, arr: [{ k: 1 }] };
  const added = mergeInto(base, { a: 2, b: 3, o: { y: 2 }, arr: [{ k: 1 }, { k: 2 }] });
  assert.deepEqual(base, { a: 1, b: 3, o: { x: 1, y: 2 }, arr: [{ k: 1 }, { k: 2 }] });
  assert.deepEqual(added, ['b', 'o.y', 'arr[]']);
});

test('upsertBlock: append, replace, shebang, hash markers, CRLF', () => {
  const once = upsertBlock('# Title\n', 'hello', 'CLAUDE.md');
  assert.equal(once, '# Title\n\n<!-- truthgate:begin -->\nhello\n<!-- truthgate:end -->\n');
  const twice = upsertBlock(once + 'tail\n', 'bye', 'CLAUDE.md');
  assert.equal(twice, '# Title\n\n<!-- truthgate:begin -->\nbye\n<!-- truthgate:end -->\ntail\n');
  assert.equal(upsertBlock('', 'x', 'a.toml'), '# truthgate:begin\nx\n# truthgate:end\n');
  assert.equal(upsertBlock('#!/bin/sh\nexit 0\n', 'v', 'pre-commit'), '#!/bin/sh\n# truthgate:begin\nv\n# truthgate:end\nexit 0\n');
  assert.equal(upsertBlock('a\r\n', 'x', 'R.md'), 'a\r\n\r\n<!-- truthgate:begin -->\r\nx\r\n<!-- truthgate:end -->\r\n');
});

test('applyChanges: create never overwrites a different file; dry run writes nothing', async () => {
  const root = await tmp();
  await writeFile(join(root, 'x.md'), 'mine');
  const lines = await applyChanges(root, [
    { path: 'x.md', action: 'create', content: 'theirs' },
    { path: 'd/new.md', action: 'create', content: 'n' },
  ], true);
  assert.deepEqual(lines, ['skip x.md (exists and differs; not overwritten)', 'would create d/new.md']);
  await assert.rejects(readFile(join(root, 'd/new.md')));
  await applyChanges(root, [{ path: 'd/new.md', action: 'create', content: 'n' }], false);
  assert.deepEqual(await applyChanges(root, [{ path: 'd/new.md', action: 'create', content: 'n' }], false), ['skip d/new.md (up to date)']);
});

test('applyChanges: JSON merge is idempotent and keeps user keys', async () => {
  const root = await tmp();
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'o' } }, keep: true }));
  const change = { path: '.mcp.json', action: 'merge' as const, content: JSON.stringify({ mcpServers: { truthgate: { command: 'npx' } } }) };
  assert.deepEqual(await applyChanges(root, [change], false), ['merge .mcp.json (+mcpServers.truthgate)']);
  assert.deepEqual(JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')), {
    mcpServers: { other: { command: 'o' }, truthgate: { command: 'npx' } },
    keep: true,
  });
  assert.deepEqual(await applyChanges(root, [change], false), ['skip .mcp.json (up to date)']);
});

test('applyChanges: invalid JSON is skipped, not clobbered', async () => {
  const root = await tmp();
  await writeFile(join(root, 's.json'), '{ // comment\n}');
  const [line] = await applyChanges(root, [{ path: 's.json', action: 'merge', content: '{"a":1}' }], false);
  assert.match(line!, /^skip s\.json \(cannot parse/);
  assert.equal(await readFile(join(root, 's.json'), 'utf8'), '{ // comment\n}');
});

test('applyChanges: TOML merge appends (keeping comments) or rewrites on overlap', async () => {
  const root = await tmp();
  await mkdir(join(root, '.codex'));
  const f = join(root, '.codex/config.toml');
  await writeFile(f, '# my comment\nmodel = "x"\n');
  const change = { path: '.codex/config.toml', action: 'merge' as const, content: '[mcp_servers.truthgate]\ncommand = "npx"\nargs = ["-y", "truthgate", "mcp"]\n' };
  assert.deepEqual(await applyChanges(root, [change], false), ['merge .codex/config.toml (+mcp_servers)']);
  const text = await readFile(f, 'utf8');
  assert.match(text, /# my comment/);
  assert.match(text, /\[mcp_servers\.truthgate\]/);
  assert.deepEqual(await applyChanges(root, [change], false), ['skip .codex/config.toml (up to date)']);

  await writeFile(f, '[mcp_servers.truthgate]\ncommand = "mine"\n');
  await applyChanges(root, [change], false);
  const rewritten = await readFile(f, 'utf8');
  assert.match(rewritten, /command = "mine"/);
  assert.match(rewritten, /args = \[/);
});

test('applyChanges: append-block files and shebang files are written', async () => {
  const root = await tmp();
  await applyChanges(root, [{ path: 'AGENTS.md', action: 'append-block', content: 'rules' }], false);
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '<!-- truthgate:begin -->\nrules\n<!-- truthgate:end -->\n');
  assert.deepEqual(await applyChanges(root, [{ path: 'AGENTS.md', action: 'append-block', content: 'rules' }], false), ['skip AGENTS.md (up to date)']);
});
