import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguageAdapter, Spec, TamperFinding } from '../contract.ts';
import { showAt } from './diff.ts';
import { readBaseline } from './baseline.ts';
import { matchesAny } from './glob.ts';
import { CONFIG_FILE } from './config.ts';

/** Assertions that check nothing. Flagged when newly added. */
export const CONSTANT_ASSERTS: RegExp[] = [
  /\bassert\s*\(?\s*(True|true|1)\s*\)?\s*;?$/, // assert True, assert(true)
  /\bassert\s+(?<v>\S+)\s*==\s*\k<v>\s*$/, // assert 1 == 1
  /(\bexpect|\bassertTrue|\bassert!|\bAssert\.(True|IsTrue)|\bassert\.ok|\bassert)\s*\(\s*(true|True|1)\s*\)/,
  /\bexpect\s*\(\s*(?<v>[^()]+?)\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\s*\(\s*\k<v>\s*\)/, // expect(1).toBe(1)
  /\b(assert_eq!|assertEquals|assertEqual|assert\.(equal|strictEqual|deepEqual|deepStrictEqual)|Assert\.(Equal|AreEqual))\s*\(\s*(?<v>[^,()]+?)\s*,\s*\k<v>\s*\)/,
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Lines with line comments removed (a comment starts at line start or after whitespace), trimmed.
 *  ponytail: block comments are not stripped. */
const code = (text: string, comments: string[]) => {
  const re = comments.length ? new RegExp(`(^|\\s)(${comments.map(esc).join('|')}).*$`) : undefined;
  return text.split(/\r?\n/).map((l) => (re ? l.replace(re, '') : l).trim());
};

/** Lines of `a` (matching `pred`) not matched one-for-one by a line in `b`, with 1-based line numbers. */
function extra(a: string[], b: string[], pred: (l: string) => boolean): { line: number; text: string }[] {
  const pool = b.filter(pred);
  const out: { line: number; text: string }[] = [];
  a.forEach((text, i) => {
    if (!pred(text)) return;
    const j = pool.indexOf(text);
    if (j >= 0) pool.splice(j, 1);
    else out.push({ line: i + 1, text });
  });
  return out;
}

/** Test-file rules vs the baseline commit: assert-removed (an assertion line removed or changed, or a
 *  new constant assertion), skip-added (also in new test files), test-deleted.
 *  The config rule is checkConfig; spec edits are warnings (specChanges), not tamper. */
export async function detectTamper(root: string, changed: string[], adapters?: LanguageAdapter[], base?: string): Promise<TamperFinding[]> {
  adapters ??= (await import('../lang/index.ts')).adapters;
  base ??= (await readBaseline(root)).commit;
  const findings: TamperFinding[] = [];
  for (const file of changed) {
    const own = adapters.filter((a) => matchesAny(file, a.testFileGlobs));
    if (own.length === 0) continue;
    const old = await showAt(root, base, file);
    const exists = existsSync(join(root, file));
    const current = exists ? await readFile(join(root, file), 'utf8') : undefined;
    // Rust unit tests live inline in src/: such a file is a test file only if it has a test module.
    if (file.endsWith('.rs') && matchesAny(file, ['**/src/**/*.rs']) && !(old ?? current ?? '').includes('#[cfg(test)]')) continue;
    if (!exists) {
      if (old !== undefined) findings.push({ file, rule: 'test-deleted', detail: 'test file deleted' });
      continue;
    }
    const comments = [...new Set(own.map((a) => a.lineComment).filter(Boolean))];
    const was = old === undefined ? [] : code(old, comments);
    const now = code(current!, comments);
    const asserts = own.flatMap((a) => a.assertPatterns);
    const skips = own.flatMap((a) => a.skipMarkers);
    const isAssert = (l: string) => asserts.some((p) => l.search(p) >= 0);
    const isSkip = (l: string) => skips.some((p) => l.search(p) >= 0);

    const removed = extra(was, now, isAssert);
    if (removed.length)
      findings.push({ file, rule: 'assert-removed', detail: `${removed.length} assertion line(s) removed or changed since the baseline, e.g. \`${removed[0]!.text}\`` });
    for (const c of extra(now, was, (l) => CONSTANT_ASSERTS.some((p) => l.search(p) >= 0)))
      findings.push({ file, line: c.line, rule: 'assert-removed', detail: `constant assertion: \`${c.text}\`` });
    const added = extra(now, was, isSkip);
    if (added.length) findings.push({ file, line: added[0]!.line, rule: 'skip-added', detail: `new skip marker: ${added[0]!.text}` });
  }
  return findings;
}

const lf = (t: string | undefined) => t?.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

/** config-edited: .truthgate/config.json differs from the baseline commit (budget, runs, globs and seed all weaken checks). */
export async function checkConfig(root: string, base: string): Promise<TamperFinding[]> {
  const now = lf(await readFile(join(root, CONFIG_FILE), 'utf8').catch(() => undefined));
  if (now === lf(await showAt(root, base, CONFIG_FILE))) return [];
  const detail = `${CONFIG_FILE} differs from the baseline commit; if the user made this change, they commit it and run \`npx truthgate accept\``;
  return [{ file: CONFIG_FILE, rule: 'config-edited', detail }];
}

/** Specs edited or deleted since the baseline. Not blocking (specs need no approval), but weakening a spec is
 *  how an agent would dodge a FALSIFIED, so reports and stop hooks show these loudly. */
export async function specChanges(root: string, specs: Spec[], changed: string[], base: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of changed) {
    if (!f.startsWith('.truthgate/specs/') || !/\.ya?ml$/.test(f)) continue;
    const old = await showAt(root, base, f);
    if (old === undefined) continue; // a new spec
    const spec = specs.find((x) => x.file === f);
    if (!spec) out.push(`spec file ${f} was deleted since the baseline ${base.slice(0, 7)}`);
    else if (lf(old) !== lf(await readFile(join(root, f), 'utf8')))
      out.push(`spec ${spec.id} (${f}) was changed since the baseline ${base.slice(0, 7)}: check it was not weakened`);
  }
  return out;
}
