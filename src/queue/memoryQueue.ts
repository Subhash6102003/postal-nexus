import { IMessageQueue, EmailJobPayload, QueuedMessage } from './types.js';
import { v4 as uuidv4 } from 'uuid';

export class MemoryQueue implements IMessageQueue {
  private incoming: QueuedMessage[] = [];
  private dlq: QueuedMessage[] = [];
  private pending: Map<string, QueuedMessage> = new Map();

  async enqueue(payload: EmailJobPayload): Promise<string> {
    const messageId = `${Date.now()}-${uuidv4().substring(0, 8)}`;
    const msg: QueuedMessage = {
      messageId,
      streamName: 'memory:incoming',
      payload,
    };
    this.incoming.push(msg);
    return messageId;
  }

  async readBatch(
    _consumerGroup: string,
    _consumerName: string,
    batchSize: number,
    _blockTimeoutMs: number
  ): Promise<QueuedMessage[]> {
    const batch = this.incoming.splice(0, batchSize);
    for (const msg of batch) {
      this.pending.set(msg.messageId, msg);
    }
    return batch;
  }

  async ack(_streamName: string, _consumerGroup: string, messageId: string): Promise<void> {
    this.pending.delete(messageId);
  }

  async moveToDlq(
    message: QueuedMessage,
    _reason: string,
    _errorDetails?: string
  ): Promise<string> {
    this.pending.delete(message.messageId);
    this.dlq.push(message);
    return `dlq-${message.messageId}`;
  }

  async claimAbandoned(
    _consumerGroup: string,
    _consumerName: string,
    _minIdleTimeMs: number,
    count: number
  ): Promise<QueuedMessage[]> {
    const stalled = Array.from(this.pending.values()).slice(0, count);
    return stalled;
  }

  async getQueueDepth(): Promise<number> {
    return this.incoming.length;
  }

  async getDlqDepth(): Promise<number> {
    return this.dlq.length;
  }

  async close(): Promise<void> {
    this.incoming = [];
    this.dlq = [];
    this.pending.clear();
  }
}
