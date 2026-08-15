'use strict';

// Prometheus metrics registry & collectors — see Architecture.md §2.1 and API.md §3.
const client = require('prom-client');

const register = new client.Registry();

// Collect Node.js process runtime metrics (memory, event loop lag, cpu)
client.collectDefaultMetrics({
  register,
  prefix: 'rateshield_',
});

const httpRequestsTotal = new client.Counter({
  name: 'rateshield_http_requests_total',
  help: 'Total number of HTTP requests processed',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'rateshield_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.015, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const rateLimitDecisionsTotal = new client.Counter({
  name: 'rateshield_ratelimit_decisions_total',
  help: 'Total rate limit checks evaluated',
  labelNames: ['algorithm', 'action', 'policy_name'],
  registers: [register],
});

const rateLimitBlockedTotal = new client.Counter({
  name: 'rateshield_ratelimit_blocked_total',
  help: 'Total requests throttled with 429 Too Many Requests',
  labelNames: ['algorithm', 'policy_name'],
  registers: [register],
});

const redisErrorsTotal = new client.Counter({
  name: 'rateshield_redis_errors_total',
  help: 'Total Redis errors and fail-open/closed events',
  labelNames: ['operation'],
  registers: [register],
});

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  rateLimitDecisionsTotal,
  rateLimitBlockedTotal,
  redisErrorsTotal,
};
