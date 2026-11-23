import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { EmailSanitizer } from '../../security/sanitizer.js';

export const sendEmailSchema = z.object({
  recipient: z
    .string()
    .email({ message: 'Invalid recipient email address format' })
    .max(255),
  subject: z
    .string()
    .min(1, { message: 'Subject cannot be empty' })
    .max(500, { message: 'Subject exceeds 500 characters maximum' }),
  body_text: z.string().optional(),
  body_html: z.string().optional(),
  idempotency_key: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/, {
      message: 'Idempotency key must be alphanumeric, dashes, or underscores',
    })
    .optional(),
  template_id: z.string().optional(),
  template_variables: z.record(z.union([z.string(), z.number()])).optional(),
}).refine((data) => data.body_text || data.body_html || data.template_id, {
  message: 'At least one of body_text, body_html, or template_id must be provided',
});

export function validateSendEmail(req: Request, res: Response, next: NextFunction): void {
  const result = sendEmailSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Validation failed',
      issues: result.error.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  // Security sanitization: Email Header Injection defense & HTML sanitization
  const sanitizedRecipient = EmailSanitizer.sanitizeEmail(result.data.recipient);
  const sanitizedSubject = EmailSanitizer.sanitizeHeader(result.data.subject);
  const sanitizedHtml = result.data.body_html
    ? EmailSanitizer.sanitizeHtml(result.data.body_html)
    : undefined;

  // Replace req.body with sanitized data
  req.body = {
    ...result.data,
    recipient: sanitizedRecipient,
    subject: sanitizedSubject,
    body_html: sanitizedHtml,
  };

  next();
}
