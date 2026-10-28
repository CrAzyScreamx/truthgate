import type { Spec, TypeSpec, Verdict } from '../contract.ts';
import { expr } from './expr.ts';
import { parseType } from './typespec.ts';

const SAMPLES = 30;

/** Deterministic sample: i=0 lower edge, i=1 upper edge, else seeded random. */
function sample(t: TypeSpec, i: number, rnd: () => number): unknown {
  const pick = <T>(lo: T, hi: T, r: () => T) => (i === 0 ? lo : i === 1 ? hi : r());
  switch (t.t) {
    case 'int':
      return pick(t.min, t.max, () => t.min + Math.floor(rnd() * (t.max - t.min + 1)));
    case 'decimal':
      return pick(t.min, t.max, () => Number((t.min + rnd() * (t.max - t.min)).toFixed(t.places)));
    case 'str':
      return pick('', 'z'.repeat(t.max), () => Array.from({ length: Math.floor(rnd() * (t.max + 1)) }, () => 'abZ 09_é'[Math.floor(rnd() * 8)]).join(''));
    case 'bool':
      return pick(false, true, () => rnd() < 0.5);
    case 'list': {
      const n = pick(0, t.max, () => Math.floor(rnd() * (t.max + 1)));
      return Array.from({ length: n }, () => sample(t.of, i, rnd));
    }
    case 'record':
      return Object.fromEntries(Object.entries(t.fields).map(([k, f]) => [k, sample(f, i, rnd)]));
    case 'oneof':
      return pick(t.values[0], t.values.at(-1), () => t.values[Math.floor(rnd() * t.values.length)]);
  }
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** WEAK_SPEC when a fake implementation satisfies every `ensures` on sample inputs. No shim needed.
 *  ponytail: sequence specs are skipped; their state only exists behind a shim. */
export function weakSpecCheck(spec: Spec): Verdict[] {
  if (spec.kind !== 'function' || spec.ensures.length === 0) return [];
  const start = Date.now();
  const types = Object.entries(spec.inputs).map(([k, g]) => [k, parseType(g)] as const);
  const rnd = lcg(42);
  const requires = spec.requires.map((r) => expr.parse(r));
  const ensures = spec.ensures.map((p) => expr.parse(p.expr));
  const inputs: Record<string, unknown>[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const input = Object.fromEntries(types.map(([k, t]) => [k, sample(t, i, rnd)]));
    try {
      if (requires.every((r) => expr.evaluate(r, input) === true)) inputs.push(input);
    } catch {
      // input the preconditions cannot judge: not a usable sample
    }
  }
  if (inputs.length === 0) return [];

  const first = types[0]?.[0];
  const fakes: [string, (input: Record<string, unknown>) => unknown][] = [
    ...(first ? [[`returns its input "${first}" unchanged`, (x: Record<string, unknown>) => x[first]] as [string, (x: Record<string, unknown>) => unknown]] : []),
    ['always returns 0', () => 0],
    ['always returns ""', () => ''],
    ['always returns []', () => []],
    ['always returns {}', () => ({})],
    ['always returns null', () => null],
  ];
  const passing = fakes
    .filter(([, fake]) =>
      inputs.every((input) => {
        const env = { ...input, out: fake(input) };
        try {
          return ensures.every((e) => expr.evaluate(e, env) === true);
        } catch {
          return false;
        }
      }),
    )
    .map(([desc]) => desc);
  if (passing.length === 0) return [];
  return [
    {
      specId: spec.id,
      kind: 'WEAK_SPEC',
      detail: `a fake implementation that ${passing.join(' / ')} passes every ensures; the spec does not pin the behavior down`,
      durationMs: Date.now() - start,
    },
  ];
}
