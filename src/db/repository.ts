import { v4 as uuidv4 } from 'uuid';
import { DatabasePoolManager } from './pool.js';
import { logger } from '../observability/logger.js';
import {
  EmailRequestRecord,
  EmailStatus,
  UserRecord,
  DeliveryLogRecord,
  IdempotencyRecord,
} from './types.js';

export interface IDbRepository {
  getUserById(userId: string): Promise<UserRecord | null>;
  getUserByApiKeyHash(hash: string): Promise<UserRecord | null>;
  upsertUser(user: Partial<UserRecord> & { id: string; email: string }): Promise<UserRecord>;

  findIdempotentRequest(userId: string, key: string): Promise<EmailRequestRecord | null>;
  createEmailRequest(
    request: Omit<EmailRequestRecord, 'created_at' | 'updated_at'>,
    idempotencyKey?: string
  ): Promise<EmailRequestRecord>;

  getEmailRequestById(id: string): Promise<EmailRequestRecord | null>;
  getEmailRequestsByUser(
    userId: string,
    limit: number,
    offset: number
  ): Promise<{ items: EmailRequestRecord[]; total: number }>;

  updateEmailStatus(
    id: string,
    status: EmailStatus,
    details?: {
      attemptCount?: number;
      providerId?: string;
      lastError?: string;
      sentAt?: Date;
      deliveredAt?: Date;
    }
  ): Promise<void>;

  batchUpdateEmailStatus(
    updates: Array<{
      id: string;
      status: EmailStatus;
      attemptCount?: number;
      providerId?: string;
      lastError?: string;
      sentAt?: Date;
      deliveredAt?: Date;
    }>
  ): Promise<void>;

  addDeliveryLog(log: DeliveryLogRecord): Promise<void>;
  getDeliveryLogsByRequestId(requestId: string): Promise<DeliveryLogRecord[]>;

  addAuditLog(userId: string | undefined, action: string, details?: unknown, ip?: string): Promise<void>;
}

/**
 * Production PostgreSQL Repository implementation
 */
export class PostgresRepository implements IDbRepository {
  private pool = DatabasePoolManager.getPool();

  async getUserById(userId: string): Promise<UserRecord | null> {
    const res = await this.pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    return res.rows[0] || null;
  }

  async getUserByApiKeyHash(hash: string): Promise<UserRecord | null> {
    const res = await this.pool.query('SELECT * FROM users WHERE api_key_hash = $1', [hash]);
    return res.rows[0] || null;
  }

  async upsertUser(user: Partial<UserRecord> & { id: string; email: string }): Promise<UserRecord> {
    const res = await this.pool.query(
      `INSERT INTO users (id, email, api_key_hash, role, tier, rate_limit_per_minute)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         api_key_hash = COALESCE(EXCLUDED.api_key_hash, users.api_key_hash),
         role = EXCLUDED.role,
         tier = EXCLUDED.tier,
         rate_limit_per_minute = EXCLUDED.rate_limit_per_minute,
         updated_at = NOW()
       RETURNING *`,
      [
        user.id,
        user.email,
        user.api_key_hash || null,
        user.role || 'user',
        user.tier || 'standard',
        user.rate_limit_per_minute || 5,
      ]
    );
    return res.rows[0];
  }

  async findIdempotentRequest(userId: string, key: string): Promise<EmailRequestRecord | null> {
    const res = await this.pool.query(
      `SELECT er.* FROM email_requests er
       JOIN idempotency_keys ik ON ik.request_id = er.id
       WHERE ik.user_id = $1 AND ik.key = $2 AND ik.expires_at > NOW()`,
      [userId, key]
    );
    return res.rows[0] || null;
  }

  async createEmailRequest(
    request: Omit<EmailRequestRecord, 'created_at' | 'updated_at'>,
    idempotencyKey?: string
  ): Promise<EmailRequestRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query(
        `INSERT INTO email_requests 
         (id, user_id, recipient, subject, body_text, body_html, idempotency_key, status, attempt_count, max_retries)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          request.id,
          request.user_id,
          request.recipient,
          request.subject,
          request.body_text || null,
          request.body_html || null,
          idempotencyKey || null,
          request.status,
          request.attempt_count || 0,
          request.max_retries || 3,
        ]
      );

      if (idempotencyKey) {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
        await client.query(
          `INSERT INTO idempotency_keys (key, user_id, request_id, expires_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, key) DO NOTHING`,
          [idempotencyKey, request.user_id, request.id, expiresAt]
        );
      }

      await client.query('COMMIT');
      return res.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getEmailRequestById(id: string): Promise<EmailRequestRecord | null> {
    const res = await this.pool.query('SELECT * FROM email_requests WHERE id = $1', [id]);
    return res.rows[0] || null;
  }

  async getEmailRequestsByUser(
    userId: string,
    limit: number,
    offset: number
  ): Promise<{ items: EmailRequestRecord[]; total: number }> {
    const countRes = await this.pool.query(
      'SELECT COUNT(*) as total FROM email_requests WHERE user_id = $1',
      [userId]
    );
    const total = parseInt(countRes.rows[0].total, 10);

    const itemsRes = await this.pool.query(
      `SELECT * FROM email_requests 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return { items: itemsRes.rows, total };
  }

