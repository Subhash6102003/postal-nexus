export class TemplateEngine {
  private static templates: Map<string, { subject: string; html: string; text: string }> = new Map([
    [
      'welcome',
      {
        subject: 'Welcome to Postal Nexus, {{name}}!',
        html: '<h1>Welcome, {{name}}!</h1><p>Thank you for signing up for our service. Your user ID is <strong>{{userId}}</strong>.</p>',
        text: 'Welcome, {{name}}!\nThank you for signing up for our service. Your user ID is {{userId}}.',
      },
    ],
    [
      'password_reset',
      {
        subject: 'Password Reset Request',
        html: '<p>Hello {{name}},</p><p>Click <a href="{{resetUrl}}">here</a> to reset your password. Token: <code>{{token}}</code></p>',
        text: 'Hello {{name}},\nUse this link to reset your password: {{resetUrl}}\nToken: {{token}}',
      },
    ],
    [
      'alert',
      {
        subject: '[ALERT] {{title}}',
        html: '<h2 style="color:red;">{{title}}</h2><p>{{message}}</p><p>Timestamp: {{timestamp}}</p>',
        text: '[ALERT] {{title}}\n{{message}}\nTimestamp: {{timestamp}}',
      },
    ],
  ]);

  static render(
    templateId: string,
    variables: Record<string, string | number> = {}
  ): { subject: string; html: string; text: string } | null {
    const tpl = this.templates.get(templateId);
    if (!tpl) return null;

    const replaceVars = (str: string) => {
      return str.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
        const val = variables[key];
        return val !== undefined ? String(val) : '';
      });
    };

    return {
      subject: replaceVars(tpl.subject),
      html: replaceVars(tpl.html),
      text: replaceVars(tpl.text),
    };
  }

  static registerTemplate(
    templateId: string,
    template: { subject: string; html: string; text: string }
  ): void {
    this.templates.set(templateId, template);
  }
}
