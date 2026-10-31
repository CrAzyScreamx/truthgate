#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as clack from '@clack/prompts';
import type { AgentId, FileChange, Spec } from './contract.ts';
import { CONFIG_FILE } from './core/config.ts';
import { loadSpecs, SpecError } from './core/spec.ts';
import { readBaseline, writeBaseline } from './core/baseline.ts';
import { changedFiles, commitOf, isDirty, NotGitError } from './core/diff.ts';
import { checkConfig, detectTamper, specChanges } from './core/tamper.ts';
import { OWN_FILES, verify } from './core/verify.ts';
import { formatReport } from './core/report.ts';

const USAGE = `usage: truthgate <command>
  init [--agent <id>...] [--yes] [--dry-run]   set up agents, skills, MCP and hooks
  verify [--deep] [--all] [--json] [--budget <s>]
  accept                                       accept intentional test/config changes (baseline = HEAD)
  status                                       list specs, the baseline, and changes since it
  shim <spec-id> [--force]                     write the shim template for a spec
  hook --agent <id>                            stop-hook entry point (reads stdin)
  mcp                                          MCP server on stdio`;

const AGENTS: AgentId[] = ['claude', 'codex', 'gemini', 'copilot', 'cursor', 'amp', 'windsurf', 'opencode', 'cline', 'kiro'];
const VALUE_FLAGS = new Set(['agent', 'budget']);
const BOOL_FLAGS = new Set(['yes', 'dry-run', 'deep', 'all', 'json', 'force', 'help']);

class UsageError extends Error {}

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h') (flags.help ??= []).push('');
    else if (!a.startsWith('--')) pos.push(a);
    else {
      const eq = a.indexOf('=');
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (VALUE_FLAGS.has(k)) {
        const v = eq < 0 ? argv[++i] : a.slice(eq + 1);
        if (v === undefined || v === '') throw new UsageError(`--${k} needs a value`);
        (flags[k] ??= []).push(v);
      } else if (BOOL_FLAGS.has(k) && eq < 0) (flags[k] ??= []).push('');
      else throw new UsageError(`unknown option ${a}`);
    }
  }
  return { pos, flags, has: (k: string) => k in flags };
}

class Cancelled extends Error {}

/** Unwrap a clack prompt result; Esc / Ctrl+C aborts init. */
async function answer<T>(r: Promise<T>): Promise<Exclude<T, symbol>> {
  const v = await r;
  if (clack.isCancel(v)) throw new Cancelled();
  return v as Exclude<T, symbol>;
}

/** `--flag a,b --flag c` → ['a','b','c'], lowercased. */
const listFlag = (v: string[] | undefined) => (v ?? []).flatMap((a) => a.split(',')).map((a) => a.trim().toLowerCase()).filter(Boolean);

const PY_MARKERS = new Set(['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile']);

/** A Python project (a packaging/requirements file), not just stray scripts in another stack's repo. */
async function hasPythonProject(dir: string, depth = 0): Promise<boolean> {
  if (depth > 6) return false;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile() && PY_MARKERS.has(e.name)) return true;
  for (const e of entries)
    if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'venv', 'target', 'dist', 'build'].includes(e.name) && (await hasPythonProject(join(dir, e.name), depth + 1)))
      return true;
  return false;
}

/** Install command for Hypothesis as a project dev dependency: uv, or the project's .venv. Never the system Python. */
async function hypothesisInstall(root: string): Promise<string[] | undefined> {
  if (existsSync(join(root, 'uv.lock'))) return ['uv', 'add', '--dev', 'hypothesis'];
  const py = (await import('./lang/python/adapter.ts')).pythonCmd(root);
  return ['python', 'python3'].includes(py[0]!) ? undefined : [...py, '-m', 'pip', 'install', 'hypothesis'];
}

/** Only called to turn the native path on: false is the default, so writing it would just be a config change to commit. */
async function enablePythonNative(root: string) {
  const file = join(root, CONFIG_FILE);
  const cfg = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
  cfg.python = { ...cfg.python, native: true };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
}

