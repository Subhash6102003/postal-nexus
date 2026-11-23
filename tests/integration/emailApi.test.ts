import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createServer } from '../../src/api/server.js';
import { TokenManager } from '../../src/security/token.js';
import { WebhookVerifier } from '../../src/security/webhookVerifier.js';
import { DbManager, MemoryRepository } from '../../src/db/repository.js';
import { MemoryQueue } from '../../src/queue/memoryQueue.js';
import { setQueueInstance } from '../../src/api/controllers/email.controller.js';
import { config } from '../../src/config/index.js';

describe('Email API Integration Tests', () => {
  const app = createServer();
  const testQueue = new MemoryQueue();
  const testDb = new MemoryRepository();

  // Distinct test user tokens to avoid cross-test rate limit collision
  const authUserToken = TokenManager.generateJwt({
    userId: 'integration_user_auth',
    email: 'auth@example.com',
    role: 'user',
  });

  const validUserToken = TokenManager.generateJwt({
    userId: 'integration_user_valid',
    email: 'valid@example.com',
    role: 'user',
  });

  const idemUserToken = TokenManager.generateJwt({
    userId: 'integration_user_idem',
    email: 'idem@example.com',
    role: 'user',
  });

  const trackUserToken = TokenManager.generateJwt({
    userId: 'integration_user_track',
    email: 'track@example.com',
    role: 'user',
  });

  const otherUserToken = TokenManager.generateJwt({
    userId: 'integration_user_other',
    email: 'other@example.com',
    role: 'user',
  });

  const webhookUserToken = TokenManager.generateJwt({
    userId: 'integration_user_webhook',
    email: 'webhook@example.com',
    role: 'user',
  });

  const adminToken = TokenManager.generateJwt({
    userId: 'admin_user_01',
    email: 'admin@system.local',
    role: 'admin',
    rateLimitOverride: 1000,
  });

  beforeAll(async () => {
    DbManager.setRepository(testDb);
    setQueueInstance(testQueue);
    await testDb.upsertUser({ id: 'integration_user_auth', email: 'auth@example.com', role: 'user' });
    await testDb.upsertUser({ id: 'integration_user_valid', email: 'valid@example.com', role: 'user' });
    await testDb.upsertUser({ id: 'integration_user_idem', email: 'idem@example.com', role: 'user' });
    await testDb.upsertUser({ id: 'integration_user_track', email: 'track@example.com', role: 'user' });
    await testDb.upsertUser({ id: 'integration_user_other', email: 'other@example.com', role: 'user' });
    await testDb.upsertUser({ id: 'integration_user_webhook', email: 'webhook@example.com', role: 'user' });
  });

  describe('Authentication & Authorization', () => {
    it('should reject unauthenticated requests with 401', async () => {
      const res = await request(app).post('/api/v1/emails/send').send({
        recipient: 'test@example.com',
        subject: 'Hello',
        body_text: 'Body',
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('should accept requests with valid Bearer token', async () => {
      const res = await request(app)
        .post('/api/v1/emails/send')
        .set('Authorization', `Bearer ${authUserToken}`)
        .send({
          recipient: 'test@example.com',
          subject: 'Valid Auth Test',
          body_text: 'Hello authenticated world',
        });
      expect(res.status).toBe(202);
      expect(res.body.requestId).toBeDefined();
    });

    it('should accept requests with valid admin API key', async () => {
      const res = await request(app)
        .post('/api/v1/emails/send')
        .set('X-API-Key', config.security.adminApiKeys[0])
        .send({
          recipient: 'test@example.com',
          subject: 'Admin API Key Test',
          body_text: 'Hello from admin API key',
        });
      expect(res.status).toBe(202);
    });
  });

  describe('Validation & Header Injection Protection', () => {
    it('should reject invalid recipient email with 400', async () => {
      const res = await request(app)
        .post('/api/v1/emails/send')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          recipient: 'not-an-email',
          subject: 'Invalid email test',
          body_text: 'test',
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Bad Request');
    });

    it('should reject missing body content with 400', async () => {
      const res = await request(app)
        .post('/api/v1/emails/send')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          recipient: 'valid@example.com',
          subject: 'No body',
        });
      expect(res.status).toBe(400);
    });
  });

  describe('Idempotency & Duplicate Prevention', () => {
    it('should return identical requestId when idempotency_key is reused', async () => {
      const idempotencyKey = 'unique-tx-key-445566';

      // 1st submission
      const res1 = await request(app)
        .post('/api/v1/emails/send')
        .set('Authorization', `Bearer ${idemUserToken}`)
        .send({
          recipient: 'idem@example.com',
          subject: 'Idempotent Email',
          body_text: 'This should only be enqueued once',
          idempotency_key: idempotencyKey,
        });

      expect(res1.status).toBe(202);
      const originalRequestId = res1.body.requestId;

      // 2nd submission with same idempotency key
      const res2 = await request(app)
        .post('/api/v1/emails/send')
        .set('Authorization', `Bearer ${idemUserToken}`)
        .send({
          recipient: 'idem@example.com',
          subject: 'Idempotent Email',
          body_text: 'This should only be enqueued once',
          idempotency_key: idempotencyKey,
        });

      expect(res2.status).toBe(200);
      expect(res2.body.requestId).toBe(originalRequestId);
      expect(res2.body.message).toContain('idempotency match');
    });
  });

  describe('Status Tracking & Cross-User Security', () => {
    let createdRequestId: string;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/v1/emails/send')
        .set('Authorization', `Bearer ${trackUserToken}`)
        .send({
          recipient: 'track@example.com',
          subject: 'Track Status',
          body_text: 'Tracking test',
        });
      expect(res.status).toBe(202);
      createdRequestId = res.body.requestId;
    });

    it('should retrieve status for own email request', async () => {
      const res = await request(app)
        .get(`/api/v1/emails/${createdRequestId}`)
        .set('Authorization', `Bearer ${trackUserToken}`);

      expect(res.status).toBe(200);
      expect(res.body.requestId).toBe(createdRequestId);
      expect(res.body.recipient).toBe('track@example.com');
      expect(res.body.status).toBe('QUEUED');
    });

    it('should forbid other non-admin users from accessing the email record (403)', async () => {
      const res = await request(app)
        .get(`/api/v1/emails/${createdRequestId}`)
        .set('Authorization', `Bearer ${otherUserToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
    });

    it('should allow admin users to inspect any email record', async () => {
      const res = await request(app)
        .get(`/api/v1/emails/${createdRequestId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.requestId).toBe(createdRequestId);
    });

    it('should return paginated email history for user', async () => {
      const res = await request(app)
        .get('/api/v1/emails?page=1&limit=10')
        .set('Authorization', `Bearer ${trackUserToken}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toBeInstanceOf(Array);
      expect(res.body.total).toBeGreaterThan(0);
    });
  });

  describe('Webhooks & HMAC Verification', () => {
    it('should reject webhooks with missing or invalid signature (401)', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks/email-status')
        .send({ requestId: 'req-1', event: 'delivered' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid webhook signature');
    });

    it('should verify valid HMAC signature and transition status to DELIVERED', async () => {
      // Create an email first
      const sendRes = await request(app)
        .post('/api/v1/emails/send')
        .set('Authorization', `Bearer ${webhookUserToken}`)
        .send({
          recipient: 'webhook@example.com',
          subject: 'Webhook Test',
          body_text: 'Body',
        });

      expect(sendRes.status).toBe(202);
      const reqId = sendRes.body.requestId;
      const payload = JSON.stringify({
        requestId: reqId,
        event: 'delivered',
        providerId: 'smtp-primary',
        details: 'Delivered to recipient MTA 250 OK',
      });

      const signature = WebhookVerifier.createSignature(payload);

      const res = await request(app)
        .post('/api/v1/webhooks/email-status')
        .set('Content-Type', 'application/json')
        .set('X-Webhook-Signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);

      // Verify status in DB updated to DELIVERED
      const statusRes = await request(app)
        .get(`/api/v1/emails/${reqId}`)
        .set('Authorization', `Bearer ${webhookUserToken}`);

      expect(statusRes.body.status).toBe('DELIVERED');
      expect(statusRes.body.deliveredAt).not.toBeNull();
    });
  });

  describe('Health, Readiness & Metrics', () => {
    it('should return health check 200', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.checks).toBeDefined();
    });

    it('should return readiness 200', async () => {
      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
    });

    it('should return prometheus metrics', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toContain('mailer_http_requests_total');
      expect(res.text).toContain('mailer_queue_depth');
    });
  });
});
