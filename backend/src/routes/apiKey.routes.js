'use strict';

// API Key route definitions — see API.md Section 7.
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const apiKeyController = require('../controllers/apiKey.controller');

const router = express.Router();

// All API key endpoints require an authenticated user session
router.use(requireAuth);

router.post('/', apiKeyController.create);
router.get('/', apiKeyController.list);
router.delete('/:id', apiKeyController.revoke);

module.exports = router;
