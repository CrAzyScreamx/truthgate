# truthgate v0.1: tasks

Source of truth: `plan.md`. Interfaces: `src/contract.ts` (owned by the lead, so don't edit it). Coders update only their own rows.
Status values: Pending · In Progress · Done · Blocked (with the reason).

## M0: Scaffold (lead)
| ID | Task | Owner | Status |
|---|---|---|---|
| M0.1 | git init, package.json, tsconfig, .gitignore, npm install | lead | Done |
| M0.2 | `src/contract.ts`, plan.md, tasks.md, first commit | lead | Done |

## M1: Core (C1: `src/core`, `src/cli.ts`)
| ID | Task | Owner | Status |
|---|---|---|---|
| M1.1 | `typespec.ts`: parse generator strings into TypeSpec, with tests. **Do this first: C2 depends on it.** | C1 | Done |
| M1.2 | `expr.ts`: parser, evaluator, `toPython`, with tests (including that no eval or prototype access is possible). **Do this second: C2 depends on it.** | C1 | Done |
| M1.3 | `spec.ts`: YAML loader and validation, `SpecError` messages that include file and field | C1 | Done |
| M1.4 | `config.ts`, `state.ts`, with defaults per the contract | C1 | Done |
| M1.5 | `diff.ts`: changed files (working tree + staged vs HEAD + untracked; works in a repo with no commits) | C1 | Done |
| M1.6 | `tamper.ts`: all 6 rules, using `LanguageAdapter` patterns | C1 | Done |
| M1.7 | `approve.ts`: interactive TTY approval, lock file, integrity hash, `checkApprovals` | C1 | Done |
| M1.8 | `weak.ts`: fake implementations (identity, constant 0, empty, null, echo first input) | C1 | Done |
| M1.9 | `verify.ts` + `report.ts`: pipeline, 60 s budget, blocking rule, last-run.json | C1 | Done |
| M1.10 | `cli.ts`: all subcommands wired; `init` drives the installers and asks about Hypothesis and pre-commit | C1 | Done |

## M2: Runners + languages (C2: `src/runner`, `src/lang`, `fixtures`)
| ID | Task | Owner | Status |
|---|---|---|---|
| M2.1 | Shim client: JSON Lines process, timeouts, crash handling | C2 | Done |
| M2.2 | fast-check function runner: TypeSpec → arbitraries, requires/ensures, shrinking, TESTED 3/N | C2 | Done |
| M2.3 | Sequence runner: fast-check commands, reset/state, invariant after every op | C2 | Done |
| M2.4 | JS/TS in-process adapter (dynamic import, no shim) | C2 | Done |
| M2.5 | Python shim + native Hypothesis path (uses `expr.toPython`) | C2 | Done |
| M2.6 | Java, C#, Go, Rust shim templates and adapters | C2 | Done |
| M2.7 | Fixtures for all 6 languages: correct, buggy, weak and sequence, with expected verdicts | C2 | Done |
| M2.8 | e2e test: fixtures produce their expected verdicts (`npm run e2e`) | C2 | Done |

## M3: Integrations (C3: `src/agents`, `src/mcp`, `assets`, `docs/agents.md`)
| ID | Task | Owner | Status |
|---|---|---|---|
| M3.1 | Shared merge helpers: JSON, TOML (smol-toml), append-block; idempotent, never clobber | C3 | Done |
| M3.2 | Installers: Claude, Codex, Gemini, Copilot, Cursor (with stop hook). Verify against current docs first. | C3 | Done |
| M3.3 | Installers: Amp, Windsurf/Devin, OpenCode, Cline, Kiro (instruct-only) | C3 | Done |
| M3.4 | `runHook`: parse each agent's stdin, run verify, loop cap 3, per-agent output | C3 | Done |
| M3.5 | `installPreCommit` (POSIX sh hook that calls `npx truthgate verify`) | C3 | Done |
| M3.6 | MCP server: verify, list_specs, spec_status, explain_verdict, shim_template (no approve tool) | C3 | Done |
| M3.7 | Skills: truthgate-spec, truthgate-shim, truthgate-verdicts. Commands: verify, approve. | C3 | Done |
| M3.8 | `docs/agents.md`: matrix with UNCONFIRMED notes | C3 | Done |

## M4: Deep (C4: `src/deep`)
| ID | Task | Owner | Status |
|---|---|---|---|
| M4.1 | Mutation spot-check: changed lines only, text mutations, temp copy, 120 s cap | C4 | Done |
| M4.2 | Proof audit, Rocq: compile with prover on PATH, reject Admitted/admit/Axiom/Parameter, Print Assumptions | C4 | Done |
| M4.3 | Proof audit, Dafny: `dafny verify`, reject assume/{:axiom}; mark UNVERIFIED if not installed | C4 | Done |
| M4.4 | PROVEN only with a TESTED linked spec, else PROVEN_MODEL_ONLY; tests including a real Rocq fixture | C4 | Done |

## M5: Integration + review (lead, R1, R2)
| ID | Task | Owner | Status |
|---|---|---|---|
| M5.1 | Integrate, run the definition of done, commit | lead | Done |
| M5.2 | Review round 1 (R1 security/correctness, R2 plan fidelity/simplicity/DoD) | R1, R2 | Pending |
| M5.3 | Fix round 1 | coders | Pending |
| M5.4 | Review round 2 + fixes (last round; leftovers → KNOWN_ISSUES.md) | all | Pending |

## Contract requests
(Coders: add a line here if you need something changed in `src/contract.ts`.)
