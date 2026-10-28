import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseType, describeType } from '../../src/core/typespec.ts';

test('parses every generator form', () => {
  assert.deepEqual(parseType('int[-1000,1000]'), { t: 'int', min: -1000, max: 1000 });
  assert.deepEqual(parseType(' decimal[0, 99.5, 2] '), { t: 'decimal', min: 0, max: 99.5, places: 2 });
  assert.deepEqual(parseType('str[5]'), { t: 'str', max: 5 });
  assert.deepEqual(parseType('str'), { t: 'str', max: 20 });
  assert.deepEqual(parseType('bool'), { t: 'bool' });
  assert.deepEqual(parseType('list<int[0,1]>'), { t: 'list', of: { t: 'int', min: 0, max: 1 }, max: 10 });
  assert.deepEqual(parseType('list<list<bool>[2]>[3]'), {
    t: 'list',
    of: { t: 'list', of: { t: 'bool' }, max: 2 },
    max: 3,
  });
  assert.deepEqual(parseType('record{a: int[0,1], b: str[3]}'), {
    t: 'record',
    fields: { a: { t: 'int', min: 0, max: 1 }, b: { t: 'str', max: 3 } },
  });
  assert.deepEqual(parseType('record{}'), { t: 'record', fields: {} });
  assert.deepEqual(parseType('oneof["a,]", 1, true, null, {"k":[1]}]'), {
    t: 'oneof',
    values: ['a,]', 1, true, null, { k: [1] }],
  });
});

test('rejects bad generators', () => {
  for (const bad of [
    'int[5,1]',
    'int[1.5,2]',
    'int[1]',
    'decimal[0,1,-1]',
    'decimal[2,1,2]',
    'float',
    'list<int[0,1]',
    'record{a:int[0,1],a:bool}',
    'oneof[]',
    'oneof[foo]',
    'oneof[1',
    'bool extra',
    'str[-1]',
    '',
  ]) {
    assert.throws(() => parseType(bad), /bad type/, bad);
  }
});

test('describes types in plain words', () => {
  assert.equal(
    describeType(parseType('list<record{a:int[0,1]}>[3]')),
    'a list of up to 3 items, each a record with a = an integer from 0 to 1',
  );
  assert.equal(describeType(parseType('oneof["x",2]')), 'one of "x", 2');
  assert.equal(describeType(parseType('decimal[0,1,2]')), 'a decimal from 0 to 1 with 2 places');
  assert.equal(describeType(parseType('str[4]')), 'a string of up to 4 characters');
  assert.equal(describeType(parseType('bool')), 'true or false');
});
