# #363 [P2.13] Dependency audit gate

## Plan (self-authored)

The acceptance criteria point at the maintainer's private P2.13 checklist, which is not in
the repository. The owner's direction on the issue (2026-11-08) is "This status is out of
date. Review and revise." So the plan is the review, and what it found to revise.

**Review (2026-11-11, main at 36307a9).**
- The gate exists: `npm audit --omit=dev --audit-level=high`, last step of CI's `build`
  job; both deploy jobs need `build`.
- Production dependencies: 0 advisories at any level (291 packages, root and portal).
- All dependencies: 32 (27 moderate, 5 low), every one development-only. The 8 high and 1
  critical of 2026-10-12 are gone (Dependabot bumps since).
- It covers the portal: a high advisory planted in the portal's dependencies, in a
  scratch copy of the manifests, fails it (exit 1).
- It fails closed: an unreachable advisory endpoint is exit 1.
- Nothing pins it. Deleting the step, `|| true`, `continue-on-error` or
  `--audit-level=critical` leaves every suite green. Nothing documents it or says what to
  do when it holds a deploy.

**Decisions.**
- The command stays as it is. Tightening it to `moderate`, gating development
  dependencies, an exception list or a scheduled run would each be new policy, and the
  review found no defect that asks for one.
- No network call in the suite: the catch is shown in the PR against the real registry.

## Steps
1. `__tests__/container-config.test.ts`: pin the command, no `continue-on-error` in the
   build job, both deploys `needs: build`, the portal recorded in the root lockfile, Dependabot's
   security-updates group for the npm lockfile.
2. Docs: a comment on the step in `ci.yml`, `.claude/rules/deploy-ops.md`,
   `docs/runbook-production.md` ("When the dependency audit fails"), `plans/README.md`.

## Acceptance criteria
- [ ] Every checklist item for P2.13 in the private backlog is done (not checkable here:
      the checklist was never posted; the review above stands in for it)
- [ ] Each item is covered by a regression test
