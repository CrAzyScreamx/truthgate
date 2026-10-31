# truthgate

Verify agent-written code against property specs. Honest verdicts, never more than was established.

Coding agents say "done" and "all tests pass". truthgate makes that claim checkable: the agent writes
**property specs** (what must hold for *every* input), truthgate generates hundreds of inputs and runs
them against the real code, and a stop hook keeps the agent working until nothing is falsified. It also
catches the agent weakening the checks instead of fixing the code.

```powershell
npx truthgate        # setup: this project or globally, then pick your agents
```

Requires Node 22+ and git. Languages: Python, TypeScript, JavaScript, Java, C#, Go, Rust.

## How it works

1. You ask the agent for a change. Its rules tell it to write a spec in `.truthgate/specs/`.
2. When the agent tries to finish, the stop hook runs `truthgate verify`.
3. A counterexample (`FALSIFIED`) or a weakened test (`TAMPER`) blocks the stop and goes back to the agent, which fixes the **code**.
4. You see the verdicts, and every spec the agent edited along the way.

## Setup: `npx truthgate`

Run it in a terminal. It asks two things, then installs:

1. **Where:** this project (files in the repo) or globally (your user-level agent config, every project).
2. **Which agents:** pick from the list. Globally, the agents found in your home directory are preselected.

For each agent it writes (never overwriting your files; JSON/TOML configs are merged):

- **Skills**: how to write specs, how to write shims, how to act on verdicts.
- **Commands**: `truthgate-verify` (check current changes) and `truthgate-review` (inventory existing code, write specs, verify everything).
- **Rules** block in the agent's rules file (`CLAUDE.md`, `AGENTS.md`, ...).
- **MCP server** config, so the agent can call truthgate as tools.
- **Stop hook**, where the agent supports one.
- For a project, optionally a **git pre-commit hook** running `truthgate verify`.

| Agent | Enforcement |
|---|---|
| Claude Code, Codex, Gemini CLI, Copilot, Cursor | stop hook: the agent can't finish while something blocks |
| Amp, Windsurf/Devin, OpenCode, Cline, Kiro | instruct-only: rules file, plus the pre-commit hook |

Per-agent file paths: [docs/agents.md](docs/agents.md).

**Global setup notes:**

