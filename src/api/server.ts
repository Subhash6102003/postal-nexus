import express, { Request, Response, NextFunction } from 'express';
import { correlationMiddleware } from './middlewares/correlation.middleware.js';
import { metricsMiddleware } from './middlewares/metrics.middleware.js';
import emailRoutes from './routes/email.routes.js';
import webhookRoutes from './routes/webhook.routes.js';
import healthRoutes from './routes/health.routes.js';
import { logger } from '../observability/logger.js';
import { config } from '../config/index.js';

export function createServer(): express.Express {
  const app = express();

  // Disable x-powered-by header
  app.disable('x-powered-by');

  // Capture raw body for webhook HMAC signature checks
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString();
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Global Middlewares
  app.use(correlationMiddleware);
  app.use(metricsMiddleware);

  // Mount Routes
  app.use('/', healthRoutes);
  app.use('/api/v1/emails', emailRoutes);
  app.use('/api/v1/webhooks', webhookRoutes);

  // 404 Not Found Handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: `Endpoint ${req.method} ${req.path} not found`,
    });
  });

  // Central Error Handler
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    logger.error(
      {
        err: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        correlationId: (req as any).correlationId,
      },
      'Unhandled API Exception'
    );

    res.status(err.status || 500).json({
      error: 'Internal Server Error',
      message: config.env === 'production' ? 'An unexpected error occurred' : err.message,
    });
  });

  return app;
}
