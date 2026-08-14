'use strict';

// Integration test for GET /health — see API.md Section 9.
const request = require('supertest');
const app = require('../../src/app');
const redisConfig = require('../../src/config/redis');
const dbConfig = require('../../src/config/db');

jest.mock('../../src/config/redis');
jest.mock('../../src/config/db');

describe('GET /health (Integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and healthy status when all components are up', async () => {
    redisConfig.pingRedis.mockResolvedValue({ status: 'healthy', latencyMs: 2, error: null });
    dbConfig.pingDb.mockResolvedValue({ status: 'healthy', latencyMs: 3, error: null });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('healthy');
    expect(res.body.data.components.api.status).toBe('healthy');
    expect(res.body.data.components.redis.status).toBe('healthy');
    expect(res.body.data.components.postgres.status).toBe('healthy');
  });

  it('should return 200 and degraded status when Redis or Postgres is unreachable', async () => {
    redisConfig.pingRedis.mockResolvedValue({ status: 'unhealthy', latencyMs: null, error: 'Connection refused' });
    dbConfig.pingDb.mockResolvedValue({ status: 'healthy', latencyMs: 4, error: null });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.components.redis.status).toBe('unhealthy');
    expect(res.body.data.components.redis.error).toBe('Connection refused');
    expect(res.body.data.components.postgres.status).toBe('healthy');
  });
});
