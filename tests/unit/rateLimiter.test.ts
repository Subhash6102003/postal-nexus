import { describe, it, expect, beforeEach } from 'vitest';
import { DistributedRateLimiter, getRateLimitRedis } from '../../src/api/middlewares/rateLimiter.middleware.js';

describe('DistributedRateLimiter (Sliding Window)', () => {
  const redis = getRateLimitRedis();

  beforeEach(async () => {
    // Clean test keys
    const keys = await redis.keys('*test_user*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  it('should allow up to 5 requests within a 60-second window', async () => {
    const userId = 'test_user_alpha';
    const limit = 5;
    const windowMs = 60000;

    for (let i = 1; i <= limit; i++) {
      const res = await DistributedRateLimiter.evaluate(userId, limit, windowMs);
      expect(res.allowed).toBe(true);
      expect(res.limit).toBe(5);
      expect(res.remaining).toBe(limit - i);
    }

    // 6th request must be rejected
    const blockedRes = await DistributedRateLimiter.evaluate(userId, limit, windowMs);
    expect(blockedRes.allowed).toBe(false);
    expect(blockedRes.remaining).toBe(0);
    expect(blockedRes.retryAfterSec).toBeGreaterThan(0);
  });

  it('should guarantee user isolation: User A rate limit does not affect User B', async () => {
    const userA = 'test_user_isolation_A';
    const userB = 'test_user_isolation_B';
    const limit = 5;
    const windowMs = 60000;

    // User A exhausts quota (5 requests) + 1 blocked
    for (let i = 0; i < 5; i++) {
      const res = await DistributedRateLimiter.evaluate(userA, limit, windowMs);
      expect(res.allowed).toBe(true);
    }
    const blockedA = await DistributedRateLimiter.evaluate(userA, limit, windowMs);
    expect(blockedA.allowed).toBe(false);

    // User B should still have full quota (5 remaining)
    for (let i = 1; i <= 5; i++) {
      const resB = await DistributedRateLimiter.evaluate(userB, limit, windowMs);
      expect(resB.allowed).toBe(true);
      expect(resB.remaining).toBe(5 - i);
    }
  });

  it('should support configurable admin limits', async () => {
    const adminId = 'test_user_admin_01';
    const adminLimit = 50;

    for (let i = 1; i <= 20; i++) {
      const res = await DistributedRateLimiter.evaluate(adminId, adminLimit, 60000);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(adminLimit - i);
    }
  });
});
