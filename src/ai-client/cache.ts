import Database from 'better-sqlite3';
import { ensureDatabaseDir } from '../db';
import { AIVisionResponse } from './base';
import { AIVisionResponseSchema } from './types';

/**
 * Cache configuration
 */
export interface CacheConfig {
  /**
   * Maximum number of entries in memory cache (default: 100)
   */
  maxMemoryEntries?: number;

  /**
   * Time-to-live in milliseconds (default: 30 days)
   */
  ttlMs?: number;

  /**
   * Database file path for persistent cache
   */
  dbPath?: string;

  /**
   * Number of set() calls between automatic prunes of expired rows (default: 100).
   * Keeps the persistent SQLite cache from growing unbounded on long-running
   * processes. Pruning also runs once on construction.
   */
  pruneIntervalWrites?: number;

  /**
   * Enable debug logging (default: false)
   */
  debug?: boolean;
}

/**
 * Cache entry metadata
 */
export interface CacheEntry {
  key: string;
  value: AIVisionResponse;
  timestamp: number;
  provider: string;
  model: string;
  hits: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  memorySize: number;
  persistentSize: number;
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<CacheConfig> = {
  maxMemoryEntries: 100,
  ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  dbPath: ':memory:',
  pruneIntervalWrites: 100,
  debug: false,
};

/**
 * LRU cache node for linked list implementation
 */
class LRUNode {
  constructor(
    public key: string,
    public value: CacheEntry,
    public prev: LRUNode | null = null,
    public next: LRUNode | null = null,
  ) {}
}

/**
 * AI vision result cache with LRU memory cache and SQLite persistence
 *
 * Implements two-tier caching:
 * 1. Fast in-memory LRU cache for hot data
 * 2. SQLite persistent cache for all results
 *
 * Cache keys are generated from image hashes, provider, and model.
 */
export class AIVisionCache {
  private config: Required<CacheConfig>;
  private db: Database.Database;
  private memoryCache: Map<string, LRUNode>;
  private head: LRUNode | null = null;
  private tail: LRUNode | null = null;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private writesSincePrune = 0;

  constructor(config: CacheConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.memoryCache = new Map();

    // Initialize SQLite database
    ensureDatabaseDir(this.config.dbPath);
    this.db = new Database(this.config.dbPath);
    this.initializeDatabase();

    // Reclaim any rows that expired while the process was down.
    this.pruneExpired();
  }

