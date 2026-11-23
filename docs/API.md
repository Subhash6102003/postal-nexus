# Postal Nexus API Specification

Base URL: `http://localhost:3000`

---

## 1. Authentication

All requests (except health check and webhooks) require authentication via **Bearer Token (JWT)** or **API Key**:

### Bearer Token
```http
Authorization: Bearer <jwt-token>
```

### API Key
```http
X-API-Key: pm_live_abcdef1234567890
```

---

## 2. Endpoints

### 2.1 Submit Email Request

**`POST /api/v1/emails/send`**

Submits an email request for asynchronous delivery. Applies per-user rate limiting (5 req/min).

#### Headers
- `Authorization: Bearer <jwt>`
- `Content-Type: application/json`
- `X-Correlation-ID: <uuid>` (Optional, auto-generated if omitted)

#### Request Body
```json
{
  "recipient": "customer@example.com",
  "subject": "Order Confirmation #88392",
  "body_text": "Thank you for your order! Your items will ship soon.",
  "body_html": "<h1>Order Confirmed!</h1><p>Thank you for your purchase.</p>",
  "idempotency_key": "order-88392-checkout",
  "template_id": "welcome",
  "template_variables": {
    "name": "Jane Doe",
    "userId": "usr_77665"
  }
}
```

#### Success Response (HTTP 202 Accepted)
```http
HTTP/1.1 202 Accepted
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4
X-RateLimit-Reset: 1700000060
X-Correlation-ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890
Content-Type: application/json

{
  "status": "accepted",
  "message": "Email request accepted and queued for asynchronous delivery",
  "requestId": "4c94db81-4b16-419b-a0d3-3b1bfecb52a3",
  "idempotencyKey": "order-88392-checkout",
  "recipient": "customer@example.com",
  "queuedAt": "2026-11-23T14:00:00.000Z"
}
```

#### Idempotency Duplicate Response (HTTP 200 OK)
When submitting with an existing `idempotency_key` that was already accepted:
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "message": "Request already processed (idempotency match)",
  "requestId": "4c94db81-4b16-419b-a0d3-3b1bfecb52a3",
  "status": "QUEUED",
  "createdAt": "2026-11-23T14:00:00.000Z"
}
```

#### Rate Limit Exceeded (HTTP 429 Too Many Requests)
When user exceeds 5 email requests in the current 60-second window:
```http
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
Retry-After: 42
Content-Type: application/json

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Each user can submit a maximum of 5 email requests per minute.",
  "limit": 5,
  "remaining": 0,
  "retryAfterSeconds": 42
}
```

---

### 2.2 Retrieve Email Status

**`GET /api/v1/emails/:requestId`**

Retrieves the current lifecycle status and delivery logs for a specific email request.

#### Success Response (HTTP 200 OK)
```json
{
  "requestId": "4c94db81-4b16-419b-a0d3-3b1bfecb52a3",
  "userId": "usr_77665",
  "recipient": "customer@example.com",
  "subject": "Order Confirmation #88392",
  "status": "SENT",
  "attemptCount": 1,
  "maxRetries": 3,
  "providerId": "smtp-primary",
  "lastError": null,
  "createdAt": "2026-11-23T14:00:00.000Z",
  "updatedAt": "2026-11-23T14:00:01.200Z",
  "sentAt": "2026-11-23T14:00:01.150Z",
  "deliveredAt": null,
  "logs": [
    {
      "attempt": 1,
      "status": "SENT",
      "provider": "smtp-primary",
      "durationMs": 142,
      "error": null,
      "createdAt": "2026-11-23T14:00:01.150Z"
    }
  ]
}
```

---

### 2.3 List User Email History

**`GET /api/v1/emails?page=1&limit=20`**

Retrieves paginated delivery history for the authenticated user.

#### Success Response (HTTP 200 OK)
```json
{
  "page": 1,
  "limit": 20,
  "total": 45,
  "totalPages": 3,
  "items": [
    {
      "requestId": "4c94db81-4b16-419b-a0d3-3b1bfecb52a3",
      "recipient": "customer@example.com",
      "subject": "Order Confirmation #88392",
      "status": "SENT",
      "attemptCount": 1,
      "createdAt": "2026-11-23T14:00:00.000Z",
      "sentAt": "2026-11-23T14:00:01.150Z",
      "deliveredAt": null
    }
  ]
}
```

---

### 2.4 Webhook: Delivery Events

**`POST /api/v1/webhooks/email-status`**

Webhook endpoint for downstream email delivery providers to confirm mailbox delivery (`delivered`) or bounces (`bounced`).

#### Headers
- `Content-Type: application/json`
- `X-Webhook-Signature: v1=<hmac-sha256-hex>`
- `X-Webhook-Timestamp: <epoch-seconds>`

#### Request Body
```json
{
  "requestId": "4c94db81-4b16-419b-a0d3-3b1bfecb52a3",
  "event": "delivered",
  "providerId": "sendgrid-relay",
  "timestamp": "2026-11-23T14:01:05.000Z",
  "details": "250 2.1.5 Recipient OK"
}
```

#### Success Response (HTTP 200 OK)
```json
{
  "received": true,
  "requestId": "4c94db81-4b16-419b-a0d3-3b1bfecb52a3",
  "event": "delivered"
}
```

---

### 2.5 Health & Observability

- **`GET /health`**: Returns system health breakdown (Redis connection, PostgreSQL pool, queue depths).
- **`GET /ready`**: Readiness probe for Kubernetes / load balancers.
- **`GET /metrics`**: Prometheus standard metrics endpoint.
