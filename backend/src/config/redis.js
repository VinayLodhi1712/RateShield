'use strict';

// Redis connection wrapper — see Redis.md and Architecture.md §2.4.
const Redis = require('ioredis');
const config = require('./index');
const logger = require('../utils/logger');

let hasLoggedOfflineWarning = false;

const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy(times) {
    if (times > 3) {
      if (!hasLoggedOfflineWarning) {
        logger.warn('[Redis] Offline — standalone in-memory fallback active.');
        hasLoggedOfflineWarning = true;
      }
      return null; // Stop endless reconnect loop when offline
    }
    return 1000;
  },
});

redis.on('connect', () => {
  hasLoggedOfflineWarning = false;
  logger.info('[Redis] Connection ready');
});
redis.on('error', () => {
  // Suppress uncaught event emitter errors in standalone dev mode
});

async function pingRedis() {
  const start = Date.now();
  try {
    if (redis.status === 'wait') {
      await redis.connect();
    }
    const pong = await redis.ping();
    if (pong === 'PONG') {
      return { status: 'healthy', latencyMs: Date.now() - start, error: null };
    }
    return { status: 'unhealthy', latencyMs: null, error: 'Unexpected response' };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: null, error: err.message };
  }
}

async function closeRedis() {
  try {
    if (redis.status !== 'end' && redis.status !== 'wait') {
      await redis.quit();
    }
  } catch {
    // ignore
  }
}

module.exports = {
  redis,
  pingRedis,
  closeRedis,
};
