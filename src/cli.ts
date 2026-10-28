#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentId, FileChange } from './contract.ts';
import { CONFIG_FILE } from './core/config.ts';
import { loadSpecs, SpecError } from './core/spec.ts';
import { approvalStates, checkApprovals, runApprove } from './core/approve.ts';
import { verify } from './core/verify.ts';
import { formatReport } from './core/report.ts';

const USAGE = `usage: truthgate <command>
  init [--agent <id>...] [--yes] [--dry-run]   set up agents, skills, MCP and hooks
  verify [--deep] [--all] [--json] [--budget <s>]
  approve                                      review and approve specs (interactive only)
  status                                       list specs and their approval state
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

/** Line reader over stdin; only used when stdin is a TTY. */
function prompter() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(q: string): Promise<string> {
      process.stdout.write(q);
      const r = await lines.next();
      return r.done ? '' : r.value.trim();
    },
    close: () => rl.close(),
  };
}

async function hasPython(dir: string, depth = 0): Promise<boolean> {
  if (depth > 6) return false;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile() && e.name.endsWith('.py')) return true;
  for (const e of entries)
    if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'venv', 'target', 'dist', 'build'].includes(e.name) && (await hasPython(join(dir, e.name), depth + 1)))
      return true;
  return false;
}

async function setPythonNative(root: string, native: boolean) {
  const file = join(root, CONFIG_FILE);
  const cfg = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
  cfg.python = { ...cfg.python, native };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
}

async function init(root: string, args: ReturnType<typeof parseArgs>): Promise<number> {
  const { installers, applyChanges, installPreCommit } = await import('./agents/index.ts');
  const yes = args.has('yes');
  const dryRun = args.has('dry-run');
  const tty = !!process.stdin.isTTY;
  const p = tty ? prompter() : undefined;
  try {
    let ids = (args.flags.agent ?? []).flatMap((a) => a.split(',')).map((a) => a.trim().toLowerCase());
    if (ids.length === 0) {
      if (!p) throw new UsageError('no TTY to ask which agents: pass --agent <id> (repeatable). Agents: ' + AGENTS.join(', '));
      console.log('Which coding agents should truthgate set up?');
      AGENTS.forEach((a, i) => console.log(`  ${i + 1}) ${a}${installers[a].enforces ? '' : ' (instruct-only)'}`));
      const ans = await p.ask('Numbers or names, comma-separated: ');
      ids = ans.split(/[\s,]+/).filter(Boolean).map((x) => (/^\d+$/.test(x) ? (AGENTS[Number(x) - 1] ?? x) : x.toLowerCase()));
      if (ids.length === 0) throw new UsageError('no agents selected');
    }
    const bad = ids.filter((a) => !AGENTS.includes(a as AgentId));
    if (bad.length) throw new UsageError(`unknown agent ${bad.join(', ')}. Agents: ${AGENTS.join(', ')}`);
    const agents = [...new Set(ids)] as AgentId[];

    const changes: FileChange[] = [{ path: '.truthgate/.gitignore', action: 'create', content: 'state.json\nlast-run.json\n' }];
    for (const a of agents) changes.push(...(await installers[a].plan(root)));

    let hypothesis = false;
    if (await hasPython(root)) {
      hypothesis = yes || (!!p && !/^n/i.test(await p.ask('Python found. Add Hypothesis (dev dependency) for native property tests? [Y/n] ')));
      if (!yes && !p) console.log('Python found: rerun with --yes to add Hypothesis (native path); using the shim for now.');
    }
    const instructOnly = agents.filter((a) => !installers[a].enforces);
    const hookDefault = instructOnly.length > 0;
    let preCommit = hookDefault;
    if (p && !yes) {
      const ans = await p.ask(`Install a git pre-commit hook that runs \`truthgate verify\`? [${hookDefault ? 'Y/n' : 'y/N'}] `);
      if (ans) preCommit = /^y/i.test(ans);
    }
    if (preCommit) changes.push(await installPreCommit(root));

    for (const line of await applyChanges(root, changes, dryRun)) console.log(line);

    if (hypothesis) {
      const cmd = existsSync(join(root, 'uv.lock'))
        ? ['uv', 'add', '--dev', 'hypothesis']
        : [...(await import('./lang/python/adapter.ts')).pythonCmd(root), '-m', 'pip', 'install', 'hypothesis'];
      if (dryRun) console.log(`would run: ${cmd.join(' ')}, then set python.native in ${CONFIG_FILE}`);
      else {
        console.log(`running: ${cmd.join(' ')}`);
        const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: root, stdio: 'inherit' });
        const ok = r.status === 0;
        if (!ok) console.log('Hypothesis install failed; Python specs will use the shim path.');
        await setPythonNative(root, ok);
      }
    }
    for (const a of agents) for (const s of installers[a].manualSteps ?? []) console.log(`${a}: ${s}`);
    if (instructOnly.length)
      console.log(
        `${instructOnly.join(', ')}: instruct-only. No stop hook exists for ${instructOnly.length === 1 ? 'this agent' : 'these agents'}, so truthgate runs only when the agent follows its rules file${preCommit ? ' and at every commit (pre-commit hook)' : ''}.`,
      );
    console.log(dryRun ? 'Dry run: nothing was written.' : 'Next: have the agent draft specs in .truthgate/specs/, then run `npx truthgate approve`.');
    return 0;
  } finally {
    p?.close();
  }
}

async function status(root: string): Promise<number> {
  const specs = await loadSpecs(root);
  const states = await approvalStates(root, specs);
  if (specs.length === 0) console.log('No specs in .truthgate/specs/.');
  const w = Math.max(...specs.map((s) => s.id.length), 2);
  for (const s of specs) console.log(`${s.id.padEnd(w)}  ${states[s.id]!.padEnd(8)}  ${s.kind.padEnd(8)}  ${s.target}`);
  for (const f of await checkApprovals(root, specs)) console.log(`TAMPER  ${f.rule}  ${f.file}  ${f.detail}`);
  const pending = specs.filter((s) => states[s.id] !== 'approved').length;
  if (pending) console.log(`${pending} spec(s) need approval: run \`npx truthgate approve\` in a terminal.`);
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
    case 'approve':
      return runApprove(root);
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
    const known = e instanceof UsageError || e instanceof SpecError || (e instanceof Error && e.message.includes(CONFIG_FILE));
    process.stderr.write(`truthgate: ${known ? (e as Error).message : ((e as Error)?.stack ?? String(e))}\n`);
    if (e instanceof UsageError) process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  },
);
