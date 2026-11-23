import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    constant_rate: {
      executor: 'constant-arrival-rate',
      rate: 1000, // 1000 requests per second
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 100,
      maxVUs: 300,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<100'],
  },
};

const BASE_URL = 'http://localhost:3000';

export default function () {
  const userId = `vu_user_${Math.floor(Math.random() * 1000000) + 1}`;
  const payload = JSON.stringify({
    recipient: `${userId}@perf.internal`,
    subject: 'High Throughput k6 Test',
    body_text: 'Payload for high throughput validation',
  });

  const res = http.post(`${BASE_URL}/api/v1/emails/send`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': userId,
    },
  });

  check(res, {
    'status is 202': (r) => r.status === 202,
  });
}
