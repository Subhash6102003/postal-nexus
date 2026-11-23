import { createServer } from './api/server.js';
import { config } from './config/index.js';
import { logger } from './observability/logger.js';
import { EmailWorker } from './worker/worker.js';
import { getQueueInstance } from './api/controllers/email.controller.js';
import { DbManager } from './db/repository.js';
import { MockProvider } from './providers/mockProvider.js';
import { SmtpProvider } from './providers/smtpProvider.js';
import { FailoverProvider } from './providers/failoverProvider.js';
import { DatabasePoolManager } from './db/pool.js';

async function bootstrap() {
  const args = process.argv.slice(2);
  const roleArg = args.find((a) => a.startsWith('--role='));
  const role = roleArg ? roleArg.split('=')[1] : 'all';

  logger.info({ role, env: config.env }, 'Initializing Mailing Infrastructure...');

  // Initialize Database
  const db = await DbManager.getRepository();

  // Initialize Provider
  let provider;
  if (config.provider.type === 'smtp') {
    provider = new SmtpProvider();
  } else if (config.provider.type === 'failover') {
    const primary = new SmtpProvider();
    const secondary = new MockProvider();
    provider = new FailoverProvider(primary, secondary);
  } else {
    provider = new MockProvider();
  }

  // Initialize Queue
  const queue = getQueueInstance();

  let serverInstance: any = null;
  let workerInstance: EmailWorker | null = null;

  // 1. Start API Server
  if (role === 'all' || role === 'api') {
    const app = createServer();
    serverInstance = app.listen(config.server.port, config.server.host, () => {
      logger.info(
        { port: config.server.port, host: config.server.host },
        '🚀 API Gateway server listening'
      );
    });
  }

  // 2. Start Worker Process
  if (role === 'all' || role === 'worker') {
    workerInstance = new EmailWorker(queue, db, provider);
    await workerInstance.start();
    logger.info({ workerId: workerInstance.workerId }, '⚙️ Background Email Worker running');
  }

  // Graceful Shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Graceful shutdown initiated...');

    if (serverInstance) {
      await new Promise((resolve) => serverInstance.close(resolve));
      logger.info('HTTP server closed');
    }

    if (workerInstance) {
      await workerInstance.stop();
      logger.info('Worker stopped and drained');
    }

    await queue.close();
    await DatabasePoolManager.close();

    logger.info('System shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Fatal bootstrap failure');
  process.exit(1);
});
