'use strict';

// Rate limit status routes — see API.md Section 9.
const express = require('express');
const rateLimitController = require('../controllers/rateLimit.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/status', requireAuth, rateLimitController.getStatus);

module.exports = router;
