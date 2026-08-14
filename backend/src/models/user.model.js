'use strict';

// User model queries — see Database.md Table 1: users.
const bcrypt = require('bcrypt');
const db = require('../config/db');
const logger = require('../utils/logger');

// In-memory fallback store for standalone development mode
const inMemoryUsers = new Map([
  [
    'developer@rateshield.io',
    {
      id: 1,
      email: 'developer@rateshield.io',
      password_hash: bcrypt.hashSync('password123', 10),
      role: 'developer',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
  [
    'admin@rateshield.io',
    {
      id: 2,
      email: 'admin@rateshield.io',
      password_hash: bcrypt.hashSync('AdminSecure2026!', 10),
      role: 'admin',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
]);

let nextUserId = 3;

async function findByEmail(email) {
  try {
    const res = await db.query(
      'SELECT id, email, password_hash, role, is_active, created_at, updated_at FROM users WHERE email = $1 LIMIT 1;',
      [email]
    );
    return res.rows[0] || null;
  } catch (err) {
    logger.warn(`[User] DB lookup fallback to in-memory: ${err.message}`);
    return inMemoryUsers.get(email.toLowerCase()) || null;
  }
}

async function findById(id) {
  try {
    const res = await db.query(
      'SELECT id, email, role, is_active, created_at, updated_at FROM users WHERE id = $1 LIMIT 1;',
      [id]
    );
    return res.rows[0] || null;
  } catch (err) {
    for (const u of inMemoryUsers.values()) {
      if (u.id === Number(id)) return u;
    }
    return null;
  }
}

async function createUser({ email, passwordHash, role = 'developer' }) {
  try {
    const res = await db.query(
      `INSERT INTO users (email, password_hash, role, is_active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, email, role, is_active, created_at, updated_at;`,
      [email, passwordHash, role]
    );
    return res.rows[0];
  } catch (err) {
    logger.warn(`[User] DB write fallback to in-memory: ${err.message}`);
    const newUser = {
      id: nextUserId++,
      email: email.toLowerCase(),
      password_hash: passwordHash,
      role,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    inMemoryUsers.set(email.toLowerCase(), newUser);
    return newUser;
  }
}

module.exports = {
  findByEmail,
  findById,
  createUser,
  inMemoryUsers,
};
