---
name: truthgate-spec
description: Write a truthgate property spec (.truthgate/specs/<id>.yaml) before or while changing a function or stateful class. Use when adding or modifying logic that has a clear contract (sorting, parsing, money, counters, state machines), when truthgate reports UNVERIFIED (no spec), or when asked to "spec" or "verify" code.
---

# Writing a truthgate spec

truthgate checks code against **user-approved** property specs. A spec says what must hold for
*every* input, not for one example. Unit tests still matter; specs complement them.

## When to write one
- New or changed function with a contract you can state in one line ("output is sorted", "total is conserved").
- Stateful code with guards (balances, stock, queues): use a **sequence** spec.
- `truthgate verify` says `UNVERIFIED (no spec)` for a file you changed.
- Skip pure glue, I/O wiring and UI code.

## File: `.truthgate/specs/<id>.yaml`
```yaml
id: sort.basic                       # unique, dotted
target: src/sort.py::sort_list       # repo-relative file :: function (forward slashes)
lang: python                         # python | ts | js | java | csharp | go | rust
kind: function                       # function | sequence
inputs:
  xs: list<int[-1000,1000]>[50]
requires: []                         # preconditions; failing inputs are discarded
ensures:
  - name: sorted
    expr: "all(i in range(len(out) - 1): out[i] <= out[i + 1])"
  - name: permutation
    expr: "perm(out, xs)"
runs: 100                            # optional
```
`out` is the return value; inputs are in scope by name. Add `allowCrash: true` only if an
exception is an acceptable outcome. Non-JS/TS targets need a shim: see the `truthgate-shim` skill.

## Generators (`inputs`)
| Syntax | Meaning |
|---|---|
| `int[a,b]` | integer in [a, b] |
| `decimal[a,b,places]` | decimal in [a, b] with `places` digits |
| `str[max]` | string up to `max` chars |
| `bool` | true / false |
| `list<T>[max]` | list of T, up to `max` items |
| `record{a:T,b:T}` | object with typed fields |
| `oneof[v1,v2,...]` | one of these JSON literals |

## Expressions (`requires`, `ensures`, `invariant`)
Literals, names, `a.b`, `a[i]`, `+ - * / %`, `== != < <= > >=`, `and or not`, `a implies b`,
`all(x in xs: e)`, `any(x in xs: e)`, and only these helpers:
`len sum min max abs round sorted perm unique count range keys values`. Nothing else is callable.

## Property catalog (pick the strongest that is true)
| Property | One-line example |
|---|---|
| Round-trip | target a helper `roundtrip(x) = decode(encode(x))`: `out == x` |
| Conservation | `sum(out) == sum(xs)` / `len(out) == len(xs)` / `perm(out, xs)` |
| Invariant | `all(i in range(len(out) - 1): out[i] <= out[i + 1])` |
| Idempotence | target a helper returning `[f(x), f(f(x))]`: `out[0] == out[1]` |
| Bounds | `out >= 0 and out <= total` |
| Matches a model | `out == sorted(xs)` / `out == max(xs)` (a trivially correct reference) |
| Implication | `len(xs) == 0 implies out == 0` |
| Guarded state | sequence spec with an invariant over `state` (below) |

Avoid properties a fake passes. truthgate runs each spec against fakes (identity, constant 0,
empty, null, echo first input); if one passes, the verdict is `WEAK SPEC`: add a property that fails it.

## Sequence specs (guarded state)
For classes or modules whose correctness depends on call order. The shim provides `reset`
(fresh instance) and `state` (a JSON snapshot). Random op sequences run; `invariant` is checked
after every op, and failures shrink to the shortest bad sequence.
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
A guarded op that refuses (raises a validation error) should return a `rejected` error, which is
a normal outcome. Only a broken invariant or a `crash` is a failure.

## Approval (required)
Specs only count once the **user** approves them. You cannot approve your own spec.
1. Write the spec file.
2. Tell the user: "Please review `.truthgate/specs/<id>.yaml` and run `npx truthgate approve` in your terminal."
3. Never edit `.truthgate/approved.json`. Editing an approved spec voids its approval and is reported as tampering.

## Check it
Run `npx truthgate verify` (or the MCP `verify` tool). Read results with the `truthgate-verdicts` skill.
