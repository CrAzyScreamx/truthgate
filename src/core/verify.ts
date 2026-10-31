import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, DeepReport, LanguageAdapter, RunOptions, RunReport, Spec, Verdict } from '../contract.ts';
import { loadConfig } from './config.ts';
import { loadSpecs, targetFile } from './spec.ts';
import { changedFiles, commitOf, isDirty, NotGitError } from './diff.ts';
import { readBaseline, writeBaseline } from './baseline.ts';
import { checkConfig, detectTamper, specChanges } from './tamper.ts';
import { weakSpecCheck } from './weak.ts';
import { matchesAny } from './glob.ts';

export const LAST_RUN_FILE = '.truthgate/last-run.json';
export const OWN_FILES = [LAST_RUN_FILE, '.truthgate/state.json'];

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

  // Everything compares against the user-local baseline commit, not the agent-movable HEAD.
  let changed: string[] = [];
  let git = true;
  let base = '';
  try {
    const b = await readBaseline(root);
    base = b.commit;
    changed = await changedFiles(root, base);
    // First run here (or the record was deleted): pin HEAD now, so later commits cannot hide test or config edits.
    if (b.source === 'head' && base) {
      await writeBaseline(root, { commit: base, source: 'auto' });
      warnings.push(`recorded the truthgate baseline at ${base.slice(0, 7)} (HEAD): changes committed before it are not checked`);
    }
  } catch (e) {
    if (!(e instanceof NotGitError)) throw e;
    git = false;
    warnings.push('not a git repository: running every spec; tamper checks skipped');
  }
  const tamper = git ? [...(await detectTamper(root, changed, adapters, base)), ...(await checkConfig(root, base))] : [];
  const specChanged = git ? await specChanges(root, specs, changed, base) : [];

  const all = opts.all || !git;
  const selected = all ? specs : specs.filter((s) => changed.includes(targetFile(s)) || changed.includes(s.file));

  const targets = new Set(specs.map(targetFile));
  const testGlobs = adapters.flatMap((a) => a.testFileGlobs);
  for (const f of changed) {
    if (targets.has(f) || f.startsWith('.truthgate/') || !matchesAny(f, config.sourceGlobs) || matchesAny(f, testGlobs)) continue;
    if (existsSync(join(root, f))) warnings.push(`${f} changed but has no spec: UNVERIFIED (no spec)`);
  }

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
    specChanges: specChanged,
    changedFiles: changed,
    blocking: tamper.length > 0 || verdicts.some((v) => v.kind === 'FALSIFIED'),
    durationMs: Date.now() - start,
    ...(deep && { deep }),
  };
  // A fully clean run on a clean tree moves the baseline forward. UNVERIFIED holds it back, so committing
  // code whose check could not run never becomes part of the baseline. Spec changes don't (they only warn).
  if (git && !report.blocking && !verdicts.some((v) => v.kind === 'UNVERIFIED') && !(await isDirty(root, OWN_FILES))) {
    const head = await commitOf(root, 'HEAD');
    if (head && head !== base) await writeBaseline(root, { commit: head, source: 'clean-run' });
  }
  await mkdir(join(root, '.truthgate'), { recursive: true });
  await writeFile(join(root, LAST_RUN_FILE), JSON.stringify(report, null, 2) + '\n');
  return report;
}
