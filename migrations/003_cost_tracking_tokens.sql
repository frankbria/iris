-- Migration 003: Token counts on cost tracking
-- Purpose: Persist per-operation token usage so recorded spend reflects real
--          token-based cost (issue #67) instead of a flat per-image estimate.
-- Date: 2026-07-12

-- Add token count columns to the cost tracking table.
-- Note: the live schema is created in code (CostTracker.initializeDatabase),
-- which applies these same columns idempotently. This file documents the
-- schema change for reference and manual/greenfield application.
ALTER TABLE cost_tracking ADD COLUMN input_tokens INTEGER;
ALTER TABLE cost_tracking ADD COLUMN output_tokens INTEGER;

-- Rollback (SQLite lacks DROP COLUMN before 3.35; recreate table if needed):
-- ALTER TABLE cost_tracking DROP COLUMN input_tokens;
-- ALTER TABLE cost_tracking DROP COLUMN output_tokens;
