'use strict';

// Integration tests for Rate Limiting Middleware — see API.md §5, §11.
const request = require('supertest');
const app = require('../../src/app');
const { redis } = require('../../src/config/redis');
const redisConfig = require('../../src/config/redis');
const dbConfig = require('../../src/config/db');

jest.mock('../../src/config/redis', () => ({
  redis: {
    eval: jest.fn(),
  },
  pingRedis: jest.fn(),
  closeRedis: jest.fn(),
}));

jest.mock('../../src/config/db', () => ({
  query: jest.fn(),
  pingDb: jest.fn(),
  closeDb: jest.fn(),
}));

describe('Rate Limiting Middleware (Integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should set X-RateLimit headers on allowed requests', async () => {
    redis.eval.mockResolvedValue([1, 1, 99]);
    redisConfig.pingRedis.mockResolvedValue({ status: 'healthy', latencyMs: 1 });
    dbConfig.pingDb.mockResolvedValue({ status: 'healthy', latencyMs: 1 });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('100');
    expect(res.headers['x-ratelimit-remaining']).toBe('99');
    expect(res.headers['x-ratelimit-algorithm']).toBe('fixed_window');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('should return 429 Too Many Requests when rate limit exceeded', async () => {
    redis.eval.mockResolvedValue([0, 100, 0]);

    const res = await request(app).get('/health');

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('should fail-open when Redis throws error on default policy', async () => {
    redis.eval.mockRejectedValue(new Error('Redis connection lost'));
    redisConfig.pingRedis.mockResolvedValue({ status: 'unhealthy', error: 'Redis down' });
    dbConfig.pingDb.mockResolvedValue({ status: 'healthy' });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-fallback']).toBe('true');
  });
});
