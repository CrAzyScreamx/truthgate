import fc from 'fast-check';
import type { CallResult, Expr, FunctionCaller, Property, RunOptions, Spec, TypeSpec, Verdict } from '../contract.ts';
import { expr, ExprError } from '../core/expr.ts';
import { parseType } from '../core/typespec.ts';
import { getAdapter } from '../lang/index.ts';
import { runHypothesis } from './hypothesis.ts';

/** TypeSpec -> fast-check arbitrary. Decimals are scaled integers, so they are exact to `places`. */
export function arb(t: TypeSpec): fc.Arbitrary<unknown> {
  switch (t.t) {
    case 'int':
      return fc.integer({ min: t.min, max: t.max });
    case 'decimal': {
      const k = 10 ** t.places;
      return fc.integer({ min: Math.ceil(t.min * k), max: Math.floor(t.max * k) }).map((n) => Number((n / k).toFixed(t.places)));
    }
    case 'str':
      return fc.string({ maxLength: t.max });
    case 'bool':
      return fc.boolean();
    case 'list':
      return fc.array(arb(t.of), { maxLength: t.max });
    case 'record':
      return fc.record(Object.fromEntries(Object.entries(t.fields).map(([k, v]) => [k, arb(v)])));
    case 'oneof':
      return fc.constantFrom(...t.values);
  }
}

/** Input generator for an ordered set of named args; the object keeps that order (shims rely on it). */
export function inputArb(inputs: Record<string, string>): fc.Arbitrary<Record<string, unknown>> {
  const names = Object.keys(inputs);
  return fc.tuple(...names.map((n) => arb(parseType(inputs[n]!)))).map((vs) => Object.fromEntries(names.map((n, i) => [n, vs[i]])));
}

class Timeout extends Error {}

function timed<T>(p: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Timeout('timeout')), Math.max(0, deadline - Date.now()))));
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

function truth(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new ExprError(`${what} evaluated to ${v === null ? 'null' : typeof v}, expected bool`);
  return v;
}

const show = (v: unknown) => {
  const s = JSON.stringify(v) ?? 'null';
  return s.length > 300 ? `${s.slice(0, 300)}...` : s;
};

const abortReason = (e: unknown) =>
  e instanceof Timeout ? 'timeout' : e instanceof ExprError ? `expression error: ${e.message}` : `shim error: ${(e as Error).message}`;

const tested = (n: number, skips: number) =>
  `${n} runs, 0 failures: failure rate < 3/${n} (95%)${skips ? `; ${skips} inputs discarded by requires/rejected` : ''}`;

type Outcome = { failed: boolean; interrupted: boolean; counterexample: unknown; numRuns: number; numSkips: number };

/** Map a fast-check run onto one verdict. */
function verdictOf(spec: Spec, p: Property, runs: number, r: Outcome, abort: string | null, fail: { ce: unknown; why: string } | null, t0: number, seed: number): Verdict {
  const base = { specId: spec.id, property: p.name, seed, runs: r.numRuns };
  const v = (kind: Verdict['kind'], detail: string, counterexample?: unknown): Verdict => ({ ...base, kind, detail, counterexample, durationMs: Date.now() - t0 });
  if (abort) return v('UNVERIFIED', `${abort} (after ${r.numRuns} runs)`);
  if (r.failed && r.counterexample && fail) return v('FALSIFIED', fail.why, fail.ce);
  if (r.failed && !r.interrupted) return v('UNVERIFIED', `preconditions too strict: ${r.numSkips} inputs discarded vs ${r.numRuns} run`);
  if (r.numRuns < runs) return v('UNVERIFIED', `timeout after ${r.numRuns} of ${runs} runs`);
  return v('TESTED', tested(r.numRuns, r.numSkips));
}

/** fast-check options shared by both runners. maxSkipsPerRun 1 = stop once more than half the inputs were discarded. */
const checkOpts = (seed: number, runs: number, deadline: number) => ({
  seed,
  numRuns: runs,
  maxSkipsPerRun: 1,
  plugins: [fc.interruptAfterTimeLimit(Math.max(1, deadline - Date.now()))],
});

async function runFunctionProp(spec: Spec, p: Property, ast: Expr, caller: FunctionCaller, opts: RunOptions, runs: number): Promise<Verdict> {
  const t0 = Date.now();
  const fn = spec.target.slice(spec.target.lastIndexOf('::') + 2);
  const reqs = spec.requires.map((r) => expr.parse(r));
  let abort: string | null = null;
  let fail: { ce: unknown; why: string } | null = null;
  const prop = fc.asyncProperty(inputArb(spec.inputs), async (input) => {
    if (abort) return true;
    let skip = false;
    let res: CallResult | undefined;
    let ok = true;
    try {
      skip = !reqs.every((r) => truth(expr.evaluate(r, { ...input }), 'requires'));
      if (!skip) {
        res = await timed(caller.call(fn, input), opts.deadline);
        if (!res.ok) skip = res.kind === 'rejected' || !!spec.allowCrash;
        else ok = truth(expr.evaluate(ast, { ...input, out: res.out }), p.name);
      }
    } catch (e) {
      abort = abortReason(e);
      return true;
    }
    fc.pre(!skip);
    if (res && !res.ok) {
      fail = { ce: input, why: `crash for ${show(input)}: ${res.error}` };
      return false;
    }
    if (!ok) fail = { ce: input, why: `${p.name} failed for ${show(input)}: out = ${show(res?.ok && res.out)}` };
    return ok;
  });
  const r = await fc.check(prop, checkOpts(opts.seed, runs, opts.deadline));
  return verdictOf(spec, p, runs, r, abort, fail, t0, opts.seed);
}

