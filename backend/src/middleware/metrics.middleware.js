'use strict';

// HTTP metrics instrumentation middleware — see Architecture.md §2.1.
const { httpRequestsTotal, httpRequestDurationSeconds } = require('../metrics/metrics');

function normalizeRoute(path) {
  if (!path || path === '/') return '/';
  if (path.startsWith('/health')) return '/health';
  if (path.startsWith('/metrics')) return '/metrics';
  if (path.startsWith('/auth')) return path;
  if (path.startsWith('/rate-limit')) return path;
  if (path.startsWith('/api-keys')) return '/api-keys';
  return 'other';
}

function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = normalizeRoute(req.baseUrl || req.path);
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode,
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSec);
  });

  next();
}

module.exports = metricsMiddleware;
