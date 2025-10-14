-- Migration 002: AI Vision Cache and Cost Tracking Tables
-- Purpose: Add tables for AI vision result caching and cost tracking
-- Date: 2025-10-13

-- AI Vision Cache Table
-- Stores cached vision analysis results with TTL and hit tracking
CREATE TABLE IF NOT EXISTS ai_vision_cache (
  key TEXT PRIMARY KEY,          -- Cache key: provider:model:baseline_hash:current_hash
  value TEXT NOT NULL,            -- JSON-serialized AIVisionResponse
  timestamp INTEGER NOT NULL,     -- Creation timestamp (milliseconds)
  provider TEXT NOT NULL,         -- AI provider name (openai, anthropic, ollama)
  model TEXT NOT NULL,            -- Model identifier
  hits INTEGER DEFAULT 0          -- Cache hit counter
);

CREATE INDEX IF NOT EXISTS idx_ai_cache_timestamp ON ai_vision_cache(timestamp);
CREATE INDEX IF NOT EXISTS idx_ai_cache_provider_model ON ai_vision_cache(provider, model);

-- Cost Tracking Table
-- Tracks API usage costs with provider and model granularity
CREATE TABLE IF NOT EXISTS cost_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,     -- Operation timestamp (milliseconds)
  provider TEXT NOT NULL,         -- AI provider name
  model TEXT NOT NULL,            -- Model identifier
  operation TEXT NOT NULL,        -- Operation type (vision-analysis)
  cost REAL NOT NULL,             -- Cost in USD
  cached INTEGER NOT NULL DEFAULT 0  -- 1 if result was cached (no cost), 0 otherwise
);

CREATE INDEX IF NOT EXISTS idx_cost_timestamp ON cost_tracking(timestamp);
CREATE INDEX IF NOT EXISTS idx_cost_provider_model ON cost_tracking(provider, model);

-- Note: This migration adds new tables and does not modify existing data
-- Rollback: DROP TABLE ai_vision_cache; DROP TABLE cost_tracking;
