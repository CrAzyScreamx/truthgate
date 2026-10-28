import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commitOf } from './diff.ts';

// User-local record OUTSIDE the repo, so committing (or editing tracked files) cannot move it:
// `${TRUTHGATE_HOME ?? ~/.truthgate}/repos/<sha256(realpath root)>.json`.
// ponytail: the agent runs as the same OS user and could still find and edit this file; a keyed
// store (OS keychain) is the upgrade if that ever matters.

export type BaselineSource = 'approve' | 'clean-run' | 'head';

interface BaselineRecord {
  baseline: string | null;
  /** sha256 of approved.json (LF-normalized) as written by `approve`. */
  approvedSha?: string;
  source?: Exclude<BaselineSource, 'head'>;
  updatedAt: string;
}

export const recordPath = async (root: string) => {
  const key = createHash('sha256').update(await realpath(root)).digest('hex');
  return join(process.env.TRUTHGATE_HOME ?? join(homedir(), '.truthgate'), 'repos', `${key}.json`);
};

export async function readRecord(root: string): Promise<BaselineRecord | undefined> {
  try {
    return JSON.parse(await readFile(await recordPath(root), 'utf8')) as BaselineRecord;
  } catch {
    return undefined;
  }
}

/** The commit tamper/approval/config rules compare against. Falls back to HEAD (source 'head') when
 *  nothing is recorded or the recorded commit is gone; commit is '' when the repo has no commits. */
export async function readBaseline(root: string): Promise<{ commit: string; source: BaselineSource }> {
  const rec = await readRecord(root);
  const recorded = rec?.baseline ? await commitOf(root, rec.baseline) : undefined;
  if (recorded) return { commit: recorded, source: rec?.source ?? 'approve' };
  return { commit: (await commitOf(root, 'HEAD')) ?? '', source: 'head' };
}

export async function writeBaseline(
  root: string,
  patch: { commit?: string; approvedSha?: string; source?: Exclude<BaselineSource, 'head'> },
): Promise<void> {
  const file = await recordPath(root);
  const rec: BaselineRecord = { baseline: null, updatedAt: '', ...(await readRecord(root)) };
  if (patch.commit !== undefined) {
    rec.baseline = patch.commit;
    rec.source = patch.source ?? 'approve';
  }
  if (patch.approvedSha !== undefined) rec.approvedSha = patch.approvedSha;
  rec.updatedAt = new Date().toISOString();
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify(rec, null, 2) + '\n');
}
