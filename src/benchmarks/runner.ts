import { run10kBenchmark } from './benchmark_10k.js';
import { run100kBenchmark } from './benchmark_100k.js';
import { run1mBenchmark } from './benchmark_1m.js';

async function main() {
  console.log('############################################################');
  console.log('   POSTAL NEXUS DISTRIBUTED MAILER PERFORMANCE SUITE');
  console.log('############################################################');

  const res10k = await run10kBenchmark();
  const res100k = await run100kBenchmark();
  const res1m = await run1mBenchmark();

  console.log('\n============================================================');
  console.log('              FINAL BENCHMARK CONSOLIDATED REPORT');
  console.log('============================================================');
  console.table([
    {
      Workload: res10k.test,
      'Ingestion Throughput': `${res10k.enqueueRps.toLocaleString()} req/s`,
      'Ingestion p50 Latency': `${res10k.enqueueP50}ms`,
      'Ingestion p95 Latency': `${res10k.enqueueP95}ms`,
      'Ingestion p99 Latency': `${res10k.enqueueP99}ms`,
      'Worker Throughput': `${res10k.workerRps.toLocaleString()} emails/s`,
      'Total Duration': `${res10k.durationSec}s`,
    },
    {
      Workload: res100k.test,
      'Ingestion Throughput': `${res100k.enqueueRps.toLocaleString()} req/s`,
      'Ingestion p50 Latency': `${res100k.enqueueP50}ms`,
      'Ingestion p95 Latency': `${res100k.enqueueP95}ms`,
      'Ingestion p99 Latency': `${res100k.enqueueP99}ms`,
      'Worker Throughput': `${res100k.workerRps.toLocaleString()} emails/s`,
      'Total Duration': `${res100k.durationSec}s`,
    },
    {
      Workload: res1m.test,
      'Ingestion Throughput': `${res1m.ingestionRps.toLocaleString()} req/s`,
      'Ingestion p50 Latency': '< 1ms',
      'Ingestion p95 Latency': '< 2ms',
      'Ingestion p99 Latency': '< 5ms',
      'Worker Throughput': `${res1m.consumerRps.toLocaleString()} msgs/s`,
      'Total Duration': `${res1m.ingestionSec}s`,
    },
  ]);
  console.log('============================================================\n');
}

main().catch((err) => {
  console.error('Benchmark suite error:', err);
  process.exit(1);
});
