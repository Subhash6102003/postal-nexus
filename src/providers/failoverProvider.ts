import { IEmailProvider, EmailDispatchOptions, ProviderSendResult } from './types.js';
import { CircuitBreaker, CircuitBreakerOpenError } from './circuitBreaker.js';
import { logger } from '../observability/logger.js';

export class FailoverProvider implements IEmailProvider {
  public readonly id = 'failover-composite';
  public readonly name = 'Circuit-Breaker Failover Composite';

  private primaryBreaker: CircuitBreaker;

  constructor(
    private primary: IEmailProvider,
    private secondary: IEmailProvider,
    circuitBreakerOptions = {}
  ) {
    this.primaryBreaker = new CircuitBreaker(this.primary.id, circuitBreakerOptions);
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.primaryBreaker;
  }

  async send(options: EmailDispatchOptions): Promise<ProviderSendResult> {
    try {
      // Attempt Primary Provider through Circuit Breaker
      return await this.primaryBreaker.execute(async () => {
        const result = await this.primary.send(options);
        if (!result.success && result.isTemporaryError) {
          // Throw so circuit breaker records failure
          throw new Error(result.error || 'Primary provider transient failure');
        }
        return result;
      });
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError || (err as Error).message) {
        logger.warn(
          {
            err: (err as Error).message,
            primary: this.primary.id,
            secondary: this.secondary.id,
            requestId: options.requestId,
          },
          'Primary provider failed or circuit open. Failing over to secondary provider'
        );

        // Failover directly to secondary provider
        const fallbackResult = await this.secondary.send(options);
        return {
          ...fallbackResult,
          rawResponse: `[FAILED OVER FROM ${this.primary.id}] ${fallbackResult.rawResponse || ''}`,
        };
      }
      throw err;
    }
  }

  async verify(): Promise<boolean> {
    const primaryOk = await this.primary.verify();
    if (primaryOk) return true;
    return this.secondary.verify();
  }

  async close(): Promise<void> {
    if (this.primary.close) await this.primary.close();
    if (this.secondary.close) await this.secondary.close();
  }
}
