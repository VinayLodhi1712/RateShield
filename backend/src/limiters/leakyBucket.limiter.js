'use strict';

// Leaky Bucket rate limiter — see Algorithms.md §7 and Redis.md §5.
const { redis } = require('../config/redis');

const LEAKY_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local leak_rate = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'queue', 'last_leak')
local queue = tonumber(data[1])
local last_leak = tonumber(data[2])

if not queue or not last_leak then
  queue = 0
  last_leak = now_ms
else
  local elapsed_sec = math.max(0, (now_ms - last_leak) / 1000)
  local drained = elapsed_sec * leak_rate
  queue = math.max(0, queue - drained)
  last_leak = now_ms
end

if queue >= capacity then
  redis.call('HMSET', key, 'queue', queue, 'last_leak', last_leak)
  redis.call('EXPIRE', key, ttl)
  local overflow = (queue - capacity) + 1
  local retry_after = math.max(1, math.ceil(overflow / leak_rate))
  return { 0, math.floor(queue), 0, retry_after }
else
  queue = queue + 1
  redis.call('HMSET', key, 'queue', queue, 'last_leak', last_leak)
  redis.call('EXPIRE', key, ttl)
  local remaining = math.max(0, math.floor(capacity - queue))
  return { 1, math.floor(queue), remaining, 0 }
end
`;

// In-memory fallback map for standalone local development without live Redis
const inMemoryQueues = new Map();

function buildKey(identityKey, method, path) {
  const encodedPath = encodeURIComponent(path);
  return `rateshield:leaky_bucket:${identityKey}:${method}:${encodedPath}`;
}

async function checkLeakyBucket({ identityKey, method, path, limit, windowSeconds, leakRate = null }) {
  const nowMs = Date.now();
  const capacity = limit;
  const leakRatePerSec = leakRate || (limit / windowSeconds);
  const ttlSeconds = 86400; // 24-hour idle TTL — see Redis.md Q5
  const key = buildKey(identityKey, method, path);

  try {
    const result = await redis.eval(
      LEAKY_BUCKET_LUA,
      1,
      key,
      capacity,
      leakRatePerSec,
      nowMs,
      ttlSeconds
    );

    const allowed = result[0] === 1;
    const current = Number(result[1]);
    const remaining = Math.max(0, Number(result[2]));
    const retryAfter = Number(result[3] || (allowed ? 0 : 1));
    const resetTime = Math.floor((nowMs + (retryAfter * 1000)) / 1000);

    return {
      allowed,
      limit: capacity,
      remaining,
      resetTime: allowed ? Math.floor((nowMs + (windowSeconds * 1000)) / 1000) : resetTime,
      current,
      retryAfter,
      algorithm: 'leaky_bucket',
    };
  } catch {
    // In-memory leaky bucket fallback when Redis is offline in standalone dev
    const state = inMemoryQueues.get(key) || { queue: 0, lastLeak: nowMs };
    const elapsedSec = Math.max(0, (nowMs - state.lastLeak) / 1000);
    const drained = elapsedSec * leakRatePerSec;
    const queue = Math.max(0, state.queue - drained);

    if (queue >= capacity) {
      state.queue = queue;
      state.lastLeak = nowMs;
      inMemoryQueues.set(key, state);

      const overflow = (queue - capacity) + 1;
      const retryAfter = Math.max(1, Math.ceil(overflow / leakRatePerSec));

      return {
        allowed: false,
        limit: capacity,
        remaining: 0,
        resetTime: Math.floor((nowMs + (retryAfter * 1000)) / 1000),
        current: Math.floor(queue),
        retryAfter,
        algorithm: 'leaky_bucket',
      };
    }

    const nextQueue = queue + 1;
    state.queue = nextQueue;
    state.lastLeak = nowMs;
    inMemoryQueues.set(key, state);
    const remaining = Math.max(0, Math.floor(capacity - nextQueue));

    return {
      allowed: true,
      limit: capacity,
      remaining,
      resetTime: Math.floor((nowMs + (windowSeconds * 1000)) / 1000),
      current: Math.floor(nextQueue),
      retryAfter: 0,
      algorithm: 'leaky_bucket',
    };
  }
}

async function getLeakyBucketStatus({ identityKey, method, path, limit, windowSeconds, leakRate = null }) {
  const nowMs = Date.now();
  const capacity = limit;
  const leakRatePerSec = leakRate || (limit / windowSeconds);
  const key = buildKey(identityKey, method, path);

  try {
    const data = await redis.hmget(key, 'queue', 'last_leak');
    const rawQueue = data[0] ? parseFloat(data[0]) : null;
    const lastLeak = data[1] ? parseInt(data[1], 10) : null;

    let queue = 0;
    if (rawQueue !== null && lastLeak !== null) {
      const elapsedSec = Math.max(0, (nowMs - lastLeak) / 1000);
      const drained = elapsedSec * leakRatePerSec;
      queue = Math.max(0, rawQueue - drained);
    }

    const remaining = Math.max(0, Math.floor(capacity - queue));

    return {
      allowed: queue < capacity,
      remaining,
      resetAt: new Date(nowMs + (windowSeconds * 1000)).toISOString(),
      algorithm: 'leaky_bucket',
    };
  } catch {
    const state = inMemoryQueues.get(key);
    let queue = 0;
    if (state) {
      const elapsedSec = Math.max(0, (nowMs - state.lastLeak) / 1000);
      const drained = elapsedSec * leakRatePerSec;
      queue = Math.max(0, state.queue - drained);
    }

    const remaining = Math.max(0, Math.floor(capacity - queue));

    return {
      allowed: queue < capacity,
      remaining,
      resetAt: new Date(nowMs + (windowSeconds * 1000)).toISOString(),
      algorithm: 'leaky_bucket',
    };
  }
}

module.exports = {
  checkLeakyBucket,
  getLeakyBucketStatus,
  buildKey,
  LEAKY_BUCKET_LUA,
};
