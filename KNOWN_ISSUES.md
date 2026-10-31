# Known issues and limits

## Trust boundary
- **Specs need no approval, so an agent can weaken one.** truthgate can't stop that; it makes it visible. Every spec edited or deleted since the baseline is listed as `SPEC EDIT` in the report, and in the stop hook's message to the user (Claude Code, Codex, Gemini; stderr for the others). It doesn't block.
- **Test and config tampering blocks.** The baseline commit lives outside the repo, in `~/.truthgate` (or `TRUTHGATE_HOME`), so an agent that removes assertions, skips or deletes tests, or edits `.truthgate/config.json` is caught even after committing with `--no-verify`. `npx truthgate accept` (no TTY needed) moves the baseline to HEAD when such a change was intentional; the rules tell agents never to run it, and nothing else enforces that.
- **Deleting the store:** an agent that deletes its record in `~/.truthgate/repos/` gets a fresh baseline at HEAD on the next run, which hides what it committed before. That run says so ("recorded the truthgate baseline at ..."). An agent running as your OS user can always rewrite this file; no local, file-based scheme prevents that.
- **Loop counter:** `.truthgate/state.json` lives in the repo. An agent can preset it to reach the cap early. The only effect is an early allowed stop with the loud unresolved-failures report.

## Coverage
- **Languages:** Python, JS/TS, Java, C#, Go, Rust. PHP and Ruby are not supported yet.
- **Stop hooks** exist only for Claude Code, Codex, Gemini CLI, Copilot and Cursor. Amp, Windsurf/Devin, OpenCode, Cline and Kiro are instruct-only; use the opt-in pre-commit hook as a backstop. Gemini CLI has been superseded by Antigravity CLI, whose paths are unconfirmed.
- **Dafny** proof audit is implemented but untested, because Dafny isn't installed here. Rocq is tested against Rocq 9.1.
- **Tamper detection** is line-based. It strips line comments but not block comments or docstrings, and it doesn't detect dead code such as asserts moved under `if False:`. A sufficiently creative assertion rewrite can evade it.

## Language adapters
- **TS/JS targets load through tsx** with the project's `tsconfig.json`. Importing a target runs its imports' top-level code, so modules with side effects on import (DB connections, env checks) fail to load and come back `UNVERIFIED` with the error. Deep mode's mutation copies exclude `node_modules`, so mutants of targets that import npm packages can't load.
- **`observe` and `init`** (mutated arguments, constructor arguments) are implemented in the generic JS/TS and Python shims only. Java, C#, Go and Rust specs reject them; wrap the target in a helper instead. Function arguments (callbacks, injected services) can't be passed from a spec at all.
- **Java:** compiles the target with `javac -sourcepath`. Projects that need external jars must set `spec.shim.command`.
- **Go, Rust, C# sequence specs:** private and unexported fields are invisible, so expose a `State()`/`state()` method.
- **JSON numbers:** decimals cross the shim as floats rounded to `places`. Integers compare exactly. Other numbers use a 1e-12 relative tolerance: it absorbs float drift from summing up to ~10,000 terms and still sees a 1-cent error on totals up to ~10 billion. Beyond that, compare scaled integers (cents) in the spec.

## Tooling
- **Local tarballs:** `npx ./truthgate-0.1.0.tgz` silently does nothing in Git Bash. Use `npx --package=<abs path to tgz> truthgate …`. The published form, `npx truthgate`, is unaffected.
