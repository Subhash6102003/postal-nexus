import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  server: {
    port: number;
    host: string;
    trustProxy: boolean;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    keyPrefix: string;
    streamName: string;
    dlqStreamName: string;
    consumerGroup: string;
    maxQueueDepth: number;
  };
  database: {
    url?: string;
    host: string;
    port: number;
    database: string;
    user: string;
    password?: string;
    maxConnections: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    batchFlushIntervalMs: number;
    batchFlushSize: number;
  };
  rateLimit: {
    windowMs: number;
    defaultLimit: number;
    adminLimit: number;
  };
  worker: {
    concurrency: number;
    batchSize: number;
    blockTimeoutMs: number;
    maxRetries: number;
    baseRetryDelayMs: number;
    maxRetryDelayMs: number;
    reaperIntervalMs: number;
    pendingIdleTimeMs: number;
  };
  provider: {
    type: 'smtp' | 'mock' | 'failover';
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      pass?: string;
      pool: boolean;
      maxConnections: number;
      maxMessages: number;
      rateDelta: number;
      rateLimit: number;
    };
    circuitBreaker: {
      failureThreshold: number;
      resetTimeoutMs: number;
      halfOpenSuccessThreshold: number;
    };
  };
  security: {
    jwtSecret: string;
    webhookSecret: string;
    adminApiKeys: string[];
  };
}

export const config: AppConfig = {
  env: (process.env.NODE_ENV as AppConfig['env']) || 'development',
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    trustProxy: process.env.TRUST_PROXY === 'true' || true,
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'mailer:',
    streamName: process.env.REDIS_STREAM_NAME || 'email:stream:incoming',
    dlqStreamName: process.env.REDIS_DLQ_STREAM_NAME || 'email:stream:dlq',
    consumerGroup: process.env.REDIS_CONSUMER_GROUP || 'email-worker-group',
    maxQueueDepth: parseInt(process.env.MAX_QUEUE_DEPTH || '1000000', 10),
  },
  database: {
    url: process.env.DATABASE_URL,
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'mailer_db',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    maxConnections: parseInt(process.env.PG_MAX_CONNECTIONS || '50', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    batchFlushIntervalMs: 50,
    batchFlushSize: 100,
  },
  rateLimit: {
    windowMs: 60 * 1000, // 1 minute sliding window
    defaultLimit: 5,     // 5 email requests per minute per authenticated user
    adminLimit: 1000,   // Configurable admin quota
  },
  worker: {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '25', 10),
    batchSize: parseInt(process.env.WORKER_BATCH_SIZE || '50', 10),
    blockTimeoutMs: 1000,
    maxRetries: parseInt(process.env.WORKER_MAX_RETRIES || '3', 10),
    baseRetryDelayMs: 1000,
    maxRetryDelayMs: 30000,
    reaperIntervalMs: 30000,
    pendingIdleTimeMs: 60000,
  },
  provider: {
    type: (process.env.EMAIL_PROVIDER as AppConfig['provider']['type']) || 'mock',
    smtp: {
      host: process.env.SMTP_HOST || '127.0.0.1',
      port: parseInt(process.env.SMTP_PORT || '1025', 10),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      pool: true,
      maxConnections: parseInt(process.env.SMTP_MAX_CONNECTIONS || '20', 10),
      maxMessages: 1000,
      rateDelta: 1000,
      rateLimit: 100,
    },
    circuitBreaker: {
      failureThreshold: 5,
      resetTimeoutMs: 15000,
      halfOpenSuccessThreshold: 2,
    },
  },
  security: {
    jwtSecret: process.env.JWT_SECRET || 'postal-nexus-super-secret-key-32chars!!',
    webhookSecret: process.env.WEBHOOK_SECRET || 'postal-webhook-signature-secret-key',
    adminApiKeys: (process.env.ADMIN_API_KEYS || 'admin-api-key-master-777').split(','),
  },
};
