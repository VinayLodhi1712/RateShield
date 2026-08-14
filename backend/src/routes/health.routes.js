'use strict';

// GET /health — returns API, Redis, and Postgres operational status (API.md Section 9).
const express = require('express');
const { pingRedis } = require('../config/redis');
const { pingDb } = require('../config/db');

const router = express.Router();

router.get('/', async (req, res) => {
  const [redisHealth, dbHealth] = await Promise.all([
    pingRedis(),
    pingDb(),
  ]);

  const isHealthy = redisHealth.status === 'healthy' && dbHealth.status === 'healthy';

  const redisData = { status: redisHealth.status, latencyMs: redisHealth.latencyMs };
  if (redisHealth.error) redisData.error = redisHealth.error;

  const postgresData = { status: dbHealth.status, latencyMs: dbHealth.latencyMs };
  if (dbHealth.error) postgresData.error = dbHealth.error;

  res.status(200).json({
    success: true,
    data: {
      status: isHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      components: {
        api: { status: 'healthy' },
        redis: redisData,
        postgres: postgresData,
      },
    },
  });
});

module.exports = router;
