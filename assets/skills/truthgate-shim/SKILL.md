---
name: truthgate-shim
description: Create or fix the truthgate shim that lets the verifier call Python, Java, C#, Go or Rust code. Use when a spec targets a non-JS/TS file, when verify reports UNVERIFIED (shim error) or (toolchain missing), or when asked about `truthgate shim`.
---

# truthgate shims

JS/TS targets are imported directly and need no shim. Every other language talks to the verifier
through a small **shim**: a program that reads JSON Lines on stdin and answers on stdout.
Python may also run natively through Hypothesis when it is installed; the shim is the fallback.

## Get a template
```
npx truthgate shim <spec-id>
```
This **writes** the template to the path it prints. It won't replace an existing file unless you
pass `--force`. The MCP `shim_template` tool returns the same source and path without writing.
- **Python, Java, C#:** the shims are generic. Leave them exactly as written.
- **Go, Rust:** fill in only the parts the template marks. Keep the protocol code as-is.

## Protocol (one persistent process per spec run)
Requests, one JSON object per line:
- `{"op":"call","fn":"sort_list","input":{"xs":[3,1]}}`: call `fn` with named inputs.
- `{"op":"reset"}`: sequence specs. Start from a fresh instance.
- `{"op":"state"}`: sequence specs. Return a JSON snapshot of the instance.

Responses, exactly one line per request:
- `{"out": <json value>}`: the return value (for `reset`, any value such as `null`).
- `{"error":"msg","kind":"rejected"}`: the function refused the input (validation error). This is a normal outcome.
- `{"error":"msg","kind":"crash"}`: anything unexpected. This counts as FALSIFIED unless the spec sets `allowCrash: true`.

Rules:
- Write **nothing else to stdout**: no logs, prints or banners. Use stderr for debugging.
- Flush after every response line.
- Only an explicit refusal counts as `rejected`:
  - Python `ValueError`, Java `IllegalArgumentException`, C# `ArgumentException`
  - an exception class named `Rejected`
  - Go: a trailing non-nil `error` result. Rust: `Err(..)`. JS: `RangeError`.

  Anything else is a `crash`, including `TypeError`/`NullPointerException`. To refuse an input, throw one of these. Never catch bugs and report them as rejections.
- Return plain JSON: numbers, strings, bools, null, arrays, objects. Convert decimals, enums and
  dates explicitly. `state` should expose the fields that the spec's `invariant` reads.

## Custom start command
By default each language adapter starts the shim at the template's path. Override this in the spec when
your build differs:
```yaml
shim:
  command: ["go", "run", "{shim}"]   # tokens: {root} = repo root, {shim} = shim path
  cwd: services/inventory           # optional, relative to repo root
```

## Troubleshooting
| Verdict detail | Fix |
|---|---|
| `UNVERIFIED (toolchain missing)` | Install the compiler/runtime, or tell the user it is missing. Do not delete the spec. |
| `UNVERIFIED (shim error)` | Run the shim by hand and pipe one request into it. Check for stray stdout output, a wrong `fn` name or a non-JSON return value. |
| Every call returns `crash` | Usually an import/path problem in the shim, not a code bug. Fix the shim first. |

Never "fix" a FALSIFIED verdict by making the shim swallow errors or alter outputs. The shim must
pass the real behaviour through unchanged.
