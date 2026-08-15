'use strict';

// Unit tests for Leaky Bucket limiter — see Algorithms.md §7.
const {
  checkLeakyBucket,
  getLeakyBucketStatus,
  buildKey,
} = require('../../src/limiters/leakyBucket.limiter');
const { redis } = require('../../src/config/redis');

jest.mock('../../src/config/redis', () => ({
  redis: {
    eval: jest.fn(),
    hmget: jest.fn(),
  },
}));

describe('Leaky Bucket Limiter (Unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildKey', () => {
    it('should build deterministic hash key for leaky bucket', () => {
      const key = buildKey('user:7', 'POST', '/api/submit');
      expect(key).toBe('rateshield:leaky_bucket:user:7:POST:%2Fapi%2Fsubmit');
    });
  });

  describe('checkLeakyBucket', () => {
    it('should allow request and queue +1 when queue is under capacity', async () => {
      // Lua returns: [allowed=1, current=2, remaining=3, retryAfter=0]
      redis.eval.mockResolvedValue([1, 2, 3, 0]);

      const res = await checkLeakyBucket({
        identityKey: 'user:7',
        method: 'POST',
        path: '/api/submit',
        limit: 5,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(3);
      expect(res.retryAfter).toBe(0);
      expect(res.algorithm).toBe('leaky_bucket');
    });

    it('should block request and compute retryAfter when queue is full', async () => {
      // Lua returns: [allowed=0, current=5, remaining=0, retryAfter=12]
      redis.eval.mockResolvedValue([0, 5, 0, 12]);

      const res = await checkLeakyBucket({
        identityKey: 'user:7',
        method: 'POST',
        path: '/api/submit',
        limit: 5,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
      expect(res.retryAfter).toBe(12);
      expect(res.algorithm).toBe('leaky_bucket');
    });
  });

  describe('getLeakyBucketStatus', () => {
    it('should inspect queue depth and drained items without modifying queue state', async () => {
      const nowMs = Date.now();
      redis.hmget.mockResolvedValue(['2.0', String(nowMs - 5000)]);

      const res = await getLeakyBucketStatus({
        identityKey: 'user:7',
        method: 'POST',
        path: '/api/submit',
        limit: 10,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(true);
      expect(res.remaining).toBeGreaterThanOrEqual(8);
      expect(res.resetAt).toBeDefined();
      expect(res.algorithm).toBe('leaky_bucket');
    });
  });
});
