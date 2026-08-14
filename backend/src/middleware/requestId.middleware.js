'use strict';

// Attaches X-Request-Id to every request and response — see API.md Section 2.
// Must be the first middleware in app.js so all downstream code sees req.requestId.

const { generateRequestId } = require('../utils/requestId');

function requestIdMiddleware(req, res, next) {
  // Honour a pre-existing ID from an upstream proxy; otherwise generate one.
  const id = req.headers['x-request-id'] || generateRequestId();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = requestIdMiddleware;
