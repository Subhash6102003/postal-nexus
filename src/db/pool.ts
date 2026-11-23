import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { dbPoolConnectionsGauge } from '../observability/metrics.js';

const { Pool } = pg;

export class DatabasePoolManager {
  private static instance: pg.Pool | null = null;
  private static isConnected = false;

  static getPool(): pg.Pool {
    if (!this.instance) {
      const poolConfig: pg.PoolConfig = config.database.url
        ? { connectionString: config.database.url }
        : {
            host: config.database.host,
            port: config.database.port,
            database: config.database.database,
            user: config.database.user,
            password: config.database.password,
            max: config.database.maxConnections,
            idleTimeoutMillis: config.database.idleTimeoutMillis,
            connectionTimeoutMillis: config.database.connectionTimeoutMillis,
          };

      this.instance = new Pool(poolConfig);

      this.instance.on('error', (err) => {
        logger.error({ err }, 'Unexpected PostgreSQL pool error');
      });

      this.instance.on('connect', () => {
        this.updateMetrics();
      });

      this.instance.on('acquire', () => {
        this.updateMetrics();
      });

      this.instance.on('release', () => {
        this.updateMetrics();
      });
    }

    return this.instance;
  }

  static async testConnection(): Promise<boolean> {
    try {
      const pool = this.getPool();
      const res = await pool.query('SELECT 1 as alive');
      this.isConnected = res.rows.length > 0;
      return this.isConnected;
    } catch (err) {
      this.isConnected = false;
      logger.warn({ err }, 'PostgreSQL connection test failed');
      return false;
    }
  }

  static getStatus(): boolean {
    return this.isConnected;
  }

  static updateMetrics(): void {
    if (this.instance) {
      dbPoolConnectionsGauge.set({ state: 'active' }, this.instance.totalCount - this.instance.idleCount);
      dbPoolConnectionsGauge.set({ state: 'idle' }, this.instance.idleCount);
      dbPoolConnectionsGauge.set({ state: 'waiting' }, this.instance.waitingCount);
    }
  }

  static async close(): Promise<void> {
    if (this.instance) {
      await this.instance.end();
      this.instance = null;
      this.isConnected = false;
      logger.info('PostgreSQL pool closed gracefully');
    }
  }
}
