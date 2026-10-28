import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, Lang, Spec, Verdict } from '../../src/contract.ts';
import { lineMutants, mask, parseHunks, spread } from '../../src/deep/mutation.ts';
import { runDeep, type Deps } from '../../src/deep/index.ts';

const config: Config = {
  budgetSeconds: 60,
  deepBudgetSeconds: 120,
  loopCap: 3,
  seed: 42,
  defaultRuns: 100,
  provers: {},
  python: { native: false },
  sourceGlobs: [],
};

const muts = (line: string, lang: Lang = 'ts') =>
  lineMutants('f', 1, line, mask(line, lang, lang === 'python' ? '#' : '//'), lang).map((m) => `${m.from}>${m.to}`);

test('operators are token-aware', () => {
  assert.deepEqual(muts('if (a <= b) x = y'), ['<=><']);
  assert.deepEqual(muts('if (a === b && c !== d) {'), ['===>!==', '&&>||', '!==>===']);
  assert.deepEqual(muts('const f = (x) => x; let s: i32 = 0'), ['0>1']);
  assert.deepEqual(muts('fn f() -> i32 { a += b; i++ }', 'rust'), []);
});

test('generics are left alone, comparisons are not', () => {
  assert.deepEqual(muts('List<Map<String, Integer>> xs = new ArrayList<>();', 'java'), []);
  assert.deepEqual(muts('if (i<n && j>k) {', 'java'), ['<><=', '&&>||', '>>>=']);
  assert.deepEqual(muts('fn f<\'a>(x: &\'a str) -> Vec<u8> { y < 2 }', 'rust'), ['<><=', '2>3']);
});

test('strings and comments are masked', () => {
  assert.deepEqual(muts('x = "a < b" + 1  // c - 2'), ['+>-', '1>2']);
  assert.deepEqual(muts("s = 'x>y' # 3 + 4", 'python'), []);
  const src = 'def f():\n    """doc\n    a < b\n    """\n    return x\n';
  const masked = mask(src, 'python', '#').split('\n');
  assert.equal(masked[2]!.trim(), '');
  assert.equal(masked[4], '    return x');
});

test('python and/or, integer literals, return of zero value', () => {
  assert.deepEqual(muts('return a and not b or c', 'python'), ['and>or', 'or>and', 'a and not b or c>None']);
  assert.deepEqual(muts('x = 1.5 + arr[10]'), ['+>-', '10>11']);
  assert.deepEqual(muts('    return total; // done', 'csharp'), ['total>default']);
  assert.deepEqual(muts('return None', 'python'), []);
});

test('parseHunks reads new-side line ranges; null when there are none', () => {
  const d = '@@ -3 +3 @@\n-a\n+b\n@@ -10,0 +11,2 @@\n+c\n+d\n@@ -20,2 +22,0 @@\n-e\n';
  assert.deepEqual([...parseHunks(d)!], [3, 11, 12]);
  assert.equal(parseHunks(''), null);
});

test('spread alternates files, then lines, before repeating a line', () => {
  const m = (file: string, line: number, from: string) => ({ file, line, col: 0, from, to: '', desc: '' });
  const out = spread([[m('a', 1, 'x'), m('a', 1, 'y'), m('a', 2, 'z')], [m('b', 5, 'w')]]);
  assert.deepEqual(out.map((x) => `${x.file}${x.line}${x.from}`), ['a1x', 'b5w', 'a2z', 'a1y']);
});

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mut-test-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'big.js'), 'x');
  fs.writeFileSync(path.join(dir, 'src', 'm.ts'), 'import x from "y";\nexport function lt(a, b) {\n  return a;\n}\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  // Changed lines: 3 (mutable) and 4 (comment). Line 1 (import) stays unchanged anyway.
  fs.writeFileSync(
    path.join(dir, 'src', 'm.ts'),
    'import x from "y";\nexport function lt(a, b) {\n  return a < b && b > 0;\n  // a - b\n}\n',
  );
  return dir;
}

const spec: Spec = {
  id: 'm.lt',
  target: 'src/m.ts::lt',
  lang: 'ts',
  kind: 'function',
  inputs: {},
  requires: [],
  ensures: [],
  file: '.truthgate/specs/m.yaml',
};

