'use strict';

// Token Bucket rate limiter — see Algorithms.md §6 and Redis.md §5.
const { redis } = require('../config/redis');
const { runLuaScript } = require('../utils/luaScriptRunner');

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if not tokens or not last_refill then
  tokens = capacity
  last_refill = now_ms
else
  local elapsed_sec = math.max(0, (now_ms - last_refill) / 1000)
  tokens = math.min(capacity, tokens + (elapsed_sec * refill_rate))
  last_refill = now_ms
end

if tokens < 1 then
  redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
  redis.call('EXPIRE', key, ttl)
  local deficit = 1 - tokens
  local retry_after = math.max(1, math.ceil(deficit / refill_rate))
  return { 0, math.floor(tokens), 0, retry_after }
else
  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
  redis.call('EXPIRE', key, ttl)
  local remaining = math.floor(tokens)
  return { 1, remaining, remaining, 0 }
end
`;

// In-memory fallback map for standalone local development without live Redis
const inMemoryBuckets = new Map();

function buildKey(identityKey, method, path) {
  const encodedPath = encodeURIComponent(path);
  return `rateshield:token_bucket:${identityKey}:${method}:${encodedPath}`;
}

async function checkTokenBucket({ identityKey, method, path, limit, windowSeconds }) {
  const nowMs = Date.now();
  const capacity = limit;
  const refillRate = limit / windowSeconds;
  const ttlSeconds = windowSeconds * 3;
  const key = buildKey(identityKey, method, path);

  try {
    const result = typeof redis.evalsha === 'function'
      ? await runLuaScript(
          redis,
          TOKEN_BUCKET_LUA,
          1,
          key,
          capacity,
          refillRate,
          nowMs,
          ttlSeconds
        )
      : await redis.eval(
          TOKEN_BUCKET_LUA,
          1,
          key,
          capacity,
          refillRate,
          nowMs,
          ttlSeconds
        );

    const allowed = result[0] === 1;
    const remaining = Math.max(0, Number(result[2]));
    const retryAfter = Number(result[3] || (allowed ? 0 : 1));
    const resetTime = Math.floor((nowMs + (retryAfter * 1000)) / 1000);

    return {
      allowed,
      limit: capacity,
      remaining,
      resetTime: allowed ? Math.floor((nowMs + (windowSeconds * 1000)) / 1000) : resetTime,
      current: capacity - remaining,
      retryAfter,
      algorithm: 'token_bucket',
    };
  } catch {
    // In-memory token bucket fallback when Redis is offline in standalone dev
    const state = inMemoryBuckets.get(key) || { tokens: capacity, lastRefill: nowMs };
    const elapsedSec = Math.max(0, (nowMs - state.lastRefill) / 1000);
    const tokens = Math.min(capacity, state.tokens + (elapsedSec * refillRate));

    if (tokens < 1) {
      state.tokens = tokens;
      state.lastRefill = nowMs;
      inMemoryBuckets.set(key, state);

      const deficit = 1 - tokens;
      const retryAfter = Math.max(1, Math.ceil(deficit / refillRate));

      return {
        allowed: false,
        limit: capacity,
        remaining: 0,
        resetTime: Math.floor((nowMs + (retryAfter * 1000)) / 1000),
        current: capacity,
        retryAfter,
        algorithm: 'token_bucket',
      };
    }

    const nextTokens = tokens - 1;
    state.tokens = nextTokens;
    state.lastRefill = nowMs;
    inMemoryBuckets.set(key, state);

    return {
      allowed: true,
      limit: capacity,
      remaining: Math.floor(nextTokens),
      resetTime: Math.floor((nowMs + (windowSeconds * 1000)) / 1000),
      current: capacity - Math.floor(nextTokens),
      retryAfter: 0,
      algorithm: 'token_bucket',
    };
  }
}

async function getTokenBucketStatus({ identityKey, method, path, limit, windowSeconds }) {
  const nowMs = Date.now();
  const capacity = limit;
  const refillRate = limit / windowSeconds;
  const key = buildKey(identityKey, method, path);

  try {
    const data = await redis.hmget(key, 'tokens', 'last_refill');
    const rawTokens = data[0] ? parseFloat(data[0]) : null;
    const lastRefill = data[1] ? parseInt(data[1], 10) : null;

    let tokens = capacity;
    if (rawTokens !== null && lastRefill !== null) {
      const elapsedSec = Math.max(0, (nowMs - lastRefill) / 1000);
      tokens = Math.min(capacity, rawTokens + (elapsedSec * refillRate));
    }

    const remaining = Math.max(0, Math.floor(tokens));

    return {
      allowed: tokens >= 1,
      remaining,
      resetAt: new Date(nowMs + (windowSeconds * 1000)).toISOString(),
      algorithm: 'token_bucket',
    };
  } catch {
    const state = inMemoryBuckets.get(key);
    let tokens = capacity;
    if (state) {
      const elapsedSec = Math.max(0, (nowMs - state.lastRefill) / 1000);
      tokens = Math.min(capacity, state.tokens + (elapsedSec * refillRate));
    }

    return {
      allowed: tokens >= 1,
      remaining: Math.max(0, Math.floor(tokens)),
      resetAt: new Date(nowMs + (windowSeconds * 1000)).toISOString(),
      algorithm: 'token_bucket',
    };
  }
}

module.exports = {
  checkTokenBucket,
  getTokenBucketStatus,
  buildKey,
  TOKEN_BUCKET_LUA,
};
