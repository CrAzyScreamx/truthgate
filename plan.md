# truthgate v0.1: plan

An npx-installed verification layer for code written by agents. It complements normal tests and does not replace them. It checks agent output against **user-approved specs** and reports verdicts that never claim more than was established.

## Decisions (from the design interview)
| # | Decision |
|---|---|
| Languages | Python, JS/TS, Java, C#, Go, Rust |
| Runner | Hybrid. A central fast-check runner (Node) works through a JSON adapter (shim) for every language. Python additionally gets a native Hypothesis path. JS/TS is imported in-process (Node 24 type stripping), so it needs no shim. |
| Scoping | File-level. A spec runs when its `target` file appears in the git diff. |
| Specs | The agent drafts them. The user approves with `npx truthgate approve` (interactive TTY only), and fingerprints go into `.truthgate/approved.json`. |
| Blocking | Block only on `FALSIFIED` or tampering. `WEAK SPEC` and `UNVERIFIED` are warnings. |
| Loop cap | After 3 consecutive blocks, allow the stop and print a loud failure report. The count resets when a check passes. |
| Time limit | Default `verify` is capped at 60 s, configurable. A spec that times out reports `UNVERIFIED (timeout)`. |
| Deep (`--deep`) | Mutation spot-check: 3–5 mutants on changed lines, 120 s cap. Proof audit for specs with `prove:` (Rocq/Dafny, only if installed). |
| Deps | `init` detects Python and asks before adding Hypothesis (`--yes` skips the question). If it's missing later, Python falls back to the shim. |
| Agents | All 10 get skills, MCP and their rules file. Claude, Codex, Gemini, Copilot and Cursor also get the stop hook. Amp, Windsurf/Devin, OpenCode, Cline and Kiro are instruct-only, and `init` says so. |
| Pre-commit | `init` offers an opt-in git pre-commit hook. The default is yes for instruct-only agents. |
| Outward | Local git only. No GitHub push, no npm publish. Tested with `npm pack` and npx on the tarball. |

## Stack
TypeScript, ESM, Node ≥ 22, npm. Runtime deps: `fast-check`, `yaml`, `@modelcontextprotocol/sdk`. Nothing else without a reason. Tests: `node:test`. Build: `tsc`. Binary: `truthgate`.

## Spec format: `.truthgate/specs/<id>.yaml`
```yaml
id: sort.basic
target: src/sort.py::sort_list      # file::function
lang: python                        # python|ts|js|java|csharp|go|rust
kind: function                      # function | sequence
inputs:
  xs: list<int[-1000,1000]>         # int[a,b] decimal[a,b,places] str[max] bool list<T> record{...} oneof[...]
requires: []                        # preconditions (expressions)
ensures:
  - name: sorted
    expr: "all(i in range(len(out)-1): out[i] <= out[i+1])"
  - name: permutation
    expr: "perm(out, xs)"
runs: 100                           # optional
prove:                              # optional, deep only
  tool: rocq                        # rocq | dafny
  file: proofs/sort.v
  theorem: sort_correct
```
- **Expression language:** a small restricted grammar with no `eval`. It covers literals, variables, field and index access, arithmetic, comparisons, `and/or/not/implies`, `all/any(x in xs: e)`, and a fixed helper set: `len sum min max abs round sorted perm unique count range keys values`. One parser feeds two consumers: an evaluator in JS and an emitter that generates Python for the Hypothesis path.
- **`kind: sequence`** (stateful code): `ops` (name + input generators), `invariant` (expressions over `state`), with `reset` and `state` provided by the shim. fast-check `commands` generates and shrinks the op sequences. This is the check that found the warehouse −1 bug.

