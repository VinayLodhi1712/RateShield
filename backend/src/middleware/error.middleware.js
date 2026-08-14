'use strict';

// Global error handler — returns standard error envelope (API.md Section 4).
// Must be last middleware registered in Express (4-arg signature).

const logger = require('../utils/logger');

function errorMiddleware(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const errorCode = err.errorCode || 'INTERNAL_ERROR';

  // Log 500 / unhandled errors with stack trace for debugging
  if (statusCode >= 500) {
    logger.error(`[Unhandled Error] ${err.message}`, {
      requestId: req.requestId,
      stack: err.stack,
    });
  }

  // Hide raw internal error messages in production for 5xx errors
  const isProd = process.env.NODE_ENV === 'production';
  const message = isProd && statusCode >= 500
    ? 'An unexpected error occurred.'
    : err.message || 'An unexpected error occurred.';

  const body = {
    success: false,
    error: { code: errorCode, message },
  };

  if (Array.isArray(err.details)) {
    body.error.details = err.details;
  }

  if (req.requestId) {
    res.setHeader('X-Request-Id', req.requestId);
  }

  res.status(statusCode).json(body);
}

module.exports = errorMiddleware;
