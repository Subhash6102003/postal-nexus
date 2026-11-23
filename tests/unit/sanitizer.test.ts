import { describe, it, expect } from 'vitest';
import { EmailSanitizer } from '../../src/security/sanitizer.js';

describe('EmailSanitizer', () => {
  it('should strip CRLF characters to prevent Header Injection', () => {
    const maliciousSubject = 'Account Update\r\nBcc: victim@example.com\r\nSubject: Injected';
    const clean = EmailSanitizer.sanitizeHeader(maliciousSubject);
    expect(clean).not.toContain('\r');
    expect(clean).not.toContain('\n');
    expect(clean).toBe('Account Update  Bcc: victim@example.com  Subject: Injected');
  });

  it('should sanitize email addresses and convert to lowercase', () => {
    const dirty = '  Alice.Doe+test@EXAMPLE.COM \r\n';
    const clean = EmailSanitizer.sanitizeEmail(dirty);
    expect(clean).toBe('alice.doe+test@example.com');
  });

  it('should strip <script> tags from HTML body', () => {
    const dirtyHtml = '<div>Hello</div><script>alert("XSS")</script><p>Welcome</p>';
    const clean = EmailSanitizer.sanitizeHtml(dirtyHtml);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('alert');
    expect(clean).toBe('<div>Hello</div><p>Welcome</p>');
  });

  it('should strip inline javascript event handlers and javascript: URIs', () => {
    const dirtyHtml = '<a href="javascript:stealData()" onclick="alert(1)">Click Here</a>';
    const clean = EmailSanitizer.sanitizeHtml(dirtyHtml);
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('javascript:stealData');
    expect(clean).toContain('href="#"');
  });

  it('should strip <iframe>, <object>, and <embed> tags', () => {
    const dirtyHtml = '<iframe src="https://evil.com"></iframe><embed src="malware.swf"></embed>';
    const clean = EmailSanitizer.sanitizeHtml(dirtyHtml);
    expect(clean).not.toContain('<iframe');
    expect(clean).not.toContain('<embed');
  });
});
