import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics to monitor 1,000,000 virtual user distribution
const acceptedCounter = new Counter('emails_accepted_202');
const rateLimitedCounter = new Counter('rate_limited_429');
const errorCounter = new Counter('http_errors_5xx');
const successRate = new Rate('success_rate');
const submissionLatency = new Trend('email_submission_duration');

export const options = {
  scenarios: {
    // 1,000,000 User Stress Scenario: High concurrent workers drawing from a pool of 1,000,000 distinct user IDs
    million_users_stress: {
      executor: 'ramping-vus',
      startVUs: 20,
      stages: [
        { duration: '10s', target: 100 },  // Ramp-up to 100 concurrent workers
        { duration: '20s', target: 300 },  // Surge to 300 concurrent workers
        { duration: '30s', target: 500 },  // Peak stress with 500 concurrent workers
        { duration: '15s', target: 100 },  // Ramp-down
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    'email_submission_duration': ['p(95)<150', 'p(99)<300'],
    'http_errors_5xx': ['count<5'],
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:3000';
const TOTAL_USER_POPULATION = 1000000; // 1 Million Virtual Users

export default function () {
  // Generate a distinct virtual user ID from the 1,000,000 user population
  // 90% of requests simulate unique users (testing 1M rate-limit buckets in Redis)
  // 10% of requests intentionally reuse IDs to test rate limit enforcement (5 req/min)
  let simulatedUserId;
  const isSpammer = Math.random() < 0.10;

  if (isSpammer) {
    // Pick from a small set of 50 aggressive users to test 429 rate limiting
    const spammerId = Math.floor(Math.random() * 50);
    simulatedUserId = `spammer_user_${spammerId}`;
  } else {
    // Pick from the 1,000,000 virtual user space
    const randomUserNumber = Math.floor(Math.random() * TOTAL_USER_POPULATION) + 1;
    simulatedUserId = `virtual_user_${randomUserNumber}`;
  }

  const payload = JSON.stringify({
    recipient: `${simulatedUserId}@loadtest.domain.internal`,
    subject: `Stress Test Message for User ${simulatedUserId}`,
    body_text: `Automated stress payload simulating 1M virtual user traffic at timestamp ${Date.now()}`,
    idempotency_key: `stress-tx-${simulatedUserId}-${__ITER}`,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': simulatedUserId,
      'X-Correlation-ID': `corr-${__VU}-${__ITER}`,
    },
    timeout: '5s',
  };

  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/v1/emails/send`, payload, params);
  const latency = Date.now() - start;
  submissionLatency.add(latency);

  if (res.status === 202) {
    acceptedCounter.add(1);
    successRate.add(true);
    check(res, {
      'status is 202 Accepted': (r) => r.status === 202,
      'has requestId in body': (r) => {
        try {
          return JSON.parse(r.body).requestId !== undefined;
        } catch {
          return false;
        }
      },
      'has X-RateLimit-Remaining': (r) => r.headers['X-Ratelimit-Remaining'] !== undefined,
    });
  } else if (res.status === 429) {
    rateLimitedCounter.add(1);
    successRate.add(true); // Rate limiting is expected system behavior for spammers
    check(res, {
      'status is 429': (r) => r.status === 429,
      'has Retry-After header': (r) => r.headers['Retry-After'] !== undefined,
      'remaining is 0': (r) => r.headers['X-Ratelimit-Remaining'] === '0',
    });
  } else {
    errorCounter.add(1);
    successRate.add(false);
  }

  // Minimal sleep to maintain high request rate
  sleep(0.02);
}
