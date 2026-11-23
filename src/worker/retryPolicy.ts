import { config } from '../config/index.js';

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  nextAttempt: number;
  moveToDlq: boolean;
}

export class RetryPolicy {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number }) {
    this.maxRetries = options?.maxRetries ?? config.worker.maxRetries;
    this.baseDelayMs = options?.baseDelayMs ?? config.worker.baseRetryDelayMs;
    this.maxDelayMs = options?.maxDelayMs ?? config.worker.maxRetryDelayMs;
  }

  calculateRetry(currentAttempt: number, isTemporaryError: boolean): RetryDecision {
    // If error is permanent (e.g. 550 User unknown), never retry
    if (!isTemporaryError) {
      return {
        shouldRetry: false,
        delayMs: 0,
        nextAttempt: currentAttempt + 1,
        moveToDlq: true,
      };
    }

    const nextAttempt = currentAttempt + 1;

    // Check if retry budget exhausted
    if (nextAttempt > this.maxRetries) {
      return {
        shouldRetry: false,
        delayMs: 0,
        nextAttempt,
        moveToDlq: true,
      };
    }

    // Exponential backoff with full jitter formula:
    // delay = min(maxDelay, baseDelay * 2^attempt) + random_jitter
    const exponentialMultiplier = Math.pow(2, currentAttempt);
    const calculatedDelay = Math.min(this.maxDelayMs, this.baseDelayMs * exponentialMultiplier);
    const jitter = Math.floor(Math.random() * (this.baseDelayMs * 0.5));
    const finalDelayMs = calculatedDelay + jitter;

  return {
      shouldRetry: true,
      delayMs: finalDelayMs,
      nextAttempt,
      moveToDlq: false,
    };
  }
}
