import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config/index.js';
import { logger } from '../../observability/logger.js';
import { rateLimitExceededCounter, redisLatencyHistogram } from '../../observability/metrics.js';

// Dedicated Redis client for rate limiting
let rateLimitRedis: Redis | null = null;

export function getRateLimitRedis(): Redis {
  if (!rateLimitRedis) {
    rateLimitRedis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      keyPrefix: `${config.redis.keyPrefix}ratelimit:`,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 100, 2000),
    });

    rateLimitRedis.on('error', (err) => {
      logger.warn({ err: err.message }, 'Rate limiter Redis connection error - fallback will activate');
    });
  }
  return rateLimitRedis;
}

export function setRateLimitRedis(client: Redis | null): void {
  rateLimitRedis = client;
}

/**
 * Lua Script for Atomic Sliding-Window Rate Limiting
 * KEYS[1]: rate:user:<userId>
 * ARGV[1]: now (ms)
 * ARGV[2]: window_ms (e.g. 60000)
 * ARGV[3]: limit (e.g. 5)
 * ARGV[4]: unique_id
 * Returns: [allowed (1 or 0), remaining, retry_after_seconds, limit]
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

local clear_before = now - window
redis.call('ZREMRANGEBYSCORE', key, '-inf', clear_before)

local current_count = redis.call('ZCARD', key)

if current_count < limit then
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, window)
    local remaining = limit - current_count - 1
    return { 1, remaining, 0, limit }
else
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retry_after_sec = 1
    if #oldest > 0 then
        local oldest_time = tonumber(oldest[2])
        local retry_after_ms = (oldest_time + window) - now
        retry_after_sec = math.ceil(math.max(1, retry_after_ms / 1000))
    end
    return { 0, 0, retry_after_sec, limit }
end
`;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
}

/**
 * In-memory fallback if Redis is temporarily unreachable
 */
class MemoryRateLimiterFallback {
  private static userWindows: Map<string, number[]> = new Map();

  static check(userId: string, limit: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    const clearBefore = now - windowMs;
    const timestamps = (this.userWindows.get(userId) || []).filter((t) => t > clearBefore);

    if (timestamps.length < limit) {
      timestamps.push(now);
      this.userWindows.set(userId, timestamps);
      return {
        allowed: true,
        limit,
        remaining: limit - timestamps.length,
        retryAfterSec: 0,
      };
    } else {
      const oldest = timestamps[0];
      const retryAfterSec = Math.ceil(Math.max(1, (oldest + windowMs - now) / 1000));
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSec,
      };
    }
  }

  static clear(): void {
    this.userWindows.clear();
  }
}

export class DistributedRateLimiter {
  static async evaluate(
    userId: string,
    limit = config.rateLimit.defaultLimit,
    windowMs = config.rateLimit.windowMs
  ): Promise<RateLimitResult> {
    const redis = getRateLimitRedis();
    const now = Date.now();
    const member = `${now}-${uuidv4().substring(0, 8)}`;
    const key = `user:${userId}`;

    const endTimer = redisLatencyHistogram.startTimer({ command: 'eval_ratelimit' });
    try {
      if (redis.status !== 'ready' && redis.status !== 'connecting') {
        throw new Error(`Redis not connected (status: ${redis.status})`);
      }

      const res = (await redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        now.toString(),
        windowMs.toString(),
        limit.toString(),
        member
      )) as [number, number, number, number];

      endTimer();

      const [allowedRaw, remaining, retryAfterSec, enforcedLimit] = res;
      return {
        allowed: allowedRaw === 1,
        limit: enforcedLimit,
        remaining,
        retryAfterSec,
      };
    } catch (err) {
      endTimer();
      logger.warn(
        { err: (err as Error).message, userId },
        'Redis rate limiter failed, falling back to local sliding window'
      );
      return MemoryRateLimiterFallback.check(userId, limit, windowMs);
    }
  }

  static resetFallback(): void {
    MemoryRateLimiterFallback.clear();
  }
}

/**
 * Express Middleware for Per-User Rate Limiting
 */
export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = (req as any).user;
  if (!user || !user.userId) {
    res.status(401).json({ error: 'Unauthorized: Authentication required before rate limiting' });
    return;
  }

  // Determine user limit: Admin limit or user's specific tier/override
  let limit = config.rateLimit.defaultLimit;
  if (user.role === 'admin') {
    limit = user.rateLimitOverride || config.rateLimit.adminLimit;
  } else if (user.rateLimitOverride) {
    limit = user.rateLimitOverride;
  }

  const result = await DistributedRateLimiter.evaluate(user.userId, limit, config.rateLimit.windowMs);

  // Set standardized rate-limit headers
  res.setHeader('X-RateLimit-Limit', result.limit.toString());
  res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
  const resetEpochSeconds = Math.ceil((Date.now() + result.retryAfterSec * 1000) / 1000);
  res.setHeader('X-RateLimit-Reset', resetEpochSeconds.toString());

  if (!result.allowed) {
    res.setHeader('Retry-After', result.retryAfterSec.toString());
    rateLimitExceededCounter.inc({ user_id: user.userId, role: user.role });

    logger.warn(
      { userId: user.userId, role: user.role, limit: result.limit, retryAfter: result.retryAfterSec },
      'Rate limit exceeded'
    );

    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Each user can submit a maximum of ${result.limit} email requests per minute.`,
      limit: result.limit,
      remaining: 0,
      retryAfterSeconds: result.retryAfterSec,
    });
    return;
  }

  next();
}
