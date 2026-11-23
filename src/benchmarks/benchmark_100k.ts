import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';
import { RedisStreamQueue } from '../queue/redisStreamQueue.js';
import { MemoryRepository } from '../db/repository.js';
import { MockProvider } from '../providers/mockProvider.js';
import { EmailWorker } from '../worker/worker.js';

export async function run100kBenchmark() {
  process.env.LOG_LEVEL = 'warn';

  console.log('\n======================================================');
  console.log('🚀 RUNNING BENCHMARK: 100,000 EMAIL REQUESTS');
  console.log('======================================================');

  const TOTAL_REQUESTS = 100000;
  const queue = new RedisStreamQueue();
  const db = new MemoryRepository();
  const provider = new MockProvider({ simulatedLatencyMs: 0 });

  // Phase 1: Ingestion & Enqueueing
  console.log(`[Phase 1] Enqueueing ${TOTAL_REQUESTS.toLocaleString()} email requests into Redis Stream...`);
  const enqueueStart = performance.now();
  const latencies: number[] = [];

  const BATCH_SIZE = 250;
  for (let i = 0; i < TOTAL_REQUESTS; i += BATCH_SIZE) {
    const chunkPromises = [];
    for (let j = 0; j < BATCH_SIZE && i + j < TOTAL_REQUESTS; j++) {
      const itemStart = performance.now();
      const requestId = uuidv4();
      const p = queue
        .enqueue({
          requestId,
          userId: `user_${(i + j) % 2000}`,
          recipient: `load_${i + j}@benchmark.internal`,
          subject: `Benchmark 100K test #${i + j}`,
          attempt: 0,
          maxRetries: 3,
          enqueuedAt: Date.now(),
        })
        .then(() => {
          if ((i + j) % 10 === 0) {
            latencies.push(performance.now() - itemStart);
          }
        });
      chunkPromises.push(p);
    }
    await Promise.all(chunkPromises);
    if (i % 25000 === 0 && i > 0) {
      console.log(`   Progress: ${i.toLocaleString()} / ${TOTAL_REQUESTS.toLocaleString()} enqueued...`);
    }
  }

  const enqueueDurationSec = (performance.now() - enqueueStart) / 1000;
  const enqueueRps = TOTAL_REQUESTS / enqueueDurationSec;

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)].toFixed(2);
  const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(2);
  const p99 = latencies[Math.floor(latencies.length * 0.99)].toFixed(2);

  console.log(`✅ Ingestion Complete:`);
  console.log(`   - Total Enqueued: ${TOTAL_REQUESTS.toLocaleString()}`);
  console.log(`   - Ingestion Duration: ${enqueueDurationSec.toFixed(2)} seconds`);
  console.log(`   - Enqueue Throughput: ${Math.round(enqueueRps).toLocaleString()} req/sec`);
  console.log(`   - Enqueue Latency: p50 = ${p50}ms | p95 = ${p95}ms | p99 = ${p99}ms`);

  // Phase 2: High-Concurrency Multi-Worker Processing
  const workerCount = 8;
  const concurrencyPerWorker = 100;
  console.log(`\n[Phase 2] Spawning ${workerCount} Workers (Total Parallel Slots: ${workerCount * concurrencyPerWorker})...`);

  const workers: EmailWorker[] = [];
  for (let w = 0; w < workerCount; w++) {
    const worker = new EmailWorker(queue, db, provider, {
      workerId: `bench-100k-worker-${w}`,
      concurrency: concurrencyPerWorker,
      batchSize: 200,
    });
    workers.push(worker);
  }

  const workerStart = performance.now();
  await Promise.all(workers.map((w) => w.start()));

  let remaining = await queue.getQueueDepth();
  while (remaining > 0) {
    process.stdout.write(`   Remaining jobs in queue: ${remaining.toLocaleString()}...\r`);
    await new Promise((r) => setTimeout(r, 500));
    remaining = await queue.getQueueDepth();
  }
  process.stdout.write(`   Remaining jobs in queue: 0                           \n`);

  await Promise.all(workers.map((w) => w.stop()));

  const workerDurationSec = (performance.now() - workerStart) / 1000;
  const processRps = TOTAL_REQUESTS / workerDurationSec;

  console.log(`✅ Worker Processing Complete:`);
  console.log(`   - Total Processed & Delivered: ${TOTAL_REQUESTS.toLocaleString()}`);
  console.log(`   - Duration: ${workerDurationSec.toFixed(2)} seconds`);
  console.log(`   - Throughput: ${Math.round(processRps).toLocaleString()} emails/sec`);
  console.log(`   - DLQ Count: ${await queue.getDlqDepth()}`);
  console.log('======================================================\n');

  await queue.close();

  return {
    test: '100,000 Emails',
    enqueueRps: Math.round(enqueueRps),
    enqueueP50: p50,
    enqueueP95: p95,
    enqueueP99: p99,
    workerRps: Math.round(processRps),
    durationSec: (enqueueDurationSec + workerDurationSec).toFixed(2),
  };
}

if (process.argv[1]?.includes('benchmark_100k')) {
  run100kBenchmark().then(() => process.exit(0));
}
