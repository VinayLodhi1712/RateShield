'use strict';

// Fixed Window rate limiter — see Redis.md Section 5 and Algorithms.md Section 3.
const { redis } = require('../config/redis');
const { runLuaScript } = require('../utils/luaScriptRunner');

const FIXED_WINDOW_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

local current = redis.call('GET', key)
if not current then
  redis.call('SET', key, 1, 'EX', window + 1)
  return { 1, 1, limit - 1 }
end

local count = tonumber(current)
if count >= limit then
  return { 0, count, 0 }
else
  local newCount = redis.call('INCR', key)
  return { 1, newCount, limit - newCount }
end
`;

function buildKey(identityKey, method, path, windowStart) {
  const encodedPath = encodeURIComponent(path);
  return `rateshield:fixed:${identityKey}:${method}:${encodedPath}:${windowStart}`;
}

async function checkFixedWindow({ identityKey, method, path, limit, windowSeconds }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const resetTime = windowStart + windowSeconds;
  const key = buildKey(identityKey, method, path, windowStart);

  const result = typeof redis.evalsha === 'function'
    ? await runLuaScript(redis, FIXED_WINDOW_LUA, 1, key, limit, windowSeconds)
    : await redis.eval(FIXED_WINDOW_LUA, 1, key, limit, windowSeconds);

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
    algorithm: 'fixed_window',
  };
}

async function getFixedWindowStatus({ identityKey, method, path, limit, windowSeconds }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const resetTime = windowStart + windowSeconds;
  const key = buildKey(identityKey, method, path, windowStart);

  try {
    const rawVal = await redis.get(key);
    const current = rawVal ? parseInt(rawVal, 10) : 0;
    const remaining = Math.max(0, limit - current);
    const allowed = current < limit;

    return {
      allowed,
      remaining,
      resetAt: new Date(resetTime * 1000).toISOString(),
      algorithm: 'fixed_window',
    };
  } catch {
    return {
      allowed: true,
      remaining: limit,
      resetAt: new Date(resetTime * 1000).toISOString(),
      algorithm: 'fixed_window',
    };
  }
}

module.exports = {
  checkFixedWindow,
  getFixedWindowStatus,
  buildKey,
  FIXED_WINDOW_LUA,
};
