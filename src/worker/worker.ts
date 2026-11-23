import { v4 as uuidv4 } from 'uuid';
import { IMessageQueue, QueuedMessage } from '../queue/types.js';
import { IDbRepository } from '../db/repository.js';
import { IEmailProvider } from '../providers/types.js';
import { RetryPolicy } from './retryPolicy.js';
import { TemplateEngine } from './templateEngine.js';
import { logger } from '../observability/logger.js';
import {
  emailsProcessedCounter,
  emailRetriesCounter,
  workerActiveJobsGauge,
  queueWaitDuration,
} from '../observability/metrics.js';
import { config } from '../config/index.js';

export interface WorkerOptions {
  workerId?: string;
  concurrency?: number;
  batchSize?: number;
  blockTimeoutMs?: number;
  reaperIntervalMs?: number;
  pendingIdleTimeMs?: number;
}

export class EmailWorker {
  public readonly workerId: string;
  private isRunning = false;
  private activeJobsCount = 0;
  private concurrency: number;
  private batchSize: number;
  private blockTimeoutMs: number;
  private reaperIntervalMs: number;
  private pendingIdleTimeMs: number;
  private retryPolicy: RetryPolicy;

  private loopPromise: Promise<void> | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  // Batch Database Write Buffer
  private statusBuffer: Array<{
    id: string;
    status: 'SENT' | 'FAILED' | 'PROCESSING';
    attemptCount?: number;
    providerId?: string;
    lastError?: string;
    sentAt?: Date;
  }> = [];

