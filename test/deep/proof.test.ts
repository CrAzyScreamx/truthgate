import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, Spec, Verdict } from '../../src/contract.ts';
import { auditProof, findTool, run, stripComments, withProverPath } from '../../src/deep/proof.ts';
import type { RunSpecFn } from '../../src/deep/index.ts';

const root = path.resolve(import.meta.dirname, '../..');
const ROCQ_DIR = 'D:/Rocq-Platform~9.1~2026.01/bin';

const config: Config = {
  budgetSeconds: 60,
  deepBudgetSeconds: 120,
  loopCap: 3,
  seed: 42,
  defaultRuns: 100,
  provers: fs.existsSync(ROCQ_DIR) ? { rocq: ROCQ_DIR } : {},
  python: { native: false },
  sourceGlobs: [],
};

function has(cmd: string, prover?: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { env: withProverPath(prover), stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const rocq = has('rocq', config.provers.rocq);
const dafny = has('dafny');

const spec = (tool: 'rocq' | 'dafny', file: string, theorem = 'rev_rev'): Spec => ({
  id: `proof.${path.basename(file)}`,
  target: 'src/x.py::f',
  lang: 'python',
  kind: 'function',
  inputs: {},
  requires: [],
  ensures: [],
  prove: { tool, file, theorem },
  file: '.truthgate/specs/x.yaml',
});
const stub = (kind: Verdict['kind']): RunSpecFn => async (s) => [{ specId: s.id, kind, detail: '', durationMs: 0 }];
const audit = (s: Spec, run = stub('TESTED'), cfg = config) => auditProof(s, root, cfg, Date.now() + 60_000, run);

function tmpProof(name: string, body: string): { dir: string; rel: string } {
  const dir = fs.mkdtempSync(path.join(root, '.tg-proof-test-'));
  fs.writeFileSync(path.join(dir, name), body);
  return { dir, rel: path.relative(root, path.join(dir, name)).replace(/\\/g, '/') };
}

const skipRocq = rocq ? false : 'rocq not installed';

test('clean proof + TESTED spec -> PROVEN, no build artifacts in the tree', { skip: skipRocq }, async () => {
  const v = await audit(spec('rocq', 'fixtures/proofs/clean.v'));
  assert.equal(v.kind, 'PROVEN', v.detail);
  assert.match(v.detail, /closed under the global context/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'fixtures/proofs')).filter((f) => !f.endsWith('.v')), []);
});

test('clean proof + non-TESTED spec -> PROVEN_MODEL_ONLY', { skip: skipRocq }, async () => {
  const v = await audit(spec('rocq', 'fixtures/proofs/clean.v'), stub('FALSIFIED'));
  assert.equal(v.kind, 'PROVEN_MODEL_ONLY');
  assert.match(v.detail, /FALSIFIED/);
});

test('Admitted is rejected', async () => {
  const v = await audit(spec('rocq', 'fixtures/proofs/admitted.v'));
  assert.equal(v.kind, 'UNVERIFIED');
  assert.match(v.detail, /'Admitted' at line 6/);
});

test('Axiom is rejected', async () => {
  const v = await audit(spec('rocq', 'fixtures/proofs/axiom.v'));
  assert.equal(v.kind, 'UNVERIFIED');
  assert.match(v.detail, /'Axiom'/);
});

