'use strict';

// Unit tests for Distributed Lock module — see Redis.md §5.
const {
  acquireLock,
  releaseLock,
  withLock,
} = require('../../src/utils/distributedLock');
const { redis } = require('../../src/config/redis');

jest.mock('../../src/config/redis', () => ({
  redis: {
    set: jest.fn(),
    eval: jest.fn(),
  },
}));

describe('Distributed Lock (Unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('acquireLock', () => {
    it('should acquire lock when key is free', async () => {
      redis.set.mockResolvedValue('OK');

      const lock = await acquireLock('user:policy:update');

      expect(lock.acquired).toBe(true);
      expect(lock.token).toBeDefined();
      expect(lock.key).toBe('rateshield:lock:user:policy:update');
      expect(typeof lock.release).toBe('function');
    });

    it('should return acquired: false when lock is held after max retries', async () => {
      redis.set.mockResolvedValue(null);

      const lock = await acquireLock('busy:resource', { retryCount: 2, retryDelayMs: 5 });

      expect(lock.acquired).toBe(false);
      expect(lock.token).toBeNull();
    });
  });

  describe('releaseLock', () => {
    it('should release lock when token matches', async () => {
      redis.eval.mockResolvedValue(1);

      const released = await releaseLock('rateshield:lock:resource', 'token-123');

      expect(released).toBe(true);
    });

    it('should fail release when token does not match', async () => {
      redis.eval.mockResolvedValue(0);

      const released = await releaseLock('rateshield:lock:resource', 'wrong-token');

      expect(released).toBe(false);
    });
  });

  describe('withLock', () => {
    it('should execute task inside critical section and release lock', async () => {
      redis.set.mockResolvedValue('OK');
      redis.eval.mockResolvedValue(1);

      const task = jest.fn().mockResolvedValue('success');
      const result = await withLock('critical:section', task);

      expect(result).toBe('success');
      expect(task).toHaveBeenCalledTimes(1);
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });
  });
});
