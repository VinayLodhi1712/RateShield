'use strict';

// Distributed lock with atomic release Lua script — see Architecture.md §3 and Redis.md §5.
const crypto = require('crypto');
const { redis } = require('../config/redis');
const logger = require('./logger');

const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const inMemoryLocks = new Map();

async function acquireLock(resource, { ttlMs = 5000, retryCount = 5, retryDelayMs = 50 } = {}) {
  const lockKey = `rateshield:lock:${resource}`;
  const lockToken = crypto.randomUUID();

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const res = await redis.set(lockKey, lockToken, 'PX', ttlMs, 'NX');
      if (res === 'OK') {
        return {
          acquired: true,
          token: lockToken,
          key: lockKey,
          release: () => releaseLock(lockKey, lockToken),
        };
      }
    } catch {
      // In-memory mutex fallback when Redis is offline in standalone dev
      const existing = inMemoryLocks.get(lockKey);
      if (!existing || existing.expiresAt <= Date.now()) {
        inMemoryLocks.set(lockKey, { token: lockToken, expiresAt: Date.now() + ttlMs });
        return {
          acquired: true,
          token: lockToken,
          key: lockKey,
          release: () => releaseLock(lockKey, lockToken),
        };
      }
    }

    if (attempt < retryCount) {
      const jitter = Math.floor(Math.random() * 20);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitter));
    }
  }

  return {
    acquired: false,
    token: null,
    key: lockKey,
    release: async () => false,
  };
}

async function releaseLock(lockKey, token) {
  try {
    const result = await redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
    return result === 1;
  } catch {
    const existing = inMemoryLocks.get(lockKey);
    if (existing && existing.token === token) {
      inMemoryLocks.delete(lockKey);
      return true;
    }
    return false;
  }
}

async function withLock(resource, fn, options = {}) {
  const lock = await acquireLock(resource, options);
  if (!lock.acquired) {
    throw new Error(`Failed to acquire distributed lock for resource: ${resource}`);
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  withLock,
  RELEASE_LOCK_LUA,
};