## Shim protocol (JSON Lines, one persistent process per spec run)
in: `{"op":"call","fn":"sort_list","input":{...}}` · `{"op":"reset"}` · `{"op":"state"}`
out: `{"out":...}` · `{"error":"msg","kind":"rejected|crash"}`
A `rejected` error (the function refused the input) is a normal outcome. A `crash` counts as `FALSIFIED` unless the spec allows it. `truthgate shim <spec-id>` prints a ready-made shim template for the spec's language: Python, Java, C#, Go or Rust (about 15–30 lines each).

## Verdict ladder (exactly these)
`PROVEN` (prover ran, no assumptions, linked to a passing spec) · `PROVEN (model only)` · `FALSIFIED` (shrunk counterexample) · `TESTED` (N runs, 0 failures → failure rate < 3/N at 95%) · `WEAK SPEC` (a fake implementation passed) · `UNVERIFIED` (with a reason: no spec / timeout / toolchain missing / shim error)
Exit codes: `0` ok or warnings, `1` FALSIFIED or tampering, `2` usage/config error.

## `verify` pipeline
1. **Diff:** working tree + staged changes vs `HEAD`, plus untracked files. This gives the changed files.
2. **Tamper check:**
   - removed assertions in test files
   - new skip markers (`pytest.mark.skip/xfail`, `it/test/describe.skip`, `xit`, `@Disabled`, `[Fact(Skip=`, `t.Skip(`, `#[ignore]`)
   - deleted test files
   - an approved spec's hash changed, or an approved spec was deleted
   - `.truthgate/approved.json` edited outside `approve`
3. **Select specs** whose `target` file changed (`--all` = every spec). If a changed source file has no spec, report `UNVERIFIED (no spec)` as a warning.
4. **Weak-spec check:** evaluate `ensures` against fakes (identity, constant 0 / empty / null, echo first input). No shim is needed for this.
5. **Run** properties through the native or shim path with a fixed seed and the shared time budget.
6. **Report:** a terminal table, or `--json`. Write `.truthgate/last-run.json`.

## CLI
`init [--agent <x>...] [--yes] [--dry-run]` · `verify [--deep] [--all] [--json] [--budget s]` · `approve` (TTY only, refuses when not interactive) · `status` · `shim <spec-id>` · `hook --agent <x>` (internal entry point for stop hooks) · `mcp` (stdio server)

## Agent integration (`src/agents/<agent>.ts`, one installer each)
Each installer merges into existing config files and never overwrites them. It's idempotent and supports `--dry-run`.
| Agent | Skills | MCP | Rules | Stop hook |
|---|---|---|---|---|
| Claude Code | `.claude/skills/` | `.mcp.json` | `CLAUDE.md` | `.claude/settings.json` `Stop` → `{"decision":"block","reason"}` |
| Codex | `.agents/skills/` | `.codex/config.toml` | `AGENTS.md` | `.codex/hooks.json` `Stop` (decision block / exit 2) |
| Gemini CLI | `.gemini/skills/` | `.gemini/settings.json` | `GEMINI.md` | `AfterAgent` `decision:"deny"` |
| Copilot | `.github/skills/` | `.mcp.json` | `.github/copilot-instructions.md` | `.github/hooks/truthgate.json` `agentStop` |
| Cursor | `.cursor/skills/` | `.cursor/mcp.json` | `.cursor/rules/truthgate.mdc` | `.cursor/hooks.json` `stop` → `followup_message` |
| Amp | `.agents/skills/` | `.amp/settings.json` | `AGENTS.md` | instruct-only |
| Windsurf/Devin | `.devin/skills/` | user `mcp_config.json` (print instructions) | `.devin/rules/` | instruct-only |
| OpenCode | `.opencode/skills/` | `opencode.json` | `AGENTS.md` | instruct-only |
| Cline | `.cline/skills/` | print instructions | `.clinerules/` | instruct-only |
| Kiro | `.kiro/skills/` | `.kiro/settings/mcp.json` | `.kiro/steering/truthgate.md` | instruct-only (unconfirmed) |

**Coders: verify each path and payload against the agent's current docs before writing its installer.** Mark anything unconfirmed in `docs/agents.md`.

