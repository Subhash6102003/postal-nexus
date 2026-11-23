import { performance } from 'perf_hooks';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { RedisStreamQueue } from '../queue/redisStreamQueue.js';
import { config } from '../config/index.js';

export async function run1mBenchmark() {
  process.env.LOG_LEVEL = 'warn';

  console.log('\n======================================================');
  console.log('🚀 RUNNING BENCHMARK: 1,000,000 QUEUED EMAIL REQUESTS');
  console.log('======================================================');

  const TOTAL_REQUESTS = 1000000;
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  });

  const streamKey = 'email:stream:benchmark_1m';
  const groupName = 'bench-1m-group';

  // Clean prior benchmark stream if exists
  await redis.del(streamKey);

  try {
    await redis.xgroup('CREATE', streamKey, groupName, '$', 'MKSTREAM');
  } catch {}

  console.log(`[Phase 1] Pipelined Stream Ingestion: Inserting 1,000,000 jobs into ${streamKey}...`);
  const ingestionStart = performance.now();

  const PIPELINE_CHUNK = 5000;
  let enqueued = 0;

  for (let i = 0; i < TOTAL_REQUESTS; i += PIPELINE_CHUNK) {
    const pipeline = redis.pipeline();
    for (let j = 0; j < PIPELINE_CHUNK && i + j < TOTAL_REQUESTS; j++) {
      const idx = i + j;
      const reqId = uuidv4();
      pipeline.xadd(
        streamKey,
        '*',
        'requestId',
        reqId,
        'userId',
        `user_${idx % 10000}`,
        'recipient',
        `user_${idx}@domain.internal`,
        'subject',
        `Mass delivery notification #${idx}`,
        'attempt',
        '0',
        'maxRetries',
        '3',
        'enqueuedAt',
        Date.now().toString()
      );
    }
    await pipeline.exec();
    enqueued += PIPELINE_CHUNK;

    if (enqueued % 100000 === 0) {
      const elapsed = (performance.now() - ingestionStart) / 1000;
      const rate = Math.round(enqueued / elapsed);
      console.log(`   Progress: ${enqueued.toLocaleString()} / ${TOTAL_REQUESTS.toLocaleString()} enqueued (${rate.toLocaleString()} ops/sec)...`);
    }
  }

  const ingestionSec = (performance.now() - ingestionStart) / 1000;
  const ingestionThroughput = Math.round(TOTAL_REQUESTS / ingestionSec);

  const streamLength = await redis.xlen(streamKey);
  const memoryInfo = await redis.memory('USAGE', streamKey);
  const memoryMb = (Number(memoryInfo) / (1024 * 1024)).toFixed(2);

  console.log(`\n✅ 1,000,000 Ingestion Results:`);
  console.log(`   - Verified Stream Length (XLEN): ${streamLength.toLocaleString()}`);
  console.log(`   - Total Ingestion Time: ${ingestionSec.toFixed(2)} seconds`);
  console.log(`   - Peak Ingestion Throughput: ${ingestionThroughput.toLocaleString()} ops/sec`);
  console.log(`   - Total Redis Memory Footprint: ${memoryMb} MB (~${(Number(memoryInfo) / TOTAL_REQUESTS).toFixed(1)} bytes/message)`);

  // Phase 2: High-Volume Consumer Group Read & Dequeue Verification
  console.log(`\n[Phase 2] Benchmark Consumer Dequeue & Acknowledgment Throughput...`);
  const sampleReadCount = 50000;
  const dequeueStart = performance.now();

  let dequeued = 0;
  const READ_BATCH = 1000;
  while (dequeued < sampleReadCount) {
    const res = (await redis.xreadgroup(
      'GROUP',
      groupName,
      'benchmark-consumer-01',
      'COUNT',
      READ_BATCH,
      'STREAMS',
      streamKey,
      '>'
    )) as any;

    if (!res || res.length === 0) break;
    const entries = res[0][1];
    const ids = entries.map((e: any) => e[0]);

    // Batch ACK & Delete
    await redis.xack(streamKey, groupName, ...ids);
    await redis.xdel(streamKey, ...ids);
    dequeued += ids.length;
  }

  const dequeueSec = (performance.now() - dequeueStart) / 1000;
  const dequeueThroughput = Math.round(dequeued / dequeueSec);

  console.log(`✅ Consumer Group Dequeue Results (Sample 50,000):`);
  console.log(`   - Processed & Acknowledged: ${dequeued.toLocaleString()}`);
  console.log(`   - Duration: ${dequeueSec.toFixed(2)} seconds`);
  console.log(`   - Consumer Group Throughput: ${dequeueThroughput.toLocaleString()} messages/sec`);

  // Cleanup benchmark stream
  console.log(`\nCleaning up temporary benchmark stream...`);
  await redis.del(streamKey);
  await redis.quit();

  console.log('======================================================\n');

  return {
    test: '1,000,000 Emails',
    ingestionRps: ingestionThroughput,
    ingestionSec: ingestionSec.toFixed(2),
    memoryMb,
    consumerRps: dequeueThroughput,
  };
}

if (process.argv[1]?.includes('benchmark_1m')) {
  run1mBenchmark().then(() => process.exit(0));
}
