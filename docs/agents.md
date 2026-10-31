# Agent integrations

`npx truthgate` asks whether to set up this project or globally, then which agents, then merges these files into the repo (or the home directory, below). It never overwrites a different file and never removes your keys. It is idempotent.
Facts below were checked against each vendor's official docs on 2026-10-28. **UNCONFIRMED** marks anything the docs did not state clearly.

Commands written into configs:
- **MCP:** `npx -y truthgate mcp`. On Windows this becomes `cmd /c npx -y truthgate mcp`, because agents spawn MCP servers without a shell and `npx` is `npx.cmd`. The written config is per-machine, so teammates on another OS rerun setup.
- **Stop hook:** `npx -y truthgate hook --agent <id>`.

Merge rules:
- **JSON:** objects are deep-merged, and missing array items are appended.
- **An existing `truthgate` entry is yours.** It is never merged into: our args are not spliced into your command. setup prints "kept your existing … merge by hand".
- **TOML:** only ever appended to, so comments and layout survive. If our tables would overlap yours, setup skips the file and prints the block to merge by hand.

**Gemini CLI → Antigravity CLI:** since 2026-06-18, geminicli.com carries a banner saying Gemini CLI has been replaced by Antigravity CLI. The `gemini` installer targets the documented `.gemini/` layout. Whether Antigravity CLI reads the same paths is **UNCONFIRMED**.

## Matrix
| Agent | Skills | MCP | Rules | Commands | Stop hook |
|---|---|---|---|---|---|
| Claude Code | `.claude/skills/` | `.mcp.json` `mcpServers` | `CLAUDE.md` block | `.claude/commands/*.md` | `.claude/settings.json` `hooks.Stop` |
| Codex | `.agents/skills/` | `.codex/config.toml` `[mcp_servers.truthgate]` | `AGENTS.md` block | none | `.codex/hooks.json` `hooks.Stop` |
| Gemini CLI | `.gemini/skills/` | `.gemini/settings.json` `mcpServers` | `GEMINI.md` block | `.gemini/commands/*.toml` | `.gemini/settings.json` `hooks.AfterAgent` |
| Copilot | `.github/skills/` | `.mcp.json` (CLI) + `.vscode/mcp.json` `servers` (VS Code) | `.github/copilot-instructions.md` block | `.github/prompts/*.prompt.md` | `.github/hooks/truthgate.json` `agentStop` |
| Cursor | `.cursor/skills/` | `.cursor/mcp.json` `mcpServers` | `.cursor/rules/truthgate.mdc` (`alwaysApply: true`) | `.cursor/commands/*.md` | `.cursor/hooks.json` `hooks.stop` |
| Amp | `.agents/skills/` | `.amp/settings.json` `amp.mcpServers` | `AGENTS.md` block | none | instruct-only |
| Windsurf / Devin | `.devin/skills/` | user-scope only, printed | `.devin/rules/truthgate.md` (`trigger: always_on`) | `.devin/workflows/*.md` | instruct-only |
| OpenCode | `.opencode/skills/` | `opencode.json` `mcp.truthgate` (`type: local`) | `AGENTS.md` block | `.opencode/commands/*.md` | instruct-only |
| Cline | `.cline/skills/` | global only, printed | `.clinerules/truthgate.md` | none | instruct-only |
| Kiro | `.kiro/skills/` | `.kiro/settings/mcp.json` `mcpServers` | `.kiro/steering/truthgate.md` (`inclusion: always`) | none | instruct-only |

The skills are copied from `assets/skills/` (`truthgate-spec`, `truthgate-shim` and `truthgate-verdicts`). The commands are `truthgate-verify` (check current changes) and `truthgate-review` (inventory the code, write specs, run `verify --all`). Specs need no approval. The MCP server has no `accept` tool: moving the baseline past test or config edits is the user's call.

## Stop-hook behaviour
`truthgate hook --agent <id>` reads the agent's JSON payload on stdin and ignores fields it doesn't know. It runs `verify` and applies the loop cap (`loopCap`, default 3):
- On a blocking report (FALSIFIED or tampering), it blocks while `consecutiveBlocks < loopCap`.
- A spec or config error blocks too, with the error text as the reason, and counts toward the cap. This covers an invalid `.truthgate/specs/*.yaml` and a broken `.truthgate/config.json`. Breaking a spec is not a way out.
- Once the cap is reached, it allows the stop, prints a loud "STOP ALLOWED WITHOUT A PASSING VERIFY" summary to stderr (and to the agent where it has a message channel), and resets the count.
- A passing run resets the count to 0.
- When the payload says the stop is *not* a hook-forced continuation (`stop_hook_active: false`, Cursor `loop_count: 0`), the count restarts at 0.
- Only an unexpected internal crash allows the stop outright. It is reported the same loud way ("truthgate internal error, stop allowed"), so the session never breaks silently.

