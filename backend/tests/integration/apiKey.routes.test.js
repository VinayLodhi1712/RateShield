'use strict';

// Integration tests for API Keys endpoints — see API.md Section 7.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const config = require('../../src/config');

jest.mock('../../src/config/redis', () => ({
  redis: {
    eval: jest.fn().mockResolvedValue([1, 1, 99]),
    get: jest.fn().mockResolvedValue('10'),
  },
  pingRedis: jest.fn().mockResolvedValue({ status: 'healthy' }),
  closeRedis: jest.fn(),
}));

jest.mock('../../src/services/policyCache.service', () => ({
  resolvePolicy: jest.fn().mockResolvedValue({
    id: 1,
    name: 'Default Policy',
    algorithm: 'fixed_window',
    limit_count: 100,
    window_seconds: 60,
    failure_mode: 'open',
  }),
}));

describe('API Keys Endpoints (Integration)', () => {
  const token = jwt.sign(
    { sub: 1, email: 'developer@rateshield.io', role: 'developer' },
    config.jwt.secret,
    { expiresIn: '15m' }
  );

  let createdKeyId;
  let createdRawKey;

  it('should create a new API key (POST /api-keys)', async () => {
    const res = await request(app)
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Integration Test Key' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.apiKey.name).toBe('Integration Test Key');
    expect(res.body.data.apiKey.key).toMatch(/^rs_[a-f0-9]{32}$/);
    expect(res.body.data.apiKey.prefix).toBe(res.body.data.apiKey.key.slice(0, 8));
    expect(res.body.data.warning).toBeDefined();

    createdKeyId = res.body.data.apiKey.id;
    createdRawKey = res.body.data.apiKey.key;
  });

  it('should reject creation with missing or invalid name (POST /api-keys)', async () => {
    const res = await request(app)
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should list API keys for the user (GET /api-keys)', async () => {
    const res = await request(app)
      .get('/api-keys')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].key).toBeUndefined(); // Raw key never returned in list
  });

  it('should authenticate using X-API-Key header', async () => {
    const res = await request(app)
      .get('/health')
      .set('X-API-Key', createdRawKey);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should revoke an API key (DELETE /api-keys/:id)', async () => {
    const res = await request(app)
      .delete(`/api-keys/${createdKeyId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toContain('revoked successfully');
  });

  it('should reject unauthenticated access (GET /api-keys)', async () => {
    const res = await request(app).get('/api-keys');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('MISSING_CREDENTIALS');
  });
});
