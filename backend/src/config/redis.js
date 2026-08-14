'use strict';

// Redis connection wrapper — see Redis.md and Architecture.md §2.4.
const Redis = require('ioredis');
const config = require('./index');
const logger = require('../utils/logger');

const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true, // connect on demand to avoid blocking startup if offline
  retryStrategy(times) {
    // Exponential backoff capped at 2 seconds
    return Math.min(times * 100, 2000);
  },
});

redis.on('connect', () => logger.info('[Redis] Connecting to Redis server...'));
redis.on('ready', () => logger.info('[Redis] Connection ready'));
redis.on('error', (err) => logger.warn(`[Redis] Connection error: ${err.message}`));
redis.on('close', () => logger.warn('[Redis] Connection closed'));
redis.on('reconnecting', (time) => logger.info(`[Redis] Reconnecting in ${time}ms...`));

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
    if (redis.status !== 'end') {
      await redis.quit();
    }
  } catch (err) {
    logger.warn(`[Redis] Error during shutdown: ${err.message}`);
  }
}

module.exports = {
  redis,
  pingRedis,
  closeRedis,
};
