'use strict';

// Integration tests for GET /rate-limit/status — see API.md Section 9.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const config = require('../../src/config');
const redisConfig = require('../../src/config/redis');
const policyCache = require('../../src/services/policyCache.service');

jest.mock('../../src/config/redis', () => ({
  redis: {
    eval: jest.fn().mockResolvedValue([1, 1, 99]),
    get: jest.fn().mockResolvedValue('15'),
  },
  pingRedis: jest.fn().mockResolvedValue({ status: 'healthy' }),
  closeRedis: jest.fn(),
}));

jest.mock('../../src/services/policyCache.service');

describe('GET /rate-limit/status (Integration)', () => {
  const token = jwt.sign(
    { sub: 1, email: 'dev@rateshield.io', role: 'developer' },
    config.jwt.secret,
    { expiresIn: '15m' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    redisConfig.redis.eval.mockResolvedValue([1, 1, 99]);
    redisConfig.redis.get.mockResolvedValue('15');
    policyCache.resolvePolicy.mockResolvedValue({
      id: 1,
      name: 'Developer Policy',
      algorithm: 'fixed_window',
      limit_count: 100,
      window_seconds: 60,
      failure_mode: 'open',
    });
  });

  it('should return 200 and rate limit status for authenticated user', async () => {
    const res = await request(app)
      .get('/rate-limit/status?endpoint=GET%20%2Fapi%2Fdata')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.endpoint).toBe('GET /api/data');
    expect(res.body.data.policy.limitCount).toBe(100);
    expect(res.body.data.state.remaining).toBe(85); // 100 - 15 = 85
    expect(res.body.data.state.allowed).toBe(true);
    expect(res.body.data.state.resetAt).toBeDefined();
  });

  it('should return 400 when endpoint query param is missing', async () => {
    const res = await request(app)
      .get('/rate-limit/status')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 401 when no auth token is provided', async () => {
    const res = await request(app)
      .get('/rate-limit/status?endpoint=GET%20%2Fapi%2Fdata');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('MISSING_CREDENTIALS');
  });
});
