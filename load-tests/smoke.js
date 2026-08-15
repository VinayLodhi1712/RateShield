// k6 smoke test — baseline sanity verification under minimal concurrency.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 3,
  duration: '15s',
  thresholds: {
    http_req_duration: ['p(95)<100'], // 95% of requests should be < 100ms
    http_req_failed: ['rate<0.01'],    // Error rate under 1%
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:3000';

export default function () {
  // 1. Health check
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health status is 200': (r) => r.status === 200,
    'has valid JSON': (r) => r.json('success') === true,
  });

  // 2. Metrics endpoint
  const metricsRes = http.get(`${BASE_URL}/metrics`);
  check(metricsRes, {
    'metrics status is 200': (r) => r.status === 200,
    'contains rateshield metrics': (r) => r.body.includes('rateshield_http_requests_total'),
  });

  sleep(0.5);
}
