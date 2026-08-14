'use strict';

// Logs every HTTP request on response finish: method, path, status, duration, requestId.
// Uses res.on('finish') so the status code is known before logging.

const logger = require('../utils/logger');

function requestLoggerMiddleware(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warn'
                : 'http';

    logger[level](`${req.method} ${req.path}`, {
      status:    res.statusCode,
      durationMs: duration,
      requestId: req.requestId,
    });
  });

  next();
}

module.exports = requestLoggerMiddleware;
