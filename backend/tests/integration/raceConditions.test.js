'use strict';

// Race condition and concurrency integration tests — see Architecture.md §3 and Redis.md §5.
const request = require('supertest');
const app = require('../../src/app');
const { acquireLock, releaseLock, withLock } = require('../../src/utils/distributedLock');

describe('Concurrency & Race Condition Hardening (Integration)', () => {
  describe('High Concurrency Rate Limiter Bursts', () => {
    it('should handle 30 simultaneous concurrent requests without dropping requests', async () => {
      const requests = Array.from({ length: 30 }, () =>
        request(app).get('/health')
      );

      const responses = await Promise.all(requests);
      expect(responses).toHaveLength(30);

      // Verify all responses have standard headers
      for (const res of responses) {
        expect([200, 429]).toContain(res.status);
        expect(res.headers['x-ratelimit-limit']).toBeDefined();
        expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      }
    });
  });

  describe('Distributed Mutex Concurrency', () => {
    it('should ensure mutually exclusive execution among concurrent workers', async () => {
      let activeWorkers = 0;
      let maxConcurrentObserved = 0;
      const executionLog = [];

      const runWorker = async (id) => {
        await withLock('concurrency:test:resource', async () => {
          activeWorkers++;
          if (activeWorkers > maxConcurrentObserved) {
            maxConcurrentObserved = activeWorkers;
          }
          executionLog.push({ id, enter: Date.now() });

          // Simulate critical section work
          await new Promise((resolve) => setTimeout(resolve, 20));

          activeWorkers--;
        }, { retryCount: 15, retryDelayMs: 25 });
      };

      const workers = Array.from({ length: 5 }, (_, i) => runWorker(i + 1));
      await Promise.all(workers);

      // Mutex guarantee: at most 1 worker in critical section at any instant
      expect(maxConcurrentObserved).toBe(1);
      expect(activeWorkers).toBe(0);
      expect(executionLog).toHaveLength(5);
    });
  });
});
