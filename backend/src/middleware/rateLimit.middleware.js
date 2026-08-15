'use strict';

// Stage 2 Rate Limit Middleware — see Architecture.md §2.3 and API.md §5, §11.
const { checkFixedWindow } = require('../limiters/fixedWindow.limiter');
const { checkSlidingWindow } = require('../limiters/slidingWindow.limiter');
const { checkSlidingLog } = require('../limiters/slidingLog.limiter');
const { resolvePolicy } = require('../services/policyCache.service');
const logger = require('../utils/logger');

let hasLoggedFailOpen = false;

async function executeLimiter(params, algorithm) {
  switch (algorithm) {
    case 'sliding_log':
      return checkSlidingLog(params);
    case 'sliding_window':
      return checkSlidingWindow(params);
    case 'fixed_window':
    default:
      return checkFixedWindow(params);
  }
}

function createRateLimiter(customPolicy = null) {
  return async function rateLimitMiddleware(req, res, next) {
    const ipAddress = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const userId = req.user ? req.user.id : null;
    const identityKey = req.identityKey || (userId ? `user:${userId}` : `ip:${ipAddress}`);

    const policy = customPolicy || await resolvePolicy({
      userId,
      ipAddress,
      method: req.method,
      path: req.path,
    });

    const limit = policy.limit_count || policy.limit || 100;
    const windowSeconds = policy.window_seconds || policy.windowSeconds || 60;
    const failureMode = policy.failure_mode || policy.failureMode || 'open';
    const policyName = policy.name || 'Default Policy';
    const algorithm = policy.algorithm || 'fixed_window';

    try {
      const result = await executeLimiter(
        {
          identityKey,
          method: req.method,
          path: req.path,
          limit,
          windowSeconds,
          requestId: req.id,
        },
        algorithm
      );

      hasLoggedFailOpen = false;
      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', result.resetTime);
      res.setHeader('X-RateLimit-Algorithm', result.algorithm);

      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter);
        return res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. You have exceeded the rate limit for this endpoint.',
            retryAfter: result.retryAfter,
            limit: result.limit,
            windowSeconds,
            algorithm: result.algorithm,
            policyName,
          },
        });
      }

      next();
    } catch (err) {
      if (failureMode === 'closed') {
        logger.error(`[RateLimit] Redis unavailable on fail-closed policy: ${err.message}`);
        return res.status(503).json({
          success: false,
          error: {
            code: 'RATE_LIMITER_UNAVAILABLE',
            message: 'The rate limiting service is temporarily unavailable. Please retry with exponential backoff.',
            failureMode: 'closed',
            retryAfter: null,
          },
        });
      }

      // Fail-open: allow request through during Redis downtime
      if (!hasLoggedFailOpen) {
        logger.warn(`[RateLimit] Redis unavailable, failing open: ${err.message}`);
        hasLoggedFailOpen = true;
      }
      res.setHeader('X-RateLimit-Fallback', 'true');
      next();
    }
  };
}

module.exports = {
  createRateLimiter,
  rateLimitMiddleware: createRateLimiter(),
};
