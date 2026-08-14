'use strict';

// Single source of truth for environment configuration.
// All env vars are validated here at startup; no other file reads process.env directly.
// Rationale for this pattern: Architecture.md Section 2.1 ("Centralised Configuration").

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(key) {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(
      `[Config] Missing required environment variable: ${key}\n` +
      `         Add it to backend/.env or your deployment environment.\n` +
      `         See backend/.env.example for the full list.`
    );
  }
  return value.trim();
}

function optionalEnv(key, defaultValue) {
  const value = process.env[key];
  return (value && value.trim() !== '') ? value.trim() : defaultValue;
}

function intEnv(key, defaultValue) {
  const raw = process.env[key];
  if (!raw || raw.trim() === '') return defaultValue;
  const parsed = parseInt(raw.trim(), 10);
  if (isNaN(parsed)) throw new Error(`[Config] ${key} must be an integer, got: "${raw}"`);
  return parsed;
}

// ─── Startup Validation ───────────────────────────────────────────────────────

const NODE_ENV = optionalEnv('NODE_ENV', 'development');
if (!['development', 'test', 'production'].includes(NODE_ENV)) {
  throw new Error(`[Config] Invalid NODE_ENV: "${NODE_ENV}". Must be development | test | production.`);
}

const LOG_LEVEL = optionalEnv('LOG_LEVEL', 'info');
if (!['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'].includes(LOG_LEVEL)) {
  throw new Error(`[Config] Invalid LOG_LEVEL: "${LOG_LEVEL}".`);
}

const JWT_SECRET = requireEnv('JWT_SECRET');
if (JWT_SECRET.length < 32) {
  // 32 chars minimum = 256 bits, required for HMAC-SHA256 security.
  throw new Error(
    `[Config] JWT_SECRET too short (${JWT_SECRET.length} chars, min 32). ` +
    `Generate one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  );
}

// ─── Config Object ────────────────────────────────────────────────────────────

const config = {
  server: {
    port:   intEnv('PORT', 3000),
    env:    NODE_ENV,
    isDev:  NODE_ENV === 'development',
    isProd: NODE_ENV === 'production',
    isTest: NODE_ENV === 'test',
  },
  jwt: {
    secret:    JWT_SECRET,
    expiresIn: optionalEnv('JWT_EXPIRES_IN', '15m'), // short-lived — see Architecture.md §2.2
  },
  db: {
    url: requireEnv('DATABASE_URL'), // never log — contains credentials
  },
  redis: {
    url: requireEnv('REDIS_URL'),    // never log — may contain password
  },
  logging: {
    level: LOG_LEVEL,
  },
};

module.exports = config;
