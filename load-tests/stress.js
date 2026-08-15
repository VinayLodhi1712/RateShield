// k6 stress test — ramped load testing to measure saturation and latency under heavy concurrency.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '15s', target: 20 },  // Ramp up to 20 VUs
    { duration: '30s', target: 60 },  // Ramp up to 60 VUs
    { duration: '15s', target: 0 },   // Ramp down to 0 VUs
  ],
  thresholds: {
    http_req_duration: ['p(99)<300'], // 99% of requests under 300ms
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:3000';

export default function () {
  const res = http.get(`${BASE_URL}/health`);

  check(res, {
    'status is expected': (r) => [200, 429].includes(r.status),
    'response under 200ms': (r) => r.timings.duration < 200,
  });

  sleep(0.05);
}
