import { v4 as uuidv4 } from 'uuid';
import { IEmailProvider, EmailDispatchOptions, ProviderSendResult } from './types.js';
import { emailDeliveryDuration } from '../observability/metrics.js';

export class MockProvider implements IEmailProvider {
  public readonly id = 'mock-provider';
  public readonly name = 'Mock High-Throughput Provider';

  private failureRate = 0; // 0 to 1
  private simulatedLatencyMs = 0;
  private shouldFailPermanently = false;

  constructor(options?: {
    failureRate?: number;
    simulatedLatencyMs?: number;
    shouldFailPermanently?: boolean;
  }) {
    if (options?.failureRate !== undefined) this.failureRate = options.failureRate;
    if (options?.simulatedLatencyMs !== undefined) this.simulatedLatencyMs = options.simulatedLatencyMs;
    if (options?.shouldFailPermanently !== undefined) this.shouldFailPermanently = options.shouldFailPermanently;
  }

  setFailureRate(rate: number, permanently = false): void {
    this.failureRate = rate;
    this.shouldFailPermanently = permanently;
  }

  setLatency(ms: number): void {
    this.simulatedLatencyMs = ms;
  }

  async send(options: EmailDispatchOptions): Promise<ProviderSendResult> {
    const start = Date.now();
    const timer = emailDeliveryDuration.startTimer({ provider: this.id });

    if (this.simulatedLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulatedLatencyMs));
    }

    const durationMs = Date.now() - start;

    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      timer({ status: 'failure' });
      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        durationMs,
        error: this.shouldFailPermanently
          ? '550 5.1.1 User unknown (Permanent failure)'
          : '421 4.4.2 Temporary connection timeout',
        isTemporaryError: !this.shouldFailPermanently,
      };
    }

    timer({ status: 'success' });
    const messageId = `<mock-${uuidv4()}@mailer.internal>`;

    return {
      success: true,
      providerId: this.id,
      providerMessageId: messageId,
      status: 'SENT',
      durationMs,
      rawResponse: '250 2.0.0 OK: message queued for delivery',
    };
  }

  async verify(): Promise<boolean> {
    return true;
  }
}
