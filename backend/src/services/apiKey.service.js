'use strict';

// API Key business logic & hashing — see API.md Section 7 and Database.md Table 3.
const crypto = require('crypto');
const apiKeyModel = require('../models/apiKey.model');
const { ValidationError, NotFoundError } = require('../utils/errors');

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

async function createApiKey({ userId, name, expiresAt = null }) {
  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    throw new ValidationError('Name is required and must be between 1 and 100 characters');
  }

  let parsedExpiresAt = null;
  if (expiresAt) {
    parsedExpiresAt = new Date(expiresAt);
    if (isNaN(parsedExpiresAt.getTime()) || parsedExpiresAt.getTime() <= Date.now()) {
      throw new ValidationError('expiresAt must be a valid future ISO 8601 date');
    }
  }

  // 35-character cryptographically secure key: 'rs_' + 32 random hex characters
  const rawKey = `rs_${crypto.randomBytes(16).toString('hex')}`;
  const keyPrefix = rawKey.slice(0, 8);
  const keyHash = hashApiKey(rawKey);

  const record = await apiKeyModel.createApiKey({
    userId,
    keyHash,
    keyPrefix,
    name: name.trim(),
    expiresAt: parsedExpiresAt ? parsedExpiresAt.toISOString() : null,
  });

  return {
    apiKey: {
      id: record.id,
      name: record.name,
      prefix: record.key_prefix,
      key: rawKey, // Returned strictly once on creation — see API.md Section 7
      isActive: record.is_active,
      expiresAt: record.expires_at,
      createdAt: record.created_at,
    },
    warning: 'Save this key now — it will not be shown again.',
  };
}

async function listApiKeys(userId, { includeInactive = false, limit = 20 } = {}) {
  const parsedLimit = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
  const keys = await apiKeyModel.findByUserId(userId, {
    includeInactive: String(includeInactive) === 'true',
    limit: parsedLimit,
  });

  return {
    data: keys,
    meta: {
      limit: parsedLimit,
      nextCursor: null,
      hasMore: false,
    },
  };
}

async function revokeApiKey(id, userId) {
  const revoked = await apiKeyModel.revokeKey(id, userId);
  if (!revoked) {
    throw new NotFoundError(`API key ${id} not found or not owned by user`);
  }

  return {
    message: `API key ${revoked.key_prefix} revoked successfully.`,
    revokedAt: new Date().toISOString(),
  };
}

async function validateApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith('rs_')) {
    return null;
  }

  const keyHash = hashApiKey(rawKey);
  const record = await apiKeyModel.findByKeyHash(keyHash);

  if (!record || !record.is_active || !record.user_active) {
    return null;
  }

  if (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) {
    return null;
  }

  // Fire-and-forget asynchronous last_used_at touch
  apiKeyModel.touchLastUsed(record.id).catch(() => {});

  return {
    id: record.id,
    name: record.name,
    prefix: record.key_prefix,
    userId: record.user_id,
    userRole: record.user_role || 'developer',
    userEmail: record.user_email,
  };
}

module.exports = {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKey,
  hashApiKey,
};
