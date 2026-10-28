import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, DeepReport, LanguageAdapter, RunOptions, RunReport, Spec, Verdict } from '../contract.ts';
import { loadConfig } from './config.ts';
import { loadSpecs, targetFile } from './spec.ts';
import { changedFiles, NotGitError } from './diff.ts';
import { detectTamper } from './tamper.ts';
import { approvalStates, checkApprovals } from './approve.ts';
import { weakSpecCheck } from './weak.ts';
import { matchesAny } from './glob.ts';

export const LAST_RUN_FILE = '.truthgate/last-run.json';

/** Injection points for tests; defaults are the real modules, imported lazily. */
export interface VerifyDeps {
  runSpec(spec: Spec, root: string, opts: RunOptions): Promise<Verdict[]>;
  runDeep(root: string, specs: Spec[], changed: string[], config: Config): Promise<DeepReport>;
  adapters: LanguageAdapter[];
}

export async function verify(
  root: string,
  opts: { deep?: boolean; all?: boolean; budgetSeconds?: number },
  deps: Partial<VerifyDeps> = {},
): Promise<RunReport> {
  const start = Date.now();
  const config = await loadConfig(root);
  const specs = await loadSpecs(root);
  const adapters = deps.adapters ?? (await import('../lang/index.ts')).adapters;
  const warnings: string[] = [];

  let changed: string[] = [];
  let git = true;
  try {
    changed = await changedFiles(root);
  } catch (e) {
    if (!(e instanceof NotGitError)) throw e;
    git = false;
    warnings.push('not a git repository: running every spec; tamper checks skipped');
  }
  const tamper = git ? [...(await detectTamper(root, changed, adapters)), ...(await checkApprovals(root, specs))] : [];

  const all = opts.all || !git;
  const selected = all ? specs : specs.filter((s) => changed.includes(targetFile(s)) || changed.includes(s.file));

  const targets = new Set(specs.map(targetFile));
  const testGlobs = adapters.flatMap((a) => a.testFileGlobs);
  for (const f of changed) {
    if (targets.has(f) || f.startsWith('.truthgate/') || !matchesAny(f, config.sourceGlobs) || matchesAny(f, testGlobs)) continue;
    if (existsSync(join(root, f))) warnings.push(`${f} changed but has no spec: UNVERIFIED (no spec)`);
  }
  const states = await approvalStates(root, selected);
  for (const s of selected) if (states[s.id] !== 'approved') warnings.push(`spec ${s.id} is not approved yet; ask the user to run \`npx truthgate approve\``);

  const verdicts: Verdict[] = [];
  const budget = opts.budgetSeconds ?? config.budgetSeconds;
  const deadline = start + budget * 1000;
  const runSpec = selected.length ? (deps.runSpec ?? (await import('../runner/index.ts')).runSpec) : undefined;
  // ponytail: specs run one after another; run per-language groups in parallel if the budget gets tight.
  for (const spec of selected) {
    verdicts.push(...weakSpecCheck(spec));
    const t0 = Date.now();
    if (t0 >= deadline) {
      verdicts.push({ specId: spec.id, kind: 'UNVERIFIED', detail: `timeout: the ${budget}s budget ran out before this spec started`, durationMs: 0 });
      continue;
    }
    try {
      verdicts.push(...(await runSpec!(spec, root, { seed: config.seed, runs: spec.runs ?? config.defaultRuns, deadline, config })));
    } catch (e) {
      verdicts.push({ specId: spec.id, kind: 'UNVERIFIED', detail: `runner error: ${(e as Error).message}`, durationMs: Date.now() - t0 });
    }
  }

  let deep: DeepReport | undefined;
  if (opts.deep) deep = await (deps.runDeep ?? (await import('../deep/index.ts')).runDeep)(root, selected, changed, config);

  const report: RunReport = {
    verdicts,
    tamper,
    warnings,
    changedFiles: changed,
    blocking: tamper.length > 0 || [...verdicts, ...(deep?.proofs ?? [])].some((v) => v.kind === 'FALSIFIED'),
    durationMs: Date.now() - start,
    ...(deep && { deep }),
  };
  await mkdir(join(root, '.truthgate'), { recursive: true });
  await writeFile(join(root, LAST_RUN_FILE), JSON.stringify(report, null, 2) + '\n');
  return report;
}
