import { logger } from '../observability/logger.js';
import { circuitBreakerStateGauge } from '../observability/metrics.js';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class CircuitBreakerOpenError extends Error {
  constructor(providerName: string) {
    super(`Circuit breaker for provider '${providerName}' is OPEN`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number; // Consecutive failures to trip (default: 5)
  resetTimeoutMs?: number;   // Time to remain OPEN before trying HALF_OPEN (default: 15s)
  halfOpenSuccesses?: number; // Successes in HALF_OPEN to return to CLOSED (default: 2)
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private halfOpenSuccessCount = 0;
  private nextAttemptTimestamp = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccesses: number;

  constructor(public readonly name: string, options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeoutMs = options.resetTimeoutMs || 15000;
    this.halfOpenSuccesses = options.halfOpenSuccesses || 2;
    this.updateMetric();
  }

  getState(): CircuitState {
    if (this.state === CircuitState.OPEN && Date.now() >= this.nextAttemptTimestamp) {
      this.state = CircuitState.HALF_OPEN;
      this.halfOpenSuccessCount = 0;
      logger.info({ provider: this.name }, 'Circuit breaker entered HALF_OPEN state');
      this.updateMetric();
    }
    return this.state;
  }

  async execute<T>(action: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      throw new CircuitBreakerOpenError(this.name);
    }

    try {
      const result = await action();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenSuccessCount++;
      if (this.halfOpenSuccessCount >= this.halfOpenSuccesses) {
        this.state = CircuitState.CLOSED;
        this.consecutiveFailures = 0;
        logger.info({ provider: this.name }, 'Circuit breaker recovered: returned to CLOSED');
        this.updateMetric();
      }
    } else {
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(err: unknown): void {
    this.consecutiveFailures++;

    if (this.state === CircuitState.HALF_OPEN) {
      this.trip();
    } else if (this.consecutiveFailures >= this.failureThreshold) {
      this.trip();
    }

    logger.warn(
      {
        provider: this.name,
        state: this.state,
        failures: this.consecutiveFailures,
        threshold: this.failureThreshold,
        err,
      },
      'Circuit breaker recorded failure'
    );
  }

  trip(): void {
    this.state = CircuitState.OPEN;
    this.nextAttemptTimestamp = Date.now() + this.resetTimeoutMs;
    this.updateMetric();
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.halfOpenSuccessCount = 0;
    this.updateMetric();
  }

  private updateMetric(): void {
    const val =
      this.state === CircuitState.CLOSED ? 0 : this.state === CircuitState.HALF_OPEN ? 1 : 2;
    circuitBreakerStateGauge.set({ provider: this.name }, val);
  }
}
