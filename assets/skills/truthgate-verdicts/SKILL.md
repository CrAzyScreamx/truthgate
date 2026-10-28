---
name: truthgate-verdicts
description: Read and act on truthgate verdicts (FALSIFIED, WEAK SPEC, UNVERIFIED, TESTED, PROVEN) and tamper findings. Use whenever `truthgate verify`, the truthgate stop hook or the MCP verify tool reports results, or when it blocks you from finishing.
---

# Acting on truthgate verdicts

truthgate never claims more than it established. Report its verdicts to the user **as worded**.
Do not upgrade them: "TESTED" is not "proven correct".

| Verdict | Meaning | What you do |
|---|---|---|
| `FALSIFIED` | A shrunk counterexample breaks a property. **Blocks.** | **Fix the code.** Never weaken, delete or skip the spec, and never special-case the counterexample. |
| `WEAK SPEC` | A fake implementation (identity, constant, empty, null, echo) passed. | Strengthen the spec with a property the fake fails, then ask the user to re-approve. |
| `UNVERIFIED` | Nothing was established. The reason is given: no spec / timeout / toolchain missing / shim error. | Explain the reason to the user. Fix it where it's yours: write a spec, fix the shim, or narrow the generators on timeout. |
| `TESTED` | N runs and 0 failures, so the failure rate is < 3/N at 95% confidence. | Fine. Report it as tested with N runs, not as proven. |
| `PROVEN (model only)` | The proof checked, but the linked spec isn't TESTED against the real code. | Say so. The proof covers a model, not the implementation. |
| `PROVEN` | The prover ran with no assumptions, and the linked spec is TESTED. | Report it. |

## FALSIFIED: the loop
1. Read the counterexample: `npx truthgate verify --json`, or the MCP `explain_verdict` tool
   (spec id + property). For sequence specs it's the shortest failing op sequence.
2. Reproduce it mentally or with a unit test, find the root cause, and fix the **implementation**.
3. Re-run `npx truthgate verify`. Repeat until it isn't FALSIFIED.
4. If you believe the spec itself is wrong, **stop and ask the user**. Changing an approved spec
   voids its approval and shows up as tampering. Only the user can re-approve (`npx truthgate approve`).

## Tamper findings (block)
These are reported when the change weakens the checks themselves:
- removed assertions
- added skip markers (`skip`, `xfail`, `xit`, `@Disabled`, `t.Skip`, `#[ignore]`, ...)
- deleted test files
- changed or deleted approved specs
- a hand-edited `.truthgate/approved.json`

Undo the weakening. If it was intentional, explain why to the user and let them decide.

## Stop hook
When the truthgate stop hook blocks you, its message lists the failing verdicts. Fix them and
finish again. After 3 consecutive blocks, the hook lets you stop and prints a loud failure
report. Then tell the user plainly what is still failing. Never describe the work as done or verified.
