import { Request, Response, NextFunction } from 'express';
import { httpRequestCounter, httpRequestDuration } from '../../observability/metrics.js';

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime();

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const durationSeconds = diff[0] + diff[1] / 1e9;

    // Normalize path to avoid high cardinality metrics
    let route = req.baseUrl + (req.route?.path || req.path);
    if (route.includes('/emails/') && route !== '/api/v1/emails/send') {
      route = '/api/v1/emails/:requestId';
    }

    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    };

    httpRequestCounter.inc(labels);
    httpRequestDuration.observe(labels, durationSeconds);
  });

  next();
}
