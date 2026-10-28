# Known issues and limits (v0.1)

## Trust boundary
- **Same-user forgery is possible on purpose.** Approvals and the tamper baseline live outside the repo, in `~/.truthgate` (or `TRUTHGATE_HOME`).
  - An agent that edits approved.json, weakens an approved spec, or commits with `--no-verify` is detected.
  - An agent running as your OS user that deliberately rewrites the store can still forge an approval. No local, file-based scheme can prevent that. The goal is that tampering can't happen by accident or casually, and always takes a deliberate act.
- **Deleting the store:** an agent that deletes its record in `~/.truthgate/repos/` makes verify fall back to comparing against `HEAD`. Every run then warns ("no truthgate baseline recorded"), and a clean run never creates a new record (only `approve` does). So a forgery committed this way is flagged on every run but not blocked.
- **`approve` checks for a TTY.** A process that allocates a pseudo-terminal can get past that check. Same boundary as above.
- **Loop counter:** `.truthgate/state.json` lives in the repo. An agent can preset it to reach the cap early. The only effect is an early allowed stop with the loud unresolved-failures report.

## Coverage
- **Languages:** Python, JS/TS, Java, C#, Go, Rust. PHP and Ruby are not supported yet.
- **Stop hooks** exist only for Claude Code, Codex, Gemini CLI, Copilot and Cursor. Amp, Windsurf/Devin, OpenCode, Cline and Kiro are instruct-only; use the opt-in pre-commit hook as a backstop. Gemini CLI has been superseded by Antigravity CLI, whose paths are unconfirmed.
- **Dafny** proof audit is implemented but untested, because Dafny isn't installed here. Rocq is tested against Rocq 9.1.
- **Tamper detection** is line-based. It strips line comments but not block comments or docstrings, and it doesn't detect dead code such as asserts moved under `if False:`. A sufficiently creative assertion rewrite can evade it.

## Language adapters
- **Java:** compiles the target with `javac -sourcepath`. Projects that need external jars must set `spec.shim.command`.
- **Go, Rust, C# sequence specs:** private and unexported fields are invisible, so expose a `State()`/`state()` method.
- **JSON numbers:** decimals cross the shim as floats rounded to `places`. Equality uses a 1e-9 relative tolerance.

## Tooling
- **Local tarballs:** `npx ./truthgate-0.1.0.tgz` silently does nothing in Git Bash. Use `npx --package=<abs path to tgz> truthgate …`. The published form, `npx truthgate`, is unaffected.
