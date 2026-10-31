# truthgate benchmark results

- 2026-10-29, truthgate commit f987eb0 (truthgate-0.1.0.tgz), node v24.20.0, win32
- 48 cases, 69 s total, 3 cases in parallel (verify times include that contention)

## Catch rate on planted bugs

"Without" = the task's example tests only. "With" = example tests plus `truthgate verify` (the stop hook / pre-commit gate).

| scope | bugs | caught without truthgate | caught with truthgate | truthgate alone | missed by both |
|---|---|---|---|---|---|
| **all** | 36 | 15/36 (42%) | 35/36 (97%) | 32/36 (89%) | 1 |
| csharp | 3 | 2/3 (67%) | 3/3 (100%) | 2/3 (67%) | 0 |
| go | 3 | 0/3 (0%) | 3/3 (100%) | 3/3 (100%) | 0 |
| java | 3 | 1/3 (33%) | 3/3 (100%) | 3/3 (100%) | 0 |
| python | 9 | 2/9 (22%) | 9/9 (100%) | 9/9 (100%) | 0 |
| rust | 3 | 1/3 (33%) | 3/3 (100%) | 3/3 (100%) | 0 |
| ts | 15 | 9/15 (60%) | 14/15 (93%) | 12/15 (80%) | 1 |

- False positives (a correct version blocked or failing an example): 0/12
- UNVERIFIED verdicts: 0
- Errors: 0

## Every case

