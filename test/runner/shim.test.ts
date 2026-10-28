import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exec } from '../../src/runner/proc.ts';
import { openShim, ShimError } from '../../src/runner/shim.ts';

// A fake shim in JS: echo / reject / crash / hang / die, plus a user print before each reply.
const dir = mkdtempSync(join(tmpdir(), 'tg-shim-test-'));
const fake = join(dir, 'fake.mjs');
writeFileSync(
  fake,
  `import { createInterface } from 'node:readline';
let n = 0;
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  console.log('user print, not protocol');
  if (m.op === 'reset') { n = 0; return console.log(JSON.stringify({ out: null })); }
  if (m.op === 'state') return console.log(m.fail ? JSON.stringify({ error: 'boom' }) : JSON.stringify({ out: { n } }));
  n++;
  if (m.fn === 'echo') console.log(JSON.stringify({ out: m.input }));
  if (m.fn === 'reject') console.log(JSON.stringify({ error: 'no', kind: 'rejected' }));
  if (m.fn === 'crash') console.log(JSON.stringify({ error: 'bad', kind: 'crash' }));
  if (m.fn === 'die') process.exit(7);
});`,
);
const open = (callTimeoutMs?: number) => openShim([process.execPath, fake], dir, { callTimeoutMs });

test('call round-trips JSON and keeps key order; user prints are ignored', async () => {
  const c = open();
  const r = await c.call('echo', { b: 1, a: [1.5, 'x'] });
  assert.deepEqual(r, { ok: true, out: { b: 1, a: [1.5, 'x'] } });
  assert.deepEqual(Object.keys((r as { out: object }).out), ['b', 'a']);
  await c.close();
});

test('rejected and crash map to CallResult kinds', async () => {
  const c = open();
  assert.deepEqual(await c.call('reject', {}), { ok: false, kind: 'rejected', error: 'no' });
  assert.deepEqual(await c.call('crash', {}), { ok: false, kind: 'crash', error: 'bad' });
  await c.close();
});

test('reset and state', async () => {
  const c = open();
  await c.call('echo', {});
  await c.reset();
  await c.call('echo', {});
  assert.deepEqual(await c.state(), { n: 1 });
  await c.close();
});

test('process exit -> ShimError on the pending and later calls', async () => {
  const c = open();
  await assert.rejects(c.call('die', {}), (e) => e instanceof ShimError && /exited \(code 7\)/.test(e.message));
  await assert.rejects(c.call('echo', {}), ShimError);
  await c.close();
});

test('a call that never answers times out after the first answer', async () => {
  const c = open(200);
  await c.call('echo', {});
  await assert.rejects(c.call('hang', {}), (e) => e instanceof ShimError && /timed out/.test(e.message));
  await c.close();
});

test('missing executable -> ShimError', async () => {
  const c = openShim(['truthgate-no-such-tool-xyz'], dir);
  await assert.rejects(c.call('echo', {}), ShimError);
  await c.close();
});

test('exec runs .cmd tools on Windows (npm) and reports failures', async () => {
  const r = await exec(['npm', '--version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\d+\.\d+/);
  const bad = await exec(['truthgate-no-such-tool-xyz']);
  assert.notEqual(bad.code, 0);
});
