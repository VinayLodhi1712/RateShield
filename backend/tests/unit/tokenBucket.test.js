'use strict';

// Unit tests for Token Bucket limiter — see Algorithms.md §6.
const {
  checkTokenBucket,
  getTokenBucketStatus,
  buildKey,
} = require('../../src/limiters/tokenBucket.limiter');
const { redis } = require('../../src/config/redis');

jest.mock('../../src/config/redis', () => ({
  redis: {
    eval: jest.fn(),
    hmget: jest.fn(),
  },
}));

describe('Token Bucket Limiter (Unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildKey', () => {
    it('should build deterministic hash key for token bucket', () => {
      const key = buildKey('user:5', 'GET', '/api/data');
      expect(key).toBe('rateshield:token_bucket:user:5:GET:%2Fapi%2Fdata');
    });
  });

  describe('checkTokenBucket', () => {
    it('should allow request and return remaining tokens when tokens are available', async () => {
      // Lua returns: [allowed=1, current=4, remaining=4, retryAfter=0]
      redis.eval.mockResolvedValue([1, 4, 4, 0]);

      const res = await checkTokenBucket({
        identityKey: 'user:5',
        method: 'GET',
        path: '/api/data',
        limit: 5,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(4);
      expect(res.retryAfter).toBe(0);
      expect(res.algorithm).toBe('token_bucket');
    });

    it('should block request and compute retryAfter when bucket is empty', async () => {
      // Lua returns: [allowed=0, current=0, remaining=0, retryAfter=12]
      redis.eval.mockResolvedValue([0, 0, 0, 12]);

      const res = await checkTokenBucket({
        identityKey: 'user:5',
        method: 'GET',
        path: '/api/data',
        limit: 5,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
      expect(res.retryAfter).toBe(12);
      expect(res.algorithm).toBe('token_bucket');
    });
  });

  describe('getTokenBucketStatus', () => {
    it('should inspect tokens and refill accumulation without consuming tokens', async () => {
      const nowMs = Date.now();
      redis.hmget.mockResolvedValue(['4.5', String(nowMs - 5000)]);

      const res = await getTokenBucketStatus({
        identityKey: 'user:5',
        method: 'GET',
        path: '/api/data',
        limit: 10,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(true);
      expect(res.remaining).toBeGreaterThanOrEqual(4);
      expect(res.resetAt).toBeDefined();
      expect(res.algorithm).toBe('token_bucket');
    });
  });
});
