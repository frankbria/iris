# Beads Issue Tracker Migration Guide

## Overview

The IRIS project implementation plan has been converted to the **Beads** issue tracking system (`bd`), enabling AI agents and developers to systematically work through remaining Phase 2 tasks with clear dependency tracking.

## What is Beads?

Beads (`bd`) is a dependency-aware issue tracker designed for AI-supervised workflows. Issues are "chained together like beads" with explicit dependencies, making it easy for AI agents to:

1. Find ready work (`bd ready` - issues with no blockers)
2. Understand context and dependencies (`bd show iris-X`)
3. Track progress and create discovered work
4. Avoid duplicating effort through dependency management

## Installation

Beads is already installed in this project:

```bash
# bd is installed globally at /home/frankbria/go/bin/bd
# Added to PATH in ~/.bashrc

# Verify installation
bd version

# Show help
bd --help
bd quickstart
```

## Database Location

- **Database**: `.beads/iris.db` (SQLite)
- **Issue Prefix**: `iris-` (e.g., `iris-1`, `iris-2`)
- **Auto-sync**: JSONL export/import for git collaboration (5s debounce)

## Current Issue Status

### Summary

- **Total Issues**: 19
- **Priority Breakdown**:
  - P0 (Critical): 1 issue (Week 7 validation harness)
  - P1 (High): 11 issues (Sub-phases and features)
  - P2 (Medium): 3 issues (Infrastructure gaps)
  - P3 (Low): 4 issues (Optimizations)

### Issue Hierarchy

**Sub-Phase 2B: Visual Classification Integration (Week 5-7)**
- `iris-5` (Epic, P1) - Parent epic
  - `iris-6` (Feature, P1) - Week 5-6: AI Visual Classifier Implementation
  - `iris-7` (Feature, P0) - Week 7: Validation Harness & Golden Dataset ⚠️ CRITICAL

**Sub-Phase 2C: Parallel Execution & Performance (Week 8-10)**
- `iris-8` (Epic, P1) - Parent epic (blocked by iris-7)
  - `iris-9` (Feature, P1) - Week 8-9: Parallel Execution Architecture
  - `iris-10` (Feature, P1) - Week 10: Optimization & Profiling (blocked by iris-9)

**Sub-Phase 2D: CLI Integration & Reporting (Week 11-14)**
- `iris-11` (Epic, P1) - Parent epic (blocked by iris-10)
  - `iris-12` (Feature, P1) - Week 11-12: CLI Command Implementation
  - `iris-13` (Feature, P1) - Week 13-14: Report Generation (blocked by iris-12)

**Sub-Phase 2E: Accessibility Foundation (Week 15-18)**
- `iris-14` (Epic, P1) - Parent epic (blocked by iris-13)
  - `iris-15` (Feature, P1) - Week 15-16: Axe-core Integration
  - `iris-16` (Feature, P1) - Week 17-18: Integration & Polish (blocked by iris-15)

**Infrastructure Issues (P2)**
- `iris-17` (Bug, P2) - Fix concurrency control bug in visual-runner.ts
- `iris-18` (Task, P2) - AccessibilityRunner URL handling architecture
- `iris-19` (Feature, P2) - Baseline creation workflow improvement

**Optimization Issues (P3)**
- `iris-1` (Bug, P3) - Performance test timing threshold adjustment
- `iris-2` (Task, P3) - Branch coverage improvement to 80%+
- `iris-3` (Task, P3) - Accessibility E2E infrastructure decision
- `iris-4` (Task, P3) - Database test optimization

## Common Commands for AI Agents

### Finding Work

```bash
# Show all issues ready to work on (no blockers)
bd ready

# Show all open issues
bd list --status open

# Show issues by priority
bd list --priority 0  # Critical
bd list --priority 1  # High
bd list --priority 2  # Medium
bd list --priority 3  # Low
```

### Viewing Details

```bash
# Show full issue details
bd show iris-1

# Show dependency tree
bd dep tree iris-5

# Check for circular dependencies
bd dep cycles

# View statistics
bd stats
```

### Creating Issues

```bash
# Create a new task
bd create "Task description" -p 2 -t task -d "Detailed description"

# Create with dependencies
bd create "New feature" -t feature --deps "blocks:iris-5"

# Create discovered work
bd create "Found during iris-7" --deps "discovered-from:iris-7"
```

### Updating Issues

