import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LanguageAdapter, Spec } from '../../src/contract.ts';
import { createServer, type McpDeps } from '../../src/mcp/server.ts';
import { report } from '../agents/report.ts';

const spec = (id: string, lang: Spec['lang']): Spec => ({
  id, target: `src/${id}.py::f`, lang, kind: 'function', inputs: {}, requires: [],
  ensures: [{ name: 'sorted', expr: 'out == sorted(xs)' }], file: `.truthgate/specs/${id}.yaml`,
});

async function connect() {
  const root = await mkdtemp(join(tmpdir(), 'tg-mcp-'));
  await mkdir(join(root, '.truthgate'));
  await writeFile(join(root, '.truthgate/last-run.json'), JSON.stringify(report(true)));
  await writeFile(join(root, '.truthgate/approved.json'), JSON.stringify({ version: 1, specs: { 'sort.basic': { sha256: 'x', approvedAt: 'now' } }, integrity: 'y' }));
  const deps: McpDeps = {
    verify: async () => report(true),
    loadSpecs: async () => [spec('sort.basic', 'python'), spec('ui.thing', 'ts')],
    checkApprovals: async () => [],
    getAdapter: () => ({ shimTemplate: () => ({ path: 'shims/sort.py', source: 'print(1)' }) }) as unknown as LanguageAdapter,
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(root, deps).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as { text: string }[])[0]!.text, isError: r.isError === true };
  };
  return { client, call };
}

test('exposes exactly the five tools, no approve', async () => {
  const { client } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['explain_verdict', 'list_specs', 'shim_template', 'spec_status', 'verify']);
});

test('tool results are compact text', async () => {
  const { call } = await connect();
  assert.match((await call('verify', { all: true })).text, /^BLOCKING .*\nFALSIFIED sort\.basic\/sorted/);
  assert.equal((await call('list_specs')).text, 'sort.basic python function src/sort.basic.py::f approved\nui.thing ts function src/ui.thing.py::f NOT APPROVED');
  assert.match((await call('spec_status', { id: 'sort.basic' })).text, /approval: approved\nFALSIFIED/);
  const ex = (await call('explain_verdict', { id: 'sort.basic', property: 'sorted' })).text;
  assert.match(ex, /counterexample: \{"xs":\[1,0\]\}\nproperty: out == sorted\(xs\)\nnext: Fix the code/);
  assert.equal((await call('shim_template', { id: 'sort.basic' })).text, 'save to shims/sort.py:\nprint(1)');
  assert.match((await call('shim_template', { id: 'ui.thing' })).text, /no shim needed/);
});

test('errors come back as tool errors, unknown and prototype names are rejected', async () => {
  const { call } = await connect();
  assert.deepEqual(await call('spec_status', { id: 'nope' }), { text: 'error: no spec with id "nope"', isError: true });
  assert.equal((await call('approve')).isError, true);
  assert.equal((await call('constructor')).isError, true);
  assert.match((await call('explain_verdict', { id: 'other' })).text, /no verdict/);
});
