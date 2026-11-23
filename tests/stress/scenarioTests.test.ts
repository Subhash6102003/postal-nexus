import { describe, it, expect } from 'vitest';
import { DistributedRateLimiter, getRateLimitRedis, setRateLimitRedis } from '../../src/api/middlewares/rateLimiter.middleware.js';
import { EmailWorker } from '../../src/worker/worker.js';
import { MemoryRepository } from '../../src/db/repository.js';
import { MemoryQueue } from '../../src/queue/memoryQueue.js';
import { MockProvider } from '../../src/providers/mockProvider.js';
import { FailoverProvider } from '../../src/providers/failoverProvider.js';
import { CircuitState } from '../../src/providers/circuitBreaker.js';

describe('Resilience and Chaos Scenario Tests', () => {
  /**
   * Scenario 5: One user attempting 100 requests in one minute
   * Requirement: First 5 succeed, next 95 blocked with 429; user B is unaffected.
   */
  it('Scenario 5: User attempting 100 requests in 1 minute - strict rate limit isolation', async () => {
    const userA = 'stress_user_spammer';
    const userB = 'stress_user_innocent';
    const limit = 5;
    const windowMs = 60000;

    let userASuccess = 0;
    let userABlocked = 0;

    // User A fires 100 rapid requests
    for (let i = 0; i < 100; i++) {
      const res = await DistributedRateLimiter.evaluate(userA, limit, windowMs);
      if (res.allowed) {
        userASuccess++;
      } else {
        userABlocked++;
      }
    }

    expect(userASuccess).toBe(5);
    expect(userABlocked).toBe(95);

    // Verify User B is completely unaffected
    let userBSuccess = 0;
    for (let i = 0; i < 5; i++) {
      const res = await DistributedRateLimiter.evaluate(userB, limit, windowMs);
      if (res.allowed) userBSuccess++;
    }
    expect(userBSuccess).toBe(5);
  });

  /**
   * Scenario 6: Redis temporarily becoming unavailable
   * Requirement: Fallback sliding window activates, avoiding total system failure.
   */
  it('Scenario 6: Redis temporarily unavailable - graceful in-memory fallback', async () => {
    const activeRedis = getRateLimitRedis();

    // Disconnect / simulate broken Redis client
    const brokenRedis: any = {
      status: 'end',
      eval: async () => {
        throw new Error('Connection to Redis lost');
      },
    };
    setRateLimitRedis(brokenRedis);
    DistributedRateLimiter.resetFallback();

    const fallbackUser = 'fallback_user_123';
    // Should still enforce rate limit via memory fallback
    for (let i = 0; i < 5; i++) {
      const res = await DistributedRateLimiter.evaluate(fallbackUser, 5, 60000);
      expect(res.allowed).toBe(true);
    }

    const blocked = await DistributedRateLimiter.evaluate(fallbackUser, 5, 60000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);

    // Restore real Redis client
    setRateLimitRedis(activeRedis);
  });

  /**
   * Scenario 7: Worker crashing during processing
   * Requirement: Jobs in pending list / PEL are reclaimed by survivor worker without loss.
   */
  it('Scenario 7: Worker crash during processing - abandoned job recovery', async () => {
    const queue = new MemoryQueue();
    const db = new MemoryRepository();
    const provider = new MockProvider();

    // Enqueue 3 jobs
    await queue.enqueue({
      requestId: 'crash-job-1',
      userId: 'usr-1',
      recipient: 'a@ex.com',
      subject: 'Job 1',
      attempt: 0,
      maxRetries: 3,
      enqueuedAt: Date.now(),
    });
    await queue.enqueue({
      requestId: 'crash-job-2',
      userId: 'usr-1',
      recipient: 'b@ex.com',
      subject: 'Job 2',
      attempt: 0,
      maxRetries: 3,
      enqueuedAt: Date.now(),
    });

    // Worker 1 starts, reads jobs, and "crashes" before completing them
    const worker1 = new EmailWorker(queue, db, provider, { workerId: 'worker-dead-1', concurrency: 2 });
    const batch = await queue.readBatch('test-group', 'worker-dead-1', 2, 100);
    expect(batch.length).toBe(2);
    // Worker 1 dies abruptly: no ACK, no stop()

    // Worker 2 starts as survivor and runs abandoned-claim reaper
    const worker2 = new EmailWorker(queue, db, provider, { workerId: 'worker-survivor-2', concurrency: 5 });
    const claimed = await queue.claimAbandoned('test-group', 'worker-survivor-2', 0, 10);
    expect(claimed.length).toBe(2);

    // Worker 2 processes the reclaimed jobs
    for (const msg of claimed) {
      await worker2.processJob(msg);
      await queue.ack(msg.streamName, 'test-group', msg.messageId);
    }

    const remainingPending = await queue.claimAbandoned('test-group', 'worker-survivor-2', 0, 10);
    expect(remainingPending.length).toBe(0);
  });

  /**
   * Scenario 9: SMTP provider downtime & Circuit Breaker Failover
   * Requirement: Trips circuit breaker, fails over to secondary provider.
   */
  it('Scenario 9: SMTP provider downtime - circuit breaker trips and fails over cleanly', async () => {
    // Primary provider always fails
    const failingPrimary = new MockProvider({ failureRate: 1.0 });
    // Secondary backup provider succeeds
    const backupSecondary = new MockProvider({ failureRate: 0 });

    const failover = new FailoverProvider(failingPrimary, backupSecondary, {
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });

    // 1st email: Primary fails -> secondary handles it
    const res1 = await failover.send({
      requestId: 'req-failover-1',
      recipient: 'user@example.com',
      subject: 'Failover 1',
    });
    expect(res1.success).toBe(true);
    expect(res1.rawResponse).toContain('FAILED OVER FROM mock-provider');

    // 2nd email: Primary fails again -> trips breaker to OPEN
    const res2 = await failover.send({
      requestId: 'req-failover-2',
      recipient: 'user@example.com',
      subject: 'Failover 2',
    });
    expect(res2.success).toBe(true);

    // Breaker is now OPEN: immediate failover without calling failing primary
    expect(failover.getCircuitBreaker().getState()).toBe(CircuitState.OPEN);

    // 3rd email: Dispatched through secondary without waiting on primary
    const res3 = await failover.send({
      requestId: 'req-failover-3',
      recipient: 'user@example.com',
      subject: 'Failover 3',
    });
    expect(res3.success).toBe(true);
  });

  /**
   * Scenario 10: Recovery after infrastructure restart
   * Requirement: Persistent queue retains messages; after worker restart, pending messages are dispatched.
   */
  it('Scenario 10: Recovery after infrastructure restart', async () => {
    const persistentQueue = new MemoryQueue();
    const db = new MemoryRepository();
    const provider = new MockProvider();

    // 10 emails enqueued before system shutdown
    for (let i = 1; i <= 10; i++) {
      const reqId = `persist-job-${i}`;
      await db.createEmailRequest({
        id: reqId,
        user_id: 'restart_user',
        recipient: `user${i}@example.com`,
        subject: `Pre-restart ${i}`,
        status: 'QUEUED',
        attempt_count: 0,
        max_retries: 3,
      });

      await persistentQueue.enqueue({
        requestId: reqId,
        userId: 'restart_user',
        recipient: `user${i}@example.com`,
        subject: `Pre-restart ${i}`,
        attempt: 0,
        maxRetries: 3,
        enqueuedAt: Date.now(),
      });
    }

    expect(await persistentQueue.getQueueDepth()).toBe(10);

    // System restarts: New worker instance boots up and connects
    const rebootedWorker = new EmailWorker(persistentQueue, db, provider, {
      workerId: 'rebooted-worker-1',
      concurrency: 10,
      batchSize: 10,
    });

    const batch = await persistentQueue.readBatch('email-worker-group', 'rebooted-worker-1', 10, 500);
    expect(batch.length).toBe(10);

    for (const msg of batch) {
      await rebootedWorker.processJob(msg);
      await persistentQueue.ack(msg.streamName, 'email-worker-group', msg.messageId);
    }

    // Stop worker to cleanly flush all buffered database status updates
    await rebootedWorker.stop();

    expect(await persistentQueue.getQueueDepth()).toBe(0);

    // Verify all 10 were processed and transitioned to SENT in the database
    for (let i = 1; i <= 10; i++) {
      const req = await db.getEmailRequestById(`persist-job-${i}`);
      expect(req).not.toBeNull();
      expect(req!.status).toBe('SENT');
    }
  });
});
