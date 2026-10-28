import type { RunReport } from '../../src/contract.ts';

export function report(blocking: boolean): RunReport {
  return {
    verdicts: blocking
      ? [{ specId: 'sort.basic', property: 'sorted', kind: 'FALSIFIED', detail: 'shrunk after 12 runs', counterexample: { xs: [1, 0] }, durationMs: 5 }]
      : [{ specId: 'sort.basic', property: 'sorted', kind: 'TESTED', detail: '100 runs, failure rate < 3%', durationMs: 5 }],
    tamper: [],
    warnings: [],
    changedFiles: ['src/sort.py'],
    blocking,
    durationMs: 10,
  };
}