| Agent | Payload used | Block | Capped / allow | Shell on Windows | Timeout set |
|---|---|---|---|---|---|
| Claude | `stop_hook_active` | stdout `{"decision":"block","reason"}` | `{"systemMessage"}` / empty | Git Bash, falling back to PowerShell: plain `npx` works | `timeout: 300` (s) |
| Codex | `stop_hook_active` | stdout `{"decision":"block","reason"}` | `{"systemMessage"}` **UNCONFIRMED** for Codex / empty | **UNCONFIRMED**, so we also set `commandWindows: "cmd /c npx …"` | `timeout: 300` (s) |
| Gemini | `stop_hook_active` | stdout `{"decision":"deny","reason"}` | `{"decision":"allow","systemMessage"}` (systemMessage **UNCONFIRMED**) | PowerShell `-Command` (**UNCONFIRMED**, from a third-party source; plain `npx` works there) | `timeout: 300000` (ms; the default of 60 s is too short) |
| Copilot | `stop_hook_active` | stdout `{"decision":"block","reason"}` | empty (no documented message channel) | separate `bash` and `powershell` fields | `timeoutSec: 300` |
| Cursor | `loop_count` | stdout `{"followup_message"}` (sent as the next user message) | `{}` | PowerShell: plain `npx` works | not set; default and unit **UNCONFIRMED**. Cursor's own `loop_limit` default of 5 is above our cap. |

Agents' own continuation caps: Claude and Copilot CLI stop after 8 consecutive blocks, Cursor after `loop_limit` (5). All are above truthgate's cap of 3.

## Trust and approval prompts (printed by setup)
- **Claude:** interactive sessions ask before starting project `.mcp.json` servers.
- **Codex:** project `.codex/config.toml` and hooks load only for trusted projects. New hooks must be reviewed with `/hooks`.
- **Gemini:** changed project hooks show a warning before they run. Whether hooks are on by default is **UNCONFIRMED**.
- **Cursor:** project hooks run only in trusted workspaces.
- **Amp:** workspace MCP servers need `amp mcp approve truthgate`.
- **Copilot cloud agent:** MCP servers are configured only in the repo settings UI, not in a file.

## Instruct-only agents and why
These get skills, MCP (where a project file exists) and rules that tell the agent to run `verify` before finishing. Setup offers the git pre-commit hook for them, and the default answer is yes.
- **Amp:** a plugin (`.amp/plugins/*.ts`, the `agent.end` event returning `{action:'continue'}`) could force a continue. v0.1 ships no plugin. The `agent.end` payload fields are **UNCONFIRMED**.
- **Windsurf / Devin:** the `.devin/hooks.json` `post_cascade_response` hook runs async and the docs say post-hooks cannot block. MCP is user-scope only (`%APPDATA%\devin\mcp_config.json`, or `~/.config/devin/mcp_config.json`), so setup prints the snippet. Whether the legacy `~/.codeium/windsurf/mcp_config.json` is still read is **UNCONFIRMED**. Workflow frontmatter is **UNCONFIRMED**; ours carries only `description`.
- **OpenCode:** plugins see `session.idle` but there is no documented way to block. Forcing a continue via the SDK prompt API is undocumented.
- **Cline:** the hooks docs now redirect to SDK plugins. `afterRun` cannot block, and the file-based `TaskComplete` hook is **UNCONFIRMED**. MCP is global only, so setup prints the snippet. The workflow format is **UNCONFIRMED**, so no commands are installed.
- **Kiro:** has a `Stop` hook (`.kiro/hooks/*.json`), but the docs conflict on how to block it (exit 1 vs exit 0 with `{"decision":"block"}`), so it is **UNCONFIRMED** and not installed. The prompt-file format (`.kiro/prompts/`) is **UNCONFIRMED**, so no commands are installed.

## Pre-commit hook
Setup offers it as opt-in. It writes a `# truthgate:begin … # truthgate:end` block containing `npx -y truthgate verify || exit 1`, with LF line endings, into the directory from `git rev-parse --git-path hooks`. That respects `core.hooksPath` and worktrees. An existing hook is kept. When it is sh-family (sh, bash, zsh or dash) or has no shebang, the block goes right after its shebang so a trailing `exit` can't skip it. A hook in another language, such as a Python or Node shebang, is left untouched, and setup prints the line to add by hand.

