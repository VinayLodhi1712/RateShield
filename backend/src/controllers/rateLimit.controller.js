'use strict';

// Rate limit status controller — see API.md Section 9.
const { resolvePolicy } = require('../services/policyCache.service');
const { getFixedWindowStatus } = require('../limiters/fixedWindow.limiter');
const { getSlidingWindowStatus } = require('../limiters/slidingWindow.limiter');
const { getSlidingLogStatus } = require('../limiters/slidingLog.limiter');
const { getTokenBucketStatus } = require('../limiters/tokenBucket.limiter');
const { getLeakyBucketStatus } = require('../limiters/leakyBucket.limiter');
const { ValidationError } = require('../utils/errors');

async function resolveStatusByAlgorithm(params, algorithm) {
  switch (algorithm) {
    case 'leaky_bucket':
      return getLeakyBucketStatus(params);
    case 'token_bucket':
      return getTokenBucketStatus(params);
    case 'sliding_log':
      return getSlidingLogStatus(params);
    case 'sliding_window':
      return getSlidingWindowStatus(params);
    case 'fixed_window':
    default:
      return getFixedWindowStatus(params);
  }
}

async function getStatus(req, res, next) {
  try {
    const rawEndpoint = req.query.endpoint;
    if (!rawEndpoint || typeof rawEndpoint !== 'string' || !rawEndpoint.trim()) {
      throw new ValidationError('Validation failed', [
        { field: 'endpoint', message: 'endpoint query parameter is required' },
      ]);
    }

    let method = 'GET';
    let path = rawEndpoint.trim();
    if (path.includes(' ')) {
      const parts = path.split(/\s+/);
      method = parts[0].toUpperCase();
      path = parts.slice(1).join(' ');
    }

    const userId = req.user.id;
    const ipAddress = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const identityKey = `user:${userId}`;

    const policy = await resolvePolicy({
      userId,
      ipAddress,
      method,
      path,
    });

    const limit = policy.limit_count || policy.limit || 100;
    const windowSeconds = policy.window_seconds || policy.windowSeconds || 60;
    const algorithm = policy.algorithm || 'fixed_window';
    const leakRate = policy.leak_rate_per_second || null;

    const state = await resolveStatusByAlgorithm(
      {
        identityKey,
        method,
        path,
        limit,
        windowSeconds,
        leakRate,
      },
      algorithm
    );

    res.status(200).json({
      success: true,
      data: {
        endpoint: `${method} ${path}`,
        policy: {
          id: policy.id,
          name: policy.name,
          algorithm,
          limitCount: limit,
          windowSeconds,
          failureMode: policy.failure_mode || 'open',
        },
        state,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getStatus,
};
