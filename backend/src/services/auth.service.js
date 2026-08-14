'use strict';

// Auth business logic (JWT + refresh token rotation) — see API.md Section 6.
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const config = require('../config');
const userModel = require('../models/user.model');
const refreshTokenModel = require('../models/refreshToken.model');
const { UnauthorizedError, ConflictError } = require('../utils/errors');

const REFRESH_TOKEN_EXPIRY_DAYS = 7;

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

function generateRefreshTokenString() {
  return 'rt_' + crypto.randomBytes(32).toString('hex');
}

async function register({ email, password }) {
  const existing = await userModel.findByEmail(email);
  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await userModel.createUser({ email, passwordHash, role: 'developer' });

  const accessToken = generateAccessToken(user);
  const rawRefreshToken = generateRefreshTokenString();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await refreshTokenModel.createRefreshToken({
    userId: user.id,
    tokenHash: hashToken(rawRefreshToken),
    expiresAt,
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: user.is_active,
      createdAt: user.created_at,
    },
    accessToken,
    refreshToken: rawRefreshToken,
  };
}

async function login({ email, password }) {
  const user = await userModel.findByEmail(email);
  if (!user || !user.is_active) {
    throw new UnauthorizedError('Invalid credentials', 'INVALID_CREDENTIALS');
  }

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    throw new UnauthorizedError('Invalid credentials', 'INVALID_CREDENTIALS');
  }

  const accessToken = generateAccessToken(user);
  const rawRefreshToken = generateRefreshTokenString();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await refreshTokenModel.createRefreshToken({
    userId: user.id,
    tokenHash: hashToken(rawRefreshToken),
    expiresAt,
  });

  const decoded = jwt.decode(accessToken);
  const accessTokenExpiresAt = new Date(decoded.exp * 1000).toISOString();

  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    accessToken,
    accessTokenExpiresAt,
    refreshToken: rawRefreshToken,
    refreshTokenExpiresAt: expiresAt.toISOString(),
  };
}

async function refresh({ refreshToken }) {
  const tokenHash = hashToken(refreshToken);
  const stored = await refreshTokenModel.findTokenByHash(tokenHash);

  if (!stored) {
    throw new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  }
  if (stored.revoked_at) {
    throw new UnauthorizedError('Refresh token has been revoked', 'REFRESH_TOKEN_REVOKED');
  }
  if (new Date(stored.expires_at) <= new Date()) {
    throw new UnauthorizedError('Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
  }

  const user = await userModel.findById(stored.user_id);
  if (!user || !user.is_active) {
    throw new UnauthorizedError('Account is inactive', 'ACCOUNT_SUSPENDED');
  }

  // Token rotation: revoke old token and issue a new one.
  await refreshTokenModel.revokeToken(stored.id);

  const newAccessToken = generateAccessToken(user);
  const newRawRefreshToken = generateRefreshTokenString();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await refreshTokenModel.createRefreshToken({
    userId: user.id,
    tokenHash: hashToken(newRawRefreshToken),
    expiresAt,
  });

  const decoded = jwt.decode(newAccessToken);
  const accessTokenExpiresAt = new Date(decoded.exp * 1000).toISOString();

  return {
    accessToken: newAccessToken,
    accessTokenExpiresAt,
    refreshToken: newRawRefreshToken,
    refreshTokenExpiresAt: expiresAt.toISOString(),
  };
}

async function logout({ refreshToken, userId }) {
  const tokenHash = hashToken(refreshToken);
  const stored = await refreshTokenModel.findTokenByHash(tokenHash);

  if (stored && Number(stored.user_id) === Number(userId)) {
    await refreshTokenModel.revokeToken(stored.id);
  }

  return { message: 'Logged out successfully.' };
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  hashToken,
  generateAccessToken,
};
