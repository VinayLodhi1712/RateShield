'use strict';

// Auth route controllers — see API.md Section 6.
const authService = require('../services/auth.service');
const { ValidationError } = require('../utils/errors');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function register(req, res, next) {
  try {
    const { email, password } = req.body;
    const details = [];

    if (!email || !EMAIL_REGEX.test(email)) {
      details.push({ field: 'email', message: 'Must be a valid email address' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      details.push({ field: 'password', message: 'Password must be at least 8 characters' });
    }

    if (details.length > 0) {
      throw new ValidationError('Validation failed', details);
    }

    const data = await authService.register({ email: email.toLowerCase().trim(), password });
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const details = [];

    if (!email) details.push({ field: 'email', message: 'Email is required' });
    if (!password) details.push({ field: 'password', message: 'Password is required' });

    if (details.length > 0) {
      throw new ValidationError('Validation failed', details);
    }

    const data = await authService.login({ email: email.toLowerCase().trim(), password });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      throw new ValidationError('Validation failed', [
        { field: 'refreshToken', message: 'refreshToken is required' },
      ]);
    }

    const data = await authService.refresh({ refreshToken });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      throw new ValidationError('Validation failed', [
        { field: 'refreshToken', message: 'refreshToken is required' },
      ]);
    }

    const data = await authService.logout({
      refreshToken,
      userId: req.user.id,
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  register,
  login,
  refresh,
  logout,
};
