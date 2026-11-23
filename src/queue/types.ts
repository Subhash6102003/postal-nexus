export interface EmailJobPayload {
  requestId: string;
  userId: string;
  recipient: string;
  subject: string;
  idempotencyKey?: string;
  templateId?: string;
  templateVariables?: Record<string, string | number>;
  attempt: number;
  maxRetries: number;
  enqueuedAt: number;
}

export interface QueuedMessage {
  messageId: string;
  streamName: string;
  payload: EmailJobPayload;
}

export interface IMessageQueue {
  enqueue(payload: EmailJobPayload): Promise<string>;
  readBatch(
    consumerGroup: string,
    consumerName: string,
    batchSize: number,
    blockTimeoutMs: number
  ): Promise<QueuedMessage[]>;
  ack(streamName: string, consumerGroup: string, messageId: string): Promise<void>;
  moveToDlq(
    message: QueuedMessage,
    reason: string,
    errorDetails?: string
  ): Promise<string>;
  claimAbandoned(
    consumerGroup: string,
    consumerName: string,
    minIdleTimeMs: number,
    count: number
  ): Promise<QueuedMessage[]>;
  getQueueDepth(): Promise<number>;
  getDlqDepth(): Promise<number>;
  close(): Promise<void>;
}
