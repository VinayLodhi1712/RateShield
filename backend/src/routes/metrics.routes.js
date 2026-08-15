'use strict';

// Prometheus metrics scraper endpoint — see Architecture.md §2.1 and API.md §3.
const express = require('express');
const { register } = require('../metrics/metrics');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    res.setHeader('Content-Type', register.contentType);
    res.status(200).send(await register.metrics());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
