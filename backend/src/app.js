'use strict';

// app.js — Express application factory (no server.listen here; that lives in server.js).
// Middleware order is load-order-dependent; do not reorder without understanding the chain.
// Full rationale for each choice lives in Architecture.md Section 2.1 and API.md Section 3.

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');

const requestIdMiddleware     = require('./middleware/requestId.middleware');
const requestLoggerMiddleware = require('./middleware/requestLogger.middleware');
const errorMiddleware         = require('./middleware/error.middleware');
const healthRouter            = require('./routes/health.routes');

const app = express();

// 1. Request ID first — every subsequent log line and error response carries it.
app.use(requestIdMiddleware);

// 2. HTTP request logger — must come after requestId so req.requestId is set.
app.use(requestLoggerMiddleware);

// 3. Security headers. Defaults are safe for v1; tighten in production if needed.
app.use(helmet());

// 4. CORS — open in dev; restrict to frontend origin in production.
app.use(cors());

// 5. JSON body parsing. 10kb limit guards against oversized-payload attacks.
app.use(express.json({ limit: '10kb' }));

// 6. Routes.
app.use('/health', healthRouter);
// Future mounts (added per milestone):
//   app.use('/auth',       authRouter);       // M7
//   app.use('/api-keys',   apiKeysRouter);    // M7
//   app.use('/policies',   policiesRouter);   // M9+
//   app.use('/admin',      adminRouter);      // M9+
//   app.use('/metrics',    metricsRouter);    // M14

// 7. 404 — converts unmatched routes into a structured error rather than Express's HTML default.
app.use((req, _res, next) => {
  const err = Object.assign(new Error(`Route not found: ${req.method} ${req.path}`), {
    statusCode: 404,
    errorCode: 'NOT_FOUND',
  });
  next(err);
});

// 8. Global error handler — must be last.
app.use(errorMiddleware);

module.exports = app;