  /**
   * Initialize database schema
   */
  private initializeDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_vision_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        hits INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON ai_vision_cache(timestamp);
      CREATE INDEX IF NOT EXISTS idx_provider_model ON ai_vision_cache(provider, model);
    `);
  }

  /**
   * Generate cache key from image hash, provider, and model
   *
   * @param baselineHash - Baseline image hash
   * @param currentHash - Current image hash
   * @param provider - AI provider name
   * @param model - Model identifier
   * @param context - Serialized request context (url/selector/etc). Included in
   *   the key only when non-empty, since context influences the analysis result
   *   and identical images with different context must not share a cache entry.
   * @param diffHash - Hash of the diff mask sent as a third image, when one was
   *   sent. A diff-aware answer must never be served for a diff-less request
   *   (issue #124), so it is part of the key identity. It carries a `diff=`
   *   marker rather than being appended bare: without one, `(context: "X", no
   *   diff)` and `(no context, diff: "X")` would produce the same key. Callers
   *   passing a `context` that could itself start with `diff=` would defeat
   *   that — in-repo it is always a JSON object.
   * @returns Cache key string
   */
  generateKey(
    baselineHash: string,
    currentHash: string,
    provider: string,
    model: string,
    context = '',
    diffHash = '',
  ): string {
    const parts = [provider, model, baselineHash, currentHash];
    // Omitted when absent, so keys for diff-less requests stay byte-identical
    // to the pre-#124 format and existing cache entries survive the upgrade.
    if (diffHash) parts.push(`diff=${diffHash}`);
    if (context) parts.push(context);
    return parts.join(':');
  }

  /**
   * Get cached result
   *
   * Checks memory cache first, then persistent cache.
   * Updates LRU order and hit statistics.
   *
   * @param key - Cache key
   * @returns Cached vision response or undefined
   */
  get(key: string): AIVisionResponse | undefined {
    // Check memory cache first
    const node = this.memoryCache.get(key);
    if (node) {
      // Defensive re-validation: a corrupt entry is treated as a miss and
      // evicted rather than returning a structurally invalid response.
      const valid = AIVisionResponseSchema.safeParse(node.value.value);
      if (!valid.success) {
        this.delete(key);
      } else {
        this.moveToHead(node);
        this.hits++;
        this.incrementHitCount(key);

        if (this.config.debug) {
          console.log(`[Cache] Memory hit: ${key}`);
        }

        return valid.data;
      }
    }

    // Check persistent cache
    const stmt = this.db.prepare(
      'SELECT value, timestamp, provider, model, hits FROM ai_vision_cache WHERE key = ?',
    );
    const row = stmt.get(key) as
      | {
          value: string;
          timestamp: number;
          provider: string;
          model: string;
          hits: number;
        }
      | undefined;

    if (row) {
      // Check if expired
      const age = Date.now() - row.timestamp;
      if (age > this.config.ttlMs) {
        this.delete(key);
        this.misses++;

        if (this.config.debug) {
          console.log(`[Cache] Expired: ${key}`);
        }

        return undefined;
      }

      // Validate the persisted value: a stale/corrupt entry (e.g. written by an
      // older version, or non-JSON) is treated as a miss instead of
      // reintroducing an invalid shape into the pipeline.
      let parsed = AIVisionResponseSchema.safeParse(undefined);
      try {
        parsed = AIVisionResponseSchema.safeParse(JSON.parse(row.value));
      } catch {
        // Non-JSON row: falls through to the invalid-entry miss path below.
      }
      if (!parsed.success) {
        this.delete(key);
        this.misses++;

        if (this.config.debug) {
          console.log(`[Cache] Invalid persisted entry treated as miss: ${key}`);
        }

        return undefined;
      }
      const value = parsed.data;
      this.addToMemory(key, {
        key,
        value,
        timestamp: row.timestamp,
        provider: row.provider,
        model: row.model,
        hits: row.hits + 1,
      });

      this.hits++;
      this.incrementHitCount(key);

      if (this.config.debug) {
        console.log(`[Cache] Persistent hit: ${key}`);
      }

      return value;
    }

    this.misses++;

    if (this.config.debug) {
      console.log(`[Cache] Miss: ${key}`);
    }

    return undefined;
  }

  /**
   * Store result in cache
   *
   * Saves to both memory and persistent cache.
   *
   * @param key - Cache key
   * @param value - Vision response to cache
   * @param provider - AI provider name
   * @param model - Model identifier
   */
  set(key: string, value: AIVisionResponse, provider: string, model: string): void {
    const timestamp = Date.now();
    const entry: CacheEntry = {
      key,
      value,
      timestamp,
      provider,
      model,
      hits: 0,
    };

    // Add to memory cache
    this.addToMemory(key, entry);

    // Add to persistent cache
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ai_vision_cache (key, value, timestamp, provider, model, hits)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(key, JSON.stringify(value), timestamp, provider, model, 0);

    if (this.config.debug) {
      console.log(`[Cache] Set: ${key}`);
    }

    // Throttled prune so the persistent cache stays bounded without paying the
    // DELETE cost on every write. A non-positive interval disables throttled
    // pruning (construction-time prune still runs).
    if (
      this.config.pruneIntervalWrites > 0 &&
      ++this.writesSincePrune >= this.config.pruneIntervalWrites
    ) {
      this.writesSincePrune = 0;
      this.pruneExpired();
    }
  }

  /**
   * Add entry to memory cache with LRU eviction
   */
  private addToMemory(key: string, entry: CacheEntry): void {
    // Remove if already exists
    const existing = this.memoryCache.get(key);
    if (existing) {
      this.removeNode(existing);
    }

    // Create new node and add to head
    const node = new LRUNode(key, entry);
    this.addToHead(node);
    this.memoryCache.set(key, node);

    // Evict if over capacity
    if (this.memoryCache.size > this.config.maxMemoryEntries) {
      if (this.tail) {
        this.memoryCache.delete(this.tail.key);
        this.removeNode(this.tail);
        this.evictions++;

        if (this.config.debug) {
          console.log(`[Cache] Evicted: ${this.tail.key}`);
        }
      }
    }
  }

  /**
   * Move node to head of LRU list (most recently used)
   */
  private moveToHead(node: LRUNode): void {
    this.removeNode(node);
    this.addToHead(node);
  }

  /**
   * Add node to head of LRU list
   */
  private addToHead(node: LRUNode): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }

    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }
  }

  /**
   * Remove node from LRU list
   */
  private removeNode(node: LRUNode): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
  }

  /**
   * Increment hit count in persistent cache
   */
  private incrementHitCount(key: string): void {
    const stmt = this.db.prepare('UPDATE ai_vision_cache SET hits = hits + 1 WHERE key = ?');
    stmt.run(key);
  }

  /**
   * Delete entry from cache
   *
   * @param key - Cache key
   */
  delete(key: string): void {
    // Remove from memory
    const node = this.memoryCache.get(key);
    if (node) {
      this.removeNode(node);
      this.memoryCache.delete(key);
    }

    // Remove from persistent cache
    const stmt = this.db.prepare('DELETE FROM ai_vision_cache WHERE key = ?');
    stmt.run(key);

    if (this.config.debug) {
      console.log(`[Cache] Deleted: ${key}`);
    }
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    // Clear memory
    this.memoryCache.clear();
    this.head = null;
    this.tail = null;

    // Clear persistent cache
    this.db.prepare('DELETE FROM ai_vision_cache').run();

    // Reset stats
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;

    if (this.config.debug) {
      console.log('[Cache] Cleared all entries');
    }
  }

  /**
   * Remove expired entries from the persistent cache.
   *
   * Runs automatically on construction and every `pruneIntervalWrites` writes,
   * and is also exposed for manual/scheduled cleanup (e.g. from a long-running
   * `watch` process).
   *
   * @returns Number of entries removed
   */
  pruneExpired(): number {
    const cutoff = Date.now() - this.config.ttlMs;
    const stmt = this.db.prepare('DELETE FROM ai_vision_cache WHERE timestamp < ?');
    const result = stmt.run(cutoff);

    if (this.config.debug) {
      console.log(`[Cache] Pruned ${result.changes} expired entries`);
    }

    return result.changes;
  }

  /**
   * Get cache statistics
   *
   * @returns Cache statistics
   */
  getStats(): CacheStats {
    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM ai_vision_cache');
    const { count } = countStmt.get() as { count: number };

    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;

    return {
      memorySize: this.memoryCache.size,
      persistentSize: count,
      hits: this.hits,
      misses: this.misses,
      hitRate,
      evictions: this.evictions,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Create a cache instance with default configuration
 */
export function createCache(config?: CacheConfig): AIVisionCache {
  return new AIVisionCache(config);
}
