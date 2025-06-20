/* eslint-disable no-console */
import { Redis } from '@upstash/redis';
import { compress, decompress } from 'lz-string';
import crypto from 'crypto';
import { normalizeUrl } from '@/utils/url-utils';
import { PROCESSING_CONFIG } from '@/constants';
import { CircuitBreaker } from '@/lib/circuit-breaker';

interface CacheEntry {
  value: string;
  timestamp: number;
  compressed?: boolean;
}

interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
  redisHits: number;
  redisMisses: number;
  localHits: number;
  firecrawlFetches: number;
  avgRedisLatency: number;
  slowRedisOps: number;
}

interface CrawlJobMetadata {
  id: string;
  url: string;
  limit?: number;
  maxDepth?: number;
  status: string;
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  totalPages: number;
  completedPages: number;
  failedPages?: number;
  creditsUsed: number;
  expiresAt?: string;
  next?: string;
  lastPageNumber?: number;
}

interface CrawlResult {
  metadata?: {
    sourceURL?: string;
    [key: string]: unknown;
  };
  markdown?: string;
  [key: string]: unknown;
}

export class RedisCache {
  private redis: Redis | null = null;
  private localCache: Map<string, CacheEntry> = new Map();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    errors: 0,
    redisHits: 0,
    redisMisses: 0,
    localHits: 0,
    firecrawlFetches: 0,
    avgRedisLatency: 0,
    slowRedisOps: 0,
  };
  private redisLatencies: number[] = [];
  private readonly ttl: number;
  private readonly compressionThreshold: number;
  private readonly localCacheTTL: number = PROCESSING_CONFIG.LOCAL_CACHE_TTL;
  private readonly SLOW_REDIS_THRESHOLD = 100; // ms
  public firecrawlCircuitBreaker: CircuitBreaker;

  constructor(
    ttl: number = PROCESSING_CONFIG.CACHE_DURATION / 1000, // Convert ms to seconds
    compressionThreshold: number = PROCESSING_CONFIG.COMPRESSION_THRESHOLD
  ) {
    this.ttl = ttl;
    this.compressionThreshold = compressionThreshold;
    this.initializeRedis();

    // Initialize circuit breaker with Redis instance
    this.firecrawlCircuitBreaker = new CircuitBreaker(this.redis, 'firecrawl', {
      failureThreshold: 50, // 10x more lenient - was 5
      successThreshold: 2,
      timeout: 60000, // 1 minute
      halfOpenRequests: 3,
    });
  }

  private initializeRedis() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (url && token) {
      try {
        this.redis = new Redis({ url, token });
        console.info('Redis cache initialized successfully');
      } catch (error) {
        console.error('Failed to initialize Redis:', error);
        this.redis = null;
      }
    } else {
      console.warn('Redis credentials not found, falling back to in-memory cache only');
    }
  }

  /**
   * Generate a cache key from a URL
   * Normalizes the URL first to ensure consistent caching
   */
  private getCacheKey(url: string): string {
    // Normalize URL to improve cache hit rate
    const normalized = normalizeUrl(url);
    // Use 32 characters (128 bits) for better collision resistance
    const hash = crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 32);
    return `page:${hash}:v3`; // Bump version to v3 to invalidate old cache entries
  }

  /**
   * Check if a local cache entry is expired
   */
  private isLocalCacheExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp > this.localCacheTTL;
  }

  /**
   * Compress content if it exceeds threshold
   */
  private compressContent(content: string): { data: string; compressed: boolean } {
    if (content.length > this.compressionThreshold) {
      return {
        data: compress(content),
        compressed: true,
      };
    }
    return {
      data: content,
      compressed: false,
    };
  }

  /**
   * Decompress content if it was compressed
   */
  private decompressContent(data: string, compressed: boolean): string {
    return compressed ? decompress(data) : data;
  }

  /**
   * Track Redis operation latency
   */
  private trackRedisLatency(duration: number): void {
    this.redisLatencies.push(duration);
    if (this.redisLatencies.length > 1000) {
      this.redisLatencies.shift();
    }

    // Update average latency
    const sum = this.redisLatencies.reduce((a, b) => a + b, 0);
    this.stats.avgRedisLatency = Math.round(sum / this.redisLatencies.length);

    if (duration > this.SLOW_REDIS_THRESHOLD) {
      this.stats.slowRedisOps++;
      console.warn(
        `[SLOW REDIS] GET operation took ${duration}ms (threshold: ${this.SLOW_REDIS_THRESHOLD}ms)`
      );
    }
  }

  /**
   * Get a single value from cache
   */
  async get(url: string): Promise<string | null> {
    const key = this.getCacheKey(url);

    // Check L1 cache first
    const localEntry = this.localCache.get(key);
    if (localEntry && !this.isLocalCacheExpired(localEntry)) {
      this.stats.hits++;
      this.stats.localHits++;
      console.log(`[CACHE HIT - L1] ${url} (local memory)`);
      return localEntry.value;
    }

    // Check L2 cache (Redis)
    if (this.redis) {
      try {
        const startTime = Date.now();
        const cached = await this.redis.get<{ data: string; compressed?: boolean }>(key);
        const duration = Date.now() - startTime;
        this.trackRedisLatency(duration);

        if (cached) {
          const value = this.decompressContent(cached.data, cached.compressed || false);

          // Populate L1 cache
          this.localCache.set(key, {
            value,
            timestamp: Date.now(),
            compressed: cached.compressed,
          });

          this.stats.hits++;
          this.stats.redisHits++;
          console.log(`[CACHE HIT - L2] ${url} (Redis, ${duration}ms, ${value.length} chars)`);
          return value;
        } else {
          this.stats.redisMisses++;
          console.log(`[CACHE MISS - L2] ${url} (Redis checked in ${duration}ms)`);
        }
      } catch (error) {
        console.error('Redis get error:', error);
        this.stats.errors++;
      }
    }

    this.stats.misses++;
    console.log(`[CACHE MISS] ${url} (will need Firecrawl)`);
    return null;
  }

  /**
   * Set a single value in cache
   */
  async set(url: string, value: string, customTtl?: number): Promise<void> {
    const key = this.getCacheKey(url);
    const ttl = customTtl || this.ttl;
    const { data, compressed } = this.compressContent(value);

    // Set in L1 cache
    this.localCache.set(key, {
      value,
      timestamp: Date.now(),
      compressed,
    });

    // Set in L2 cache (Redis)
    if (this.redis) {
      try {
        const startTime = Date.now();
        await this.redis.set(key, { data, compressed }, { ex: ttl });
        const duration = Date.now() - startTime;
        this.trackRedisLatency(duration);
        console.log(
          `[CACHE SET] ${url} (${value.length} chars, compressed: ${compressed}, Redis: ${duration}ms)`
        );
      } catch (error) {
        console.error('Redis set error:', error);
        this.stats.errors++;
      }
    }
  }

  /**
   * Get multiple values from cache
   */
  async mget(urls: string[]): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();
    const missingUrls: string[] = [];
    const keyToUrl = new Map<string, string>();

    // Check L1 cache first
    for (const url of urls) {
      const key = this.getCacheKey(url);
      const localEntry = this.localCache.get(key);

      if (localEntry && !this.isLocalCacheExpired(localEntry)) {
        results.set(url, localEntry.value);
        this.stats.hits++;
      } else {
        missingUrls.push(url);
        keyToUrl.set(key, url);
      }
    }

    // Check L2 cache for missing URLs
    if (this.redis && missingUrls.length > 0) {
      try {
        const keys = missingUrls.map((url) => this.getCacheKey(url));
        const startTime = Date.now();
        const values = await this.redis.mget<{ data: string; compressed?: boolean }[]>(...keys);
        const duration = Date.now() - startTime;
        this.trackRedisLatency(duration);

        console.log(`[REDIS MGET] Checked ${keys.length} keys in ${duration}ms`);

        values.forEach((cached, index) => {
          const key = keys[index];
          const url = keyToUrl.get(key)!;

          if (cached) {
            const value = this.decompressContent(cached.data, cached.compressed || false);
            results.set(url, value);

            // Populate L1 cache
            this.localCache.set(key, {
              value,
              timestamp: Date.now(),
              compressed: cached.compressed,
            });

            this.stats.hits++;
            this.stats.redisHits++;
          } else {
            results.set(url, null);
            this.stats.misses++;
            this.stats.redisMisses++;
          }
        });
      } catch (error) {
        console.error('Redis mget error:', error);
        this.stats.errors++;

        // Set all missing URLs to null
        missingUrls.forEach((url) => {
          results.set(url, null);
          this.stats.misses++;
        });
      }
    } else {
      // No Redis or no missing URLs
      missingUrls.forEach((url) => {
        results.set(url, null);
        this.stats.misses++;
      });
    }

    return results;
  }

  /**
   * Set multiple values in cache
   */
  async mset(entries: Map<string, string>, customTtl?: number): Promise<void> {
    const ttl = customTtl || this.ttl;
    const pipeline = this.redis?.pipeline();

    entries.forEach((value, url) => {
      const key = this.getCacheKey(url);
      const { data, compressed } = this.compressContent(value);

      // Set in L1 cache
      this.localCache.set(key, {
        value,
        timestamp: Date.now(),
        compressed,
      });

      // Add to pipeline for L2 cache
      if (pipeline) {
        pipeline.set(key, { data, compressed }, { ex: ttl });
      }
    });

    // Execute pipeline
    if (pipeline) {
      try {
        await pipeline.exec();
      } catch (error) {
        console.error('Redis mset error:', error);
        this.stats.errors++;
      }
    }
  }

  /**
   * Delete a value from cache
   */
  async delete(url: string): Promise<void> {
    const key = this.getCacheKey(url);

    // Delete from L1 cache
    this.localCache.delete(key);

    // Delete from L2 cache
    if (this.redis) {
      try {
        await this.redis.del(key);
      } catch (error) {
        console.error('Redis delete error:', error);
        this.stats.errors++;
      }
    }
  }

  /**
   * Clear all local cache
   */
  clearLocalCache(): void {
    this.localCache.clear();
  }

  /**
   * Increment Firecrawl fetch counter
   */
  incrementFirecrawlFetches(): void {
    this.stats.firecrawlFetches++;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats & {
    hitRate: number;
    localCacheSize: number;
    redisHitRate: number;
    summary: string;
  } {
    const total = this.stats.hits + this.stats.misses;
    const redisTotal = this.stats.redisHits + this.stats.redisMisses;

    const stats = {
      ...this.stats,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      redisHitRate: redisTotal > 0 ? this.stats.redisHits / redisTotal : 0,
      localCacheSize: this.localCache.size,
      summary: '',
    };

    stats.summary =
      `Cache Performance Summary:
` +
      `- Total Requests: ${total}
` +
      `- Overall Hit Rate: ${(stats.hitRate * 100).toFixed(1)}%
` +
      `- L1 Cache (Local) Hits: ${this.stats.localHits}
` +
      `- L2 Cache (Redis) Hits: ${this.stats.redisHits}
` +
      `- Cache Misses: ${this.stats.misses}
` +
      `- Firecrawl Fetches: ${this.stats.firecrawlFetches}
` +
      `- Avg Redis Latency: ${this.stats.avgRedisLatency}ms
` +
      `- Slow Redis Ops (>${this.SLOW_REDIS_THRESHOLD}ms): ${this.stats.slowRedisOps}`;

    return stats;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      errors: 0,
      redisHits: 0,
      redisMisses: 0,
      localHits: 0,
      firecrawlFetches: 0,
      avgRedisLatency: 0,
      slowRedisOps: 0,
    };
    this.redisLatencies = [];
  }

  /**
   * Check if Redis is available
   */
  isRedisAvailable(): boolean {
    return this.redis !== null;
  }

  /**
   * Acquire a distributed lock for a URL
   * Returns lock ID if successful, null if lock already held
   */
  async acquireLock(url: string, ttl: number = 60000): Promise<string | null> {
    if (!this.redis) return crypto.randomUUID(); // Fallback to allow operation without Redis

    const lockKey = `lock:${this.getCacheKey(url)}`;
    const lockId = crypto.randomUUID();

    try {
      const startTime = Date.now();
      // SET with NX (only if not exists) and EX (expiry)
      const result = await this.redis.set(lockKey, lockId, {
        nx: true,
        ex: Math.ceil(ttl / 1000),
      });
      const duration = Date.now() - startTime;
      this.trackRedisLatency(duration);

      if (result === 'OK') {
        console.log(`[LOCK ACQUIRED] ${url} (${duration}ms)`);
        return lockId;
      } else {
        console.log(`[LOCK FAILED] ${url} - already locked (${duration}ms)`);
        return null;
      }
    } catch (error) {
      console.error('Failed to acquire lock:', error);
      return crypto.randomUUID(); // Fallback to allow operation
    }
  }

  /**
   * Release a distributed lock
   */
  async releaseLock(url: string, lockId: string): Promise<boolean> {
    if (!this.redis) return true; // No-op without Redis

    const lockKey = `lock:${this.getCacheKey(url)}`;

    try {
      // Only delete if we own the lock (compare lockId)
      const currentLockId = await this.redis.get<string>(lockKey);
      if (currentLockId === lockId) {
        await this.redis.del(lockKey);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to release lock:', error);
      return false;
    }
  }

  /**
   * Check if a URL is currently being processed
   */
  async isLocked(url: string): Promise<boolean> {
    if (!this.redis) return false;

    const lockKey = `lock:${this.getCacheKey(url)}`;

    try {
      const exists = await this.redis.exists(lockKey);
      return exists === 1;
    } catch (error) {
      console.error('Failed to check lock:', error);
      return false;
    }
  }

  /**
   * Wait for a lock to be released (with timeout)
   */
  async waitForLock(url: string, timeout: number = 30000): Promise<boolean> {
    if (!this.redis) return true;

    const startTime = Date.now();
    const checkInterval = 500; // Check every 500ms

    while (Date.now() - startTime < timeout) {
      const isLocked = await this.isLocked(url);
      if (!isLocked) return true;

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    return false; // Timeout reached
  }

  /**
   * Store crawl job metadata
   */
  async setCrawlJob(jobId: string, data: CrawlJobMetadata, ttl: number = 86400): Promise<void> {
    const key = `crawl:job:${jobId}`;

    if (this.redis) {
      try {
        await this.redis.set(key, data, { ex: ttl });
      } catch (error) {
        console.error('Failed to store crawl job:', error);
      }
    }
  }

  /**
   * Get crawl job metadata
   */
  async getCrawlJob(jobId: string): Promise<CrawlJobMetadata | null> {
    const key = `crawl:job:${jobId}`;

    if (this.redis) {
      try {
        return await this.redis.get(key);
      } catch (error) {
        console.error('Failed to get crawl job:', error);
        return null;
      }
    }
    return null;
  }

  /**
   * Update crawl job status
   */
  async updateCrawlJobStatus(jobId: string, status: Partial<CrawlJobMetadata>): Promise<void> {
    const key = `crawl:job:${jobId}`;

    if (this.redis) {
      try {
        const existing = await this.redis.get(key);
        if (existing) {
          await this.redis.set(key, { ...existing, ...status }, { ex: 86400 });
        }
      } catch (error) {
        console.error('Failed to update crawl job status:', error);
      }
    }
  }

  /**
   * Store crawl job results with pagination support
   */
  async setCrawlResults(
    jobId: string,
    pageNumber: number,
    results: CrawlResult[],
    ttl: number = 86400
  ): Promise<void> {
    const key = `crawl:results:${jobId}:page:${pageNumber}`;

    if (this.redis) {
      try {
        await this.redis.set(key, results, { ex: ttl });
      } catch (error) {
        console.error('Failed to store crawl results:', error);
      }
    }
  }

  /**
   * Get crawl job results for a specific page
   */
  async getCrawlResults(jobId: string, pageNumber: number): Promise<CrawlResult[] | null> {
    const key = `crawl:results:${jobId}:page:${pageNumber}`;

    if (this.redis) {
      try {
        return await this.redis.get(key);
      } catch (error) {
        console.error('Failed to get crawl results:', error);
        return null;
      }
    }
    return null;
  }

  /**
   * Get all crawl result pages for a job
   */
  async getAllCrawlResults(jobId: string): Promise<CrawlResult[]> {
    if (!this.redis) return [];

    const results: CrawlResult[] = [];

    try {
      // Note: Upstash Redis doesn't support SCAN, so we need to track page numbers separately
      const job = await this.getCrawlJob(jobId);
      if (job && job.totalPages) {
        for (let i = 0; i < job.totalPages; i++) {
          const pageResults = await this.getCrawlResults(jobId, i);
          if (pageResults) {
            results.push(...pageResults);
          }
        }
      }
    } catch (error) {
      console.error('Failed to get all crawl results:', error);
    }

    return results;
  }
}

// Export a singleton instance
export const cacheService = new RedisCache();
