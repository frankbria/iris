# Phase 2 Documentation Guide

**Purpose:** This document explains the Phase 2 documentation structure and how the different files relate to each other.

---

## Documentation Hierarchy

### 📋 **Planning & Execution Documents** (START HERE)

1. **[plan/phase2_todo.md](../plan/phase2_todo.md)** - ⭐ **MAIN EXECUTION PLAN**
   - **Purpose:** Task-by-task implementation checklist
   - **Use for:** Daily development work, tracking progress
   - **Status:** 40% complete (Week 1-4 of Sub-Phase 2A complete)
   - **Timeline:** 14-18 weeks, 5 sub-phases
   - **Update frequency:** Daily/weekly as tasks complete

2. **[docs/phase2_revised_plan.md](phase2_revised_plan.md)** - **COMPREHENSIVE PLAN**
   - **Purpose:** High-level strategy and milestone breakdown
   - **Use for:** Understanding overall approach, architecture decisions
   - **Content:** Week-by-week deliverables, code examples, success criteria
   - **Relationship to todo:** This is the "why" and "what", todo is the "how"

### 📐 **Technical Specification** (REFERENCE)

3. **[docs/phase2_technical_architecture.md](phase2_technical_architecture.md)** - **TECHNICAL SPEC**
   - **Purpose:** Detailed technical design for WHAT to build
   - **Use for:** Implementation details, API contracts, data structures
   - **Size:** 2,556 lines - comprehensive technical reference
   - **Note:** Does NOT specify timeline - focuses on technical design only

### 📊 **Analysis & Context** (BACKGROUND)

4. **[docs/phase2_architecture_gaps.md](phase2_architecture_gaps.md)** - **GAP ANALYSIS**
   - **Purpose:** Why the plan was revised (12 critical gaps identified)
   - **Use for:** Understanding why 14-18 weeks vs original 8-12 weeks
   - **Content:** Problem analysis, evidence, solutions, lessons learned

### 📖 **Project-Wide Plans** (CONTEXT)

5. **[docs/dev_plan.md](dev_plan.md)** - **OVERALL PROJECT PLAN**
   - **Purpose:** All 5 phases of IRIS project (Phase 1-5)
   - **Phase 2 section:** Reflects revised 14-18 week timeline
   - **Use for:** Understanding Phase 2 in context of overall project

---

## How to Use This Documentation

### If You're **Implementing Phase 2:**
1. ⭐ **Start with:** `plan/phase2_todo.md` (execution checklist)
2. **Reference:** `docs/phase2_technical_architecture.md` (technical details)
3. **Context:** `docs/phase2_revised_plan.md` (strategy and milestones)

### If You're **Understanding Why the Plan Changed:**
1. **Read:** `docs/phase2_architecture_gaps.md` (12 critical gaps)
2. **Compare:** Original timeline (8-12 weeks) vs revised (14-18 weeks)

### If You're **Reviewing Phase 2 Strategy:**
1. **Read:** `docs/phase2_revised_plan.md` (comprehensive plan)
2. **Deep dive:** `docs/phase2_technical_architecture.md` (technical spec)

---

## Current Status

**Phase 2 Progress:** 40% Complete (Week 1-4 of 14-18)

**Completed:**
- ✅ Core visual testing infrastructure (Week 1-2)
  - Capture engine with page stabilization
  - SSIM and pixel-based diff engine
  - Git-integrated baseline manager
  - Complete TypeScript/Zod type system
  - Database schema for visual testing

- ✅ AI Vision Foundation (Week 1-4 - Sub-Phase 2A)
  - Multimodal AI client architecture (text + vision)
  - Vision provider integrations (OpenAI GPT-4o, Anthropic Claude 3.5, Ollama)
  - Image preprocessing pipeline (resize, optimize, base64 encoding)
  - AI vision result caching (LRU memory + SQLite persistence)
  - Cost tracking with budget management and circuit breaker
  - Smart client with automatic fallback and cost optimization

**Next Up (Sub-Phase 2B: Week 5-7):**
- 🔄 Visual Classification Integration
  - AI visual classifier implementation
  - Diff engine integration with AI classification
  - Validation harness with golden dataset

