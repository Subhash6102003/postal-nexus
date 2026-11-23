import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DbManager } from '../../db/repository.js';
import { RedisStreamQueue, BackpressureError } from '../../queue/redisStreamQueue.js';
import { IMessageQueue } from '../../queue/types.js';
import { logger } from '../../observability/logger.js';
import { emailsProcessedCounter } from '../../observability/metrics.js';

let defaultQueue: IMessageQueue | null = null;

export function getQueueInstance(): IMessageQueue {
  if (!defaultQueue) {
    defaultQueue = new RedisStreamQueue();
  }
  return defaultQueue;
}

export function setQueueInstance(queue: IMessageQueue): void {
  defaultQueue = queue;
}

export class EmailController {
  /**
   * POST /api/v1/emails/send
   * Submits an email request, applies rate limiting, responds immediately with HTTP 202 Accepted
   */
  static async sendEmail(req: Request, res: Response): Promise<void> {
    const user = (req as any).user;
    const {
      recipient,
      subject,
      body_text,
      body_html,
      idempotency_key,
      template_id,
      template_variables,
    } = req.body;

    const db = await DbManager.getRepository();
    const queue = getQueueInstance();

    // 1. Idempotency Check: Avoid duplicate jobs
    if (idempotency_key) {
      const existing = await db.findIdempotentRequest(user.userId, idempotency_key);
      if (existing) {
        logger.info(
          { userId: user.userId, idempotencyKey: idempotency_key, requestId: existing.id },
          'Idempotent duplicate request detected - returning existing request'
        );
        res.status(200).json({
          message: 'Request already processed (idempotency match)',
          requestId: existing.id,
          status: existing.status,
          createdAt: existing.created_at,
        });
        return;
      }
    }

    // 2. Generate unique Request ID
    const requestId = uuidv4();

    try {
      // 3. Persist record to Database with status ACCEPTED
      const emailRecord = await db.createEmailRequest(
        {
          id: requestId,
          user_id: user.userId,
          recipient,
          subject,
          body_text,
          body_html,
          idempotency_key,
          status: 'ACCEPTED',
          attempt_count: 0,
          max_retries: 3,
        },
        idempotency_key
      );

      // 4. Push minimal job payload to Durable Message Queue (Redis Stream)
      await queue.enqueue({
        requestId,
        userId: user.userId,
        recipient,
        subject,
        idempotencyKey: idempotency_key,
        templateId: template_id,
        templateVariables: template_variables,
        attempt: 0,
        maxRetries: 3,
        enqueuedAt: Date.now(),
      });

      // 5. Update Status to QUEUED
      await db.updateEmailStatus(requestId, 'QUEUED');
      emailsProcessedCounter.inc({ status: 'QUEUED', provider: 'gateway' });

      // 6. Return HTTP 202 Accepted immediately
      res.status(202).json({
        status: 'accepted',
        message: 'Email request accepted and queued for asynchronous delivery',
        requestId,
        idempotencyKey: idempotency_key || null,
        recipient,
        queuedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof BackpressureError) {
        logger.warn({ err: err.message, requestId }, 'Queue backpressure active');
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'System is experiencing extreme traffic burst. Queue backpressure active, retry shortly.',
        });
        return;
      }

      logger.error({ err, requestId }, 'Failed to queue email request');
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to accept and queue email request',
      });
    }
  }

  /**
   * GET /api/v1/emails/:requestId
   * Retrieves email delivery status and audit history
   */
  static async getEmailStatus(req: Request, res: Response): Promise<void> {
    const user = (req as any).user;
    const { requestId } = req.params;

    const db = await DbManager.getRepository();
    const email = await db.getEmailRequestById(requestId);

    if (!email) {
      res.status(404).json({ error: 'Not Found', message: `Email request '${requestId}' not found` });
      return;
    }

    // Per-user authorization: users can only view their own emails unless admin
    if (user.role !== 'admin' && email.user_id !== user.userId) {
      res.status(403).json({ error: 'Forbidden', message: 'You do not have access to this email record' });
      return;
    }

    const logs = await db.getDeliveryLogsByRequestId(requestId);

    res.status(200).json({
      requestId: email.id,
      userId: email.user_id,
      recipient: email.recipient,
      subject: email.subject,
      status: email.status,
      attemptCount: email.attempt_count,
      maxRetries: email.max_retries,
      providerId: email.provider_id || null,
      lastError: email.last_error || null,
      createdAt: email.created_at,
      updatedAt: email.updated_at,
      sentAt: email.sent_at || null,
      deliveredAt: email.delivered_at || null,
      logs: logs.map((l) => ({
        attempt: l.attempt,
        status: l.status,
        provider: l.provider_id,
        durationMs: l.duration_ms,
        error: l.error_message,
        createdAt: l.created_at,
      })),
    });
  }

  /**
   * GET /api/v1/emails
   * Paginated email request history for authenticated user
   */
  static async listEmails(req: Request, res: Response): Promise<void> {
    const user = (req as any).user;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const offset = (page - 1) * limit;

    const db = await DbManager.getRepository();
    const result = await db.getEmailRequestsByUser(user.userId, limit, offset);

    res.status(200).json({
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
      items: result.items.map((e) => ({
        requestId: e.id,
        recipient: e.recipient,
        subject: e.subject,
        status: e.status,
        attemptCount: e.attempt_count,
        createdAt: e.created_at,
        sentAt: e.sent_at,
        deliveredAt: e.delivered_at,
      })),
    });
  }
}
