import { Router } from 'express';
import { WebhookController } from '../controllers/webhook.controller.js';

const router = Router();

// POST /api/v1/webhooks/email-status - Receives provider delivery/bounce events
router.post('/email-status', WebhookController.handleWebhook);

export default router;