test('library axiom (classic) is caught by Print Assumptions', { skip: skipRocq }, async () => {
  const { dir, rel } = tmpProof(
    'lem.v',
    'From Stdlib Require Import Classical.\nTheorem t : forall P : Prop, P \\/ ~ P.\nProof. exact classic. Qed.\n',
  );
  try {
    const v = await audit(spec('rocq', rel, 't'));
    assert.equal(v.kind, 'UNVERIFIED');
    assert.match(v.detail, /assumptions: Classical_Prop.classic : forall P : Prop/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compile failure -> UNVERIFIED with the error line', { skip: skipRocq }, async () => {
  const { dir, rel } = tmpProof('broken.v', 'Theorem t : 1 = 1.\nProof. exact nonsense. Qed.\n');
  try {
    const v = await audit(spec('rocq', rel, 't'));
    assert.equal(v.kind, 'UNVERIFIED');
    assert.match(v.detail, /rocq compile failed: line 2: Error/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing theorem -> UNVERIFIED', { skip: skipRocq }, async () => {
  const v = await audit(spec('rocq', 'fixtures/proofs/clean.v', 'nope'));
  assert.equal(v.kind, 'UNVERIFIED');
  assert.match(v.detail, /Print Assumptions failed/);
});

test('rocq not on PATH -> UNVERIFIED (rocq not installed)', { skip: has('rocq') ? 'rocq on PATH' : false }, async () => {
  const v = await audit(spec('rocq', 'fixtures/proofs/clean.v'), stub('TESTED'), { ...config, provers: {} });
  assert.equal(v.kind, 'UNVERIFIED');
  assert.equal(v.detail, 'rocq not installed');
});

test('theorem name cannot inject vernacular', async () => {
  const v = await audit(spec('rocq', 'fixtures/proofs/clean.v', 'rev_rev. Axiom x : False'));
  assert.equal(v.kind, 'UNVERIFIED');
  assert.match(v.detail, /invalid theorem name/);
});

test('proof path outside the repo and missing file', async () => {
  assert.match((await audit(spec('rocq', '../outside.v'))).detail, /outside the repo/);
  assert.match((await audit(spec('rocq', 'fixtures/proofs/none.v'))).detail, /not found/);
});

test('dafny: assume, {:axiom} and {:verify false} rejected; comments ignored', async () => {
  for (const [body, re] of [
    ['lemma L() { assume false; }', /'assume'/],
    ['lemma {:axiom} L()', /axiom/],
    ['lemma {:verify false} L() {}', /verify false/],
  ] as const) {
    const { dir, rel } = tmpProof('p.dfy', body);
    try {
      const v = await audit(spec('dafny', rel, 'L'));
      assert.equal(v.kind, 'UNVERIFIED');
      assert.match(v.detail, re);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('dafny missing -> UNVERIFIED (dafny not installed)', { skip: dafny ? 'dafny installed' : false }, async () => {
  const { dir, rel } = tmpProof('ok.dfy', '// assume nothing\nlemma L() ensures 1 + 1 == 2 {}\n');
  try {
    const v = await audit(spec('dafny', rel, 'L'));
    assert.equal(v.kind, 'UNVERIFIED');
    assert.equal(v.detail, 'dafny not installed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stripComments: nested Rocq comments, strings cannot open a comment', () => {
  assert.doesNotMatch(stripComments('(* a (* Admitted *) b *) Qed.', '(*', '*)'), /Admitted/);
  assert.match(stripComments('Definition s := "(*". Axiom x : False. (* *)', '(*', '*)'), /Axiom/);
  assert.match(stripComments('var s := "\\"/*"; assume false;', '/*', '*/', '//'), /assume/);
  assert.doesNotMatch(stripComments('x // assume\n/* assume */ y', '/*', '*/', '//'), /assume/);
});

test('withProverPath accepts a dir or an exe and prepends it', () => {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const exe = path.join(os.tmpdir(), 'bin', process.platform === 'win32' ? 'rocq.exe' : 'rocq');
  assert.ok(withProverPath(exe)[key]!.startsWith(path.join(os.tmpdir(), 'bin') + path.delimiter));
  assert.ok(withProverPath(os.tmpdir())[key]!.startsWith(path.resolve(os.tmpdir()) + path.delimiter));
  assert.equal(withProverPath(undefined), process.env);
});

test('findTool resolves from PATH; run reports missing tools and kills on the deadline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-findtool-'));
  try {
    const name = process.platform === 'win32' ? 'faketool.exe' : 'faketool';
    fs.writeFileSync(path.join(dir, name), '');
    assert.equal(findTool('faketool', withProverPath(dir)), path.join(dir, name));
    assert.equal(findTool('no-such-tool-tg', withProverPath(dir)), null);
    assert.deepEqual(await run('no-such-tool-tg', [], dir, process.env, Date.now() + 5000), {
      code: -1, out: '', err: '', missing: true,
    });
    assert.equal((await run('node', [], os.tmpdir(), process.env, Date.now() - 1)).timedOut, true);
    const t0 = Date.now();
    const r = await run('node', ['-e', 'setInterval(() => {}, 1000)'], os.tmpdir(), process.env, Date.now() + 300);
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
