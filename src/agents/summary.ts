// Compact text renderings of a RunReport for stop hooks and MCP tool results.
import type { RunReport, Verdict } from '../contract.ts';

const label: Record<Verdict['kind'], string> = {
  PROVEN: 'PROVEN',
  PROVEN_MODEL_ONLY: 'PROVEN (model only)',
  FALSIFIED: 'FALSIFIED',
  TESTED: 'TESTED',
  WEAK_SPEC: 'WEAK SPEC',
  UNVERIFIED: 'UNVERIFIED',
};

export function verdictLine(v: Verdict): string {
  let s = `${label[v.kind]} ${v.specId}${v.property ? '/' + v.property : ''}: ${v.detail}`;
  if (v.counterexample !== undefined) s += ` | counterexample: ${JSON.stringify(v.counterexample)}`;
  return s;
}

/** `all` = every verdict and warning; otherwise only what blocks (FALSIFIED + tampering). */
export function summarize(r: RunReport, all = false): string {
  const verdicts = all ? r.verdicts : r.verdicts.filter((v) => v.kind === 'FALSIFIED');
  const lines = [
    ...verdicts.map(verdictLine),
    ...r.tamper.map((t) => `TAMPER ${t.rule} ${t.file}${t.line ? ':' + t.line : ''}: ${t.detail}`),
  ];
  if (all) lines.push(...r.warnings.map((w) => `warning: ${w}`));
  if (all && lines.length === 0) lines.push('no specs selected for the changed files');
  return lines.join('\n');
}

export function blockReason(r: RunReport): string {
  return `truthgate blocked this stop:\n${summarize(r)}\n` +
    'Fix the code, never weaken the spec or tests (see the truthgate-verdicts skill). ' +
    'Then run `npx -y truthgate verify` and finish again.';
}

export function cappedMessage(r: RunReport): string {
  return '!!! truthgate: STILL FAILING after the loop cap of blocked stops; letting the agent stop. !!!\n' +
    `${summarize(r)}\nThe work is NOT verified. Do not report it as done.`;
}
