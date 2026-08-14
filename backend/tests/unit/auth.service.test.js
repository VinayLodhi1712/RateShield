'use strict';

// Unit tests for auth.service — see docs/Testing.md.
const authService = require('../../src/services/auth.service');
const userModel = require('../../src/models/user.model');
const refreshTokenModel = require('../../src/models/refreshToken.model');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const config = require('../../src/config');
const { ConflictError, UnauthorizedError } = require('../../src/utils/errors');

jest.mock('../../src/models/user.model');
jest.mock('../../src/models/refreshToken.model');

describe('Auth Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('should register a new user and return tokens', async () => {
      userModel.findByEmail.mockResolvedValue(null);
      userModel.createUser.mockResolvedValue({
        id: 1,
        email: 'dev@example.com',
        role: 'developer',
        is_active: true,
        created_at: new Date().toISOString(),
      });
      refreshTokenModel.createRefreshToken.mockResolvedValue({ id: 10 });

      const result = await authService.register({
        email: 'dev@example.com',
        password: 'password123',
      });

      expect(result.user.email).toBe('dev@example.com');
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toMatch(/^rt_/);
      expect(userModel.createUser).toHaveBeenCalled();
    });

    it('should throw ConflictError if user already exists', async () => {
      userModel.findByEmail.mockResolvedValue({ id: 1, email: 'dev@example.com' });

      await expect(
        authService.register({ email: 'dev@example.com', password: 'password123' })
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('login', () => {
    it('should authenticate user and return access/refresh tokens', async () => {
      const passwordHash = await bcrypt.hash('password123', 10);
      userModel.findByEmail.mockResolvedValue({
        id: 1,
        email: 'dev@example.com',
        password_hash: passwordHash,
        role: 'developer',
        is_active: true,
      });
      refreshTokenModel.createRefreshToken.mockResolvedValue({ id: 10 });

      const result = await authService.login({
        email: 'dev@example.com',
        password: 'password123',
      });

      expect(result.user.id).toBe(1);
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toMatch(/^rt_/);
    });

    it('should throw UnauthorizedError on wrong password', async () => {
      const passwordHash = await bcrypt.hash('password123', 10);
      userModel.findByEmail.mockResolvedValue({
        id: 1,
        email: 'dev@example.com',
        password_hash: passwordHash,
        is_active: true,
      });

      await expect(
        authService.login({ email: 'dev@example.com', password: 'wrongPassword' })
      ).rejects.toThrow(UnauthorizedError);
    });

    it('should throw UnauthorizedError when user is inactive', async () => {
      userModel.findByEmail.mockResolvedValue({
        id: 1,
        email: 'dev@example.com',
        is_active: false,
      });

      await expect(
        authService.login({ email: 'dev@example.com', password: 'password123' })
      ).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('refresh', () => {
    it('should rotate refresh token and issue new access token', async () => {
      const futureDate = new Date(Date.now() + 100000);
      refreshTokenModel.findTokenByHash.mockResolvedValue({
        id: 10,
        user_id: 1,
        revoked_at: null,
        expires_at: futureDate,
      });
      userModel.findById.mockResolvedValue({ id: 1, email: 'dev@example.com', role: 'developer', is_active: true });
      refreshTokenModel.revokeToken.mockResolvedValue({ id: 10 });
      refreshTokenModel.createRefreshToken.mockResolvedValue({ id: 11 });

      const result = await authService.refresh({ refreshToken: 'rt_mock_token' });

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toMatch(/^rt_/);
      expect(refreshTokenModel.revokeToken).toHaveBeenCalledWith(10);
    });

    it('should throw UnauthorizedError if token is revoked', async () => {
      refreshTokenModel.findTokenByHash.mockResolvedValue({
        id: 10,
        user_id: 1,
        revoked_at: new Date(),
        expires_at: new Date(Date.now() + 100000),
      });

      await expect(
        authService.refresh({ refreshToken: 'rt_revoked_token' })
      ).rejects.toThrow(UnauthorizedError);
    });
  });
});
