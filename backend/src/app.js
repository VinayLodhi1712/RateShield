'use strict';

// Express application factory — see Architecture.md Section 2.1 and API.md Section 3.
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');

const requestIdMiddleware     = require('./middleware/requestId.middleware');
const requestLoggerMiddleware = require('./middleware/requestLogger.middleware');
const { authMiddleware }      = require('./middleware/auth.middleware');
const errorMiddleware         = require('./middleware/error.middleware');

const healthRouter = require('./routes/health.routes');
const authRouter   = require('./routes/auth.routes');

const app = express();

// 1. Request ID first — all downstream logs and errors carry X-Request-Id.
app.use(requestIdMiddleware);

// 2. HTTP request logger — logs request finish with status and duration.
app.use(requestLoggerMiddleware);

// 3. Security headers.
app.use(helmet());

// 4. CORS.
app.use(cors());

// 5. JSON body parsing (10kb guard limit).
app.use(express.json({ limit: '10kb' }));

// 6. Stage 1 Auth Middleware — extracts JWT or IP identity (API.md §3).
app.use(authMiddleware);

// 7. Routes.
app.use('/health', healthRouter);
app.use('/auth', authRouter);

// 8. 404 handler for unmatched routes.
app.use((req, _res, next) => {
  const err = Object.assign(new Error(`Route not found: ${req.method} ${req.path}`), {
    statusCode: 404,
    errorCode: 'NOT_FOUND',
  });
  next(err);
});

// 9. Global error handler — must be last.
app.use(errorMiddleware);

module.exports = app;
