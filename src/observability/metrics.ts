import client from 'prom-client';

// Create a separate registry for mailer service
export const register = new client.Registry();

// Add default recommended node.js process metrics
client.collectDefaultMetrics({ register, prefix: 'mailer_' });

// HTTP Metrics
export const httpRequestCounter = new client.Counter({
  name: 'mailer_http_requests_total',
  help: 'Total number of HTTP requests received',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: 'mailer_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds (p50, p95, p99 latency)',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// Rate Limit Metrics
export const rateLimitExceededCounter = new client.Counter({
  name: 'mailer_rate_limit_exceeded_total',
  help: 'Total count of requests rejected due to per-user rate limit',
  labelNames: ['user_id', 'role'],
  registers: [register],
});

// Queue Metrics
export const queueDepthGauge = new client.Gauge({
  name: 'mailer_queue_depth',
  help: 'Current depth of the email streams (incoming / DLQ)',
  labelNames: ['stream'],
  registers: [register],
});

export const queueWaitDuration = new client.Histogram({
  name: 'mailer_queue_waiting_time_seconds',
  help: 'Time spent in the queue before worker pickup',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [register],
});

// Worker & Email Metrics
export const emailsProcessedCounter = new client.Counter({
  name: 'mailer_emails_processed_total',
  help: 'Total email delivery jobs processed by status and provider',
  labelNames: ['status', 'provider'],
  registers: [register],
});

export const emailDeliveryDuration = new client.Histogram({
  name: 'mailer_email_delivery_duration_seconds',
  help: 'Time spent by email provider sending the message',
  labelNames: ['provider', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const emailRetriesCounter = new client.Counter({
  name: 'mailer_email_retries_total',
  help: 'Total retry attempts for transiently failing emails',
  labelNames: ['attempt'],
  registers: [register],
});

export const workerActiveJobsGauge = new client.Gauge({
  name: 'mailer_worker_active_jobs',
  help: 'Number of email jobs currently being processed by workers',
  labelNames: ['worker_id'],
  registers: [register],
});

// Circuit Breaker Metric
export const circuitBreakerStateGauge = new client.Gauge({
  name: 'mailer_circuit_breaker_state',
  help: 'Circuit breaker state (0: CLOSED, 1: HALF_OPEN, 2: OPEN)',
  labelNames: ['provider'],
  registers: [register],
});

// Database & Redis Metrics
export const dbPoolConnectionsGauge = new client.Gauge({
  name: 'mailer_db_pool_connections',
  help: 'Database connection pool status',
  labelNames: ['state'], // active, idle, waiting
  registers: [register],
});

export const redisLatencyHistogram = new client.Histogram({
  name: 'mailer_redis_latency_seconds',
  help: 'Redis command latency in seconds',
  labelNames: ['command'],
  buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [register],
});
