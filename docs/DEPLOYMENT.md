# Postal Nexus: Production Deployment Guide

## 1. Quickstart with Docker Compose

To boot the complete distributed infrastructure locally or on a single VM:

```bash
cd mailer-service/docker
docker compose up -d --build
```

### Services Launched:
- `api-gateway` (2 scaled instances on ports 3000-3001)
- `worker` (3 background worker instances)
- `postgres` (PostgreSQL 16 with schema initialized)
- `redis` (Redis 7.2 with AOF persistence & stream configuration)
- `mailhog` (SMTP mock sink on port 1025 with web UI at http://localhost:8025)
- `prometheus` (Scraping API and worker metrics at http://localhost:9090)
- `grafana` (Pre-configured dashboard at http://localhost:3005 - user `admin`, password `admin`)

---

## 2. Kubernetes Deployment

To deploy to a production Kubernetes cluster (EKS, GKE, AKS, or bare metal):

```bash
# 1. Create namespace & secrets
kubectl create namespace mailer
kubectl create secret generic mailer-secrets -n mailer \
  --from-literal=pg-password="your-secure-pg-password" \
  --from-literal=jwt-secret="your-32-char-jwt-secret-key" \
  --from-literal=webhook-secret="your-webhook-secret-key" \
  --from-literal=smtp-user="relay-user" \
  --from-literal=smtp-pass="relay-pass"

# 2. Deploy StatefulSets (PostgreSQL & Redis)
kubectl apply -f k8s/postgres-statefulset.yaml -n mailer
kubectl apply -f k8s/redis-statefulset.yaml -n mailer

# 3. Deploy API Gateway and Workers
kubectl apply -f k8s/api-deployment.yaml -n mailer
kubectl apply -f k8s/worker-deployment.yaml -n mailer

# 4. Deploy Horizontal Pod Autoscalers
kubectl apply -f k8s/hpa.yaml -n mailer
```

---

## 3. Environment Variables Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Runtime environment (`production`, `development`, `test`) |
| `PORT` | `3000` | HTTP listen port for API Gateway |
| `REDIS_HOST` | `127.0.0.1` | Redis host address |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_STREAM_NAME` | `email:stream:incoming` | Primary incoming email stream key |
| `REDIS_DLQ_STREAM_NAME`| `email:stream:dlq` | Dead Letter Queue stream key |
| `MAX_QUEUE_DEPTH` | `1000000` | Backpressure ceiling before rejecting requests with 503 |
| `PGHOST` | `127.0.0.1` | PostgreSQL database host |
| `PGPORT` | `5432` | PostgreSQL database port |
| `PGDATABASE` | `mailer_db` | PostgreSQL database name |
| `PGUSER` | `postgres` | PostgreSQL username |
| `PGPASSWORD` | `postgres` | PostgreSQL password |
| `PG_MAX_CONNECTIONS` | `50` | Database connection pool ceiling |
| `WORKER_CONCURRENCY` | `25` | Concurrent jobs per worker process |
| `WORKER_BATCH_SIZE` | `50` | Number of messages read per `XREADGROUP` call |
| `WORKER_MAX_RETRIES` | `3` | Maximum retry attempts before routing to DLQ |
| `EMAIL_PROVIDER` | `mock` | Delivery provider (`smtp`, `mock`, `failover`) |
| `SMTP_HOST` | `127.0.0.1` | Upstream SMTP relay host |
| `SMTP_PORT` | `1025` | Upstream SMTP relay port |
| `JWT_SECRET` | *(required)* | Secret for signing & verifying JWTs |
| `WEBHOOK_SECRET` | *(required)* | Secret for verifying HMAC delivery webhooks |
| `ADMIN_API_KEYS` | `admin-api-key-master-777` | Comma-separated admin API keys |
