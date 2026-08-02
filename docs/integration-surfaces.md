# Integration Surfaces — Decision Record

**Status:** Accepted
**Date:** 2026-07-23 (vision-alignment audit, Cycle 3)
**Revisit trigger:** when the MCP spike ([plans/012](../plans/012-mcp-server-spike.md)) reports its verdict

## Context

IRIS maintains three ways for an outside tool to drive it, and they had drifted apart:

| Surface | State |
|---|---|
| **CLI** (`src/cli.ts`) | Real. Five commands, documented, tested, the only one anyone actually uses. |
| **WebSocket JSON-RPC** (`src/protocol.ts`, `iris connect`) | Runs, but orphaned. It speaks a bespoke protocol no mainstream AI assistant understands, and two of its methods (`getStatus`, `streamLogs`) return hardcoded mock data ([#80](https://github.com/frankbria/iris/issues/80)). |
| **MCP server** | Design only. A complete design exists in `claudedocs/research_iris_claude_code_plugin_20251012.md`; no code. |

Three surfaces means triple maintenance for one product, and the README pointed
assistant users at the one surface no assistant can consume.

## Decision

1. **The CLI is the canonical integration surface today.** Shelling out and parsing
   JSON from stdout works with every assistant right now, with no protocol work.
   `iris run --json` exists for exactly this ([#113](https://github.com/frankbria/iris/issues/113)).
2. **MCP is the strategic assistant bridge.** It is the protocol the ecosystem
   actually converged on. [plans/012](../plans/012-mcp-server-spike.md) is the spike.
3. **The WebSocket JSON-RPC server is legacy-experimental: frozen, not removed.**
   It keeps working and keeps its security fixes, but takes no new features. The
   retire-or-invest decision is deliberately deferred until the MCP spike lands, so
   it is made with evidence rather than in advance.

## Consequences

- README presents the CLI JSON contract as the assistant path, and `iris connect`
  as experimental/legacy with honest status.
- No new methods are added to `src/protocol.ts`. #80's mocked `getStatus` /
  `streamLogs` are either implemented honestly or removed — not left as stubs that
  imply working features.
- `src/protocol.ts` is **not** deleted as part of this decision. Removing a working
  surface before its replacement is proven would be a regression for anyone who
  built against it.
- When the MCP spike reports, a follow-up issue schedules the retirement review.

## Update — 2026-08-01: the spike reported (#114)

The revisit trigger has fired. The Context table above is the state as of
2026-07-23 and is left unedited as the record of what was known then; this is what
changed.

**Verdict: MCP is viable, and cheaper than the spike assumed.** `src/mcp/` now
ships an stdio server exposing one tool, `run_accessibility_test`, verified
connected in Claude Code and covered by a protocol-level test that drives the
built server over real stdio.

The one finding worth carrying forward: `@modelcontextprotocol/sdk` sets
`"type": "module"`, which reads as ESM-only and stalled a first attempt at this
work. It is not — the package's `exports` map carries a `require` condition
pointing at a real `dist/cjs` build, and a `typesVersions` shim serves types to
`moduleResolution: node10` consumers. So the SDK is consumable from IRIS's
existing CommonJS build with **no tsconfig change, no second build target, and no
`engines.node` bump**, provided imports use the `.js`-suffixed deep specifier
(`@modelcontextprotocol/sdk/server/mcp.js`); the bare `.../server` form does not
resolve under node10 and is what produced the false ESM-only reading.

Decision 3 is therefore unchanged but now actionable: the WebSocket JSON-RPC
retirement review can be scheduled against evidence.

## What this decision does not do

It does not shrink the product vision. The audit's conclusion was to *close* the
gap between docs and code, not to lower the ambition. The PRD's user stories keep
their full scope and gain status markers so ambition and honesty are visible at the
same time.

## References

- [plans/README.md](../plans/README.md) — canonical status tracker; wins over any other planning doc
- [plans/012](../plans/012-mcp-server-spike.md) — MCP spike
- [#80](https://github.com/frankbria/iris/issues/80) — JSON-RPC mocked methods
- [#114](https://github.com/frankbria/iris/issues/114) — MCP spike issue
