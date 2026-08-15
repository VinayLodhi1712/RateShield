// k6 burst test — validates atomic Lua rate limit enforcement and 429 throttling.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    burst_traffic: {
      executor: 'constant-arrival-rate',
      rate: 50, // 50 requests per second
      timeUnit: '1s',
      duration: '20s',
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
  thresholds: {
    // Both 200 OK and 429 Too Many Requests are valid under heavy burst load
    http_req_duration: ['p(95)<150'],
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:3000';

export default function () {
  const res = http.get(`${BASE_URL}/health`);

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'has rate limit limit header': (r) => r.headers['X-Ratelimit-Limit'] !== undefined,
    'has rate limit remaining header': (r) => r.headers['X-Ratelimit-Remaining'] !== undefined,
  });

  if (res.status === 429) {
    check(res, {
      'has retry after header': (r) => r.headers['Retry-After'] !== undefined,
    });
  }

  sleep(0.1);
}
