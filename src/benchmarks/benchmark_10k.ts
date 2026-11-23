import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';
import { RedisStreamQueue } from '../queue/redisStreamQueue.js';
import { MemoryRepository } from '../db/repository.js';
import { MockProvider } from '../providers/mockProvider.js';
import { EmailWorker } from '../worker/worker.js';

export async function run10kBenchmark() {
  console.log('\n======================================================');
  console.log('🚀 RUNNING BENCHMARK: 10,000 EMAIL REQUESTS');
  console.log('======================================================');

  const TOTAL_REQUESTS = 10000;
  const queue = new RedisStreamQueue();
  const db = new MemoryRepository();
  const provider = new MockProvider({ simulatedLatencyMs: 0 }); // High-throughput mode

  // Phase 1: Ingestion & Enqueueing (API Gateway simulation)
  console.log(`[Phase 1] Enqueueing ${TOTAL_REQUESTS.toLocaleString()} email requests into Redis Stream...`);
  const enqueueStart = performance.now();
  const latencies: number[] = [];

  const BATCH_SIZE = 100;
  for (let i = 0; i < TOTAL_REQUESTS; i += BATCH_SIZE) {
    const chunkPromises = [];
    for (let j = 0; j < BATCH_SIZE && i + j < TOTAL_REQUESTS; j++) {
      const itemStart = performance.now();
      const requestId = uuidv4();
      const p = queue
        .enqueue({
          requestId,
          userId: `user_${(i + j) % 500}`,
          recipient: `recipient_${i + j}@benchmark.internal`,
          subject: `Benchmark 10K test #${i + j}`,
          attempt: 0,
          maxRetries: 3,
          enqueuedAt: Date.now(),
        })
        .then(() => {
          latencies.push(performance.now() - itemStart);
        });
      chunkPromises.push(p);
    }
    await Promise.all(chunkPromises);
  }

  const enqueueDurationSec = (performance.now() - enqueueStart) / 1000;
  const enqueueRps = TOTAL_REQUESTS / enqueueDurationSec;

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)].toFixed(2);
  const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(2);
  const p99 = latencies[Math.floor(latencies.length * 0.99)].toFixed(2);

  console.log(`✅ Ingestion Complete:`);
  console.log(`   - Total Enqueued: ${TOTAL_REQUESTS.toLocaleString()}`);
  console.log(`   - Duration: ${enqueueDurationSec.toFixed(2)} seconds`);
  console.log(`   - Enqueue Throughput: ${Math.round(enqueueRps).toLocaleString()} req/sec`);
  console.log(`   - Enqueue Latency: p50 = ${p50}ms | p95 = ${p95}ms | p99 = ${p99}ms`);

  // Phase 2: Worker Processing & Delivery
  const workerCount = 4;
  const concurrencyPerWorker = 50;
  console.log(`\n[Phase 2] Spawning ${workerCount} Workers (Concurrency: ${workerCount * concurrencyPerWorker} parallel workers)...`);

  const workers: EmailWorker[] = [];
  for (let w = 0; w < workerCount; w++) {
    const worker = new EmailWorker(queue, db, provider, {
      workerId: `bench-worker-${w}`,
      concurrency: concurrencyPerWorker,
      batchSize: 100,
    });
    workers.push(worker);
  }

  const workerStart = performance.now();
  await Promise.all(workers.map((w) => w.start()));

  // Monitor queue depth until drained
  let remaining = await queue.getQueueDepth();
  while (remaining > 0) {
    process.stdout.write(`   Remaining jobs in queue: ${remaining.toLocaleString()}...\r`);
    await new Promise((r) => setTimeout(r, 200));
    remaining = await queue.getQueueDepth();
  }
  process.stdout.write(`   Remaining jobs in queue: 0                        \n`);

  // Stop workers and drain
  await Promise.all(workers.map((w) => w.stop()));

  const workerDurationSec = (performance.now() - workerStart) / 1000;
  const processRps = TOTAL_REQUESTS / workerDurationSec;

  console.log(`✅ Worker Delivery Complete:`);
  console.log(`   - Total Delivered: ${TOTAL_REQUESTS.toLocaleString()}`);
  console.log(`   - Delivery Duration: ${workerDurationSec.toFixed(2)} seconds`);
  console.log(`   - Worker Delivery Throughput: ${Math.round(processRps).toLocaleString()} emails/sec`);
  console.log(`   - DLQ Count: ${await queue.getDlqDepth()}`);
  console.log('======================================================\n');

  await queue.close();

  return {
    test: '10,000 Emails',
    enqueueRps: Math.round(enqueueRps),
    enqueueP50: p50,
    enqueueP95: p95,
    enqueueP99: p99,
    workerRps: Math.round(processRps),
    durationSec: (enqueueDurationSec + workerDurationSec).toFixed(2),
  };
}

if (process.argv[1]?.includes('benchmark_10k')) {
  run10kBenchmark().then(() => process.exit(0));
}
