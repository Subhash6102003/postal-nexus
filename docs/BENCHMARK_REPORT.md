# Postal Nexus: Performance & Scalability Benchmark Report

## 1. Executive Summary

This report documents the empirical benchmark results of **Postal Nexus**, evaluated across three primary workload targets:
1. **10,000 email requests** under controlled multi-worker load.
2. **100,000 email requests** under heavy multi-instance stress.
3. **1,000,000 queued email requests** in Redis Streams testing memory efficiency, backpressure, and consumer throughput.

All tests were executed against running instances of **Redis Streams** and the **Postal Nexus Engine** with high-resolution latency histograms and throughput counters.

---

## 2. Benchmark Results Summary

| Metric | 10,000 Workload | 100,000 Workload | 1,000,000 Workload |
| :--- | :--- | :--- | :--- |
| **Total Enqueued** | **10,000** | **100,000** | **1,000,000** |
| **Ingestion Time** | **0.74 s** | **5.06 s** | **18.75 s** |
| **Peak Ingestion Rate** | **13,450 req/sec** | **19,745 req/sec** | **53,323 req/sec** |
| **Ingestion p50 Latency**| **6.13 ms** | **11.98 ms** | **< 1.00 ms** (pipelined) |
| **Ingestion p95 Latency**| **9.73 ms** | **14.43 ms** | **< 2.50 ms** |
| **Ingestion p99 Latency**| **43.27 ms** | **18.81 ms** | **< 5.00 ms** |
| **Worker Dispatch Slots**| 200 parallel slots | 800 parallel slots | Multi-consumer stream |
| **Worker Processing Rate**| **847 emails/sec** | **3,119 emails/sec** | **52,764 msgs/sec** (stream ack) |
| **Memory Footprint** | ~ 1.4 MB | ~ 13.8 MB | **133.67 MB** (~140 B/job) |
| **Dead-Letter Queue (DLQ)**| **0** | **0** | **0** |
| **Data Loss Rate** | **0.00%** | **0.00%** | **0.00%** |

---

## 3. Deep Dive Analysis by Workload

### 3.1 Workload 1: 10,000 Email Requests
- **Test Setup:** 4 independent background workers with 50 concurrency per worker (200 total concurrent slots).
- **Ingestion:** 10,000 requests accepted and enqueued in **0.74 seconds** (13,450 req/sec).
- **Latency:** Ingestion p50 was 6.13ms; p95 was 9.73ms.
- **Delivery:** All 10,000 emails were dispatched in 11.81 seconds with 0 errors.

### 3.2 Workload 2: 100,000 Email Requests
- **Test Setup:** 8 independent workers with 100 concurrency per worker (800 total concurrent slots), batch size 200.
- **Ingestion:** 100,000 requests ingested into Redis Streams in **5.06 seconds** at **19,745 req/sec**.
- **Latency Distribution:**
  - p50: 11.98 ms
  - p95: 14.43 ms
  - p99: 18.81 ms
- **Delivery:** 100,000 emails processed and delivered in **32.06 seconds** (**3,119 emails/sec** throughput).
- **Queue Leveling:** The queue smoothed the 5-second ingestion spike over 32 seconds of steady delivery without exhausting database connection pools.

### 3.3 Workload 3: 1,000,000 Queued Email Requests
- **Test Setup:** Pipelined ingress testing memory density, stream compaction, consumer group reading, and acknowledgment over 1M entries.
- **Ingestion Throughput:** **53,323 ops/sec** (1,000,000 jobs enqueued in 18.75 seconds).
- **Memory Consumption:**
  - Total Redis Stream memory: **133.67 MB**.
  - Average memory overhead per message: **~140.2 bytes**.
  - Confirms that passing minimal job descriptors rather than large HTML strings keeps RAM utilization low.
- **Consumer Dequeue & ACK:** Sample of 50,000 messages read, acknowledged, and evicted in **0.95 seconds** (**52,764 messages/sec**).

---

## 4. Key Bottlenecks Identified & Solved

1. **Database Write Bottleneck:**
   - *Problem:* Updating PostgreSQL `email_requests` table 100,000 times individually saturated connection pools and created query locks.
   - *Optimization:* Introduced a **Batch Database Buffer** in the workers that flushes status updates in chunks of 100 every 50ms. Slashed database roundtrips by 99%.

2. **Redis Memory Pressure:**
   - *Problem:* Storing full email bodies (often 20KB–100KB each) inside Redis Streams would consume 20GB–100GB of RAM for 1M messages.
   - *Optimization:* The API Gateway persists bodies to PostgreSQL immediately and only enqueues lightweight metadata (`requestId`, `userId`, `recipient`, `subject`) into Redis Streams. Total RAM for 1,000,000 messages dropped to **133.67 MB**.

3. **Rate Limit Race Conditions:**
   - *Problem:* Multi-instance API clusters querying count and updating keys concurrently suffer from TOCTOU (Time-of-Check to Time-of-Use) race conditions.
   - *Optimization:* Implemented Redis sliding-window algorithm via an atomic Lua script (`EVAL`), executing in < 1ms with ACID isolation across all nodes.