test('mutation: temp copy only, caught/total/survivors, cleanup', async () => {
  const dir = repo();
  const before = fs.readFileSync(path.join(dir, 'src/m.ts'), 'utf8');
  const roots: string[] = [];
  const deps: Deps = {
    lineComment: () => '//', baseCommit: async () => 'HEAD',
    runSpec: async (s, root, opts) => {
      roots.push(root);
      assert.equal(opts.runs, 25);
      assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
      const line = fs.readFileSync(path.join(root, 'src/m.ts'), 'utf8').split('\n')[2]!;
      // The "suite" only notices changes to the first comparison or the return value.
      const kind: Verdict['kind'] = line.includes('a < b') ? 'TESTED' : 'FALSIFIED';
      return [{ specId: s.id, kind, detail: '', durationMs: 0 }];
    },
  };
  try {
    const r = await runDeep(dir, [spec], ['src/m.ts'], config, deps);
    const mu = r.mutation!;
    assert.equal(mu.total, 5);
    assert.equal(mu.caught, 2); // '<'->'<=', return -> undefined
    assert.deepEqual(mu.survivors.map((s) => s.desc), [
      "replaced '&&' with '||'",
      "replaced '>' with '>='",
      'replaced literal 0 with 1',
    ]);
    assert.ok(mu.survivors.every((s) => s.file === 'src/m.ts' && s.line === 3));
    assert.equal(fs.readFileSync(path.join(dir, 'src/m.ts'), 'utf8'), before);
    assert.ok(roots.length && roots.every((x) => path.resolve(x) !== path.resolve(dir)));
    assert.ok(roots.every((x) => !fs.existsSync(x)));
    assert.deepEqual(r.proofs, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mutation: mutants nothing could run are not counted', async () => {
  const dir = repo();
  const deps: Deps = {
    lineComment: () => '//', baseCommit: async () => 'HEAD',
    runSpec: async (s) => [{ specId: s.id, kind: 'UNVERIFIED', detail: 'shim error', durationMs: 0 }],
  };
  try {
    const mu = (await runDeep(dir, [spec], ['src/m.ts'], config, deps)).mutation!;
    assert.deepEqual([mu.caught, mu.total, mu.survivors.length], [0, 0, 0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mutation: skipped when no changed file is targeted; untracked file counts as all changed', async () => {
  const dir = repo();
  const deps: Deps = { lineComment: () => '//', baseCommit: async () => 'HEAD', runSpec: async (s) => [{ specId: s.id, kind: 'FALSIFIED', detail: '', durationMs: 0 }] };
  try {
    assert.equal((await runDeep(dir, [spec], ['other.ts'], config, deps)).mutation, undefined);
    fs.writeFileSync(path.join(dir, 'src', 'n.ts'), 'export const n = (a) => a + 1;\n');
    const mu = (await runDeep(dir, [{ ...spec, target: 'src/n.ts::n' }], ['src/n.ts'], config, deps)).mutation!;
    assert.deepEqual([mu.caught, mu.total], [2, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mutation: zero budget runs nothing', async () => {
  const dir = repo();
  let calls = 0;
  const deps: Deps = { lineComment: () => '//', baseCommit: async () => 'HEAD', runSpec: async () => (calls++, []) };
  try {
    const mu = (await runDeep(dir, [spec], ['src/m.ts'], { ...config, deepBudgetSeconds: 0 }, deps)).mutation!;
    assert.equal(mu.total, 0);
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mutation: changed lines are measured against the baseline commit, not HEAD', async () => {
  const dir = repo();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const base = git('rev-parse', 'HEAD');
  git('commit', '-qam', 'agent moved HEAD'); // the agent commits its change; the baseline stays put
  const lines: number[] = [];
  const deps: Deps = {
    lineComment: () => '//',
    baseCommit: async (root) => (assert.equal(root, dir), base),
    runSpec: async (s) => [{ specId: s.id, kind: 'TESTED', detail: '', durationMs: 0 }],
  };
  try {
    const mu = (await runDeep(dir, [spec], ['src/m.ts'], config, deps)).mutation!;
    for (const sv of mu.survivors) lines.push(sv.line);
    assert.equal(mu.total, 5);
    assert.deepEqual([...new Set(lines)], [3]); // unchanged `const k = 7` (line 6) is never mutated
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
