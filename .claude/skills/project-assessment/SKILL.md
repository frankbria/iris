---
name: project-assessment
description: Assess the IRIS project state against its specs and plan, and write plans/status_YYYYMMDDHHMM.md. Use when asked to assess project status or where the project stands.
---

# Project Assessment Process

You will occasionally be asked to assess the current state of the development project. This involves a comprehensive review to understand where the project stands relative to its specifications and development plan.

## Assessment Steps

1. **Codebase Review**: Thoroughly examine all source code in `src/` and related files to understand current implementation state
2. **Test Analysis**: Run `npm run test` and analyze coverage, pass rates, and test quality
3. **Specification Comparison**: Review documentation in `/docs` directory and compare against actual implementation
4. **Development Plan Review**: Examine `plans/README.md` (the single source-of-truth status tracker) to understand what's marked as complete vs. actual state

## Assessment Output

Create a status report in `plans/status_YYYYMMDDHHMM.md` with the following format:

### Status
**Red/Yellow/Green assessment** based on:
- Codebase quality and completeness
- Test output and coverage
- Alignment with development plan claims

### Summary
**Bullet points of positive findings:**
- What has been successfully implemented
- Working functionality confirmed by tests
- Progress that aligns with development plan

### Feedback
**Bullet points of issues and discrepancies:**
- Functionality claimed as complete but not working
- Test failures or inadequate coverage
- Gaps between development plan claims and actual implementation
- Code quality concerns or architectural issues

This assessment provides an objective view of project status and helps identify where development claims may not match reality.