async function init(root: string, args: ReturnType<typeof parseArgs>): Promise<number> {
  const { installers, applyChanges, installPreCommit } = await import('./agents/index.ts');
  const yes = args.has('yes');
  const dryRun = args.has('dry-run');
  const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (tty) clack.intro(' truthgate ');
  try {
    let ids = listFlag(args.flags.agent);
    if (ids.length === 0) {
      if (!tty) throw new UsageError('no TTY to ask which agents: pass --agent <id> (repeatable). Agents: ' + AGENTS.join(', '));
      ids = await answer(clack.multiselect({
        message: 'Which coding agents should truthgate set up?',
        options: AGENTS.map((a) => ({ value: a, label: a, hint: installers[a].enforces ? 'stop hook' : 'instruct-only' })),
      }));
    }
    const bad = ids.filter((a) => !AGENTS.includes(a as AgentId));
    if (bad.length) throw new UsageError(`unknown agent ${bad.join(', ')}. Agents: ${AGENTS.join(', ')}`);
    const agents = [...new Set(ids)] as AgentId[];

    const changes: FileChange[] = [{ path: '.truthgate/.gitignore', action: 'create', content: 'state.json\nlast-run.json\n' }];
    for (const a of agents) changes.push(...(await installers[a].plan(root)));

    let hypothesis = false;
    const install = (await hasPythonProject(root)) ? ((await hypothesisInstall(root)) ?? null) : undefined;
    if (install) {
      hypothesis = yes || (tty && (await answer(clack.confirm({ message: `Python project found. Add Hypothesis as a dev dependency (\`${install.join(' ')}\`) for native property tests?` }))));
      if (!yes && !tty) console.log('Python project found: rerun with --yes to add Hypothesis (native path); using the shim for now.');
    } else if (install === null)
      console.log(
        `Python project found, but no uv.lock or .venv to add Hypothesis to, so Python specs use the shim. For the native path, install hypothesis in the project's environment, set "python": {"native": true} in ${CONFIG_FILE} and commit it.`,
      );
    const instructOnly = agents.filter((a) => !installers[a].enforces);
    const hookDefault = instructOnly.length > 0;
    const preCommit = tty && !yes
      ? await answer(clack.confirm({ message: 'Install a git pre-commit hook that runs `truthgate verify`?', initialValue: hookDefault }))
      : hookDefault;
    const hook = preCommit ? await installPreCommit(root) : undefined;
    if (hook) changes.push(hook);

    const applied = await applyChanges(root, changes, dryRun);
    for (const line of applied) console.log(line);
    // applyChanges reports one line per change, in order. The gate exists if the hook was (or would
    // be) written, or is already up to date; "skip … (exists and differs …)" means it is not there.
    const hookLine = hook ? applied[changes.indexOf(hook)] : undefined;
    const commitGate = !!hookLine && (!hookLine.startsWith('skip ') || hookLine.includes('(up to date)'));

    // verify reports any config change that isn't committed as tampering, so say so whenever we write it.
    const commitConfig = `commit ${CONFIG_FILE}, then run \`npx truthgate accept\` (verify reports config changes since the baseline as tampering)`;
    if (hypothesis && install) {
      if (dryRun) console.log(`would run: ${install.join(' ')}, then set python.native in ${CONFIG_FILE}; ${commitConfig}`);
      else {
        console.log(`running: ${install.join(' ')}`);
        const r = spawnSync(install[0]!, install.slice(1), { cwd: root, stdio: 'inherit' });
        if (r.status !== 0) console.log('Hypothesis install failed; Python specs will use the shim path.');
        else {
          await enablePythonNative(root);
          console.log(`Set python.native in ${CONFIG_FILE}: ${commitConfig}.`);
        }
      }
    }
    // Pin the baseline now: if the first verify recorded it, an agent's commits before that run would be in it.
    if (!dryRun) {
      const b = await readBaseline(root).catch((e) => (e instanceof NotGitError ? undefined : Promise.reject(e)));
      if (b?.source === 'head' && b.commit) {
        await writeBaseline(root, { commit: b.commit, source: 'auto' });
        console.log(`Recorded the truthgate baseline at ${b.commit.slice(0, 7)} (HEAD): tests and config are checked against it.`);
      }
    }
    for (const a of agents) for (const s of installers[a].manualSteps ?? []) console.log(`${a}: ${s}`);
    if (instructOnly.length)
      console.log(
        `${instructOnly.join(', ')}: instruct-only. No stop hook exists for ${instructOnly.length === 1 ? 'this agent' : 'these agents'}, so truthgate runs only when the agent follows its rules file${commitGate ? ' and at every commit (pre-commit hook)' : ''}.`,
      );
    const done = dryRun ? 'Dry run: nothing was written.' : 'Next: have the agent write specs in .truthgate/specs/ for the code it changes; `npx truthgate verify` checks them. To spec and check existing code, run the truthgate-review command in your agent.';
    if (tty) clack.outro(done);
    else console.log(done);
    return 0;
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    clack.cancel('Setup cancelled; nothing was written.');
    return 1;
  }
}

/** Test/config tamper findings and spec edits since `base`, working tree included. */
async function drift(root: string, specs: Spec[], base: string) {
  const changed = await changedFiles(root, base);
  return {
    tamper: [...(await detectTamper(root, changed, undefined, base)), ...(await checkConfig(root, base))],
    edits: await specChanges(root, specs, changed, base),
  };
}

