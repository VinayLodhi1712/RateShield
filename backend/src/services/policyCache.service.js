'use strict';

// 30-second in-process policy cache — see Architecture.md §3.3 and Database.md §7.
const policyModel = require('../models/policy.model');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();

const FALLBACK_POLICY = {
  id: null,
  name: 'Default Fallback Policy',
  algorithm: 'fixed_window',
  limit_count: 100,
  window_seconds: 60,
  failure_mode: 'open',
};

async function resolvePolicy({ userId = null, ipAddress = '127.0.0.1', method = 'GET', path = '/' }) {
  const endpointPath = `${method} ${path}`;
  const cacheKey = `policy:${userId || 'anon'}:${ipAddress}:${endpointPath}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.policy;
  }

  try {
    const policy = await policyModel.findMatchingPolicy({
      userId,
      ipAddress,
      endpointPath,
    });

    const activePolicy = policy || FALLBACK_POLICY;
    cache.set(cacheKey, { policy: activePolicy, timestamp: Date.now() });
    return activePolicy;
  } catch (err) {
    logger.warn(`[PolicyCache] DB lookup error, using fallback policy: ${err.message}`);
    return FALLBACK_POLICY;
  }
}

function clearCache() {
  cache.clear();
}

module.exports = {
  resolvePolicy,
  clearCache,
  FALLBACK_POLICY,
};
