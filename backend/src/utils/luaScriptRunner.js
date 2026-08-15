'use strict';

// High-speed Lua script runner with EVALSHA caching — see Architecture.md §2.4.
const crypto = require('crypto');

const scriptShaCache = new Map();

function getScriptSha(script) {
  let sha = scriptShaCache.get(script);
  if (!sha) {
    sha = crypto.createHash('sha1').update(script).digest('hex');
    scriptShaCache.set(script, sha);
  }
  return sha;
}

async function runLuaScript(redisClient, script, numKeys, ...args) {
  const sha = getScriptSha(script);

  try {
    // 1. Try high-performance EVALSHA first (40-byte hash instead of full script payload)
    return await redisClient.evalsha(sha, numKeys, ...args);
  } catch (err) {
    if (err && err.message && err.message.includes('NOSCRIPT')) {
      // 2. Fallback to EVAL on Redis cache miss and preload script into Redis memory
      const res = await redisClient.eval(script, numKeys, ...args);
      redisClient.script('LOAD', script).catch(() => {});
      return res;
    }
    throw err;
  }
}

module.exports = {
  runLuaScript,
  getScriptSha,
};
