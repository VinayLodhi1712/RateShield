'use strict';

// Express application factory — see Architecture.md §2.1 and API.md §3.
const path    = require('path');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');

const requestIdMiddleware     = require('./middleware/requestId.middleware');
const requestLoggerMiddleware = require('./middleware/requestLogger.middleware');
const metricsMiddleware       = require('./middleware/metrics.middleware');
const { authMiddleware }      = require('./middleware/auth.middleware');
const { rateLimitMiddleware } = require('./middleware/rateLimit.middleware');
const errorMiddleware         = require('./middleware/error.middleware');

const healthRouter    = require('./routes/health.routes');
const metricsRouter   = require('./routes/metrics.routes');
const authRouter      = require('./routes/auth.routes');
const rateLimitRouter = require('./routes/rateLimit.routes');
const apiKeyRouter    = require('./routes/apiKey.routes');

const app = express();

// 1. Request ID first — all downstream logs and errors carry X-Request-Id.
app.use(requestIdMiddleware);

// 2. HTTP request logger and Prometheus metrics timer.
app.use(requestLoggerMiddleware);
app.use(metricsMiddleware);

// 3. Security headers (relaxed CSP for dashboard Google fonts and styles).
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// 4. CORS.
app.use(cors());

// 5. JSON body parsing (10kb guard limit).
app.use(express.json({ limit: '10kb' }));

// 6. Serve static interactive frontend dashboard.
app.use(express.static(path.join(__dirname, '../../frontend')));

// 7. Stage 1 Auth Middleware — decodes JWT / API Key or sets IP identity (API.md §3).
app.use(authMiddleware);

// 8. Stage 2 Rate Limiter Middleware — atomic Fixed Window check against Redis.
app.use(rateLimitMiddleware);

// 9. Stage 3 API Routes.
app.use('/health', healthRouter);
app.use('/metrics', metricsRouter);
app.use('/auth', authRouter);
app.use('/rate-limit', rateLimitRouter);
app.use('/api-keys', apiKeyRouter);

// 10. 404 handler for unmatched routes.
app.use((req, _res, next) => {
  const err = Object.assign(new Error(`Route not found: ${req.method} ${req.path}`), {
    statusCode: 404,
    errorCode: 'NOT_FOUND',
  });
  next(err);
});

// 11. Global error handler — must be last.
app.use(errorMiddleware);

module.exports = app;
