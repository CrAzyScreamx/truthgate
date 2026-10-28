import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Approvals, Spec, TamperFinding } from '../contract.ts';
import { loadSpecs, SpecError, targetFile } from './spec.ts';
import { describeType, parseType } from './typespec.ts';
import { showHead } from './diff.ts';

export const APPROVALS_FILE = '.truthgate/approved.json';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : typeof v === 'object' && v !== null
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v);

/** sha256 of the spec text with line endings normalized to LF (and no BOM). */
export const specHash = (text: string) => sha256(text.replace(/^﻿/, '').replace(/\r\n?/g, '\n'));
export const integrityOf = (specs: Approvals['specs']) => sha256(canonical(specs));

const hashSpec = async (root: string, s: Spec) => specHash(await readFile(join(root, s.file), 'utf8'));

/** The approvals file, `undefined` if absent, `null` if unreadable or malformed. */
export async function readApprovals(root: string): Promise<Approvals | undefined | null> {
  let text: string;
  try {
    text = await readFile(join(root, APPROVALS_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
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

export type ApprovalState = 'approved' | 'pending' | 'changed';

/** Per-spec approval state. Approvals that fail the integrity check count as absent. */
export async function approvalStates(root: string, specs: Spec[]): Promise<Record<string, ApprovalState>> {
  const a = await readApprovals(root);
  const trusted = a && integrityOf(a.specs) === a.integrity ? a.specs : {};
  const out: Record<string, ApprovalState> = {};
  for (const s of specs) {
    const entry = Object.hasOwn(trusted, s.id) ? trusted[s.id] : undefined;
    out[s.id] = !entry ? 'pending' : entry.sha256 === (await hashSpec(root, s)) ? 'approved' : 'changed';
  }
  return out;
}

/** Tamper rules for specs and the approvals file: spec-changed, spec-deleted, approvals-edited. */
export async function checkApprovals(root: string, specs: Spec[]): Promise<TamperFinding[]> {
  const a = await readApprovals(root);
  if (a === undefined) {
    const wasCommitted = (await showHead(root, APPROVALS_FILE)) !== undefined;
    return wasCommitted ? [{ file: APPROVALS_FILE, rule: 'approvals-edited', detail: 'approvals file deleted' }] : [];
  }
  if (a === null) return [{ file: APPROVALS_FILE, rule: 'approvals-edited', detail: 'approvals file is unreadable or malformed' }];
  const findings: TamperFinding[] = [];
  if (integrityOf(a.specs) !== a.integrity)
    findings.push({ file: APPROVALS_FILE, rule: 'approvals-edited', detail: 'approvals file was edited outside `truthgate approve`' });
  for (const [id, entry] of Object.entries(a.specs)) {
    const s = specs.find((x) => x.id === id);
    if (!s) findings.push({ file: APPROVALS_FILE, rule: 'spec-deleted', detail: `approved spec "${id}" no longer exists` });
    else if ((await hashSpec(root, s)) !== entry.sha256)
      findings.push({ file: s.file, rule: 'spec-changed', detail: `approved spec "${id}" changed since approval; ask the user to run \`truthgate approve\`` });
  }
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

/** Interactive approval. Refuses (exit 2) without a TTY so an agent can never approve its own spec. */
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
  const a = await readApprovals(root);
  const approved: Approvals['specs'] = Object.create(null);
  if (a && integrityOf(a.specs) === a.integrity) Object.assign(approved, a.specs);
  else if (a !== undefined) say('The approvals file was edited outside `truthgate approve`, so every spec needs approval again.');

  let changed = false;
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
  try {
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
  if (changed || (a !== undefined && a?.integrity !== integrityOf(approved))) {
    const specsSorted = Object.fromEntries(Object.entries(approved).sort(([x], [y]) => (x < y ? -1 : 1)));
    const out: Approvals = { version: 1, specs: specsSorted, integrity: integrityOf(specsSorted) };
    await mkdir(join(root, '.truthgate'), { recursive: true });
    await writeFile(join(root, APPROVALS_FILE), JSON.stringify(out, null, 2) + '\n');
    say(`Wrote ${APPROVALS_FILE}. Commit it with the specs.`);
  }
  return 0;
}
