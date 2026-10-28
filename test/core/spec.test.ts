import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpecs, parseSpec, SpecError, targetFile } from '../../src/core/spec.ts';
import { loadConfig, DEFAULT_CONFIG } from '../../src/core/config.ts';
import { readState, writeState } from '../../src/core/state.ts';
import { globToRegExp, matchesAny } from '../../src/core/glob.ts';

const SORT = `id: sort.basic
target: src/sort.py::sort_list
lang: python
kind: function
inputs:
  xs: list<int[-1000,1000]>
requires: []
ensures:
  - name: sorted
    expr: "all(i in range(len(out)-1): out[i] <= out[i+1])"
  - name: permutation
    expr: "perm(out, xs)"
runs: 100
prove:
  tool: rocq
  file: proofs/sort.v
  theorem: sort_correct
`;

const SEQ = `id: wh.stock
target: src/wh.go::Warehouse
lang: go
kind: sequence
ops:
  - name: add
    inputs: { n: "int[1,5]" }
  - name: take
    inputs: { n: "int[1,5]" }
invariant:
  - name: nonneg
    expr: "state.stock >= 0"
allowCrash: true
shim: { command: [go, run, "{shim}"], cwd: fixtures/go }
`;

test('parses the plan example and a sequence spec', () => {
  const s = parseSpec(SORT, 'f.yaml');
  assert.equal(s.id, 'sort.basic');
  assert.deepEqual(s.inputs, { xs: 'list<int[-1000,1000]>' });
  assert.equal(s.ensures.length, 2);
  assert.deepEqual(s.prove, { tool: 'rocq', file: 'proofs/sort.v', theorem: 'sort_correct' });
  assert.equal(targetFile(s), 'src/sort.py');
  const q = parseSpec(SEQ, 'q.yaml');
  assert.equal(q.kind, 'sequence');
  assert.deepEqual(q.ops?.map((o) => o.name), ['add', 'take']);
  assert.equal(q.allowCrash, true);
  assert.deepEqual(q.shim, { command: ['go', 'run', '{shim}'], cwd: 'fixtures/go' });
  assert.deepEqual(q.ensures, []);
});

test('defaults kind to function', () => {
  assert.equal(parseSpec('id: a\ntarget: a.py::f\nlang: python\nensures: [{name: t, expr: "true"}]', 'f').kind, 'function');
});

test('errors name the file and field', () => {
  const cases: [string, RegExp][] = [
    [SORT.replace('lang: python', 'lang: cobol'), /f\.yaml: lang:/],
    [SORT.replace('src/sort.py::sort_list', 'src/sort.py'), /target:/],
    [SORT.replace('src/sort.py::sort_list', '../x.py::f'), /target:.*\.\./],
    [SORT.replace('src/sort.py::sort_list', 'src\\sort.py::f'), /target:/],
    [SORT.replace('src/sort.py::sort_list', 'C:/x.py::f'), /target:/],
    [SORT.replace('list<int[-1000,1000]>', 'list<float>'), /inputs\.xs:/],
    [SORT.replace('perm(out, xs)', 'perm(out'), /ensures\[1\]\.expr:/],
    [SORT.replace('requires: []', 'requires: ["eval(1)"]'), /requires\[0\]:/],
    [SORT.replace('requires: []', 'requires: 5'), /requires:/],
    [SORT.replace('runs: 100', 'runs: 0'), /runs:/],
    [SORT.replace('tool: rocq', 'tool: lean'), /prove\.tool:/],
    [SORT.replace('file: proofs/sort.v', 'file: ../x.v'), /prove\.file:/],
    [SORT.replace('id: sort.basic', 'id: "a b"'), /id:/],
    [SORT + 'bogus: 1\n', /bogus: unknown field/],
    ['id: a\ntarget: a.py::f\nlang: python\n', /ensures:/],
    ['- just a list', /\(root\)/],
    ['a: [', /yaml:/],
    [SEQ.replace(/invariant:[\s\S]*?allowCrash/, 'allowCrash'), /invariant:/],
    [SEQ.replace('allowCrash: true', 'allowCrash: yes please'), /allowCrash:/],
    [SEQ.replace('kind: sequence', 'kind: function'), /ensures:|ops:/],
    [SEQ.replace(/ops:[\s\S]*?invariant/, 'invariant'), /ops:/],
    [SEQ.replace('command: [go, run, "{shim}"]', 'command: []'), /shim:/],
    [SEQ.replace('n: "int[1,5]" }\n  - name: take', 'bad-name: "int[1,5]" }\n  - name: take'), /ops\[0\]\.inputs\.bad-name:/],
  ];
  for (const [text, re] of cases) assert.throws(() => parseSpec(text, 'f.yaml'), (e: unknown) => e instanceof SpecError && re.test(e.message), text);
});

