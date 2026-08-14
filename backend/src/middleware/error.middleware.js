'use strict';

// Global error handler — returns the standard error envelope from API.md Section 4.
// Must be the LAST middleware registered (Express identifies it by the 4-arg signature).
// Custom errors should set err.statusCode and err.errorCode; see Milestone 6.

function errorMiddleware(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const errorCode  = err.errorCode  || 'INTERNAL_ERROR';

  // Hide internal error messages from clients in production (4xx messages are safe to show).
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

  if (req.requestId) res.setHeader('X-Request-Id', req.requestId);

  res.status(statusCode).json(body);
}

module.exports = errorMiddleware;