type Step = { op: string; input: Record<string, unknown> };

async function runSequenceProp(spec: Spec, p: Property, ast: Expr, caller: FunctionCaller, opts: RunOptions, runs: number): Promise<Verdict> {
  const t0 = Date.now();
  let abort: string | null = null;
  let fail: { ce: unknown; why: string } | null = null;
  let trace: Step[] = [];
  const failNow = (why: string) => {
    fail = { ce: [...trace], why: `${why} after ${trace.map((s) => `${s.op}(${show(s.input)})`).join(', ')}` };
    throw new Error(why);
  };
  const cmds = (spec.ops ?? []).map((op) =>
    inputArb(op.inputs).map(
      (input): fc.AsyncCommand<object, null> => ({
        check: () => true,
        async run() {
          trace.push({ op: op.name, input });
          let res: CallResult;
          let state: unknown;
          let ok: boolean;
          try {
            res = await timed(caller.call(op.name, input), opts.deadline);
            if (!res.ok && res.kind === 'crash' && !spec.allowCrash) return failNow(`${op.name} crashed: ${res.error}`);
            state = await timed(caller.state(), opts.deadline);
            ok = truth(expr.evaluate(ast, { state, op: op.name, input, out: res.ok ? res.out : null }), p.name);
          } catch (e) {
            if (!abort && !fail) abort = abortReason(e);
            throw e;
          }
          if (!ok) failNow(`invariant ${p.name} broken (state = ${show(state)})`);
        },
        toString: () => `${op.name}(${show(input)})`,
      }),
    ),
  );
  const prop = fc.asyncProperty(fc.commands(cmds), async (seq) => {
    if (abort) return true;
    trace = [];
    try {
      await timed(caller.reset(), opts.deadline);
    } catch (e) {
      abort = abortReason(e);
      return true;
    }
    await fc.asyncModelRun(() => ({ model: {}, real: null }), seq);
    return true;
  });
  const r = await fc.check(prop, checkOpts(opts.seed, runs, opts.deadline));
  return verdictOf(spec, p, runs, r, abort, fail, t0, opts.seed);
}

/** Run every property of one spec. Never throws: problems become UNVERIFIED verdicts. */
export async function runSpec(spec: Spec, root: string, opts: RunOptions): Promise<Verdict[]> {
  const t0 = Date.now();
  const whole = (detail: string): Verdict[] => [{ specId: spec.id, kind: 'UNVERIFIED', detail, durationMs: Date.now() - t0 }];
  const props = spec.kind === 'sequence' ? (spec.invariant ?? []) : spec.ensures;
  const runs = spec.runs ?? opts.runs;
  let asts: Expr[];
  try {
    asts = props.map((p) => expr.parse(p.expr));
    spec.requires.forEach((r) => expr.parse(r));
  } catch (e) {
    return whole(`expression error: ${(e as Error).message}`);
  }
  const adapter = getAdapter(spec.lang);
  const avail = await adapter.available(root);
  if (avail !== true) return whole(avail);

  let note = '';
  if (spec.lang === 'python' && spec.kind === 'function' && opts.config.python.native) {
    const r = await runHypothesis(spec, root, { ...opts, runs });
    if (typeof r !== 'string') return r;
    note = ` [native Hypothesis path unavailable, used the shim: ${r}]`;
  }

  let caller: FunctionCaller;
  try {
    caller = await timed(adapter.open(spec, root), opts.deadline);
  } catch (e) {
    return whole(`${abortReason(e)}${note}`);
  }
  try {
    const out: Verdict[] = [];
    for (const [i, p] of props.entries()) {
      if (Date.now() >= opts.deadline) {
        out.push({ specId: spec.id, property: p.name, kind: 'UNVERIFIED', detail: 'timeout: budget used up before this property ran', durationMs: 0 });
        continue;
      }
      const run = spec.kind === 'sequence' ? runSequenceProp : runFunctionProp;
      out.push(await run(spec, p, asts[i]!, caller, opts, runs));
    }
    return note ? out.map((v) => ({ ...v, detail: v.detail + note })) : out;
  } finally {
    await caller.close().catch(() => {});
  }
}
