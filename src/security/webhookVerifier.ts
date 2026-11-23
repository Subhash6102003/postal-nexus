import crypto from 'crypto';
import { config } from '../config/index.js';

export class WebhookVerifier {
  private static readonly secret = config.security.webhookSecret;
  private static readonly MAX_TIMESTAMP_DRIFT_SEC = 300; // 5 minutes

  /**
   * Verifies an HMAC-SHA256 signature for incoming webhooks.
   * Supports signature format: 'v1=<hex>' or raw hex, with optional 't=<timestamp>'
   */
  static verifySignature(
    rawBody: string | Buffer,
    signatureHeader?: string,
    timestampHeader?: string
  ): boolean {
    if (!signatureHeader) return false;

    // Check timestamp replay prevention if timestamp provided
    if (timestampHeader) {
      const now = Math.floor(Date.now() / 1000);
      const sentTime = parseInt(timestampHeader, 10);
      if (isNaN(sentTime) || Math.abs(now - sentTime) > this.MAX_TIMESTAMP_DRIFT_SEC) {
        return false;
      }
    }

    const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const signedData = timestampHeader ? `${timestampHeader}.${payload}` : payload;

    const expectedSignature = crypto
      .createHmac('sha256', this.secret)
      .update(signedData)
      .digest('hex');

    // Handle v1= prefix if present
    const cleanSignature = signatureHeader.startsWith('v1=')
      ? signatureHeader.substring(3)
      : signatureHeader;

    if (cleanSignature.length !== expectedSignature.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(cleanSignature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }

  /**
   * Helper to generate a valid webhook signature (for tests or webhook dispatchers)
   */
  static createSignature(payload: string, timestamp?: number): string {
    const signedData = timestamp ? `${timestamp}.${payload}` : payload;
    const hmac = crypto.createHmac('sha256', this.secret).update(signedData).digest('hex');
    return `v1=${hmac}`;
  }
}
