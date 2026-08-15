'use strict';

// Sliding Log rate limiter — see Algorithms.md §5 and Redis.md §5.
const crypto = require('crypto');
const { redis } = require('../config/redis');

const SLIDING_LOG_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local request_id = ARGV[4]
local ttl = tonumber(ARGV[5])

local clear_before = now_ms - window_ms
redis.call('ZREMRANGEBYSCORE', key, '-inf', clear_before)

local count = redis.call('ZCARD', key)

if count >= limit then
  redis.call('EXPIRE', key, ttl)
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldest_ts = oldest and oldest[2] and tonumber(oldest[2]) or (now_ms - window_ms)
  local retry_after = math.max(1, math.ceil(((oldest_ts + window_ms) - now_ms) / 1000))
  return { 0, count, 0, retry_after }
else
  redis.call('ZADD', key, now_ms, request_id)
  redis.call('EXPIRE', key, ttl)
  local remaining = limit - count - 1
  return { 1, count + 1, remaining, 0 }
end
`;

// In-memory fallback map for standalone local development without live Redis
const inMemoryLogs = new Map();

function buildKey(identityKey, method, path) {
  const encodedPath = encodeURIComponent(path);
  return `rateshield:sliding_log:${identityKey}:${method}:${encodedPath}`;
}

async function checkSlidingLog({ identityKey, method, path, limit, windowSeconds, requestId = null }) {
  const nowMs = Date.now();
  const windowMs = windowSeconds * 1000;
  const ttlSeconds = windowSeconds * 3; // 3x window TTL — see Redis.md Q4
  const reqId = requestId || `req_${crypto.randomBytes(8).toString('hex')}`;
  const key = buildKey(identityKey, method, path);

  try {
    const result = await redis.eval(
      SLIDING_LOG_LUA,
      1,
      key,
      limit,
      windowMs,
      nowMs,
      reqId,
      ttlSeconds
    );

    const allowed = result[0] === 1;
    const current = Number(result[1]);
    const remaining = Math.max(0, Number(result[2]));
    const retryAfter = Number(result[3] || (allowed ? 0 : 1));
    const resetTime = Math.floor((nowMs + windowMs) / 1000);

    return {
      allowed,
      limit,
      remaining,
      resetTime,
      current,
      retryAfter,
      algorithm: 'sliding_log',
    };
  } catch {
    // In-memory array log fallback when Redis is offline in standalone dev
    const logs = inMemoryLogs.get(key) || [];
    const clearBefore = nowMs - windowMs;
    const validLogs = logs.filter((ts) => ts > clearBefore);

    if (validLogs.length >= limit) {
      const oldestTs = validLogs[0] || (nowMs - windowMs);
      const retryAfter = Math.max(1, Math.ceil(((oldestTs + windowMs) - nowMs) / 1000));
      inMemoryLogs.set(key, validLogs);

      return {
        allowed: false,
        limit,
        remaining: 0,
        resetTime: Math.floor((nowMs + windowMs) / 1000),
        current: validLogs.length,
        retryAfter,
        algorithm: 'sliding_log',
      };
    }

    validLogs.push(nowMs);
    inMemoryLogs.set(key, validLogs);
    const remaining = Math.max(0, limit - validLogs.length);

    return {
      allowed: true,
      limit,
      remaining,
      resetTime: Math.floor((nowMs + windowMs) / 1000),
      current: validLogs.length,
      retryAfter: 0,
      algorithm: 'sliding_log',
    };
  }
}

async function getSlidingLogStatus({ identityKey, method, path, limit, windowSeconds }) {
  const nowMs = Date.now();
  const windowMs = windowSeconds * 1000;
  const key = buildKey(identityKey, method, path);

  try {
    const clearBefore = nowMs - windowMs;
    await redis.zremrangebyscore(key, '-inf', clearBefore);
    const count = await redis.zcard(key);
    const remaining = Math.max(0, limit - count);

    return {
      allowed: count < limit,
      remaining,
      resetAt: new Date(nowMs + windowMs).toISOString(),
      algorithm: 'sliding_log',
    };
  } catch {
    const logs = inMemoryLogs.get(key) || [];
    const clearBefore = nowMs - windowMs;
    const validLogs = logs.filter((ts) => ts > clearBefore);
    const remaining = Math.max(0, limit - validLogs.length);

    return {
      allowed: validLogs.length < limit,
      remaining,
      resetAt: new Date(nowMs + windowMs).toISOString(),
      algorithm: 'sliding_log',
    };
  }
}

module.exports = {
  checkSlidingLog,
  getSlidingLogStatus,
  buildKey,
  SLIDING_LOG_LUA,
};
