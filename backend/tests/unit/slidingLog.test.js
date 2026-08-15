'use strict';

// Unit tests for Sliding Log limiter — see Algorithms.md §5.
const {
  checkSlidingLog,
  getSlidingLogStatus,
  buildKey,
} = require('../../src/limiters/slidingLog.limiter');
const { redis } = require('../../src/config/redis');

jest.mock('../../src/config/redis', () => ({
  redis: {
    eval: jest.fn(),
    zremrangebyscore: jest.fn(),
    zcard: jest.fn(),
  },
}));

describe('Sliding Log Limiter (Unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildKey', () => {
    it('should build deterministic sorted set key without window timestamp', () => {
      const key = buildKey('user:10', 'GET', '/api/users');
      expect(key).toBe('rateshield:sliding_log:user:10:GET:%2Fapi%2Fusers');
    });
  });

  describe('checkSlidingLog', () => {
    it('should allow request and return remaining quota when log count is under limit', async () => {
      // Lua returns: [allowed=1, current=3, remaining=2, retryAfter=0]
      redis.eval.mockResolvedValue([1, 3, 2, 0]);

      const res = await checkSlidingLog({
        identityKey: 'user:10',
        method: 'GET',
        path: '/api/users',
        limit: 5,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(true);
      expect(res.current).toBe(3);
      expect(res.remaining).toBe(2);
      expect(res.retryAfter).toBe(0);
      expect(res.algorithm).toBe('sliding_log');
    });

    it('should block request and compute retryAfter when log count reaches limit', async () => {
      // Lua returns: [allowed=0, current=5, remaining=0, retryAfter=15]
      redis.eval.mockResolvedValue([0, 5, 0, 15]);

      const res = await checkSlidingLog({
        identityKey: 'user:10',
        method: 'GET',
        path: '/api/users',
        limit: 5,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
      expect(res.retryAfter).toBe(15);
      expect(res.algorithm).toBe('sliding_log');
    });
  });

  describe('getSlidingLogStatus', () => {
    it('should prune and count sorted set without inserting new entry', async () => {
      redis.zremrangebyscore.mockResolvedValue(2);
      redis.zcard.mockResolvedValue(3);

      const res = await getSlidingLogStatus({
        identityKey: 'user:10',
        method: 'GET',
        path: '/api/users',
        limit: 10,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(7); // 10 - 3 = 7
      expect(res.resetAt).toBeDefined();
      expect(res.algorithm).toBe('sliding_log');
    });
  });
});
