import { Request, Response } from 'express';
import { WebhookVerifier } from '../../security/webhookVerifier.js';
import { DbManager } from '../../db/repository.js';
import { logger } from '../../observability/logger.js';
import { emailsProcessedCounter } from '../../observability/metrics.js';

export class WebhookController {
  /**
   * POST /api/v1/webhooks/email-status
   * Provider webhook endpoint for final delivery confirmation or bounce notifications
   */
  static async handleWebhook(req: Request, res: Response): Promise<void> {
    const signature = req.headers['x-webhook-signature'] as string | undefined;
    const timestamp = req.headers['x-webhook-timestamp'] as string | undefined;

    const rawBody = (req as any).rawBody || JSON.stringify(req.body);

    // 1. Verify HMAC Signature
    const isValid = WebhookVerifier.verifySignature(rawBody, signature, timestamp);
    if (!isValid) {
      logger.warn({ signature, timestamp }, 'Invalid webhook signature rejected');
      res.status(401).json({ error: 'Unauthorized: Invalid webhook signature' });
      return;
    }

    const { requestId, event, providerId, timestamp: eventTimestamp, details } = req.body;

    if (!requestId || !event) {
      res.status(400).json({ error: 'Bad Request: Missing requestId or event type' });
      return;
    }

    const db = await DbManager.getRepository();
    const existing = await db.getEmailRequestById(requestId);

    if (!existing) {
      // Return 200 so provider doesn't re-send non-existent event repeatedly
      logger.warn({ requestId }, 'Webhook event received for unknown requestId');
      res.status(200).json({ received: true, warning: 'RequestId not found' });
      return;
    }

    const eventDate = eventTimestamp ? new Date(eventTimestamp) : new Date();

    if (event === 'delivered') {
      // Confirmation from provider that email landed in recipient mailbox
      await db.updateEmailStatus(requestId, 'DELIVERED', {
        providerId,
        deliveredAt: eventDate,
      });

      await db.addDeliveryLog({
        request_id: requestId,
        status: 'DELIVERED',
        attempt: existing.attempt_count,
        provider_id: providerId,
        provider_response: details || 'Provider confirmed delivery',
      });

      emailsProcessedCounter.inc({ status: 'DELIVERED', provider: providerId || 'unknown' });
      logger.info({ requestId, providerId }, 'Webhook: marked DELIVERED');
    } else if (event === 'bounced') {
      await db.updateEmailStatus(requestId, 'BOUNCED', {
        providerId,
        lastError: details || 'Recipient bounced',
      });

      await db.addDeliveryLog({
        request_id: requestId,
        status: 'BOUNCED',
        attempt: existing.attempt_count,
        provider_id: providerId,
        error_message: details || 'Email bounced by provider',
      });

      emailsProcessedCounter.inc({ status: 'BOUNCED', provider: providerId || 'unknown' });
      logger.warn({ requestId, providerId, details }, 'Webhook: marked BOUNCED');
    }

    res.status(200).json({ received: true, requestId, event });
  }
}