  async updateEmailStatus(
    id: string,
    status: EmailStatus,
    details?: {
      attemptCount?: number;
      providerId?: string;
      lastError?: string;
      sentAt?: Date;
      deliveredAt?: Date;
    }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE email_requests SET
         status = $2,
         attempt_count = COALESCE($3, attempt_count),
         provider_id = COALESCE($4, provider_id),
         last_error = $5,
         sent_at = COALESCE($6, sent_at),
         delivered_at = COALESCE($7, delivered_at),
         updated_at = NOW()
       WHERE id = $1`,
      [
        id,
        status,
        details?.attemptCount ?? null,
        details?.providerId ?? null,
        details?.lastError ?? null,
        details?.sentAt ?? null,
        details?.deliveredAt ?? null,
      ]
    );
  }

  async batchUpdateEmailStatus(
    updates: Array<{
      id: string;
      status: EmailStatus;
      attemptCount?: number;
      providerId?: string;
      lastError?: string;
      sentAt?: Date;
      deliveredAt?: Date;
    }>
  ): Promise<void> {
    if (updates.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of updates) {
        await client.query(
          `UPDATE email_requests SET
             status = $2,
             attempt_count = COALESCE($3, attempt_count),
             provider_id = COALESCE($4, provider_id),
             last_error = $5,
             sent_at = COALESCE($6, sent_at),
             delivered_at = COALESCE($7, delivered_at),
             updated_at = NOW()
           WHERE id = $1`,
          [
            u.id,
            u.status,
            u.attemptCount ?? null,
            u.providerId ?? null,
            u.lastError ?? null,
            u.sentAt ?? null,
            u.deliveredAt ?? null,
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async addDeliveryLog(log: DeliveryLogRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO delivery_logs (request_id, status, attempt, provider_id, provider_response, error_message, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        log.request_id,
        log.status,
        log.attempt,
        log.provider_id || null,
        log.provider_response || null,
        log.error_message || null,
        log.duration_ms || null,
      ]
    );
  }

  async getDeliveryLogsByRequestId(requestId: string): Promise<DeliveryLogRecord[]> {
    const res = await this.pool.query(
      'SELECT * FROM delivery_logs WHERE request_id = $1 ORDER BY created_at ASC',
      [requestId]
    );
    return res.rows;
  }

  async addAuditLog(
    userId: string | undefined,
    action: string,
    details?: unknown,
    ip?: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (user_id, action, details, ip_address)
       VALUES ($1, $2, $3, $4)`,
      [userId || null, action, details ? JSON.stringify(details) : null, ip || null]
    );
  }
}

/**
 * In-Memory High-Performance Repository Implementation
 * Used for zero-dependency local development, unit tests, and self-contained benchmarks
 */
export class MemoryRepository implements IDbRepository {
  private users: Map<string, UserRecord> = new Map();
  private emails: Map<string, EmailRequestRecord> = new Map();
  private idempotency: Map<string, IdempotencyRecord> = new Map();
  private deliveryLogs: DeliveryLogRecord[] = [];
  private auditLogs: Array<{ userId?: string; action: string; details?: unknown; ip?: string; createdAt: Date }> = [];

  constructor() {
    // Seed default admin and test users
    const now = new Date();
    this.users.set('admin_001', {
      id: 'admin_001',
      email: 'admin@system.local',
      api_key_hash: 'admin-api-key-master-777',
      role: 'admin',
      tier: 'enterprise',
      rate_limit_per_minute: 1000,
      created_at: now,
      updated_at: now,
    });
    this.users.set('user_default', {
      id: 'user_default',
      email: 'user@example.com',
      role: 'user',
      tier: 'standard',
      rate_limit_per_minute: 5,
      created_at: now,
      updated_at: now,
    });
  }

  async getUserById(userId: string): Promise<UserRecord | null> {
    return this.users.get(userId) || null;
  }

  async getUserByApiKeyHash(hash: string): Promise<UserRecord | null> {
    for (const user of this.users.values()) {
      if (user.api_key_hash === hash) return user;
    }
    return null;
  }

