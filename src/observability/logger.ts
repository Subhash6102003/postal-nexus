import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  base: {
    service: 'mailer-service',
    pid: process.pid,
  },
});

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