- The global stop hooks act only in git repos that have `.truthgate/specs/`, and stand aside in repos with their own project-level truthgate hook. Elsewhere they allow the stop silently.
- The git pre-commit hook is never global (a global `core.hooksPath` would replace every repo's own hooks). Add it per repo by running `npx truthgate` there and picking "This project".
- Some agents keep parts of their user config outside files (Cursor rules, Devin and Cline IDE MCP settings). Those are printed as manual steps. Codex asks you to trust a new hook in `/hooks`.

## Specs

One YAML file per spec in `.truthgate/specs/`.

```yaml
id: sort.basic
target: src/sort.py::sort_list      # file::function, repo-relative
lang: python                        # python | ts | js | java | csharp | go | rust
kind: function                      # function | sequence
inputs:
  xs: list<int[-1000,1000]>[50]
requires: []                        # preconditions; failing inputs are discarded
ensures:
  - name: sorted
    expr: "all(i in range(len(out) - 1): out[i] <= out[i + 1])"
  - name: permutation
    expr: "perm(out, xs)"
```

**Sequence specs** check stateful code: random sequences of operations run on a fresh object, and an
invariant is checked after every step. Failures shrink to the shortest bad sequence.

```yaml
id: warehouse.stock
target: src/warehouse.py::Warehouse
lang: python
kind: sequence
ops:
  - name: add
    inputs: { sku: "oneof[\"a\",\"b\"]", qty: "int[1,10]" }
  - name: remove
    inputs: { sku: "oneof[\"a\",\"b\"]", qty: "int[1,10]" }
invariant:
  - name: never_negative
    expr: "all(q in values(state.stock): q >= 0)"
```

**Generators:** `int[a,b]`, `decimal[a,b,places]`, `str[max]`, `bool`, `list<T>[max]`, `record{a:T,b:T}`, `oneof[v1,v2]`.

**Expressions:** literals, `a.b`, `a[i]`, arithmetic, comparisons, `and or not implies`,
`all(x in xs: e)`, `any(x in xs: e)`, and the helpers `len sum min max abs round sorted perm unique count range keys values`.
Nothing else is callable.

**Optional fields:** `runs`, `allowCrash`, `observe` (functions that mutate an argument), `init`
(constructor arguments), `shim` (custom launch command), `prove` (link a Rocq/Dafny proof).

**Calling your code:** Python, JS/TS, Java and C# use a bundled generic shim. Go and Rust need a small
per-spec shim: `npx truthgate shim <spec-id>` writes the template.

Specs count as soon as they exist; there is no approval step. Editing or deleting an existing spec is
always reported to you as `SPEC EDIT`.

## Verdicts

| Verdict | Meaning |
|---|---|
| `FALSIFIED` | A shrunk counterexample breaks a property. **Blocks.** |
| `WEAK SPEC` | A fake implementation (identity, `0`, `""`, `[]`, `{}`, `null`) passes every property: the spec pins nothing down. |
| `UNVERIFIED` | Nothing was established. The reason is given: no spec, timeout, missing toolchain, target won't load. |
| `TESTED` | N runs, 0 failures: failure rate < 3/N at 95% confidence. Not "proven". |
| `PROVEN (model only)` | (`--deep`) The proof checks, but the linked spec isn't TESTED against the real code. |
| `PROVEN` | (`--deep`) The proof checks with no axioms or admits, and the linked spec is TESTED. |

## Tamper detection

`verify` compares test files and config against a **baseline commit** and blocks on:

- assertion lines removed or changed
- new assertions that check nothing (`assert True`, `expect(1).toBe(1)`)
- new skip markers (`skip`, `xfail`, `xit`, `@Disabled`, `t.Skip`, `#[ignore]`, ...)
- deleted test files
- a changed `.truthgate/config.json`

The baseline lives outside the repo (`~/.truthgate/repos/`), so commits can't move it. It moves forward
only after a fully clean `verify` on a clean working tree, or when you run `accept`.

**When a test change is intentional** (the behavior really changed), review it, commit it, and approve it:

```powershell
npx truthgate status                      # shows the baseline commit
git diff <baseline> -- path/to/test_file
git add -A; git commit -m "..."
npx truthgate accept                      # baseline = HEAD
```

`accept` is yours alone: agents are told never to run it, and the MCP server has no `accept` tool.

## Commands

| Command | What it does |
|---|---|
| *(none, in a terminal)* | Setup: this project or globally, then pick agents |
| `verify [--all] [--deep] [--json] [--budget <s>]` | Run specs for changed files (`--all`: every spec), tamper checks. Exit 1 when blocking |
| `accept` | Approve committed test/config changes: baseline = HEAD |
| `status` | Specs, the baseline, and tamper findings / spec edits since it |
| `shim <spec-id> [--force]` | Write the shim template for a spec |
| `hook --agent <id> [--global]` | Stop-hook entry point (reads the agent's payload on stdin) |
| `mcp` | MCP server on stdio: `verify`, `list_specs`, `spec_status`, `explain_verdict`, `shim_template` |

`--deep` adds **mutation testing** (up to 5 small bugs planted in the changed lines of spec'd files, in a
temp copy; a surviving mutant means the specs miss that kind of bug) and **proof audits** for specs with `prove`.

## Stop hook behavior

- Clean: the agent may stop.
- Blocking: the stop is refused and the failures are sent back to the agent.
- After 3 blocked stops in a row (`loopCap`), the stop is allowed with a loud failure report, so a session can't loop forever.
- A broken spec or config blocks too; deleting specs is not a way out.
- If truthgate itself crashes, the stop is allowed and the error is printed.

## Config

Optional `.truthgate/config.json` (defaults shown). Changing it counts as tampering until you commit it and run `accept`.

```json
{
  "budgetSeconds": 60,
  "deepBudgetSeconds": 120,
  "loopCap": 3,
  "seed": 42,
  "defaultRuns": 100,
  "provers": {},
  "python": { "native": false },
  "sourceGlobs": ["**/*.py", "**/*.ts", "**/*.js", "**/*.java", "**/*.cs", "**/*.go", "**/*.rs"]
}
```

- `python.native`: run Python function specs with Hypothesis in-process instead of the shim (setup offers to add it).
- `provers`: `{ "rocq": "<dir or exe>", "dafny": "<dir or exe>" }` for `--deep` proof audits.
- `sourceGlobs`: which changed files get an `UNVERIFIED (no spec)` warning.

## Limits

- `TESTED` is statistical evidence over the generated inputs, not a proof.
- Instruct-only agents are checked only when they follow their rules, or at commit (pre-commit hook).
- The baseline record is a file owned by your OS user; an agent running as you could still edit it.
- Tamper rules are line-based: reformatting an assertion counts as changing it.

## License

MIT
