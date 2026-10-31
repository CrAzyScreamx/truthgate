// Compact text renderings of a RunReport for stop hooks and MCP tool results.
import type { RunReport, Verdict } from '../contract.ts';
import { KIND_LABEL } from '../core/report.ts';

export function verdictLine(v: Verdict): string {
  let s = `${KIND_LABEL[v.kind]} ${v.specId}${v.property ? '/' + v.property : ''}: ${v.detail}`;
  if (v.counterexample !== undefined) s += ` | counterexample: ${JSON.stringify(v.counterexample)}`;
  return s;
}

/** `all` = every verdict plus deep results; otherwise only FALSIFIED. Tamper and warnings always. */
export function summarize(r: RunReport, all = false): string {
  const verdicts = all ? r.verdicts : r.verdicts.filter((v) => v.kind === 'FALSIFIED');
  const lines = [
    ...verdicts.map(verdictLine),
    ...r.tamper.map((t) => `TAMPER ${t.rule} ${t.file}${t.line ? ':' + t.line : ''}: ${t.detail}`),
  ];
  const m = all ? r.deep?.mutation : undefined;
  if (m) {
    lines.push(`mutation: caught ${m.caught}/${m.total} (${m.durationMs} ms)`);
    lines.push(...m.survivors.map((s) => `  survivor ${s.file}:${s.line}: ${s.desc}`));
  }
  if (all) lines.push(...(r.deep?.proofs ?? []).map(verdictLine));
  lines.push(...(r.specChanges ?? []).map((c) => `SPEC EDITED: ${c}`));
  lines.push(...r.warnings.map((w) => `warning: ${w}`));
  if (all && lines.length === 0) lines.push('no specs selected for the changed files');
  return lines.join('\n');
}

export function blockReason(r: RunReport): string {
  return `truthgate blocked this stop:\n${summarize(r)}\n` +
    'Fix the code, never weaken the spec or tests (see the truthgate-verdicts skill). ' +
    'Then run `npx -y truthgate verify` and finish again.';
}

/** Shown to the user on an allowed stop when specs were edited: specs need no approval, so this is the check. */
export function specEditMessage(r: RunReport): string | undefined {
  if (!r.specChanges?.length) return undefined;
  return `truthgate: specs were edited since the baseline. Review them: a weakened spec passes code it should catch.\n${r.specChanges.map((c) => `- ${c}`).join('\n')}`;
}

/** Shown when the stop is allowed although verification did not pass (loop cap or internal error). */
export function cappedMessage(r: RunReport): string {
  return '!!! truthgate: STOP ALLOWED WITHOUT A PASSING VERIFY !!!\n' +
    `${summarize(r)}\nThe work is NOT verified. Do not report it as done.`;
}