test('loadSpecs reads .yaml/.yml, sorted, sets file, rejects duplicate ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tg-spec-'));
  assert.deepEqual(await loadSpecs(root), []);
  await mkdir(join(root, '.truthgate/specs'), { recursive: true });
  await writeFile(join(root, '.truthgate/specs/b.yml'), SEQ);
  await writeFile(join(root, '.truthgate/specs/a.yaml'), SORT);
  await writeFile(join(root, '.truthgate/specs/notes.txt'), 'x');
  const specs = await loadSpecs(root);
  assert.deepEqual(specs.map((s) => s.file), ['.truthgate/specs/a.yaml', '.truthgate/specs/b.yml']);
  await writeFile(join(root, '.truthgate/specs/c.yaml'), SORT);
  await assert.rejects(loadSpecs(root), /c\.yaml: id: "sort.basic" is also used by \.truthgate\/specs\/a\.yaml/);
});

test('loadConfig fills defaults, merges, validates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tg-cfg-'));
  assert.deepEqual(await loadConfig(root), DEFAULT_CONFIG);
  await mkdir(join(root, '.truthgate'));
  await writeFile(join(root, '.truthgate/config.json'), JSON.stringify({ budgetSeconds: 5, provers: { rocq: 'D:/r/bin' } }));
  const c = await loadConfig(root);
  assert.equal(c.budgetSeconds, 5);
  assert.equal(c.loopCap, 3);
  assert.deepEqual(c.provers, { rocq: 'D:/r/bin' });
  assert.deepEqual(c.python, { native: false });
  await writeFile(join(root, '.truthgate/config.json'), '{"seed": "x"}');
  await assert.rejects(loadConfig(root), /seed has the wrong type/);
  await writeFile(join(root, '.truthgate/config.json'), '{nope');
  await assert.rejects(loadConfig(root), /config\.json/);
});

test('state round-trips and survives a corrupt file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tg-state-'));
  assert.deepEqual(await readState(root), { consecutiveBlocks: 0 });
  await writeState(root, { consecutiveBlocks: 2, lastRunAt: 'x' });
  assert.deepEqual(await readState(root), { consecutiveBlocks: 2, lastRunAt: 'x' });
  await writeFile(join(root, '.truthgate/state.json'), 'garbage');
  assert.deepEqual(await readState(root), { consecutiveBlocks: 0 });
});

test('globs', () => {
  assert.ok(matchesAny('src/a/b.py', ['**/*.py']));
  assert.ok(matchesAny('b.py', ['**/*.py']));
  assert.ok(!matchesAny('b.pyc', ['**/*.py']));
  assert.ok(globToRegExp('src/*.ts').test('src/x.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/x.ts'));
  assert.ok(globToRegExp('**/test_*.py').test('tests/test_x.py'));
  assert.ok(globToRegExp('**/*.{test,spec}.ts').test('a/b.spec.ts'));
  assert.ok(!globToRegExp('**/*.{test,spec}.ts').test('a/b.ts'));
  assert.ok(globToRegExp('src/**').test('src/a/b'));
  assert.ok(globToRegExp('a?.go').test('ab.go'));
  assert.ok(!globToRegExp('a.go').test('aXgo'));
});
