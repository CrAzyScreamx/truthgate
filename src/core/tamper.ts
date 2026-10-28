import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguageAdapter, TamperFinding } from '../contract.ts';
import { showHead } from './diff.ts';
import { matchesAny } from './glob.ts';

const lines = (s: string) => s.split(/\r?\n/);
const hits = (text: string, pats: RegExp[]) => lines(text).filter((l) => pats.some((p) => l.search(p) >= 0)).map((l) => l.trim());

/** Test-file rules (assert-removed, skip-added, test-deleted) for changed files that exist at HEAD.
 *  New test files have no baseline and are not checked. Spec/approval rules live in checkApprovals. */
export async function detectTamper(root: string, changed: string[], adapters?: LanguageAdapter[]): Promise<TamperFinding[]> {
  adapters ??= (await import('../lang/index.ts')).adapters;
  const findings: TamperFinding[] = [];
  for (const file of changed) {
    const own = adapters.filter((a) => matchesAny(file, a.testFileGlobs));
    if (own.length === 0) continue;
    const head = await showHead(root, file);
    if (head === undefined) continue;
    if (!existsSync(join(root, file))) {
      findings.push({ file, rule: 'test-deleted', detail: 'test file deleted' });
      continue;
    }
    const work = await readFile(join(root, file), 'utf8');
    const asserts = own.flatMap((a) => a.assertPatterns);
    const skips = own.flatMap((a) => a.skipMarkers);
    const [ah, aw] = [hits(head, asserts).length, hits(work, asserts).length];
    if (aw < ah) findings.push({ file, rule: 'assert-removed', detail: `assertions went from ${ah} to ${aw}` });
    const headSkips = hits(head, skips);
    if (hits(work, skips).length > headSkips.length) {
      // Point at the first skip line that HEAD did not have.
      const line = lines(work).findIndex((l) => {
        if (!skips.some((p) => l.search(p) >= 0)) return false;
        const i = headSkips.indexOf(l.trim());
        return i < 0 || (headSkips.splice(i, 1), false);
      });
      findings.push({ file, line: line + 1 || undefined, rule: 'skip-added', detail: `new skip marker: ${lines(work)[line]?.trim() ?? ''}` });
    }
  }
  return findings;
}
