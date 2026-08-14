'use strict';

// GET /health — response shape defined in API.md Section 9.
// Always returns 200; component failures live in the body, not the status code.
// Redis and postgres stubs replaced in Milestone 8.

/**
 * @openapi
 * /health:
 *   get:
 *     summary: API server and component health status
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Server is reachable (check body.data.status for component health)
 */

const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      status: 'degraded', // upgraded to 'healthy' once Redis + PG checks are live
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      components: {
        api:      { status: 'healthy' },
        redis:    { status: 'not_implemented', latencyMs: null },
        postgres: { status: 'not_implemented', latencyMs: null },
      },
    },
  });
});

module.exports = router;
