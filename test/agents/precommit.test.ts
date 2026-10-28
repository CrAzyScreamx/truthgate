import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyChanges, installPreCommit } from '../../src/agents/index.ts';

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tg-pc-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('creates an LF sh hook in .git/hooks, idempotently', async () => {
  const root = await repo();
  const c = await installPreCommit(root);
  assert.equal(c.path, '.git/hooks/pre-commit');
  assert.equal(c.action, 'create');
  await applyChanges(root, [c], false);
  const text = await readFile(join(root, c.path), 'utf8');
  assert.equal(text, '#!/bin/sh\n# truthgate:begin\nnpx -y truthgate verify || exit 1\n# truthgate:end\n');
  assert.deepEqual(await applyChanges(root, [await installPreCommit(root)], false), ['skip .git/hooks/pre-commit (up to date)']);
});

test('keeps an existing hook and runs before its trailing exit', async () => {
  const root = await repo();
  await writeFile(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nlint\nexit 0\n');
  const c = await installPreCommit(root);
  assert.equal(c.action, 'append-block');
  await applyChanges(root, [c], false);
  assert.equal(await readFile(join(root, '.git/hooks/pre-commit'), 'utf8'),
    '#!/bin/sh\n# truthgate:begin\nnpx -y truthgate verify || exit 1\n# truthgate:end\nlint\nexit 0\n');
});

test('sh-family and shebang-less hooks take the block; other languages get a manual step', async () => {
  const root = await repo();
  const hook = join(root, '.git/hooks/pre-commit');
  for (const head of ['#!/usr/bin/env bash\n', '#!/bin/zsh -e\n', 'echo husky\n']) {
    await writeFile(hook, head);
    assert.equal((await installPreCommit(root)).action, 'append-block', head);
  }
  const py = '#!/usr/bin/env python3\nprint("lint")\n';
  await writeFile(hook, py);
  const c = await installPreCommit(root);
  const [line] = await applyChanges(root, [c], false);
  assert.match(line!, /^skip \.git\/hooks\/pre-commit \(exists and differs; not overwritten\) - existing hook is not sh: add `npx -y truthgate verify \|\| exit 1`/);
  assert.equal(await readFile(hook, 'utf8'), py);
});

test('honours core.hooksPath', async () => {
  const root = await repo();
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
  await mkdir(join(root, '.githooks'));
  assert.equal((await installPreCommit(root)).path, '.githooks/pre-commit');
});

test('falls back to .git/hooks outside a git repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tg-nogit-'));
  assert.equal((await installPreCommit(root)).path, '.git/hooks/pre-commit');
});
