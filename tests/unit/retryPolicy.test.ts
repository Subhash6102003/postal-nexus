import { describe, it, expect } from 'vitest';
import { RetryPolicy } from '../../src/worker/retryPolicy.js';

describe('RetryPolicy', () => {
  const policy = new RetryPolicy({
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  });

  it('should immediately route permanent errors to DLQ without retry', () => {
    const decision = policy.calculateRetry(0, false);
    expect(decision.shouldRetry).toBe(false);
    expect(decision.moveToDlq).toBe(true);
  });

  it('should retry temporary errors with exponential backoff and jitter', () => {
    const decision0 = policy.calculateRetry(0, true);
    expect(decision0.shouldRetry).toBe(true);
    expect(decision0.nextAttempt).toBe(1);
    expect(decision0.delayMs).toBeGreaterThanOrEqual(100);

    const decision1 = policy.calculateRetry(1, true);
    expect(decision1.shouldRetry).toBe(true);
    expect(decision1.nextAttempt).toBe(2);
    expect(decision1.delayMs).toBeGreaterThanOrEqual(200);

    const decision2 = policy.calculateRetry(2, true);
    expect(decision2.shouldRetry).toBe(true);
    expect(decision2.nextAttempt).toBe(3);
    expect(decision2.delayMs).toBeGreaterThanOrEqual(400);
  });

  it('should route to DLQ when max retry budget is exhausted', () => {
    const decision3 = policy.calculateRetry(3, true);
    expect(decision3.shouldRetry).toBe(false);
    expect(decision3.moveToDlq).toBe(true);
  });
});