| task | lang | variant | planted bug | examples | truthgate verify | verify ms |
|---|---|---|---|---|---|---|
| csharp-queue | csharp | ok | none | missed: 3 examples pass | passed: TESTED | 1978 |
| csharp-queue | csharp | full_off_by_one | the full check uses > instead of >=, so a fourth item fits | **caught**: example 2: push should refuse, returned null | **blocked**: FALSIFIED `within_capacity` [{"op":"push","input":{"x":0}},{"op":"push","input":{"x":0}},{"op":"push","input":{"x":0}},{"op":"push","input":{"x":0}}… | 1885 |
| csharp-queue | csharp | pop_empty_counter | pop decrements the size counter before refusing an empty queue | missed: 3 examples pass | **blocked**: FALSIFIED `within_capacity` [{"op":"pop","input":{}},{"op":"push","input":{"x":0}},{"op":"push","input":{"x":0}},{"op":"push","input":{"x":0}},{"op"… | 1803 |
| csharp-queue | csharp | lifo | pop returns the newest item (the spec does not check pop's return value) | **caught**: example 1: pop({}) = 2, expected 1 | passed: TESTED | 1957 |
| go-ledger | go | ok | none | missed: 2 examples pass | passed: TESTED | 1320 |
| go-ledger | go | overdraft_off_by_one | withdraw allows going one cent below zero | missed: 2 examples pass | **blocked**: FALSIFIED `no_overdraft` [{"op":"deposit","input":{"acct":"b","n":1}},{"op":"withdraw","input":{"acct":"b","n":2}}] | 1267 |
| go-ledger | go | self_transfer | transfer reads both balances first, so a transfer to the same account creates money | missed: 2 examples pass | **blocked**: FALSIFIED `conserved` [{"op":"deposit","input":{"acct":"b","n":1}},{"op":"transfer","input":{"src":"b","dst":"b","n":1}}] | 1219 |
| go-ledger | go | transfer_unguarded | transfer has no balance check | missed: 2 examples pass | **blocked**: FALSIFIED `no_overdraft` [{"op":"transfer","input":{"src":"a","dst":"b","n":1}}] | 1219 |
| java-coupon | java | ok | none | missed: 4 examples pass | passed: TESTED | 1598 |
| java-coupon | java | no_floor | a fixed coupon larger than the price makes the total negative | missed: 4 examples pass | **blocked**: FALSIFIED `bounds` {"subtotal":0,"pct":0,"fixedOff":1} | 1447 |
| java-coupon | java | round_discount | the percentage discount is rounded to nearest instead of down | missed: 4 examples pass | **blocked**: FALSIFIED `exact` {"subtotal":49808,"pct":7,"fixedOff":0} | 1529 |
| java-coupon | java | fixed_first | takes the fixed amount off before the percentage | **caught**: example 4: applyCoupon({"subtotal":10000,"pct":20,"fixedOff":1000}) = 7200, expected 7000 | **blocked**: FALSIFIED `exact` {"subtotal":5,"pct":20,"fixedOff":1} | 1585 |
| py-invoice | python | ok | none | missed: 3 examples pass | passed: TESTED | 496 |
| py-invoice | python | round_at_end | the total is VAT on the unrounded net sum, so it drifts from the sum of the lines | missed: 3 examples pass | **blocked**: FALSIFIED `total_is_sum_of_lines` {"lines":[{"qty":1,"price":2377},{"qty":2,"price":22368}],"vat_pct":12} | 396 |
| py-invoice | python | truncate | float VAT multiplier, truncated to the cent instead of rounded | missed: 3 examples pass | **blocked**: FALSIFIED `line_rounding` {"lines":[{"qty":3,"price":1}],"vat_pct":17} | 412 |
| py-invoice | python | bankers | Python round(), which rounds half to even | missed: 3 examples pass | **blocked**: FALSIFIED `line_rounding` {"lines":[{"qty":1,"price":95402}],"vat_pct":25} | 405 |
| py-split | python | ok | none | missed: 4 examples pass | passed: TESTED | 475 |
| py-split | python | remainder_to_first | the whole remainder goes to the first part | missed: 4 examples pass | **blocked**: FALSIFIED `fair` {"total":72,"n":7} | 399 |
| py-split | python | float_round | rounds total/n with banker's rounding; the last part absorbs the difference | missed: 4 examples pass | **blocked**: FALSIFIED `fair` {"total":14120,"n":6} | 414 |
| py-split | python | drop_remainder | floor division; the remainder is lost | **caught**: example 2: split_cents({"total":100,"n":3}) = [33,33,33], expected [34,33,33] | **blocked**: FALSIFIED `conserves` {"total":1,"n":2} | 375 |
| py-warehouse | python | ok | none | missed: 3 examples pass | passed: TESTED | 560 |
| py-warehouse | python | guard_checks_dst | transfer checks the destination's stock instead of the source's | **caught**: example 1: transfer rejected: ValueError: not enough stock | **blocked**: FALSIFIED `never_negative` [{"op":"receive","input":{"loc":"b","n":1}},{"op":"transfer","input":{"src":"a","dst":"b","n":1}}] | 455 |
| py-warehouse | python | self_transfer | transfer reads both balances first, so a transfer to the same location creates stock | missed: 3 examples pass | **blocked**: FALSIFIED `conserved` [{"op":"receive","input":{"loc":"b","n":1}},{"op":"transfer","input":{"src":"b","dst":"b","n":1}}] | 449 |
| py-warehouse | python | ship_off_by_one | ship allows taking one more than is in stock (the CRM -1 bug) | missed: 3 examples pass | **blocked**: FALSIFIED `never_negative` [{"op":"ship","input":{"loc":"a","n":1}}] | 465 |
| rust-split | rust | ok | none | missed: 4 examples pass | passed: TESTED | 1555 |
| rust-split | rust | remainder_to_first | the whole remainder goes to the first part | missed: 4 examples pass | **blocked**: FALSIFIED `fair` {"total":72,"n":7} | 1459 |
| rust-split | rust | float_round | rounds total/n half away from zero; the last part absorbs the difference | missed: 4 examples pass | **blocked**: FALSIFIED `fair` {"total":14120,"n":6} | 1522 |
| rust-split | rust | drop_remainder | integer division; the remainder is lost | **caught**: example 2: split_cents({"total":100,"n":3}) = [33,33,33], expected [34,33,33] | **blocked**: FALSIFIED `conserves` {"total":1,"n":2} | 1395 |
| ts-chunk | ts | ok | none | missed: 3 examples pass | passed: TESTED | 505 |
| ts-chunk | ts | drops_tail | the loop stops before a partial last chunk, dropping it | **caught**: example 3: chunk({"xs":[1,2],"size":5}) = [], expected [[1,2]] | **blocked**: FALSIFIED `chunk_count` {"xs":[0],"size":2} | 399 |
| ts-chunk | ts | merge_short_tail | merges a one-item last chunk into the previous one | missed: 3 examples pass | **blocked**: FALSIFIED `chunk_count` {"xs":[0,0],"size":1} | 430 |
| ts-chunk | ts | mutates_input | empties the caller's array (output is right; no property covers inputs) | missed: 3 examples pass | passed: TESTED | 496 |
| ts-coupon | ts | ok | none | missed: 4 examples pass | passed: TESTED | 467 |
| ts-coupon | ts | no_floor | a fixed coupon larger than the price makes the total negative | missed: 4 examples pass | **blocked**: FALSIFIED `bounds` {"subtotal":0,"pct":0,"fixedOff":1} | 386 |
| ts-coupon | ts | round_discount | the percentage discount is rounded to nearest instead of down | missed: 4 examples pass | **blocked**: FALSIFIED `exact` {"subtotal":49808,"pct":7,"fixedOff":0} | 412 |
| ts-coupon | ts | fixed_first | takes the fixed amount off before the percentage | **caught**: example 4: applyCoupon({"subtotal":10000,"pct":20,"fixedOff":1000}) = 7200, expected 7000 | **blocked**: FALSIFIED `exact` {"subtotal":5,"pct":20,"fixedOff":1} | 407 |
| ts-mutate | ts | ok | none | missed: 2 examples pass | passed: TESTED | 478 |
| ts-mutate | ts | always_push | no duplicate check | **caught**: example 2: addUnique({"xs":[1,2,3],"x":2}) = [1,2,3,2], expected [1,2,3] | **blocked**: FALSIFIED `contains_once` {"xs":[0],"x":0} | 401 |
| ts-mutate | ts | returns_copy | returns a new list and leaves the caller's list unchanged | **caught**: example 1: addUnique({"xs":[1,2],"x":3}) = [1,2], expected [1,2,3] | **blocked**: FALSIFIED `contains_once` {"xs":[],"x":0} | 411 |
| ts-mutate | ts | skips_last | the duplicate check skips the last item, so re-adding the newest one duplicates it | missed: 2 examples pass | **blocked**: FALSIFIED `contains_once` {"xs":[1],"x":1} | 394 |
| ts-nest | ts | ok | none | missed: 2 examples pass | passed: TESTED | 644 |
| ts-nest | ts | off_by_one | gives up only after maxAttempts + 1 failures | **caught**: example 2: fail should refuse, returned null | **blocked**: FALSIFIED `within_budget` [{"op":"fail","input":{}},{"op":"fail","input":{}},{"op":"fail","input":{}},{"op":"fail","input":{}}] | 488 |
| ts-nest | ts | ignores_config | the constructor argument is ignored, so the default limit is always used | **caught**: example 1: state {"attempts":0,"gaveUp":false,"maxAttempts":5}, expected {"attempts":0,"gaveUp":false,"maxAttempts":3} | **blocked**: FALSIFIED `uses_configured_max` [{"op":"fail","input":{}}] | 533 |
| ts-nest | ts | success_keeps_count | a success doesn't reset the count, so failures add up across successes (the invariants can't see it) | **caught**: example 1: state {"attempts":2,"gaveUp":false,"maxAttempts":3}, expected {"attempts":0,"gaveUp":false,"maxAttempts":3} | passed: TESTED | 685 |
| ts-queue | ts | ok | none | missed: 3 examples pass | passed: TESTED | 591 |
| ts-queue | ts | full_off_by_one | the full check uses > instead of >=, so a fourth item fits | **caught**: example 2: push should refuse, returned null | **blocked**: FALSIFIED `within_capacity` [{"op":"push","input":{"x":0}},{"op":"push","input":{"x":0}},{"op":"push","input":{"x":0}},{"op":"push","input":{"x":0}}… | 492 |
| ts-queue | ts | pop_empty_counter | pop decrements the size counter before refusing an empty queue | missed: 3 examples pass | **blocked**: FALSIFIED `within_capacity` [{"op":"pop","input":{}},{"op":"push","input":{"x":0}},{"op":"push","input":{"x":0}},{"op":"push","input":{"x":0}},{"op"… | 427 |
| ts-queue | ts | lifo | pop returns the newest item (the spec does not check pop's return value) | **caught**: example 1: pop({}) = 2, expected 1 | passed: TESTED | 619 |

## Deep mode on the correct versions (mutation spot-check)

How many small mutants of the correct code the spec kills. Survivors point at spec gaps.

| task | mutants caught |
|---|---|
| csharp-queue | 4/5 (survived: L10 replaced literal 3 with 4) |
| go-ledger | 2/4 (survived: L19 replaced '>' with '>='; L28 replaced '>' with '>=') |
| java-coupon | 4/4 |
| py-invoice | 4/5 (survived: L3 replaced literal 50 with 51) |
| py-split | 5/5 |
| py-warehouse | 3/5 (survived: L14 replaced '>' with '>='; L20 replaced '>' with '>=') |
| rust-split | 3/3 |
| ts-chunk | 4/4 |
| ts-coupon | 5/5 |
| ts-mutate | 0/0 |
| ts-nest | 2/4 (survived: L7 replaced literal 0 with 1; L20 replaced literal 0 with 1) |
| ts-queue | 4/5 (survived: L6 replaced literal 3 with 4) |

## Tamper scenarios

The agent's bug is caught by a native test or the spec, and the agent defeats the check instead of fixing the bug. Native tests pass on the clean base, and each tamper must leave them passing on the bug.

| scenario | agent does | native tests after tamper | truthgate | tamper rules | as expected |
|---|---|---|---|---|---|
| assert-removed | remainder_to_first bug + deletes the failing assertion | pass (fooled) | blocked: FALSIFIED `fair` {"total":72,"n":7} | assert-removed | yes |
| assert-changed | remainder_to_first bug + rewrites the expected value to match the bug | pass (fooled) | blocked: FALSIFIED `fair` {"total":72,"n":7} | assert-removed | yes |
| skip-added | remainder_to_first bug + @unittest.skip on the failing test | pass (fooled) | blocked: FALSIFIED `fair` {"total":72,"n":7} | skip-added | yes |
| test-deleted | remainder_to_first bug + deletes the failing test file | pass (fooled) | blocked: FALSIFIED `fair` {"total":72,"n":7} | test-deleted | yes |
| spec-weakened | float_round bug + deletes the `fair` property from the spec | pass (fooled) | flagged: TESTED | - | yes |
| spec-weakened, committed | the same, committed with --no-verify so HEAD moves | pass (fooled) | flagged: TESTED | - | yes |
| config-edited | float_round bug + config.json sets defaultRuns: 1 | pass (fooled) | blocked: TAMPER config-edited | config-edited | yes |
| commit-no-verify | remainder_to_first bug + deleted assertion, committed with --no-verify | pass (fooled) | blocked: FALSIFIED `fair` {"total":72,"n":7} | assert-removed | yes |
| store-deleted (known limit) | the same commit, then deletes its record in ~/.truthgate | pass (fooled) | re-recorded: no verdicts | - | yes |
| ts skip-added | no_floor bug + test.skip on the failing test | pass (fooled) | blocked: FALSIFIED `bounds` {"subtotal":0,"pct":0,"fixedOff":1} | skip-added | yes |
| ts assert-removed | no_floor bug + deletes the failing assertion | pass (fooled) | blocked: FALSIFIED `bounds` {"subtotal":0,"pct":0,"fixedOff":1} | assert-removed | yes |

## Integration checks (installed tarball)

| check | result | detail |
|---|---|---|
| init --agent <all 10> writes every agent file | pass | 17 files |
| init is idempotent | pass |  |
| init installs the pre-commit hook (instruct-only agents present) | pass |  |
| init --yes in a TS repo with stray .py files: no Hypothesis, no config, not blocked | pass |  |
| hook --agent claude: blocks the bug, allows the fix | pass | bug: "{\"decision\":\"block\",\"reason\":\"truthgate blocked this stop:\\nFALSIFIED money.split/fair: fair failed for {\\\"to…; fix: "" |
| hook --agent codex: blocks the bug, allows the fix | pass | bug: "{\"decision\":\"block\",\"reason\":\"truthgate blocked this stop:\\nFALSIFIED money.split/fair: fair failed for {\\\"to…; fix: "" |
| hook --agent copilot: blocks the bug, allows the fix | pass | bug: "{\"decision\":\"block\",\"reason\":\"truthgate blocked this stop:\\nFALSIFIED money.split/fair: fair failed for {\\\"to…; fix: "" |
| hook --agent gemini: blocks the bug, allows the fix | pass | bug: "{\"decision\":\"deny\",\"reason\":\"truthgate blocked this stop:\\nFALSIFIED money.split/fair: fair failed for {\\\"tot…; fix: "{\"decision\":\"allow\"}" |
| hook --agent cursor: blocks the bug, allows the fix | pass | bug: "{\"followup_message\":\"truthgate blocked this stop:\\nFALSIFIED money.split/fair: fair failed for {\\\"total\\\":72,\\…; fix: "{}" |
| loop cap: 3 blocks, then capped allow | pass | block → block → block → capped |
| hook: a weakened spec does not block but tells the user | pass | "{\"systemMessage\":\"truthgate: specs were edited since the baseline. Review them: a weakened spec passes code it shoul… |
| status lists the spec, the baseline and the spec edit | pass | money.split  function  src/money.py::split_cents / Baseline: 50b1a1e (auto). / SPEC EDIT  spec money.split (.truthgate/specs/money.split.yaml) was changed since the baseline 50b1a1e: check it was not weakened |
| accept: a committed test change blocks until accepted, then passes | pass | "Accepting these changes since 035edca:\n  assert-removed: tests/test_money.py (1 assertion line(s) removed or changed s… |
| approve is gone | pass |  |
| MCP exposes no accept or approve tool | pass | verify, list_specs, spec_status, explain_verdict, shim_template |
| MCP verify reports FALSIFIED on the bug | pass | "BLOCKING (54 changed files, 310 ms)" |
| pre-commit rejects the bug and accepts the fix | pass | bug commit exit 1, fix commit exit 0 |
