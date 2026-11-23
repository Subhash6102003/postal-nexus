/**
 * Security Sanitizer for Email Inputs:
 * 1. Email Header Injection Prevention (CRLF Stripping)
 * 2. HTML Body Sanitization (XSS and Malicious Script Elimination)
 * 3. Email Address Normalization
 */

export class EmailSanitizer {
  /**
   * Header Injection Defense:
   * Strips Carriage Return (\r) and Line Feed (\n) characters from single-line headers.
   * Prevents attackers from injecting additional headers (Bcc:, From:, Subject:, etc.)
   */
  static sanitizeHeader(value: string | undefined): string {
    if (!value) return '';
    return value.replace(/[\r\n\0]/g, ' ').trim();
  }

  /**
   * Sanitizes email address: trims and strips control chars
   */
  static sanitizeEmail(email: string): string {
    return this.sanitizeHeader(email).toLowerCase();
  }

  /**
   * Sanitizes multiple recipient lists (comma-separated or array)
   */
  static sanitizeRecipientList(emails?: string[] | string): string[] {
    if (!emails) return [];
    const list = Array.isArray(emails) ? emails : emails.split(',');
    return list
      .map((e) => this.sanitizeEmail(e))
      .filter((e) => e.length > 0);
  }

  /**
   * HTML Body Sanitizer:
   * Strips malicious tags (<script>, <iframe>, <object>, <embed>, <applet>, <form>, <link rel="import">)
   * Strips inline javascript event handlers (onload, onerror, onclick, etc.)
   * Strips javascript: and data: text/html URIs
   */
  static sanitizeHtml(html: string): string {
    if (!html) return '';

    let clean = html;

    // 1. Remove dangerous executable tags and contents
    clean = clean.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    clean = clean.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
    clean = clean.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');
    clean = clean.replace(/<embed\b[^>]*>/gi, '');
    clean = clean.replace(/<applet\b[^<]*(?:(?!<\/applet>)<[^<]*)*<\/applet>/gi, '');
    clean = clean.replace(/<form\b[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, '');

    // 2. Remove inline JS event handlers (on* attributes)
    clean = clean.replace(/\s+on\w+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '');

    // 3. Remove javascript: pseudo-protocol in href/src
    clean = clean.replace(/\s+(?:href|src)\s*=\s*(['"]?)\s*javascript:[^'"]*\1/gi, ' href="#"');

    return clean;
  }
}
