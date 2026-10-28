import type { RunReport, Verdict, VerdictKind } from '../contract.ts';

export const KIND_LABEL: Record<VerdictKind, string> = {
  PROVEN: 'PROVEN',
  PROVEN_MODEL_ONLY: 'PROVEN (model only)',
  FALSIFIED: 'FALSIFIED',
  TESTED: 'TESTED',
  WEAK_SPEC: 'WEAK SPEC',
  UNVERIFIED: 'UNVERIFIED',
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Compact terminal table: one line per verdict, counterexamples on the next line, then a summary. */
export function formatReport(r: RunReport): string {
  const all: Verdict[] = [...r.verdicts, ...(r.deep?.proofs ?? [])];
  const rows: [string, string, string][] = all.map((v) => [KIND_LABEL[v.kind], v.property ? `${v.specId} / ${v.property}` : v.specId, v.detail]);
  const w0 = Math.max(10, ...rows.map((x) => x[0].length));
  const w1 = Math.max(4, ...rows.map((x) => x[1].length));
  const out: string[] = [];
  all.forEach((v, i) => {
    const [k, name, detail] = rows[i]!;
    out.push(`${k.padEnd(w0)}  ${name.padEnd(w1)}  ${detail}`);
    if (v.kind === 'FALSIFIED' && v.counterexample !== undefined)
      out.push(`${''.padEnd(w0)}  counterexample: ${JSON.stringify(v.counterexample)}${v.seed !== undefined ? ` (seed ${v.seed})` : ''}`);
  });
  for (const t of r.tamper) out.push(`${'TAMPER'.padEnd(w0)}  ${t.rule}  ${t.file}${t.line ? `:${t.line}` : ''}  ${t.detail}`);
  const m = r.deep?.mutation;
  if (m) {
    out.push(`${'MUTATION'.padEnd(w0)}  caught ${m.caught}/${m.total} mutants`);
    for (const s of m.survivors) out.push(`${''.padEnd(w0)}  survived: ${s.file}:${s.line} ${s.desc}`);
  }
  for (const w of r.warnings) out.push(`${'WARN'.padEnd(w0)}  ${w}`);
  if (out.length === 0) out.push('No specs ran: no changed file has a spec.');

  const counts = (Object.keys(KIND_LABEL) as VerdictKind[])
    .map((k) => [k, all.filter((v) => v.kind === k).length] as const)
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${KIND_LABEL[k]}`);
  const summary = [counts.join(', ') || 'no verdicts', plural(r.tamper.length, 'tamper finding'), plural(r.warnings.length, 'warning')].join(' · ');
  const falsified = all.filter((v) => v.kind === 'FALSIFIED').length;
  const why = [falsified && plural(falsified, 'FALSIFIED verdict'), r.tamper.length && plural(r.tamper.length, 'tamper finding')].filter(Boolean).join(' and ');
  out.push('', `${summary} · ${(r.durationMs / 1000).toFixed(1)}s`);
  out.push(r.blocking ? `BLOCKING: ${why}. Fix the code, never the spec or the tests.` : 'OK: nothing blocking.');
  return out.join('\n');
}
