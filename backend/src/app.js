const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const crypto = require("crypto");
const academicRoutes =
    require("./modules/academic/AcademicRoutes");

const app = express();

/*
|--------------------------------------------------------------------------
| Basic application configuration
|--------------------------------------------------------------------------
*/

/*
 * Do not expose:
 *
 * X-Powered-By: Express
 *
 * There is no useful reason for an external client to know
 * which framework our server is using.
 */
app.disable("x-powered-by");

/*
|--------------------------------------------------------------------------
| Security headers
|--------------------------------------------------------------------------
*/

/*
 * Helmet adds a collection of HTTP security headers.
 *
 * We are not relying on Helmet to "secure the application".
 * It is one small layer of the overall security model.
 */
app.use(helmet());

/*
|--------------------------------------------------------------------------
| CORS
|--------------------------------------------------------------------------
*/

/*
 * During development we can use:
 *
 * CORS_ORIGINS=http://localhost:5173
 *
 * Multiple origins can later be separated by commas.
 *
 * Requests which do not contain an Origin header are allowed.
 * This is useful because a native mobile application is not
 * the same thing as a browser origin.
 */
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      const allowedOrigins = (process.env.CORS_ORIGINS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin is not allowed"));
    },

    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

/*
|--------------------------------------------------------------------------
| Request body parsing
|--------------------------------------------------------------------------
*/

/*
 * Parse JSON requests.
 *
 * We intentionally keep the limit small.
 *
 * Attendance APIs should normally exchange small JSON payloads.
 * We do not want a client to send a huge JSON body and consume
 * unnecessary server memory.
 */
app.use(
  express.json({
    limit: "32kb",
    strict: true,
  })
);

/*
|--------------------------------------------------------------------------
| Request ID
|--------------------------------------------------------------------------
*/

/*
 * Every request receives an ID.
 *
 * Example:
 *
 * Client
 *   |
 *   | POST /api/v1/...
 *   |
 *   v
 * Backend
 *   |
 *   +---- requestId = 8c0...
 *
 * Later the same requestId can appear in:
 *
 * HTTP logs
 * service logs
 * security events
 * audit logs
 * error logs
 *
 * This becomes extremely useful when the system is distributed.
 */
app.use((req, res, next) => {
  const incomingRequestId = req.get("X-Request-ID");

  if (
    incomingRequestId &&
    typeof incomingRequestId === "string" &&
    incomingRequestId.length <= 128
  ) {
    req.id = incomingRequestId;
  } else {
    req.id = crypto.randomUUID();
  }

  res.setHeader("X-Request-ID", req.id);

  next();
});

/*
|--------------------------------------------------------------------------
| Health check
|--------------------------------------------------------------------------
*/

/*
 * Health means:
 *
 * "The Node.js process is alive."
 *
 * It does NOT mean that every dependency is healthy.
 *
 * Later we will create a separate readiness endpoint for:
 *
 * MongoDB
 * Redis
 * other required dependencies
 */
app.get("/api/v1/health", (req, res) => {
  return res.status(200).json({
    success: true,
    service: "attendance-backend",
    status: "healthy",
    uptimeSeconds: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
    requestId: req.id,
  });
});

app.use(
    "/api/v1/academic",
    academicRoutes
);

/*
|--------------------------------------------------------------------------
| 404 handler
|--------------------------------------------------------------------------
*/

/*
 * Express reaches this middleware only when no previous route
 * matched the incoming request.
 */
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    error: {
      code: "ROUTE_NOT_FOUND",
      message: "The requested route does not exist",
    },
    requestId: req.id,
  });
});

/*
|--------------------------------------------------------------------------
| Central error handler
|--------------------------------------------------------------------------
*/

/*
 * Error middleware has four arguments:
 *
 * (err, req, res, next)
 *
 * Express recognizes this as an error-handling middleware.
 *
 * We don't send internal stack traces to clients.
 */
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  console.error({
    requestId: req.id,
    error: err,
  });

  return res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    },
    requestId: req.id,
  });
});

module.exports = app;