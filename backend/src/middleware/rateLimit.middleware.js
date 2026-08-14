'use strict';

// Stage 2 Rate Limit Middleware — see Architecture.md §2.3 and API.md §5, §11.
const { checkFixedWindow } = require('../limiters/fixedWindow.limiter');
const logger = require('../utils/logger');

// Default fallback policy — in Milestone 10 this queries PostgreSQL policies table
const DEFAULT_POLICY = {
  name: 'Default Fixed Window Policy',
  limit: 100,
  windowSeconds: 60,
  failureMode: 'open',
  algorithm: 'fixed_window',
};

function createRateLimiter(customPolicy = {}) {
  return async function rateLimitMiddleware(req, res, next) {
    const policy = { ...DEFAULT_POLICY, ...customPolicy };
    const identityKey = req.identityKey || 'ip:' + (req.ip || req.socket.remoteAddress || '127.0.0.1');

    try {
      const result = await checkFixedWindow({
        identityKey,
        method: req.method,
        path: req.path,
        limit: policy.limit,
        windowSeconds: policy.windowSeconds,
      });

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
            windowSeconds: policy.windowSeconds,
            algorithm: result.algorithm,
            policyName: policy.name,
          },
        });
      }

      next();
    } catch (err) {
      if (policy.failureMode === 'closed') {
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
      logger.warn(`[RateLimit] Redis unavailable, failing open: ${err.message}`);
      res.setHeader('X-RateLimit-Fallback', 'true');
      next();
    }
  };
}

module.exports = {
  createRateLimiter,
  rateLimitMiddleware: createRateLimiter(),
};