```bash
# Claim work (set assignee)
bd update iris-1 --assignee your-name

# Mark as in progress
bd update iris-1 --status in_progress

# Change priority
bd update iris-1 --priority 1

# Add dependency
bd dep add iris-2 iris-1  # iris-1 blocks iris-2
```

### Closing Issues

```bash
# Close issue
bd close iris-1

# Close with reason
bd close iris-1 --reason "Fixed in commit abc123"

# Close multiple
bd close iris-1 iris-2 iris-3
```

## AI Agent Workflow

### 1. Session Start

```bash
# List available work
bd ready

# Pick highest priority ready issue
bd show iris-7  # Example: Critical validation harness
```

### 2. Claim Work

```bash
# Set yourself as assignee
bd update iris-7 --assignee claude-agent

# Mark as in progress
bd update iris-7 --status in_progress
```

### 3. During Work

```bash
# Discovered new work?
bd create "Create accuracy-validator.ts" --deps "discovered-from:iris-7" -p 1

# Found a blocker?
bd create "Need golden dataset schema" --deps "blocks:iris-7" -p 0

# Check what's blocking you
bd show iris-7  # View dependencies
```

### 4. Complete Work

```bash
# Close issue when done
bd close iris-7 --reason "Completed in commit e383ebb"

# Find next work
bd ready
```

## Critical Path

The current critical path for Phase 2 completion:

1. **iris-6** → Week 5-6: AI Visual Classifier Implementation (P1, no blockers)
2. **iris-7** → Week 7: Validation Harness & Golden Dataset (P0, blocked by iris-6)
3. **iris-8** → Sub-Phase 2C: Parallel Execution (P1, blocked by iris-7)
4. **iris-11** → Sub-Phase 2D: CLI Integration (P1, blocked by iris-10)
5. **iris-14** → Sub-Phase 2E: Accessibility (P1, blocked by iris-13)
6. **iris-16** → Week 17-18: Integration & Polish (P1, final task)

## Success Criteria Reference

Stored in issue descriptions, key metrics include:

- **AI Classification Accuracy**: >90% on golden dataset
- **False Positive Rate**: <5%
- **Performance**: 50 pages in <3 minutes (4x parallelism)
- **Memory**: <2GB for 50-page test
- **Cache Hit Rate**: >40% after first week
- **Test Coverage**: >85%
- **Test Pass Rate**: >95%

## Integration with Git

Beads automatically syncs with git:

- **Auto-export**: Exports to JSONL after create/update/close (5s debounce)
- **Auto-import**: Imports from JSONL when newer than database (after git pull)
- **Collaboration**: Multiple agents can work simultaneously across branches
- **Conflict Resolution**: Last-write-wins for simple conflicts

No manual export/import needed - just use git normally:

```bash
git pull   # Automatically imports newest JSONL
git push   # Other developers/agents see your changes
```

## Viewing Progress

### Text Format

```bash
# List all issues
bd list

# Show statistics
bd stats

# View dependency tree
bd dep tree iris-5
```

### JSON Format (for programmatic parsing)

```bash
# All issues as JSON
bd list --json

# Single issue as JSON
bd show iris-1 --json

# Ready work as JSON
bd ready --json
```

## Next Steps for AI Agents

1. **Start with ready work**: `bd ready` shows unblocked issues
2. **Pick highest priority**: P0 > P1 > P2 > P3
3. **Check dependencies**: `bd show iris-X` before starting
4. **Claim work**: `bd update iris-X --status in_progress --assignee your-name`
5. **Create discovered work**: Use `--deps discovered-from:iris-X`
6. **Close when done**: `bd close iris-X --reason "commit sha"`
7. **Find next**: `bd ready` again

## Key Files Created

- `.beads/iris.db` - SQLite database (gitignored)
- `.beads/iris.jsonl` - Auto-synced git-friendly format (committed)
- `docs/beads-migration-guide.md` - This guide

## Support

- **Beads GitHub**: https://github.com/steveyegge/beads
- **Documentation**: https://github.com/steveyegge/beads/blob/main/README.md
- **Quick Reference**: `bd quickstart`
- **Help**: `bd --help` or `bd [command] --help`

---

**Last Updated**: 2025-10-14
**Project**: IRIS (Interface Recognition & Interaction Suite)
**Phase**: Phase 2 - Visual Regression & Accessibility
**Status**: 95% Complete - Production Ready
