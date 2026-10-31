# truthgate benchmark

Measures what truthgate adds on top of ordinary example tests. Each task is run with planted bugs, once without truthgate and
once with it. The benchmark then tries to defeat the gate the way an agent would, and checks the whole plugin end to end
through the packed tarball.

```powershell
node bench/run.ts                  # everything; writes bench/RESULTS.md (1 to 3 minutes; the first run builds caches)
node bench/run.ts --only ts-chunk  # matrix for matching tasks only; writes bench/RESULTS.partial.md
```
Needs the same toolchains as the fixtures: Python, Node, JDK, .NET, Go and Rust. The exit code is 1 on a **regression**:
a correct version that is blocked, fails an example or isn't TESTED, a tamper scenario with an unexpected result, a failed
integration check, or a harness error. A planted bug that gets missed is a measurement, not a regression. On a regression
the temp work dir is kept and its path is printed at the start of the run.

## What runs

**1. Catch-rate matrix.** 12 tasks across all 6 languages. Each task has one correct version and 3 planted bugs, all in
`bench/tasks/<task>/task.yaml`. Two of them cover the code a plain TS loader can't handle:
- `ts-nest`: NestJS-style, with a decorator, a parameter property, alias and extensionless imports, CommonJS and `init`
- `ts-mutate`: a void function that mutates its argument, checked with `observe`

Every case starts as a fresh git repo: the build files and the spec are committed, a verify records the baseline, and the
target file is missing. Then the agent's version of the target file is written. Two arms run on the same tree:
- **Without truthgate:** the task's example tests. These are fixed per task and written once, before the variants, in the
  style of typical agent unit tests: a happy path, an edge case and an obvious refusal. They go through the same language
  adapter the verifier uses, so both arms call the code the same way.
- **With truthgate:** the example tests plus `truthgate verify`. A case is caught when verify blocks, which is exactly what
  the stop hook and the pre-commit gate act on.

The correct versions also run `verify --deep`, which reports how many mutants the spec kills.

**2. Tamper scenarios.** These start from a committed repo with a recorded baseline and native tests (`unittest` or
`node:test`). The agent plants a bug that a test or the spec would catch, then defeats that check instead of fixing the bug.
It removes or rewrites an assertion, skips the test, deletes the test file, edits the config, or commits with
`--no-verify`. Each of those must block.

It may also weaken the spec, committed or not. Specs need no approval, so that must be **flagged** (reported to the user as
a spec edit), not blocked. Deleting the user-local store record is the documented known limit (see `KNOWN_ISSUES.md`).
The baseline is then re-recorded at HEAD and that run says so.

**3. Integration.** Runs through the installed CLI:
- `init` for all ten agents, and that a second `init` changes nothing
- `init --yes` in a TS repo with stray `.py` scripts installs nothing and writes no config that `verify` would flag
- each enforcing agent's stop hook blocks the bug and allows the fix
- the loop cap
- a weakened spec does not block, but the stop hook tells the user
- `status` shows the spec, the baseline and the edit
- `accept` unblocks an intentional, committed test change; `approve` no longer exists
- the MCP server exposes no accept or approve tool, and its `verify` tool reports the bug
- the pre-commit hook rejects the bug and accepts the fix

## Reading the numbers honestly

- The bugs are planted by hand, and the specs were written by someone who knew the bug classes. The catch rate measures
  what a good spec checked by truthgate adds over typical example tests. It does not measure how well an agent writes specs.
- Some bugs are there to show where truthgate does not help:
  - `ts-chunk/mutates_input`: no property looks at the caller's input.
  - `*-queue/lifo`: the sequence invariant never reads `pop`'s return value. The examples catch it and truthgate does not.
- Verify times are measured with 3 cases running in parallel. They are an upper bound, not the single-run speed.

## Adding a task

Copy a `task.yaml` and fill in these fields:
- `target`
- `spec` (the spec, verbatim)
- `files` (build files committed in the base)
- `shim_edits` (Go/Rust only: string replacements applied to the template that `truthgate shim` writes)
- `examples`
- `variants`, where `ok` is the correct version

Each example is one of two shapes:
- a function case: `{input, out}` or `{input, rejected: true}`
- a sequence case: `{steps: [{op, input, out?, rejected?}], state?}`
