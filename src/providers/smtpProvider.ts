import nodemailer from 'nodemailer';
import { IEmailProvider, EmailDispatchOptions, ProviderSendResult } from './types.js';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { emailDeliveryDuration } from '../observability/metrics.js';

export class SmtpProvider implements IEmailProvider {
  public readonly id = 'smtp-primary';
  public readonly name = 'Pooled SMTP Provider';
  private transporter: nodemailer.Transporter;

  constructor(customTransporter?: nodemailer.Transporter) {
    if (customTransporter) {
      this.transporter = customTransporter;
    } else {
      this.transporter = nodemailer.createTransport({
        host: config.provider.smtp.host,
        port: config.provider.smtp.port,
        secure: config.provider.smtp.secure,
        auth:
          config.provider.smtp.user && config.provider.smtp.pass
            ? {
                user: config.provider.smtp.user,
                pass: config.provider.smtp.pass,
              }
            : undefined,
        pool: config.provider.smtp.pool,
        maxConnections: config.provider.smtp.maxConnections,
        maxMessages: config.provider.smtp.maxMessages,
        rateDelta: config.provider.smtp.rateDelta,
        rateLimit: config.provider.smtp.rateLimit,
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
      } as any);
    }
  }

  async send(options: EmailDispatchOptions): Promise<ProviderSendResult> {
    const start = Date.now();
    const timer = emailDeliveryDuration.startTimer({ provider: this.id });

    try {
      const info = await this.transporter.sendMail({
        from: options.sender || 'noreply@system.local',
        to: options.recipient,
        subject: options.subject,
        text: options.bodyText,
        html: options.bodyHtml,
        headers: {
          'X-Mailer-Request-ID': options.requestId,
          ...options.headers,
        },
      });

      const durationMs = Date.now() - start;
      timer({ status: 'success' });

      // In SMTP, a 250 OK indicates the recipient MTA accepted the message.
      // Status is marked as SENT (Delivered requires provider webhook confirmation)
      return {
        success: true,
        providerId: this.id,
        providerMessageId: info.messageId,
        status: 'SENT',
        durationMs,
        rawResponse: info.response,
      };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      timer({ status: 'failure' });

      const isTemporary = this.isTemporaryError(err);
      logger.warn(
        { err: err.message, requestId: options.requestId, isTemporary },
        'SMTP delivery error'
      );

      return {
        success: false,
        providerId: this.id,
        status: 'FAILED',
        durationMs,
        error: err.message || 'Unknown SMTP Error',
        isTemporaryError: isTemporary,
      };
    }
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch (err) {
      logger.warn({ err }, 'SMTP verification failed');
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.transporter && typeof this.transporter.close === 'function') {
      this.transporter.close();
    }
  }

  /**
   * Differentiates transient errors (4xx codes, timeouts, connection drops)
   * from permanent errors (5xx mailbox unknown, syntax errors).
   */
  private isTemporaryError(err: any): boolean {
    if (!err) return false;

    // Timeout or network drop errors are temporary
    if (
      err.code === 'ETIMEDOUT' ||
      err.code === 'ECONNRESET' ||
      err.code === 'ECONNREFUSED' ||
      err.code === 'ENOTFOUND' ||
      err.code === 'ESOCKET'
    ) {
      return true;
    }

    // SMTP response codes: 4xx is temporary, 5xx is permanent
    if (err.responseCode && typeof err.responseCode === 'number') {
      return err.responseCode >= 400 && err.responseCode < 500;
    }

    return true; // Default to temporary on ambiguous errors so retry policy can handle
  }
}
