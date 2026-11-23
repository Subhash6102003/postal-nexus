import Redis from 'ioredis';
import { IMessageQueue, EmailJobPayload, QueuedMessage } from './types.js';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { queueDepthGauge, redisLatencyHistogram } from '../observability/metrics.js';

export class BackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackpressureError';
  }
}

export class RedisStreamQueue implements IMessageQueue {
  private redis: Redis;
  private streamName: string;
  private dlqStreamName: string;
  private consumerGroup: string;
  private maxQueueDepth: number;
  private initialized = false;

  constructor(customRedis?: Redis) {
    this.streamName = config.redis.streamName;
    this.dlqStreamName = config.redis.dlqStreamName;
    this.consumerGroup = config.redis.consumerGroup;
    this.maxQueueDepth = config.redis.maxQueueDepth;

    this.redis =
      customRedis ||
      new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        maxRetriesPerRequest: null,
        connectTimeout: 5000,
        retryStrategy: (times) => Math.min(times * 100, 3000),
      });

    this.redis.on('error', (err) => {
      logger.error({ err: err.message }, 'Redis Stream Queue connection error');
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create primary stream consumer group if not existing
      await this.redis.xgroup('CREATE', this.streamName, this.consumerGroup, '$', 'MKSTREAM');
      logger.info({ group: this.consumerGroup, stream: this.streamName }, 'Consumer group created');
    } catch (err: any) {
      if (!err.message.includes('BUSYGROUP')) {
        logger.error({ err }, 'Failed to create Redis stream consumer group');
        throw err;
      }
    }

    try {
      // Create DLQ stream consumer group if not existing
      await this.redis.xgroup('CREATE', this.dlqStreamName, this.consumerGroup, '$', 'MKSTREAM');
    } catch (err: any) {
      if (!err.message.includes('BUSYGROUP')) {
        // DLQ group might already exist
      }
    }

    this.initialized = true;
  }

  async enqueue(payload: EmailJobPayload): Promise<string> {
    await this.init();

    // Check backpressure threshold
    const currentDepth = await this.getQueueDepth();
    if (currentDepth >= this.maxQueueDepth) {
      throw new BackpressureError(
        `Queue backpressure limit exceeded: ${currentDepth}/${this.maxQueueDepth}`
      );
    }

    const timer = redisLatencyHistogram.startTimer({ command: 'xadd' });
    try {
      const messageId = await this.redis.xadd(
        this.streamName,
        '*',
        'requestId',
        payload.requestId,
        'userId',
        payload.userId,
        'recipient',
        payload.recipient,
        'subject',
        payload.subject,
        'idempotencyKey',
        payload.idempotencyKey || '',
        'templateId',
        payload.templateId || '',
        'templateVariables',
        payload.templateVariables ? JSON.stringify(payload.templateVariables) : '',
        'attempt',
        payload.attempt.toString(),
        'maxRetries',
        payload.maxRetries.toString(),
        'enqueuedAt',
        payload.enqueuedAt.toString()
      );

      queueDepthGauge.set({ stream: 'incoming' }, currentDepth + 1);
      return messageId as string;
    } finally {
      timer();
    }
  }

  async readBatch(
    consumerGroup: string,
    consumerName: string,
    batchSize: number,
    blockTimeoutMs: number
  ): Promise<QueuedMessage[]> {
    await this.init();

    const timer = redisLatencyHistogram.startTimer({ command: 'xreadgroup' });
    try {
      // Read new messages with '>'
      const res = (await this.redis.xreadgroup(
        'GROUP',
        consumerGroup,
        consumerName,
        'COUNT',
        batchSize,
        'BLOCK',
        blockTimeoutMs,
        'STREAMS',
        this.streamName,
        '>'
      )) as any;

      if (!res || res.length === 0) {
        return [];
      }

      const streamResults = res[0][1];
      const messages: QueuedMessage[] = [];

      for (const entry of streamResults) {
        const messageId = entry[0];
        const fields = entry[1];
        const parsed = this.parseStreamFields(fields);
        messages.push({
          messageId,
          streamName: this.streamName,
          payload: parsed,
        });
      }

      return messages;
    } finally {
      timer();
    }
  }

  async ack(streamName: string, consumerGroup: string, messageId: string): Promise<void> {
    const timer = redisLatencyHistogram.startTimer({ command: 'xack' });
    try {
      await this.redis.xack(streamName, consumerGroup, messageId);
      // Delete acknowledged message to keep memory footprint bounded
      await this.redis.xdel(streamName, messageId);
    } finally {
      timer();
    }
  }

  async moveToDlq(
    message: QueuedMessage,
    reason: string,
    errorDetails?: string
  ): Promise<string> {
    const timer = redisLatencyHistogram.startTimer({ command: 'xadd_dlq' });
    try {
      const dlqId = await this.redis.xadd(
        this.dlqStreamName,
        '*',
        'originalMessageId',
        message.messageId,
        'requestId',
        message.payload.requestId,
        'userId',
        message.payload.userId,
        'recipient',
        message.payload.recipient,
        'subject',
        message.payload.subject,
        'reason',
        reason,
        'errorDetails',
        errorDetails || '',
        'failedAt',
        Date.now().toString(),
        'attempts',
        message.payload.attempt.toString()
      );

      // Acknowledge and remove from primary stream
      await this.ack(message.streamName, this.consumerGroup, message.messageId);

      const dlqDepth = await this.getDlqDepth();
      queueDepthGauge.set({ stream: 'dlq' }, dlqDepth);

      return dlqId as string;
    } finally {
      timer();
    }
  }

  async claimAbandoned(
    consumerGroup: string,
    consumerName: string,
    minIdleTimeMs: number,
    count: number
  ): Promise<QueuedMessage[]> {
    await this.init();

    try {
      // Use XAUTOCLAIM to reclaim messages pending longer than minIdleTimeMs
      const res = (await (this.redis as any).xautoclaim(
        this.streamName,
        consumerGroup,
        consumerName,
        minIdleTimeMs,
        '0-0',
        'COUNT',
        count
      )) as any;

      if (!res || !res[1] || res[1].length === 0) {
        return [];
      }

      const claimedEntries = res[1];
      const messages: QueuedMessage[] = [];

      for (const entry of claimedEntries) {
        const messageId = entry[0];
        const fields = entry[1];
        if (!fields) continue;
        const parsed = this.parseStreamFields(fields);
        messages.push({
          messageId,
          streamName: this.streamName,
          payload: parsed,
        });
      }

      return messages;
    } catch (err) {
      logger.warn({ err }, 'Error executing xautoclaim for abandoned messages');
      return [];
    }
  }

  async getQueueDepth(): Promise<number> {
    try {
      const len = await this.redis.xlen(this.streamName);
      return len;
    } catch {
      return 0;
    }
  }

  async getDlqDepth(): Promise<number> {
    try {
      const len = await this.redis.xlen(this.dlqStreamName);
      return len;
    } catch {
      return 0;
    }
  }

  private parseStreamFields(fields: string[]): EmailJobPayload {
    const map: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      map[fields[i]] = fields[i + 1];
    }

    return {
      requestId: map.requestId || '',
      userId: map.userId || '',
      recipient: map.recipient || '',
      subject: map.subject || '',
      idempotencyKey: map.idempotencyKey || undefined,
      templateId: map.templateId || undefined,
      templateVariables: map.templateVariables ? JSON.parse(map.templateVariables) : undefined,
      attempt: parseInt(map.attempt || '0', 10),
      maxRetries: parseInt(map.maxRetries || '3', 10),
      enqueuedAt: parseInt(map.enqueuedAt || Date.now().toString(), 10),
    };
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
