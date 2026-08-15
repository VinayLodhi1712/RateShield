'use strict';

// Stage 1 Auth Middleware & Stage 3 Auth Guards — see Architecture.md §2.2 and API.md §3.
const jwt = require('jsonwebtoken');
const config = require('../config');
const { validateApiKey } = require('../services/apiKey.service');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');

async function authMiddleware(req, _res, next) {
  const ipAddress = req.ip || req.socket.remoteAddress || '127.0.0.1';
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers.authorization;

  // 1. API Key Authentication (X-API-Key or Authorization: ApiKey <key>)
  let rawApiKey = apiKeyHeader;
  if (!rawApiKey && authHeader && authHeader.startsWith('ApiKey ')) {
    rawApiKey = authHeader.split(' ')[1];
  }

  if (rawApiKey) {
    const keyInfo = await validateApiKey(rawApiKey);
    if (keyInfo) {
      req.user = { id: keyInfo.userId, email: keyInfo.userEmail, role: keyInfo.userRole };
      req.apiKey = keyInfo;
      req.identityKey = `apikey:${keyInfo.prefix}`;
      return next();
    }
  }

  // 2. JWT Authentication (Authorization: Bearer <token>)
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      req.user = { id: decoded.sub, email: decoded.email, role: decoded.role };
      req.identityKey = `user:${decoded.sub}`;
      return next();
    } catch {
      // Fallback to IP on expired token
    }
  }

  // 3. Fallback to Anonymous IP Identity
  req.user = null;
  req.apiKey = null;
  req.identityKey = `ip:${ipAddress}`;
  next();
}

function requireAuth(req, _res, next) {
  if (!req.user) {
    return next(new UnauthorizedError('Authentication required', 'MISSING_CREDENTIALS'));
  }
  next();
}

function requireAdmin(req, _res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return next(new ForbiddenError('Admin access required', 'INSUFFICIENT_ROLE'));
  }
  next();
}

module.exports = {
  authMiddleware,
  requireAuth,
  requireAdmin,
};
