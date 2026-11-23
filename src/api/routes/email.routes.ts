import { Router } from 'express';
import { EmailController } from '../controllers/email.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { rateLimitMiddleware } from '../middlewares/rateLimiter.middleware.js';
import { validateSendEmail } from '../middlewares/validation.middleware.js';

const router = Router();

// Apply Authentication to all email routes
router.use(authMiddleware);

// POST /api/v1/emails/send - Apply Per-User Rate Limiting (5 requests/minute) & Payload Validation
router.post('/send', rateLimitMiddleware, validateSendEmail, EmailController.sendEmail);

// GET /api/v1/emails/:requestId - Retrieve delivery status
router.get('/:requestId', EmailController.getEmailStatus);

// GET /api/v1/emails - Retrieve paginated history
router.get('/', EmailController.listEmails);

export default router;
