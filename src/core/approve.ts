import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Approvals, Spec, TamperFinding } from '../contract.ts';
import { loadSpecs, SpecError, targetFile } from './spec.ts';
import { describeType, parseType } from './typespec.ts';
import { changedFiles, commitOf, NotGitError, showAt } from './diff.ts';
import { readBaseline, readRecord, writeBaseline } from './baseline.ts';
import { CONFIG_FILE } from './config.ts';
import { detectTamper } from './tamper.ts';

const RULE_WORDS: Partial<Record<TamperFinding['rule'], string>> = {
  'assert-removed': 'assertions removed, changed or made constant',
  'skip-added': 'tests skipped',
  'test-deleted': 'test file deleted',
  'config-edited': 'truthgate config changed',
};

/** Changes since the old baseline that moving it to HEAD would accept: test-file rules and config.
 *  Spec and approval changes are not listed; approve handles those spec by spec. */
async function absorbed(root: string, specs: Spec[], base: string): Promise<TamperFinding[]> {
  try {
    const changed = await changedFiles(root, base);
    return [
      ...(await detectTamper(root, changed, undefined, base)),
      ...(await checkApprovals(root, specs, base)).filter((f) => f.rule === 'config-edited'),
    ];
  } catch (e) {
    if (e instanceof NotGitError) return [];
    throw e;
  }
}

export const APPROVALS_FILE = '.truthgate/approved.json';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const lf = (s: string) => s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : typeof v === 'object' && v !== null
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v);

/** sha256 of a text file with line endings normalized to LF (and no BOM). Used for specs and approved.json. */
export const specHash = (text: string) => sha256(lf(text));
/** Secondary check only: anyone can recompute it. Trust comes from the baseline (see approvalsTrust). */
export const integrityOf = (specs: Approvals['specs']) => sha256(canonical(specs));

const hashSpec = async (root: string, s: Spec) => specHash(await readFile(join(root, s.file), 'utf8'));
const readText = (root: string, file: string) =>
  readFile(join(root, file), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });

function parseApprovals(text: string): Approvals | null {
  try {
    const a = JSON.parse(text) as Approvals;
    const ok =
      a?.version === 1 &&
      typeof a.integrity === 'string' &&
      typeof a.specs === 'object' &&
      a.specs !== null &&
      Object.values(a.specs).every((e) => typeof e?.sha256 === 'string' && typeof e.approvedAt === 'string');
    return ok ? a : null;
  } catch {
    return null;
  }
}

/** The approvals file, `undefined` if absent, `null` if unreadable or malformed. */
export async function readApprovals(root: string): Promise<Approvals | undefined | null> {
  const text = await readText(root, APPROVALS_FILE);
  return text === undefined ? undefined : parseApprovals(text);
}

/** approved.json is trusted only if it is byte-for-byte (modulo line endings) the file `approve`
 *  last wrote on this machine, or the file at the baseline commit. `edited` says why not. */
async function approvalsTrust(root: string, base: string): Promise<{ a: Approvals | undefined | null; edited?: string }> {
  const text = await readText(root, APPROVALS_FILE);
  const atBase = await showAt(root, base, APPROVALS_FILE);
  const approvedSha = (await readRecord(root))?.approvedSha;
  if (text === undefined) return { a: undefined, edited: atBase !== undefined || approvedSha ? 'approvals file deleted' : undefined };
  const a = parseApprovals(text);
  if (a === null) return { a, edited: 'approvals file is unreadable or malformed' };
  const known = specHash(text) === approvedSha || (atBase !== undefined && lf(atBase) === lf(text));
  if (!known || integrityOf(a.specs) !== a.integrity)
    return { a, edited: 'approvals file differs from what `truthgate approve` wrote and from the baseline commit' };
  return { a };
}

export type ApprovalState = 'approved' | 'pending' | 'changed';

/** Per-spec approval state. An untrusted approvals file counts as absent. */
export async function approvalStates(root: string, specs: Spec[], base?: string): Promise<Record<string, ApprovalState>> {
  const t = await approvalsTrust(root, base ?? (await readBaseline(root)).commit);
  const trusted = t.a && !t.edited ? t.a.specs : {};
  const out: Record<string, ApprovalState> = {};
  for (const s of specs) {
    const entry = Object.hasOwn(trusted, s.id) ? trusted[s.id] : undefined;
    out[s.id] = !entry ? 'pending' : entry.sha256 === (await hashSpec(root, s)) ? 'approved' : 'changed';
  }
  return out;
}

/** Tamper rules against the baseline: spec-changed, spec-deleted, approvals-edited, config-edited. */
export async function checkApprovals(root: string, specs: Spec[], base?: string): Promise<TamperFinding[]> {
  base ??= (await readBaseline(root)).commit;
  const findings: TamperFinding[] = [];
  const t = await approvalsTrust(root, base);
  if (t.edited) findings.push({ file: APPROVALS_FILE, rule: 'approvals-edited', detail: t.edited });
  for (const [id, entry] of Object.entries(t.a?.specs ?? {})) {
    const s = specs.find((x) => x.id === id);
    if (!s) findings.push({ file: APPROVALS_FILE, rule: 'spec-deleted', detail: `approved spec "${id}" no longer exists` });
    else if ((await hashSpec(root, s)) !== entry.sha256)
      findings.push({ file: s.file, rule: 'spec-changed', detail: `approved spec "${id}" changed since approval; ask the user to run \`truthgate approve\`` });
  }
  const [cfg, cfgBase] = [await readText(root, CONFIG_FILE), await showAt(root, base, CONFIG_FILE)];
  if ((cfg === undefined ? undefined : lf(cfg)) !== (cfgBase === undefined ? undefined : lf(cfgBase)))
    findings.push({
      file: CONFIG_FILE,
      rule: 'config-edited',
      detail: `${CONFIG_FILE} differs from the baseline commit; if the user made this change, they commit it and run \`truthgate approve\``,
    });
  return findings;
}

