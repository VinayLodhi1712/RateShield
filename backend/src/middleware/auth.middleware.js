'use strict';

// Stage 1 Auth Middleware & Stage 3 Auth Guards — see Architecture.md §2.2 and API.md §3.
const jwt = require('jsonwebtoken');
const config = require('../config');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');

function authMiddleware(req, _res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    req.identityKey = 'ip:' + (req.ip || req.socket.remoteAddress || '127.0.0.1');
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = { id: decoded.sub, email: decoded.email, role: decoded.role };
    req.identityKey = 'user:' + decoded.sub;
    next();
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
    next(new UnauthorizedError('Invalid or expired token', code));
  }
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
