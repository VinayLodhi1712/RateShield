'use strict';

// User model queries — see Database.md Table 1: users.
const db = require('../config/db');

async function findByEmail(email) {
  const res = await db.query(
    'SELECT id, email, password_hash, role, is_active, created_at, updated_at FROM users WHERE email = $1 LIMIT 1;',
    [email]
  );
  return res.rows[0] || null;
}

async function findById(id) {
  const res = await db.query(
    'SELECT id, email, role, is_active, created_at, updated_at FROM users WHERE id = $1 LIMIT 1;',
    [id]
  );
  return res.rows[0] || null;
}

async function createUser({ email, passwordHash, role = 'developer' }) {
  const res = await db.query(
    `INSERT INTO users (email, password_hash, role, is_active)
     VALUES ($1, $2, $3, TRUE)
     RETURNING id, email, role, is_active, created_at, updated_at;`,
    [email, passwordHash, role]
  );
  return res.rows[0];
}

module.exports = {
  findByEmail,
  findById,
  createUser,
};
