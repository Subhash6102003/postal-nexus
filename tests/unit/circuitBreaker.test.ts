import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitState, CircuitBreakerOpenError } from '../../src/providers/circuitBreaker.js';

describe('CircuitBreaker', () => {
  it('should start in CLOSED state', () => {
    const cb = new CircuitBreaker('test-cb');
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('should trip to OPEN after reaching failure threshold', async () => {
    const cb = new CircuitBreaker('test-cb', { failureThreshold: 3, resetTimeoutMs: 1000 });

    const failingAction = async () => {
      throw new Error('Connection refused');
    };

    // 1st failure
    await expect(cb.execute(failingAction)).rejects.toThrow();
    expect(cb.getState()).toBe(CircuitState.CLOSED);

    // 2nd failure
    await expect(cb.execute(failingAction)).rejects.toThrow();
    expect(cb.getState()).toBe(CircuitState.CLOSED);

    // 3rd failure -> Trips to OPEN
    await expect(cb.execute(failingAction)).rejects.toThrow();
    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Immediate fast-fail without calling underlying action
    await expect(cb.execute(async () => 'ok')).rejects.toThrow(CircuitBreakerOpenError);
  });

  it('should enter HALF_OPEN and recover to CLOSED after successes', async () => {
    const cb = new CircuitBreaker('test-recovery', {
      failureThreshold: 2,
      resetTimeoutMs: 50,
      halfOpenSuccesses: 2,
    });

    // Trip the breaker
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

    // 1st success in HALF_OPEN
    const res1 = await cb.execute(async () => 'success1');
    expect(res1).toBe('success1');
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

    // 2nd success in HALF_OPEN -> Transitions back to CLOSED
    const res2 = await cb.execute(async () => 'success2');
    expect(res2).toBe('success2');
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });
});
