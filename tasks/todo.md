# #666 [P3.41] Tests: freePort() releases the port before iris connect listens

## Plan (self-authored; no plan on the issue)

Four test files define a `freePort` (the issue says three; `portal-image.test.ts` is the fourth).
What each one hands the port to decides the fix:

1. `__tests__/utils/ports.ts` (new, with `ports.test.ts` written first):
   - `connectPort(output)`: the port `iris connect 0` printed on its `listening` line.
   - `onFreePorts(count, host, start)`: for a process that cannot be told "port 0". Probes
     `count` distinct ports, runs `start(ports)`, and tries fresh ports when `start` throws
     `PortTaken` (at most 5 attempts; any other error is thrown at once).
   - `closedPort(host)`: for a test that wants a refused connection, never a listener.
   - A guard test: no test file defines its own `freePort`.
2. `api-key-auth.test.ts`: every spawn is `iris connect 0`; the shared `beforeAll` reads the
   port from the `listening` line. `freePort` deleted.
3. `observability.test.ts`: `iris connect 0`; `--metrics-port` refuses 0 (`min: 1`), so the
   metrics port goes through `onFreePorts`, and a child that exits with
   `Cannot serve metrics ... EADDRINUSE` is `PortTaken`. Same for the worker case.
4. `ingress.test.ts`: nginx cannot report a port it chose, so both listen ports go through
   `onFreePorts`; a container that exited with `bind() ... failed (98: Address in use)` is
   `PortTaken`.
5. `portal-image.test.ts`: the server's `PORT` goes through `onFreePorts` (`EADDRINUSE` in the
   exited container's log); the closed-port SMTP case uses `closedPort`.
6. Docs: `.claude/rules/testing.md`, `plans/README.md` (P3.41), `tasks/lessons.md`.

## Decisions

- No change under `src/`: `--metrics-port 0` stays refused (letting it through would need
  the bound port printed, a product change the issue does not ask for).
- No timeout raised, no Jest concurrency cut.

## Acceptance criteria

- [ ] A test that spawns `iris connect` no longer depends on a port staying free between a
      probe and the child's `listen`
- [ ] The same for the other test files that define `freePort`
- [ ] No timeout raised and no Jest concurrency cut (CLAUDE.md, #142)
- [ ] A note in `.claude/rules/testing.md`