  constructor(
    private queue: IMessageQueue,
    private db: IDbRepository,
    private provider: IEmailProvider,
    options: WorkerOptions = {}
  ) {
    this.workerId = options.workerId || `worker-${process.pid}-${uuidv4().substring(0, 6)}`;
    this.concurrency = options.concurrency || config.worker.concurrency;
    this.batchSize = options.batchSize || config.worker.batchSize;
    this.blockTimeoutMs = options.blockTimeoutMs || config.worker.blockTimeoutMs;
    this.reaperIntervalMs = options.reaperIntervalMs || config.worker.reaperIntervalMs;
    this.pendingIdleTimeMs = options.pendingIdleTimeMs || config.worker.pendingIdleTimeMs;
    this.retryPolicy = new RetryPolicy();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info(
      {
        workerId: this.workerId,
        concurrency: this.concurrency,
        batchSize: this.batchSize,
        provider: this.provider.name,
      },
      'Email Worker started'
    );

    // Start background abandoned-message reaper
    this.startReaper();

    // Start database batch-buffer flusher
    this.startBatchFlusher();

    // Main processing loop
    this.loopPromise = this.runLoop();
  }

  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        // Respect concurrency ceiling
        if (this.activeJobsCount >= this.concurrency) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }

        const slotsAvailable = this.concurrency - this.activeJobsCount;
        const fetchCount = Math.min(this.batchSize, slotsAvailable);

        const messages = await this.queue.readBatch(
          config.redis.consumerGroup,
          this.workerId,
          fetchCount,
          this.blockTimeoutMs
        );

        if (messages.length === 0) {
          continue;
        }

        // Process fetched messages concurrently within concurrency limit
        for (const msg of messages) {
          this.activeJobsCount++;
          workerActiveJobsGauge.set({ worker_id: this.workerId }, this.activeJobsCount);

          this.processJob(msg).finally(() => {
            this.activeJobsCount--;
            workerActiveJobsGauge.set({ worker_id: this.workerId }, this.activeJobsCount);
          });
        }
      } catch (err) {
        if (!this.isRunning) break;
        logger.error({ err, workerId: this.workerId }, 'Error in worker processing loop');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  public async processJob(msg: QueuedMessage): Promise<void> {
    const { payload } = msg;
    const { requestId, attempt, enqueuedAt } = payload;

    // Record queue wait duration
    const queueWaitSeconds = (Date.now() - enqueuedAt) / 1000;
    queueWaitDuration.observe(queueWaitSeconds);

    try {
      // 1. Idempotency Check: Verify current state in database
      const existingRecord = await this.db.getEmailRequestById(requestId);
      if (existingRecord) {
        if (existingRecord.status === 'SENT' || existingRecord.status === 'DELIVERED') {
          logger.info(
            { requestId, status: existingRecord.status },
            'Email already sent/delivered, skipping duplicate dispatch'
          );
          await this.queue.ack(msg.streamName, config.redis.consumerGroup, msg.messageId);
          return;
        }
      }

      // 2. Mark Processing
      this.bufferStatusUpdate({
        id: requestId,
        status: 'PROCESSING',
        attemptCount: attempt,
      });

      // 3. Render Template if templateId specified
      let bodyHtml = existingRecord?.body_html;
      let bodyText = existingRecord?.body_text;
      let subject = payload.subject;

      if (payload.templateId) {
        const rendered = TemplateEngine.render(payload.templateId, payload.templateVariables);
        if (rendered) {
          bodyHtml = rendered.html;
          bodyText = rendered.text;
          subject = rendered.subject;
        }
      }

      // 4. Dispatch Email via Provider
      const sendResult = await this.provider.send({
        requestId,
        recipient: payload.recipient,
        subject,
        bodyText,
        bodyHtml,
      });

      // 5. Handle Provider Response
      if (sendResult.success) {
        // Success: Transition to SENT (Delivered requires provider webhook)
        const sentAt = new Date();
        this.bufferStatusUpdate({
          id: requestId,
          status: 'SENT',
          attemptCount: attempt + 1,
          providerId: sendResult.providerId,
          sentAt,
        });

        await this.db.addDeliveryLog({
          request_id: requestId,
          status: 'SENT',
          attempt: attempt + 1,
          provider_id: sendResult.providerId,
          provider_response: sendResult.rawResponse || 'Success',
          duration_ms: sendResult.durationMs,
        });

        emailsProcessedCounter.inc({ status: 'SENT', provider: sendResult.providerId });
        await this.queue.ack(msg.streamName, config.redis.consumerGroup, msg.messageId);

        logger.info(
          {
            requestId,
            recipient: payload.recipient,
            provider: sendResult.providerId,
            messageId: sendResult.providerMessageId,
            durationMs: sendResult.durationMs,
          },
          'Email dispatched successfully'
        );
      } else {
        // Provider Failure: Evaluate Retry Policy
        const retryDecision = this.retryPolicy.calculateRetry(
          attempt,
          sendResult.isTemporaryError ?? true
        );

        await this.db.addDeliveryLog({
          request_id: requestId,
          status: 'FAILED',
          attempt: attempt + 1,
          provider_id: sendResult.providerId,
          error_message: sendResult.error || 'Provider delivery failure',
          duration_ms: sendResult.durationMs,
        });

        if (retryDecision.shouldRetry) {
          emailRetriesCounter.inc({ attempt: (attempt + 1).toString() });
          logger.warn(
            {
              requestId,
              attempt: attempt + 1,
              delayMs: retryDecision.delayMs,
              err: sendResult.error,
            },
            'Transient failure: scheduling retry'
          );

          // Acknowledge original message and re-enqueue with incremented attempt
          await this.queue.ack(msg.streamName, config.redis.consumerGroup, msg.messageId);

          // Delay simulation for retry before re-enqueueing
          setTimeout(async () => {
            try {
              await this.queue.enqueue({
                ...payload,
                attempt: retryDecision.nextAttempt,
                enqueuedAt: Date.now(),
              });
            } catch (requeueErr) {
              logger.error({ requeueErr, requestId }, 'Failed to re-enqueue retry job');
            }
          }, Math.min(retryDecision.delayMs, 5000));
        } else {
          // Permanent failure or max retries exceeded -> Route to Dead Letter Queue (DLQ)
          logger.error(
            {
              requestId,
              attempt: attempt + 1,
              err: sendResult.error,
              isTemporary: sendResult.isTemporaryError,
            },
            'Permanent delivery failure: moving to DLQ'
          );

          this.bufferStatusUpdate({
            id: requestId,
            status: 'FAILED',
            attemptCount: attempt + 1,
            lastError: sendResult.error,
          });

          emailsProcessedCounter.inc({ status: 'FAILED', provider: sendResult.providerId });
          await this.queue.moveToDlq(
            msg,
            sendResult.isTemporaryError ? 'MAX_RETRIES_EXCEEDED' : 'PERMANENT_ERROR',
            sendResult.error
          );
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message, requestId }, 'Unhandled exception during job processing');
      // On unhandled exception, do not lose the message; it stays in PEL or retries
    }
  }

  private bufferStatusUpdate(update: {
    id: string;
    status: 'SENT' | 'FAILED' | 'PROCESSING';
    attemptCount?: number;
    providerId?: string;
    lastError?: string;
    sentAt?: Date;
  }): void {
    this.statusBuffer.push(update);
    if (this.statusBuffer.length >= config.database.batchFlushSize) {
      this.flushStatusBuffer();
    }
  }

  private async flushStatusBuffer(): Promise<void> {
    if (this.statusBuffer.length === 0) return;
    const batch = this.statusBuffer.splice(0, this.statusBuffer.length);
    try {
      await this.db.batchUpdateEmailStatus(batch);
    } catch (err) {
      logger.error({ err, batchSize: batch.length }, 'Failed to flush database status batch');
    }
  }

  private startBatchFlusher(): void {
    this.flushTimer = setInterval(() => {
      this.flushStatusBuffer();
    }, config.database.batchFlushIntervalMs);
  }

  private startReaper(): void {
    this.reaperTimer = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        const abandoned = await this.queue.claimAbandoned(
          config.redis.consumerGroup,
          this.workerId,
          this.pendingIdleTimeMs,
          this.batchSize
        );

        if (abandoned.length > 0) {
          logger.info(
            { workerId: this.workerId, count: abandoned.length },
            'Claimed abandoned jobs from dead workers'
          );
          for (const msg of abandoned) {
            this.processJob(msg);
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Error checking abandoned jobs in reaper');
      }
    }, this.reaperIntervalMs);
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.reaperTimer) clearInterval(this.reaperTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);

    // Wait for in-flight jobs to drain
    const drainStart = Date.now();
    while (this.activeJobsCount > 0 && Date.now() - drainStart < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Flush any remaining buffered database updates
    await this.flushStatusBuffer();

    if (this.loopPromise) {
      await this.loopPromise;
    }

    logger.info({ workerId: this.workerId }, 'Email Worker stopped cleanly');
  }
}