  async upsertUser(user: Partial<UserRecord> & { id: string; email: string }): Promise<UserRecord> {
    const existing = this.users.get(user.id);
    const now = new Date();
    const updated: UserRecord = {
      id: user.id,
      email: user.email,
      api_key_hash: user.api_key_hash ?? existing?.api_key_hash,
      role: user.role ?? existing?.role ?? 'user',
      tier: user.tier ?? existing?.tier ?? 'standard',
      rate_limit_per_minute: user.rate_limit_per_minute ?? existing?.rate_limit_per_minute ?? 5,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.users.set(user.id, updated);
    return updated;
  }

  async findIdempotentRequest(userId: string, key: string): Promise<EmailRequestRecord | null> {
    const ikKey = `${userId}:${key}`;
    const ik = this.idempotency.get(ikKey);
    if (!ik) return null;
    if (ik.expires_at < new Date()) {
      this.idempotency.delete(ikKey);
      return null;
    }
    return this.emails.get(ik.request_id) || null;
  }

  async createEmailRequest(
    request: Omit<EmailRequestRecord, 'created_at' | 'updated_at'>,
    idempotencyKey?: string
  ): Promise<EmailRequestRecord> {
    const now = new Date();
    const record: EmailRequestRecord = {
      ...request,
      created_at: now,
      updated_at: now,
    };
    this.emails.set(request.id, record);

    if (idempotencyKey) {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      this.idempotency.set(`${request.user_id}:${idempotencyKey}`, {
        key: idempotencyKey,
        user_id: request.user_id,
        request_id: request.id,
        created_at: now,
        expires_at: expiresAt,
      });
    }

    return record;
  }

  async getEmailRequestById(id: string): Promise<EmailRequestRecord | null> {
    return this.emails.get(id) || null;
  }

  async getEmailRequestsByUser(
    userId: string,
    limit: number,
    offset: number
  ): Promise<{ items: EmailRequestRecord[]; total: number }> {
    const userEmails = Array.from(this.emails.values())
      .filter((e) => e.user_id === userId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

    const total = userEmails.length;
    const items = userEmails.slice(offset, offset + limit);
    return { items, total };
  }

  async updateEmailStatus(
    id: string,
    status: EmailStatus,
    details?: {
      attemptCount?: number;
      providerId?: string;
      lastError?: string;
      sentAt?: Date;
      deliveredAt?: Date;
    }
  ): Promise<void> {
    const record = this.emails.get(id);
    if (!record) return;

    record.status = status;
    if (details?.attemptCount !== undefined) record.attempt_count = details.attemptCount;
    if (details?.providerId !== undefined) record.provider_id = details.providerId;
    if (details?.lastError !== undefined) record.last_error = details.lastError;
    if (details?.sentAt !== undefined) record.sent_at = details.sentAt;
    if (details?.deliveredAt !== undefined) record.delivered_at = details.deliveredAt;
    record.updated_at = new Date();
  }

  async batchUpdateEmailStatus(
    updates: Array<{
      id: string;
      status: EmailStatus;
      attemptCount?: number;
      providerId?: string;
      lastError?: string;
      sentAt?: Date;
      deliveredAt?: Date;
    }>
  ): Promise<void> {
    for (const u of updates) {
      await this.updateEmailStatus(u.id, u.status, u);
    }
  }

  async addDeliveryLog(log: DeliveryLogRecord): Promise<void> {
    this.deliveryLogs.push({
      id: this.deliveryLogs.length + 1,
      ...log,
      created_at: new Date(),
    });
  }

  async getDeliveryLogsByRequestId(requestId: string): Promise<DeliveryLogRecord[]> {
    return this.deliveryLogs.filter((l) => l.request_id === requestId);
  }

  async addAuditLog(
    userId: string | undefined,
    action: string,
    details?: unknown,
    ip?: string
  ): Promise<void> {
    this.auditLogs.push({
      userId,
      action,
      details,
      ip,
      createdAt: new Date(),
    });
  }

  clear(): void {
    this.emails.clear();
    this.idempotency.clear();
    this.deliveryLogs = [];
    this.auditLogs = [];
  }
}

/**
 * Unified Database Singleton Factory
 */
export class DbManager {
  private static repo: IDbRepository | null = null;

  static async getRepository(): Promise<IDbRepository> {
    if (!this.repo) {
      const isPgAlive = await DatabasePoolManager.testConnection();
      if (isPgAlive) {
        logger.info('Connected to PostgreSQL database. Using PostgresRepository.');
        this.repo = new PostgresRepository();
      } else {
        logger.info('PostgreSQL host not detected or not configured. Using high-performance MemoryRepository.');
        this.repo = new MemoryRepository();
      }
    }
    return this.repo;
  }

  static setRepository(customRepo: IDbRepository): void {
    this.repo = customRepo;
  }
}
