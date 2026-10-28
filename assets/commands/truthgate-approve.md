---
description: Ask the user to approve truthgate specs (agents cannot approve)
---

Do not try to approve specs yourself, and do not edit `.truthgate/approved.json`.
List the spec files under `.truthgate/specs/` that changed, then tell the user:

"Please review these specs, then run `npx truthgate approve` in your own terminal. It needs an interactive terminal and cannot be run by the agent."
