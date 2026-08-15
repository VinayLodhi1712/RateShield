'use strict';

// Unit tests for Sliding Window limiter — see Algorithms.md §4.
const {
  checkSlidingWindow,
  getSlidingWindowStatus,
  buildKey,
} = require('../../src/limiters/slidingWindow.limiter');
const { redis } = require('../../src/config/redis');

jest.mock('../../src/config/redis', () => ({
  redis: {
    eval: jest.fn(),
    mget: jest.fn(),
  },
}));

describe('Sliding Window Limiter (Unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildKey', () => {
    it('should build deterministic key with identity, method, path, and windowStart', () => {
      const key = buildKey('user:42', 'POST', '/api/data', 1700000000);
      expect(key).toBe('rateshield:sliding_window:user:42:POST:%2Fapi%2Fdata:1700000000');
    });
  });

  describe('checkSlidingWindow', () => {
    it('should return allowed: true with remaining quota when blended count is under limit', async () => {
      // Lua returns: [allowed=1, current=2, remaining=3]
      redis.eval.mockResolvedValue([1, 2, 3]);

      const res = await checkSlidingWindow({
        identityKey: 'user:1',
        method: 'GET',
        path: '/test',
        limit: 5,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(true);
      expect(res.current).toBe(2);
      expect(res.remaining).toBe(3);
      expect(res.retryAfter).toBe(0);
      expect(res.algorithm).toBe('sliding_window');
    });

    it('should return allowed: false when blended count reaches or exceeds limit', async () => {
      // Lua returns: [allowed=0, current=5, remaining=0]
      redis.eval.mockResolvedValue([0, 5, 0]);

      const res = await checkSlidingWindow({
        identityKey: 'user:1',
        method: 'GET',
        path: '/test',
        limit: 5,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
      expect(res.retryAfter).toBeGreaterThan(0);
      expect(res.algorithm).toBe('sliding_window');
    });
  });

  describe('getSlidingWindowStatus', () => {
    it('should read current and previous counters without mutating Redis state', async () => {
      redis.mget.mockResolvedValue(['2', '4']);

      const res = await getSlidingWindowStatus({
        identityKey: 'user:1',
        method: 'GET',
        path: '/test',
        limit: 10,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(true);
      expect(res.remaining).toBeGreaterThan(0);
      expect(res.resetAt).toBeDefined();
      expect(res.algorithm).toBe('sliding_window');
    });
  });
});
