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
