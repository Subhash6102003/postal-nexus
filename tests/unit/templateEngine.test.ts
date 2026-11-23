import { describe, it, expect } from 'vitest';
import { TemplateEngine } from '../../src/worker/templateEngine.js';

describe('TemplateEngine', () => {
  it('should render welcome template with variables', () => {
    const rendered = TemplateEngine.render('welcome', {
      name: 'Alice Cooper',
      userId: 'usr_998877',
    });

    expect(rendered).not.toBeNull();
    expect(rendered!.subject).toBe('Welcome to Postal Nexus, Alice Cooper!');
    expect(rendered!.html).toContain('Alice Cooper');
    expect(rendered!.html).toContain('usr_998877');
  });

  it('should return null for unknown templates', () => {
    const rendered = TemplateEngine.render('non_existent_template', {});
    expect(rendered).toBeNull();
  });

  it('should allow registering custom templates', () => {
    TemplateEngine.registerTemplate('custom_invoice', {
      subject: 'Invoice #{{invId}} for {{amount}}',
      html: '<p>Pay {{amount}}</p>',
      text: 'Pay {{amount}}',
    });

    const rendered = TemplateEngine.render('custom_invoice', { invId: 1045, amount: '$99.00' });
    expect(rendered!.subject).toBe('Invoice #1045 for $99.00');
  });
});
