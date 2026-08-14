'use strict';

// Unit tests for Fixed Window Limiter — see docs/Testing.md and Algorithms.md §3.
const { checkFixedWindow, buildKey } = require('../../src/limiters/fixedWindow.limiter');
const { redis } = require('../../src/config/redis');

jest.mock('../../src/config/redis', () => ({
  redis: {
    eval: jest.fn(),
  },
}));

describe('Fixed Window Limiter (Unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildKey', () => {
    it('should format Redis key with encoded path and windowStart', () => {
      const key = buildKey('user:123', 'POST', '/auth/login', 1700000000);
      expect(key).toBe('rateshield:fixed:user:123:POST:%2Fauth%2Flogin:1700000000');
    });
  });

  describe('checkFixedWindow', () => {
    it('should allow request when within limit', async () => {
      redis.eval.mockResolvedValue([1, 1, 99]); // [allowed=1, current=1, remaining=99]

      const res = await checkFixedWindow({
        identityKey: 'user:123',
        method: 'GET',
        path: '/api/data',
        limit: 100,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(true);
      expect(res.current).toBe(1);
      expect(res.remaining).toBe(99);
      expect(res.algorithm).toBe('fixed_window');
    });

    it('should block request when limit reached', async () => {
      redis.eval.mockResolvedValue([0, 100, 0]); // [allowed=0, current=100, remaining=0]

      const res = await checkFixedWindow({
        identityKey: 'user:123',
        method: 'GET',
        path: '/api/data',
        limit: 100,
        windowSeconds: 60,
      });

      expect(res.allowed).toBe(false);
      expect(res.current).toBe(100);
      expect(res.remaining).toBe(0);
      expect(res.retryAfter).toBeGreaterThan(0);
    });
  });
});
