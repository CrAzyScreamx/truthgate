---
description: Run truthgate verify on the current changes and act on the verdicts
---

Run `npx -y truthgate verify` in the repo root (or call the truthgate MCP `verify` tool).
Then follow the truthgate-verdicts skill:
- FALSIFIED: fix the code, never the spec, and re-run.
- WEAK SPEC: strengthen the spec (add a property the fake fails).
- UNVERIFIED: explain the reason to the user.

Report the verdicts exactly as worded.
