'use strict';

// Sliding Window Counter limiter — see Algorithms.md §4 and Redis.md §5.
const { redis } = require('../config/redis');
const { runLuaScript } = require('../utils/luaScriptRunner');

const SLIDING_WINDOW_LUA = `
local curr_key = KEYS[1]
local prev_key = KEYS[2]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local window_start = tonumber(ARGV[4])

local curr_count = tonumber(redis.call('GET', curr_key) or '0')
local prev_count = tonumber(redis.call('GET', prev_key) or '0')

local elapsed = now - window_start
local overlap_fraction = elapsed / window
local blended = (prev_count * (1 - overlap_fraction)) + curr_count

if blended >= limit then
  return { 0, math.floor(blended), 0 }
else
  local new_curr = redis.call('INCR', curr_key)
  if new_curr == 1 then
    redis.call('EXPIRE', curr_key, window * 2 + 1)
  end
  local new_blended = math.floor(blended + 1)
  local remaining = math.max(0, limit - new_blended)
  return { 1, new_blended, remaining }
end
`;

// In-memory fallback map for standalone local development without live Redis
const inMemoryCounters = new Map();

function buildKey(identityKey, method, path, windowStart) {
  const encodedPath = encodeURIComponent(path);
  return `rateshield:sliding_window:${identityKey}:${method}:${encodedPath}:${windowStart}`;
}

async function checkSlidingWindow({ identityKey, method, path, limit, windowSeconds }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const prevWindowStart = windowStart - windowSeconds;
  const resetTime = windowStart + windowSeconds;

  const currKey = buildKey(identityKey, method, path, windowStart);
  const prevKey = buildKey(identityKey, method, path, prevWindowStart);

  try {
    const result = typeof redis.evalsha === 'function'
      ? await runLuaScript(
          redis,
          SLIDING_WINDOW_LUA,
          2,
          currKey,
          prevKey,
          limit,
          windowSeconds,
          nowSeconds,
          windowStart
        )
      : await redis.eval(
          SLIDING_WINDOW_LUA,
          2,
          currKey,
          prevKey,
          limit,
          windowSeconds,
          nowSeconds,
          windowStart
        );

    const allowed = result[0] === 1;
    const current = Number(result[1]);
    const remaining = Math.max(0, Number(result[2]));

    return {
      allowed,
      limit,
      remaining,
      resetTime,
      current,
      retryAfter: allowed ? 0 : Math.max(1, resetTime - nowSeconds),
      algorithm: 'sliding_window',
    };
  } catch {
    // In-memory weighted calculation fallback when Redis is offline in standalone dev
    const curr = inMemoryCounters.get(currKey) || 0;
    const prev = inMemoryCounters.get(prevKey) || 0;
    const elapsed = nowSeconds - windowStart;
    const overlap = elapsed / windowSeconds;
    const blended = (prev * (1 - overlap)) + curr;

    if (blended >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetTime,
        current: Math.floor(blended),
        retryAfter: Math.max(1, resetTime - nowSeconds),
        algorithm: 'sliding_window',
      };
    }

    const nextCurr = curr + 1;
    inMemoryCounters.set(currKey, nextCurr);
    const newBlended = Math.floor(blended + 1);
    const remaining = Math.max(0, limit - newBlended);

    return {
      allowed: true,
      limit,
      remaining,
      resetTime,
      current: newBlended,
      retryAfter: 0,
      algorithm: 'sliding_window',
    };
  }
}

async function getSlidingWindowStatus({ identityKey, method, path, limit, windowSeconds }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const prevWindowStart = windowStart - windowSeconds;
  const resetTime = windowStart + windowSeconds;

  const currKey = buildKey(identityKey, method, path, windowStart);
  const prevKey = buildKey(identityKey, method, path, prevWindowStart);

  try {
    const [currRaw, prevRaw] = await redis.mget(currKey, prevKey);
    const curr = currRaw ? parseInt(currRaw, 10) : 0;
    const prev = prevRaw ? parseInt(prevRaw, 10) : 0;

    const elapsed = nowSeconds - windowStart;
    const overlap = elapsed / windowSeconds;
    const blended = Math.floor((prev * (1 - overlap)) + curr);
    const remaining = Math.max(0, limit - blended);

    return {
      allowed: blended < limit,
      remaining,
      resetAt: new Date(resetTime * 1000).toISOString(),
      algorithm: 'sliding_window',
    };
  } catch {
    const curr = inMemoryCounters.get(currKey) || 0;
    const prev = inMemoryCounters.get(prevKey) || 0;
    const elapsed = nowSeconds - windowStart;
    const overlap = elapsed / windowSeconds;
    const blended = Math.floor((prev * (1 - overlap)) + curr);
    const remaining = Math.max(0, limit - blended);

    return {
      allowed: blended < limit,
      remaining,
      resetAt: new Date(resetTime * 1000).toISOString(),
      algorithm: 'sliding_window',
    };
  }
}

module.exports = {
  checkSlidingWindow,
  getSlidingWindowStatus,
  buildKey,
  SLIDING_WINDOW_LUA,
};
