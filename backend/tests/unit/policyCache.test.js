'use strict';

// Unit tests for Policy Cache & Model — see Database.md §7.
const policyCache = require('../../src/services/policyCache.service');
const policyModel = require('../../src/models/policy.model');

jest.mock('../../src/models/policy.model');

describe('Policy Cache & Resolution (Unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    policyCache.clearCache();
  });

  it('should resolve and return matching policy from DB on cache miss', async () => {
    policyModel.findMatchingPolicy.mockResolvedValue({
      id: 1,
      name: 'Custom User Policy',
      limit_count: 50,
      window_seconds: 60,
      failure_mode: 'open',
      algorithm: 'fixed_window',
    });

    const policy = await policyCache.resolvePolicy({
      userId: 123,
      ipAddress: '192.168.1.1',
      method: 'POST',
      path: '/api/data',
    });

    expect(policy.id).toBe(1);
    expect(policy.limit_count).toBe(50);
    expect(policyModel.findMatchingPolicy).toHaveBeenCalledTimes(1);
  });

  it('should return cached policy on second call without querying DB (cache hit)', async () => {
    policyModel.findMatchingPolicy.mockResolvedValue({
      id: 2,
      name: 'Strict Login Policy',
      limit_count: 5,
      window_seconds: 60,
      failure_mode: 'closed',
      algorithm: 'fixed_window',
    });

    const first = await policyCache.resolvePolicy({
      userId: null,
      ipAddress: '203.0.113.1',
      method: 'POST',
      path: '/auth/login',
    });
    const second = await policyCache.resolvePolicy({
      userId: null,
      ipAddress: '203.0.113.1',
      method: 'POST',
      path: '/auth/login',
    });

    expect(first.id).toBe(2);
    expect(second.id).toBe(2);
    expect(policyModel.findMatchingPolicy).toHaveBeenCalledTimes(1); // 1 DB trip only
  });

  it('should return fallback policy when no policy in DB', async () => {
    policyModel.findMatchingPolicy.mockResolvedValue(null);

    const policy = await policyCache.resolvePolicy({
      userId: null,
      ipAddress: '127.0.0.1',
      method: 'GET',
      path: '/unknown',
    });

    expect(policy.limit_count).toBe(100);
    expect(policy.name).toBe('Default Fallback Policy');
  });
});