**See [plan/phase2_todo.md](../plan/phase2_todo.md) for detailed task breakdown.**

---

## Key Decisions

### Timeline: 14-18 Weeks (Revised from 8-12 Weeks)

**Why the change?**
- AI vision integration requires fundamental architecture changes (4 weeks)
- Cost control is critical for production use (2 weeks)
- Validation harness with golden dataset is mandatory for quality (1 week)
- Parallel execution needed for acceptable performance (3 weeks)

**See [docs/phase2_architecture_gaps.md](phase2_architecture_gaps.md) for full analysis.**

### Sub-Phases

**Sub-Phase 2A (Week 1-4):** AI Vision Foundation
- Multimodal architecture, cost control, provider abstraction

**Sub-Phase 2B (Week 5-7):** Visual Classification System
- Diff engine integration, validation harness (CRITICAL)

**Sub-Phase 2C (Week 8-10):** Parallel Execution & Performance
- Browser pool, concurrency control, performance optimization

**Sub-Phase 2D (Week 11-14):** CLI Integration & Reporting
- Commands, watch mode, report generation, baseline management

**Sub-Phase 2E (Week 15-18):** Accessibility Foundation
- axe-core integration, keyboard testing, accessibility reporting

### Descoped Features

**Moved to Phase 3:**
- Screen reader simulation (complex, requires dedicated focus)
- Advanced keyboard navigation testing
- Cross-browser support (requires multi-baseline architecture)

**Moved to Phase 5:**
- Autonomous UI exploration (already planned for Phase 5)

---

## Document Relationships

```
docs/dev_plan.md (Overall Project Plan)
    │
    ├─ Phase 1 ✅ Complete
    │
    ├─ Phase 2 🟡 40% Complete ← YOU ARE HERE
    │     │
    │     ├─ docs/phase2_revised_plan.md (Strategy & Milestones)
    │     │     │
    │     │     └─ plan/phase2_todo.md ⭐ (Execution Checklist)
    │     │
    │     ├─ docs/phase2_technical_architecture.md (Technical Spec)
    │     │
    │     └─ docs/phase2_architecture_gaps.md (Why Revised)
    │
    ├─ Phase 3 📋 Planned
    ├─ Phase 4 📋 Planned
    └─ Phase 5 📋 Planned
```

---

## Quick Reference

| Document | Lines | Purpose | Update Frequency |
|----------|-------|---------|------------------|
| `plan/phase2_todo.md` | 605 | ⭐ Daily execution | Daily/Weekly |
| `docs/phase2_revised_plan.md` | 605 | Strategy | Per milestone |
| `docs/phase2_technical_architecture.md` | 2,556 | Technical spec | As needed |
| `docs/phase2_architecture_gaps.md` | 605 | Gap analysis | One-time |
| `docs/dev_plan.md` | 725 | Overall project | Per phase |

---

## FAQ

**Q: Which file should I update when I complete a task?**
A: Update `plan/phase2_todo.md` to mark tasks complete. This is the execution tracker.

**Q: Where do I find implementation details?**
A: `docs/phase2_technical_architecture.md` has all technical specifications.

**Q: Why are there so many Phase 2 documents?**
A: Each serves a different purpose:
- **todo.md** = daily work tracker
- **revised_plan.md** = strategic overview
- **technical_architecture.md** = implementation details
- **architecture_gaps.md** = historical analysis

**Q: What's the single source of truth?**
A: For **WHAT to build**: `phase2_technical_architecture.md`
   For **WHEN to build it**: `plan/phase2_todo.md`
   For **WHY this approach**: `phase2_revised_plan.md`

**Q: The documents seem to overlap. Is that a problem?**
A: No - they serve different audiences:
- **Developers executing tasks** → use todo.md
- **Architects designing systems** → use technical_architecture.md
- **Stakeholders understanding strategy** → use revised_plan.md
- **Team learning from decisions** → use architecture_gaps.md

---

**Last Updated:** 2025-10-13
**Version:** 1.0
**Status:** Current
