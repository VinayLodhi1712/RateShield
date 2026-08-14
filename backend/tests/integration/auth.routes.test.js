'use strict';

// Integration tests for Auth Routes — see docs/Testing.md.
const request = require('supertest');
const app = require('../../src/app');
const userModel = require('../../src/models/user.model');
const refreshTokenModel = require('../../src/models/refreshToken.model');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const config = require('../../src/config');

jest.mock('../../src/models/user.model');
jest.mock('../../src/models/refreshToken.model');

describe('Auth Endpoints (Integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /auth/register', () => {
    it('should return 201 on valid registration', async () => {
      userModel.findByEmail.mockResolvedValue(null);
      userModel.createUser.mockResolvedValue({
        id: 1,
        email: 'test@example.com',
        role: 'developer',
        is_active: true,
        created_at: new Date().toISOString(),
      });
      refreshTokenModel.createRefreshToken.mockResolvedValue({ id: 1 });

      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'test@example.com', password: 'securePassword123' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe('test@example.com');
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
    });

    it('should return 400 on invalid email or short password', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'notanemail', password: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.length).toBeGreaterThan(0);
    });

    it('should return 409 if email already registered', async () => {
      userModel.findByEmail.mockResolvedValue({ id: 1, email: 'test@example.com' });

      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'test@example.com', password: 'securePassword123' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CONFLICT');
    });
  });

  describe('POST /auth/login', () => {
    it('should return 200 on valid credentials', async () => {
      const passwordHash = await bcrypt.hash('securePassword123', 10);
      userModel.findByEmail.mockResolvedValue({
        id: 1,
        email: 'test@example.com',
        password_hash: passwordHash,
        role: 'developer',
        is_active: true,
      });
      refreshTokenModel.createRefreshToken.mockResolvedValue({ id: 1 });

      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'securePassword123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
    });

    it('should return 401 on invalid credentials', async () => {
      userModel.findByEmail.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'wrongPassword' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('POST /auth/refresh', () => {
    it('should return 200 and new tokens on valid refresh token', async () => {
      refreshTokenModel.findTokenByHash.mockResolvedValue({
        id: 1,
        user_id: 1,
        expires_at: new Date(Date.now() + 60000),
        revoked_at: null,
      });
      userModel.findById.mockResolvedValue({ id: 1, email: 'test@example.com', role: 'developer', is_active: true });
      refreshTokenModel.revokeToken.mockResolvedValue({ id: 1 });
      refreshTokenModel.createRefreshToken.mockResolvedValue({ id: 2 });

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: 'rt_mock_token' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
    });
  });

  describe('POST /auth/logout', () => {
    it('should return 200 on logout with valid JWT token', async () => {
      const token = jwt.sign({ sub: 1, email: 'test@example.com', role: 'developer' }, config.jwt.secret, { expiresIn: '15m' });
      refreshTokenModel.findTokenByHash.mockResolvedValue({ id: 1, user_id: 1 });
      refreshTokenModel.revokeToken.mockResolvedValue({ id: 1 });

      const res = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .send({ refreshToken: 'rt_mock_token' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 401 on logout without JWT token', async () => {
      const res = await request(app)
        .post('/auth/logout')
        .send({ refreshToken: 'rt_mock_token' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('MISSING_CREDENTIALS');
    });
  });
});