## Sources
- Claude: code.claude.com/docs/en/skills, /mcp, /memory, /hooks
- Codex: learn.chatgpt.com/docs/build-skills.md, /docs/extend/mcp?surface=cli, /docs/agent-configuration/agents-md, /docs/hooks, /docs/custom-prompts
- Gemini: geminicli.com/docs/cli/skills/, /cli/custom-commands/, /tools/mcp-server/, /cli/gemini-md/, /hooks/, /hooks/reference/, /hooks/writing-hooks/
- Copilot: docs.github.com/en/copilot: how-tos/use-copilot-agents/coding-agent/create-skills, how-tos/copilot-cli/customize-copilot/add-mcp-servers, reference/custom-instructions-support, reference/hooks-configuration, concepts/prompting-and-context/prompt-files
- Cursor: cursor.com/docs/context/skills, /context/mcp, /context/rules, /agent/hooks; cursor.com/changelog/1-6
- Amp: ampcode.com/docs/customize/skills, /mcp, /agents-md, /plugins
- Windsurf/Devin: docs.devin.ai/desktop/cascade/skills, /mcp, /memories, /workflows, /hooks
- OpenCode: opencode.ai/docs/skills/, /mcp-servers/, /rules/, /commands/, /plugins/
- Cline: docs.cline.bot/features/skills, /mcp/configuring-mcp-servers, /features/cline-rules, /sdk/plugins.md
- Kiro: kiro.dev/docs/skills/, /mcp/configuration/, /steering/, /hooks/, /cli/v3/hooks-migration/

## Global (user-scope) install

Picking "Globally" in `npx truthgate` writes these paths under the home directory. Checked against vendor docs on 2026-10-31. Agents are auto-detected by the home dir in the last column. Hooks are written with `--global`. A global hook resolves the project from the payload `cwd` (or Cursor's `workspace_roots`, whose global hooks run from `~/.cursor`). It acts only in a git repo with `.truthgate/specs/` and no project-level truthgate hook for that agent.

| Agent | Skills | MCP | Rules | Commands | Stop hook | Detected by |
|---|---|---|---|---|---|---|
| Claude Code | `~/.claude/skills/` | `claude mcp add --scope user` (`~/.claude.json` is Claude's own state file) | `~/.claude/CLAUDE.md` block | `~/.claude/commands/` | `~/.claude/settings.json` `hooks.Stop` | `~/.claude` |
| Codex | `~/.agents/skills/` | `~/.codex/config.toml` | `~/.codex/AGENTS.md` block | none (prompts are deprecated) | `~/.codex/hooks.json` (trust it in `/hooks`) | `~/.codex` |
| Gemini CLI | `~/.gemini/skills/` | `~/.gemini/settings.json` | `~/.gemini/GEMINI.md` block | `~/.gemini/commands/` | `~/.gemini/settings.json` `hooks.AfterAgent` | `~/.gemini` |
| Copilot | `~/.copilot/skills/` | `~/.copilot/mcp-config.json` (CLI; VS Code "Global") | `~/.copilot/copilot-instructions.md` block | none (user path **UNCONFIRMED**) | `~/.copilot/hooks/truthgate.json` `agentStop` | `~/.copilot` |
| Cursor | `~/.cursor/skills/` | `~/.cursor/mcp.json` | UI only, printed | none (**UNCONFIRMED**) | `~/.cursor/hooks.json` `stop` | `~/.cursor` |
| Amp | `~/.config/agents/skills/` | `~/.config/amp/settings.json` | `~/.config/amp/AGENTS.md` block | none | instruct-only | `~/.config/amp` |
| Windsurf / Devin | `~/.config/devin/skills/` | printed (the docs give two different files) | `~/.devin/global_rules.md` block | `~/.codeium/windsurf/global_workflows/` | instruct-only | `~/.codeium/windsurf` |
| OpenCode | `~/.config/opencode/skills/` | `~/.config/opencode/opencode.json` | `~/.config/opencode/AGENTS.md` block | `~/.config/opencode/commands/` | instruct-only | `~/.config/opencode` |
| Cline | `~/.cline/skills/` | `~/.cline/data/settings/cline_mcp_settings.json` (CLI); IDE printed | `~/.cline/rules/truthgate.md` | none | instruct-only | `~/.cline` |
| Kiro | `~/.kiro/skills/` | `~/.kiro/settings/mcp.json` | `~/.kiro/steering/truthgate.md` | none | instruct-only (Stop blocking **UNCONFIRMED**) | `~/.kiro` |

The pre-commit hook is never installed globally: `git config --global core.hooksPath` would replace every repo's own hooks.
