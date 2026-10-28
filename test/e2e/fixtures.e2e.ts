import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { Config, Lang, Verdict } from '../../src/contract.ts';
import { loadSpecs } from '../../src/core/spec.ts';
import { weakSpecCheck } from '../../src/core/weak.ts';
import { getAdapter } from '../../src/lang/index.ts';
import { runSpec } from '../../src/runner/index.ts';

// Every fixture: total.ok -> TESTED, total.buggy -> FALSIFIED (planted off-by-one),
// total.weak -> WEAK_SPEC, stock.seq -> FALSIFIED with a shrunk op sequence (planted guard bug).
const config = { python: { native: false } } as Config;

for (const lang of ['python', 'ts', 'java', 'csharp', 'go', 'rust'] as Lang[]) {
  const root = resolve('fixtures', lang);
  test(`fixtures/${lang}`, { timeout: 300_000 }, async (t) => {
    const avail = await getAdapter(lang).available(root);
    if (avail !== true) return t.skip(`${lang} skipped: ${avail}`);
    const t0 = Date.now();
    const specs = await loadSpecs(root);
    const got: Record<string, Verdict[]> = {};
    for (const s of specs) got[s.id] = await runSpec(s, root, { seed: 42, runs: 100, deadline: Date.now() + 120_000, config });
    const kinds = (id: string) => got[id]!.map((v) => `${v.kind}: ${v.detail}`).join('\n');

    assert.ok(got['total.ok']!.every((v) => v.kind === 'TESTED'), kinds('total.ok'));
    const buggy = got['total.buggy']!.find((v) => v.kind === 'FALSIFIED');
    assert.ok(buggy, kinds('total.buggy'));
    const ce = buggy.counterexample as { xs: number[] };
    assert.ok(ce.xs.length === 1 && Math.abs(ce.xs[0]!) === 1, `off-by-one shrinks to a single +-1 item, got ${JSON.stringify(ce)}`);

    const weak = weakSpecCheck(specs.find((s) => s.id === 'total.weak')!);
    assert.equal(weak[0]?.kind, 'WEAK_SPEC');

    const seq = got['stock.seq']!.find((v) => v.kind === 'FALSIFIED');
    assert.ok(seq, kinds('stock.seq'));
    const steps = seq.counterexample as { op: string }[];
    assert.ok(steps.length >= 1 && steps.length <= 4 && steps.at(-1)!.op === 'remove', JSON.stringify(steps));
    assert.match(seq.detail, /"qty":-1/);

    const ms = Date.now() - t0;
    t.diagnostic(`${lang}: ${ms} ms`);
    if (lang === 'python') assert.ok(ms < 10_000, `python fixture took ${ms} ms (target < 10 s)`);
  });
}