/** Plain-words summary of a spec for the approval prompt. */
export function describeSpec(s: Spec): string {
  const [file, fn] = [targetFile(s), s.target.split('::')[1]];
  const args = (inputs: Record<string, string>) => Object.entries(inputs).map(([k, g]) => `    ${k}: ${describeType(parseType(g))}`);
  const out = [`${s.id}  (${s.file})`, `  Checks ${fn} in ${file} (${s.lang})${s.runs ? `, ${s.runs} runs` : ''}`];
  if (s.kind === 'function') {
    out.push('  Inputs:', ...args(s.inputs));
    if (s.requires.length) out.push('  Only for inputs where:', ...s.requires.map((r) => `    ${r}`));
    out.push('  Must hold for the result `out`:', ...s.ensures.map((p) => `    ${p.name}: ${p.expr}`));
  } else {
    out.push('  Runs random sequences of these operations:');
    for (const op of s.ops ?? []) out.push(`   ${op.name}`, ...args(op.inputs).map((l) => `  ${l}`));
    out.push('  Must hold for `state` after every operation:', ...(s.invariant ?? []).map((p) => `    ${p.name}: ${p.expr}`));
  }
  if (s.allowCrash) out.push('  A crash is not by itself a failure.');
  if (s.prove) out.push(`  Proof: ${s.prove.tool} ${s.prove.file}, ${s.prove.theorem}`);
  return out.join('\n');
}

export interface ApproveIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTTY: boolean;
}

/** Interactive approval. Refuses (exit 2) without a TTY so an agent can never approve its own spec.
 *  Records approved.json's hash and baseline = HEAD in the user-local store (baseline.ts). */
export async function runApprove(
  root: string,
  io: ApproveIO = { input: process.stdin, output: process.stdout, isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY },
): Promise<number> {
  const say = (s: string) => io.output.write(s + '\n');
  if (!io.isTTY) {
    process.stderr.write('truthgate approve needs an interactive terminal: approvals must come from a person, not an agent or script.\n');
    return 2;
  }
  let specs: Spec[];
  try {
    specs = await loadSpecs(root);
  } catch (e) {
    if (!(e instanceof SpecError)) throw e;
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const old = await readBaseline(root);
  const t = await approvalsTrust(root, old.commit);
  const findings = await absorbed(root, specs, old.commit);
  const head = await commitOf(root, 'HEAD');
  const approved: Approvals['specs'] = Object.create(null);
  if (t.a && !t.edited) Object.assign(approved, t.a.specs);
  else if (t.a !== undefined) say('The approvals file was edited outside `truthgate approve`, so every spec needs approval again.');

  let changed = t.a !== undefined && !!t.edited;
  for (const id of Object.keys(approved)) {
    if (specs.some((s) => s.id === id)) continue;
    delete approved[id];
    changed = true;
    say(`Removed the approval for deleted spec "${id}".`);
  }
  const todo: [Spec, string][] = [];
  for (const s of specs) {
    const h = await hashSpec(root, s);
    if (approved[s.id]?.sha256 !== h) todo.push([s, h]);
  }
  if (todo.length === 0) say('All specs are approved.');

  const rl = createInterface({ input: io.input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  let moveBaseline = !!head;
  try {
    if (head && findings.length) {
      say(`\nSince the baseline ${old.commit.slice(0, 7) || '(none)'}, these test and config changes were made:`);
      for (const f of findings) say(`  - ${RULE_WORDS[f.rule] ?? f.rule}: ${f.file}${f.line ? `:${f.line}` : ''} (${f.detail})`);
      io.output.write('Accept these changes as the new baseline? [y/N] ');
      const ans = await lines.next();
      moveBaseline = !ans.done && /^y(es)?$/i.test(ans.value.trim());
      say(moveBaseline ? 'Accepted.' : `Kept the baseline at ${old.commit.slice(0, 7)}: verify keeps reporting these changes. Only specs will be approved.`);
    }
    for (const [s, h] of todo) {
      say(`\n${approved[s.id] ? 'CHANGED' : 'NEW'} ${describeSpec(s)}`);
      io.output.write(`Approve ${s.id}? [y/N] `);
      const ans = await lines.next();
      if (!ans.done && /^y(es)?$/i.test(ans.value.trim())) {
        approved[s.id] = { sha256: h, approvedAt: new Date().toISOString() };
        changed = true;
        say(`Approved ${s.id}.`);
      } else say(`Left ${s.id} unapproved.`);
    }
  } finally {
    rl.close();
  }
  if (changed) {
    const specsSorted = Object.fromEntries(Object.entries(approved).sort(([x], [y]) => (x < y ? -1 : 1)));
    const out: Approvals = { version: 1, specs: specsSorted, integrity: integrityOf(specsSorted) };
    await mkdir(join(root, '.truthgate'), { recursive: true });
    await writeFile(join(root, APPROVALS_FILE), JSON.stringify(out, null, 2) + '\n');
    say(`Wrote ${APPROVALS_FILE}. Commit it with the specs.`);
  }
  const text = await readText(root, APPROVALS_FILE);
  await writeBaseline(root, { ...(text !== undefined && { approvedSha: specHash(text) }), ...(moveBaseline && head && { commit: head, source: 'approve' as const }) });
  if (moveBaseline && head) say(`Baseline set to ${head.slice(0, 7)} (HEAD): truthgate now checks tests, specs and config against this commit.`);
  return 0;
}
