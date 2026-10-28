// stdio MCP server. Deliberately has no approve tool: agents must not approve their own specs.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Approvals, LanguageAdapter, Lang, RunReport, Spec, TamperFinding } from '../contract.ts';
import { summarize, verdictLine } from '../agents/summary.ts';

export interface McpDeps {
  verify(root: string, opts: { deep?: boolean; all?: boolean }): Promise<RunReport>;
  loadSpecs(root: string): Promise<Spec[]>;
  checkApprovals(root: string, specs: Spec[]): Promise<TamperFinding[]>;
  getAdapter(lang: Lang): LanguageAdapter;
}

async function defaultDeps(): Promise<McpDeps> {
  const [{ verify }, { loadSpecs }, { checkApprovals }, { getAdapter }] = await Promise.all([
    import('../core/verify.ts'),
    import('../core/spec.ts'),
    import('../core/approve.ts'),
    import('../lang/index.ts'),
  ]);
  return { verify, loadSpecs, checkApprovals, getAdapter };
}

const idArg = { id: { type: 'string', description: 'spec id' } };
const tools = [
  {
    name: 'verify',
    description: 'Run truthgate on the changed files (all: every spec; deep: mutation + proof audit). Returns verdicts.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' }, deep: { type: 'boolean' } } },
  },
  { name: 'list_specs', description: 'List truthgate specs: id, lang, kind, target, approval.', inputSchema: { type: 'object', properties: {} } },
  { name: 'spec_status', description: 'Approval state and last-run verdicts of one spec.', inputSchema: { type: 'object', properties: idArg, required: ['id'] } },
  {
    name: 'explain_verdict',
    description: 'Explain a verdict from the last run: property, detail, counterexample, what to do.',
    inputSchema: { type: 'object', properties: { ...idArg, property: { type: 'string' } }, required: ['id'] },
  },
  { name: 'shim_template', description: 'Shim source and save path for a non-JS/TS spec.', inputSchema: { type: 'object', properties: idArg, required: ['id'] } },
];

const advice: Record<string, string> = {
  FALSIFIED: 'Fix the code so the property holds for this input. Do not weaken or edit the spec.',
  WEAK_SPEC: 'A fake implementation passed: add a property it fails, then ask the user to run `npx truthgate approve`.',
  UNVERIFIED: 'Nothing was established. Explain the reason to the user; fix the shim/spec/toolchain if it is yours.',
  TESTED: 'Report as tested with N runs, not as proven.',
  PROVEN_MODEL_ONLY: 'The proof covers a model, not the tested implementation. Say so.',
  PROVEN: 'Proof checked with no assumptions and the linked spec is TESTED.',
};

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function createServer(root: string, deps?: McpDeps): Server {
  const server = new Server({ name: 'truthgate', version: '0.1.0' }, { capabilities: { tools: {} } });
  let d: McpDeps | undefined = deps;
  const lastRun = () => readJson<RunReport>(join(root, '.truthgate', 'last-run.json'));
  const findSpec = async (id: unknown) => {
    const spec = (await d!.loadSpecs(root)).find((s) => s.id === id);
    if (!spec) throw new Error(`no spec with id ${JSON.stringify(id)}`);
    return spec;
  };

  const handlers: Record<string, (a: Record<string, unknown>) => Promise<string>> = {
    async verify(a) {
      const r = await d!.verify(root, { all: a.all === true, deep: a.deep === true });
      return `${r.blocking ? 'BLOCKING' : 'OK'} (${r.changedFiles.length} changed files, ${r.durationMs} ms)\n${summarize(r, true)}`;
    },
    async list_specs() {
      const specs = await d!.loadSpecs(root);
      const approved = (await readJson<Approvals>(join(root, '.truthgate', 'approved.json')))?.specs ?? {};
      if (specs.length === 0) return 'no specs in .truthgate/specs/';
      return specs.map((s) => `${s.id} ${s.lang} ${s.kind} ${s.target} ${Object.hasOwn(approved, s.id) ? 'approved' : 'NOT APPROVED'}`).join('\n');
    },
    async spec_status(a) {
      const spec = await findSpec(a.id);
      const approved = (await readJson<Approvals>(join(root, '.truthgate', 'approved.json')))?.specs ?? {};
      const tamper = (await d!.checkApprovals(root, [spec])).filter((t) => t.file === spec.file);
      const state = !Object.hasOwn(approved, spec.id) ? 'NOT APPROVED (ask the user to run `npx truthgate approve`)'
        : tamper.length ? `APPROVAL VOID: ${tamper.map((t) => t.detail).join('; ')}` : 'approved';
      const verdicts = (await lastRun())?.verdicts.filter((v) => v.specId === spec.id) ?? [];
      return [`${spec.id} (${spec.file}) -> ${spec.target}`, `approval: ${state}`,
        verdicts.length ? verdicts.map(verdictLine).join('\n') : 'no verdicts in the last run'].join('\n');
    },
    async explain_verdict(a) {
      const run = await lastRun();
      if (!run) return 'no last run: call verify first';
      const v = run.verdicts.find((x) => x.specId === a.id && (a.property === undefined || x.property === a.property));
      if (!v) return `no verdict for ${String(a.id)}${a.property ? '/' + String(a.property) : ''} in the last run`;
      const spec = await findSpec(a.id).catch(() => undefined);
      const prop = [...(spec?.ensures ?? []), ...(spec?.invariant ?? [])].find((p) => p.name === v.property);
      return [
        verdictLine(v),
        prop && `property: ${prop.expr}`,
        v.runs !== undefined && `runs: ${v.runs}`,
        v.seed !== undefined && `seed: ${v.seed}`,
        `next: ${advice[v.kind]}`,
      ].filter(Boolean).join('\n');
    },
    async shim_template(a) {
      const spec = await findSpec(a.id);
      if (spec.lang === 'ts' || spec.lang === 'js') return `${spec.id} is ${spec.lang}: imported in-process, no shim needed.`;
      const t = d!.getAdapter(spec.lang).shimTemplate(spec, root);
      return `save to ${t.path}:\n${t.source}`;
    },
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const h = Object.hasOwn(handlers, req.params.name) ? handlers[req.params.name] : undefined;
    if (!h) return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true };
    try {
      d ??= await defaultDeps();
      return { content: [{ type: 'text', text: await h(req.params.arguments ?? {}) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true };
    }
  });
  return server;
}

export async function startMcp(root: string): Promise<void> {
  console.log = console.error; // stdout carries the protocol; stray logs would corrupt it
  await createServer(root).connect(new StdioServerTransport());
}