**Content:**
- **Skills** (one set, copied to each agent's skills folder):
  - `truthgate-spec`: write a spec before coding. Includes the property catalog (round-trip, conservation, invariant, idempotence, matches a model, sequences for guarded state) and a "get user approval" step.
  - `truthgate-shim`
  - `truthgate-verdicts`: how to read and act on verdicts. A FALSIFIED result means fix the code, never the spec.
- **Commands** (where supported): `/truthgate-verify`, and `/truthgate-approve`, which only tells the user to run the CLI.

**MCP tools:** `verify`, `list_specs`, `spec_status`, `explain_verdict`, `shim_template`. There is **no approve tool**, because agents must not be able to approve their own specs.

## Deep mode
- **Mutation spot-check:** text-level mutations on changed lines only: operator swaps (`<`↔`<=`, `+`↔`-`, `==`↔`!=`, `and`↔`or`), off-by-one on integer literals, `return` of a constant. Each mutant runs in a temp copy. Report `caught x/y` and the surviving mutants. 120 s cap.
- **Proof audit:**
  - Rocq: `rocq compile`, which needs `<prefix>\bin` on PATH (config `provers.rocq`). Reject `Admitted|admit|Axiom|Parameter`. Store the `Print Assumptions` output.
  - Dafny: `dafny verify`. Reject `assume` and `{:axiom}`.
  - `PROVEN` requires the linked spec to be `TESTED`. Otherwise the verdict is `PROVEN (model only)`.

## Repo layout
```
src/contract.ts            shared types (written first, by the lead)
src/core/                  spec parse, expr language, verdicts, diff, tamper, weak-spec, config/state, approve
src/cli.ts
src/runner/                fast-check runner, sequence runner, native Hypothesis path, shim client
src/lang/<lang>/           shim templates + adapter (6 langs)
src/agents/                10 installers + hook output formats + pre-commit
src/mcp/                   MCP server
src/deep/                  mutation, proof audit
assets/skills/ assets/commands/
test/                      node:test unit tests
fixtures/<lang>/           tiny project per language: correct fn (→TESTED), buggy fn (→FALSIFIED), weak spec (→WEAK SPEC), one sequence spec
docs/agents.md
```

## Definition of done
- `npm test` is green. `tsc --noEmit` is clean.
- Fixture end-to-end checks pass for all 6 languages: each gets the expected TESTED, FALSIFIED and WEAK SPEC results, and the planted bug in each sequence fixture comes back FALSIFIED with a shrunk sequence.
- `npm pack`, then `npx ./truthgate-0.1.0.tgz init --agent claude --dry-run` and `verify` work in a temp copy of a fixture.
- Default `verify` on one fixture finishes in under 10 s.
- `approve` refuses to run without a TTY. The MCP server exposes no approval tool.

## Build process
- **Phase 0 (lead):** git init, package.json, tsconfig, `src/contract.ts`, `tasks.md`, commit.
- **Phase 1:** 4 Claude coders in a new Herdr tab, `truthgate-build`, each owning separate directories:
  - **C1 core:** `src/core`, `src/cli.ts`
  - **C2 runners + languages:** `src/runner`, `src/lang`, `fixtures`
  - **C3 integrations:** `src/agents`, `src/mcp`, `assets`, `docs/agents.md`
  - **C4 deep:** `src/deep`

  Coders don't commit. The lead integrates, runs the definition of done, and commits.
- **Phase 2:** 2 Claude reviewers in parallel:
  - **R1:** correctness and security (approval bypass, tamper evasion, config clobbering, path handling on Windows, the expression parser's safety)
  - **R2:** fidelity to the plan plus over-engineering (ponytail lens), and running the definition of done independently
- **Rounds:** findings go back to the owning coders, then a re-review. **At most 2 review rounds.** Anything still open after that goes into `KNOWN_ISSUES.md`.
