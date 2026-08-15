'use strict';

// Integration tests for Prometheus metrics scraper — see API.md §3.
const request = require('supertest');
const app = require('../../src/app');

jest.mock('../../src/config/redis', () => ({
  redis: {
    eval: jest.fn().mockResolvedValue([1, 1, 99]),
    get: jest.fn().mockResolvedValue('10'),
  },
  pingRedis: jest.fn().mockResolvedValue({ status: 'healthy' }),
  closeRedis: jest.fn(),
}));

describe('Prometheus Metrics Scraper (Integration)', () => {
  it('should scrape Prometheus formatted metrics at GET /metrics', async () => {
    // Generate sample HTTP traffic to populate metrics
    await request(app).get('/health');

    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('rateshield_http_requests_total');
    expect(res.text).toContain('rateshield_http_request_duration_seconds');
    expect(res.text).toContain('rateshield_ratelimit_decisions_total');
    expect(res.text).toContain('rateshield_process_cpu_user_seconds_total');
  });
});
