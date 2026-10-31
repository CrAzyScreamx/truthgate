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
| `WEAK SPEC` | A fake implementation (identity, constant, empty, null, echo) passed. | Strengthen the spec with a property the fake fails. |
| `UNVERIFIED` | Nothing was established. The reason is given: no spec / timeout / toolchain missing / shim error. | Explain the reason to the user. Fix it where it's yours: write a spec, fix the shim, or narrow the generators on timeout. `cannot load <file>` means the target didn't import: fix that or pick a target that loads (truthgate-spec, "Which targets work"). |
| `TESTED` | N runs and 0 failures, so the failure rate is < 3/N at 95% confidence. | Fine. Report it as tested with N runs, not as proven. |
| `PROVEN (model only)` | The proof checked, but the linked spec isn't TESTED against the real code. | Say so. The proof covers a model, not the implementation. |
| `PROVEN` | The prover ran with no assumptions, and the linked spec is TESTED. | Report it. |

## FALSIFIED: the loop
1. Read the counterexample: `npx truthgate verify --json`, or the MCP `explain_verdict` tool
   (spec id + property). For sequence specs it's the shortest failing op sequence.
2. Reproduce it mentally or with a unit test, find the root cause, and fix the **implementation**.
3. Re-run `npx truthgate verify`. Repeat until it isn't FALSIFIED.
4. If you believe the spec itself is wrong, **stop and ask the user**. Every spec edit is shown to
   them as `SPEC EDIT`, so explain the change before you make it.

## Tamper findings (block)
These are reported when the change weakens the checks themselves:
- removed assertions
- added skip markers (`skip`, `xfail`, `xit`, `@Disabled`, `t.Skip`, `#[ignore]`, ...)
- deleted test files
- a changed `.truthgate/config.json`

Undo the weakening. If it was intentional, explain why to the user: they commit it and run
`npx truthgate accept`. Never run `accept` yourself.

## Spec edits (warn, don't block)
`SPEC EDIT` lines list specs changed or deleted since the baseline. They don't block, because specs
need no approval, but the user sees them. Expect to be asked why.

## Stop hook
When the truthgate stop hook blocks you, its message lists the failing verdicts. Fix them and
finish again. After 3 consecutive blocks, the hook lets you stop and prints a loud failure
report. Then tell the user plainly what is still failing. Never describe the work as done or verified.
