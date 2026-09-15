'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
const routes = require('./routes');
const ApiError = require('./utils/ApiError');
const { healthCheck } = require('./db/pool');
const mailer = require('./utils/mailer');
const { apiLimiter } = require('./middleware/rateLimit');
const cachePolicy = require('./middleware/cachePolicy');
const requestId = require('./middleware/requestId');
const httpLogger = require('./middleware/httpLogger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const csrfGuard = require('./middleware/csrf');
const requestLimits = require('./middleware/requestLimits');
const { isAllowedOrigin } = require('./config/origins');

const app = express();

// First in, so every log line, every failure row and every error response for
// this request carries the same reference (§57). Ahead of the body parser
// too - a malformed JSON body still produces a traceable failure.
app.use(requestId);

// Behind a reverse proxy (nginx / load balancer) so req.ip and the rate limiter
// see the real client address rather than the proxy's.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    // Uploaded images are served from this origin and embedded by the SPA on
    // another one, so the default same-origin policy has to be relaxed.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: env.isProduction ? undefined : false,
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (curl, server-to-server) are allowed;
      // browsers always send one on POST, and those must be on the allow list.
      // `csrfGuard` below is what stops that allowance from covering a
      // cookie-authenticated write.
      if (!origin || isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      // A disallowed origin is the caller's problem, not a server fault, so it
      // must not surface as a 500 "something went wrong on our side".
      callback(ApiError.forbidden(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  }),
);

// §31. Ahead of the body parsers, so an oversized request line is refused
// before its body is read.
app.use(requestLimits);

app.use(compression());
app.use(
  express.json({
    limit: '1mb',
    // The Razorpay webhook signature is an HMAC over the exact bytes sent
    // (§8.1). Re-serialising the parsed object would reorder keys and change
    // whitespace, so the raw buffer is kept for that one verification.
    verify: (req, _res, buffer) => {
      if (buffer?.length) req.rawBody = buffer;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// §52. Immediately after the cookie parser, because that is what it reads, and
// ahead of every route so no state-changing endpoint can be added outside it.
app.use(csrfGuard);

// Structured request logging (Logging §6, §10, §11). Replaces morgan: the
// correlation id, the duration band and the endpoint pattern all have to be
// queryable fields, and a formatted line is none of those.
if (env.nodeEnv !== 'test') app.use(httpLogger);

// Processed images, for the local driver only. With S3 they are served by the
// CDN and never pass through this process. `immutable` is safe because
// filenames are unique per upload.
if (env.storage.driver === 'local') {
  app.use(
    '/uploads',
    express.static(env.storage.uploadDir, { maxAge: '30d', immutable: true, fallthrough: true }),
  );
}

/**
 * Liveness probe for load balancers and uptime monitors.
 *
 * Deliberately thin: it answers "is this process able to serve requests?" and
 * nothing else. The dependency-by-dependency breakdown §34 asks for is Super
 * Admin material and lives behind auth at `/business/health` - §55 is explicit
 * that internal diagnostics are never exposed to customers or merchants, and an
 * unauthenticated endpoint is exposed to everyone.
 */
app.get('/health', async (_req, res) => {
  const database = await healthCheck().catch(() => false);
  res.status(database ? 200 : 503).json({
    success: database,
    data: {
      status: database ? 'ok' : 'degraded',
      database,
      // Surfaced so "why did no email arrive?" is answerable without log access.
      email: mailer.isConfigured ? 'smtp' : 'not-configured',
      uptime: process.uptime(),
    },
  });
});

// Guest/authenticated cache separation (§26). Sits ahead of the router so it
// applies to every API response, including error responses.
app.use(env.apiPrefix, apiLimiter, cachePolicy, routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