async function status(root: string): Promise<number> {
  const specs = await loadSpecs(root);
  if (specs.length === 0) console.log('No specs in .truthgate/specs/.');
  const w = Math.max(...specs.map((s) => s.id.length), 2);
  for (const s of specs) console.log(`${s.id.padEnd(w)}  ${s.kind.padEnd(8)}  ${s.target}`);
  let b: Awaited<ReturnType<typeof readBaseline>>;
  try {
    b = await readBaseline(root);
  } catch (e) {
    if (e instanceof NotGitError) return console.log('Not a git repository: no baseline, tamper checks skipped.'), 0;
    throw e;
  }
  if (b.source === 'head') return console.log('Baseline: none recorded yet; the first `verify` records HEAD.'), 0;
  console.log(`Baseline: ${b.commit.slice(0, 7)} (${b.source}).`);
  const { tamper, edits } = await drift(root, specs, b.commit);
  for (const f of tamper) console.log(`TAMPER     ${f.rule}  ${f.file}  ${f.detail}`);
  for (const c of edits) console.log(`SPEC EDIT  ${c}`);
  return 0;
}

/** The user's sign-off on intentional test/config changes: move the baseline to HEAD. */
async function accept(root: string): Promise<number> {
  const head = await commitOf(root, 'HEAD');
  if (!head) throw new UsageError('accept records HEAD as the baseline, and this repo has no commits yet');
  const old = await readBaseline(root);
  if (old.source !== 'head' && old.commit !== head) {
    const { tamper, edits } = await drift(root, await loadSpecs(root), old.commit);
    if (tamper.length || edits.length) console.log(`Accepting these changes since ${old.commit.slice(0, 7)}:`);
    for (const f of tamper) console.log(`  ${f.rule}: ${f.file}${f.line ? `:${f.line}` : ''} (${f.detail})`);
    for (const c of edits) console.log(`  ${c}`);
  }
  if (await isDirty(root, OWN_FILES)) console.log('Uncommitted changes are not accepted: accept records HEAD. Commit them, then run accept again.');
  await writeBaseline(root, { commit: head, source: 'accept' });
  console.log(`Baseline set to ${head.slice(0, 7)} (HEAD): truthgate now checks tests and config against this commit.`);
  return 0;
}

async function shim(root: string, args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.pos[1];
  if (!id) throw new UsageError('shim needs a spec id');
  const spec = (await loadSpecs(root)).find((s) => s.id === id);
  if (!spec) throw new UsageError(`no spec with id "${id}"`);
  const { getAdapter } = await import('./lang/index.ts');
  const t = getAdapter(spec.lang).shimTemplate(spec, root);
  if (!t.path) {
    console.log(t.source.trim());
    return 0;
  }
  const file = join(root, t.path);
  if (existsSync(file) && !args.has('force')) {
    console.log(`${t.path} already exists; not overwritten (use --force to replace it).`);
    return 0;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, t.source);
  console.log(`wrote ${t.path}. Fill in the marked parts so it calls ${spec.target}.`);
  return 0;
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args.pos[0];
  const root = process.cwd();
  if (args.has('help') || !cmd) {
    console.log(USAGE);
    return cmd || args.has('help') ? 0 : 2;
  }
  switch (cmd) {
    case 'init':
      return init(root, args);
    case 'verify': {
      const budget = args.flags.budget?.at(-1);
      const budgetSeconds = budget === undefined ? undefined : Number(budget);
      if (budgetSeconds !== undefined && !(budgetSeconds > 0)) throw new UsageError('--budget must be a positive number of seconds');
      const r = await verify(root, { deep: args.has('deep'), all: args.has('all'), budgetSeconds });
      console.log(args.has('json') ? JSON.stringify(r, null, 2) : formatReport(r));
      return r.blocking ? 1 : 0;
    }
    case 'accept':
      return accept(root);
    case 'status':
      return status(root);
    case 'shim':
      return shim(root, args);
    case 'hook': {
      const agent = args.flags.agent?.[0] as AgentId | undefined;
      if (!agent || !AGENTS.includes(agent)) throw new UsageError(`hook needs --agent <${AGENTS.join('|')}>`);
      const { runHook } = await import('./agents/index.ts');
      const r = await runHook(agent, await readStdin(), root);
      process.stdout.write(r.stdout);
      return r.exitCode;
    }
    case 'mcp':
      await (await import('./mcp/server.ts')).startMcp(root);
      return -1; // keep serving; the transport owns the process lifetime
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e: unknown) => {
    const known = e instanceof UsageError || e instanceof SpecError || e instanceof NotGitError || (e instanceof Error && e.message.includes(CONFIG_FILE));
    process.stderr.write(`truthgate: ${known ? (e as Error).message : ((e as Error)?.stack ?? String(e))}\n`);
    if (e instanceof UsageError) process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  },
);
