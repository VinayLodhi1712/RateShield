'use strict';

// API Key controller — see API.md Section 7.
const apiKeyService = require('../services/apiKey.service');

async function create(req, res, next) {
  try {
    const { name, expiresAt } = req.body;
    const result = await apiKeyService.createApiKey({
      userId: req.user.id,
      name,
      expiresAt,
    });
    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const { includeInactive, limit } = req.query;
    const result = await apiKeyService.listApiKeys(req.user.id, {
      includeInactive,
      limit,
    });
    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
    });
  } catch (err) {
    next(err);
  }
}

async function revoke(req, res, next) {
  try {
    const { id } = req.params;
    const result = await apiKeyService.revokeApiKey(id, req.user.id);
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  create,
  list,
  revoke,
};
