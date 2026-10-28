import type { Config, DeepReport, Lang, RunOptions, Spec, Verdict } from '../contract.ts';
import { mutationCheck } from './mutation.ts';
import { auditProof } from './proof.ts';

export type RunSpecFn = (spec: Spec, root: string, opts: RunOptions) => Promise<Verdict[]>;

/** Injected collaborators; tests pass stubs, production loads the runner and adapters lazily. */
export interface Deps {
  runSpec: RunSpecFn;
  lineComment(lang: Lang): string;
  /** Commit that "changed lines" are measured against (the approval/clean-run baseline, not HEAD). */
  baseCommit(root: string): Promise<string>;
}

async function defaultDeps(): Promise<Deps> {
  const [{ runSpec }, { getAdapter }, { readBaseline }] = await Promise.all([
    import('../runner/index.ts'),
    import('../lang/index.ts'),
    import('../core/baseline.ts'),
  ]);
  return {
    runSpec,
    lineComment: (lang) => getAdapter(lang).lineComment,
    baseCommit: async (root) => (await readBaseline(root)).commit,
  };
}

export async function runDeep(
  root: string,
  specs: Spec[],
  changed: string[],
  config: Config,
  deps?: Deps,
): Promise<DeepReport> {
  const d = deps ?? (await defaultDeps());
  const deadline = Date.now() + config.deepBudgetSeconds * 1000;
  const proofs: Verdict[] = [];
  for (const s of specs) if (s.prove) proofs.push(await auditProof(s, root, config, deadline, d.runSpec));
  const mutation = await mutationCheck(root, specs, changed, config, deadline, d);
  return mutation ? { mutation, proofs } : { proofs };
}
