---
description: Review the codebase with truthgate - find contracts, write specs, verify and fix
---

Review this repo (or the paths the user named) with truthgate, end to end:

1. **Inventory.** List every function/class with a contract you can state in one line: parsers, money, sorting, validation, counters, state machines, guarded state. Skip glue, I/O wiring, UI. Show the list before writing specs.
2. **Spec.** For each item without a spec in `.truthgate/specs/`, write one (skill: truthgate-spec). Use the strongest true property; sequence specs for stateful classes. Don't edit existing specs.
3. **Verify.** Run `npx -y truthgate verify --all` (or MCP `verify` with all specs).
4. **Act** (skill: truthgate-verdicts):
   - WEAK SPEC / UNVERIFIED you can fix: strengthen the spec or fix the shim/target, re-run.
   - FALSIFIED: this is a bug. Report the counterexample; fix the code only if the user asked for fixes.
5. **Report** a table: target, spec id, verdict as worded, counterexample for each FALSIFIED.
