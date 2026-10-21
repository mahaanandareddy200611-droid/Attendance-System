const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const crypto = require("crypto");
const mongoose = require("mongoose");

const { redisClient } = require("./config/redis");
const { evaluateReadiness } = require("./config/readiness");
const academicRoutes = require("./modules/academic/AcademicRoutes");

const DeviceRoutes = require("./modules/Device/DeviceRoutes");

const BiometricRoutes = require("./modules/Biometric/BiometricRoutes");
const AttendanceRoutes = require("./modules/Attendance/AttendanceRouter");
const MediaRoutes = require("./modules/Media/MediaRoutes");
const AttendanceEvidenceRoutes = require("./modules/AttendanceEvidence/AttendanceEvidenceRoutes");

const AuthRoutes = require("./modules/Auth/AuthRouter");

const app = express();
app.disable("x-powered-by");

// Configure only the known number of trusted reverse-proxy hops. Leave this
// unset for direct local development; set it to 1 behind Render's proxy.
const trustProxyHopsRaw = process.env.TRUST_PROXY_HOPS;
if (trustProxyHopsRaw !== undefined && trustProxyHopsRaw !== "") {
  const trustProxyHops = Number(trustProxyHopsRaw);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
    throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 5");
  }
  app.set("trust proxy", trustProxyHops);
}

/*
 * Assign an ID before middleware that may reject a request.
 * This ensures even CORS and body-parser errors are traceable.
 */
app.use((req, res, next) => {
    const incomingRequestId = req.get("X-Request-ID");

    if (
        incomingRequestId &&
        typeof incomingRequestId === "string" &&
        incomingRequestId.length <= 128 &&
        /^[\w.-]+$/.test(incomingRequestId)
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

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      const allowedOrigins = (
        process.env.CORS_ORIGINS ||
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8081"
      )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      const error = new Error("Origin is not allowed");
      error.statusCode = 403;
      return callback(error);
    },

    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
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
  }),
);

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
app.get("/api/v1/livez", (req, res) => {
  res.status(200).json({
    success: true,
    status: "alive",
    requestId: req.id,
  });
});

app.get("/api/v1/readyz", (req, res) => {
  const result = evaluateReadiness({ env: process.env, mongoReady: mongoose.connection.readyState === 1, redisReady: redisClient.isReady });
  return res.status(result.ready ? 200 : 503).json({ success: result.ready, status: result.ready ? "ready" : "not_ready", dependencies: result.dependencies, requirements: result.requirements, requestId: req.id });
});
//================================================================================================
/// routes for all the development
//=======================================================================================================

app.use("/api/v1/auth", AuthRoutes);

app.use("/api/v1/academic", academicRoutes);

app.use("/api/v1/devices", DeviceRoutes);

app.use("/api/v1/biometric", BiometricRoutes);

app.use("/api/v1/attendance", AttendanceRoutes);

app.use("/api/v1/media", MediaRoutes);

app.use("/api/v1/attendance-evidence", AttendanceEvidenceRoutes);

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

    const isMulterError = err?.name === "MulterError";
    const statusCode = isMulterError
        ? (err.code === "LIMIT_FILE_SIZE" ? 413 : 400)
        : (
            Number(err.statusCode || err.status) ||
            (
                err.type === "entity.too.large" ||
                err.code === "LIMIT_FILE_SIZE"
                    ? 413
                    : 500
            )
        );

    const errorCode =
        err.providerCode ||
        (
            statusCode === 500
                ? "INTERNAL_SERVER_ERROR"
                : "REQUEST_FAILED"
        );

    const logEntry = {
        requestId: req.id,
        method: req.method,
        path: req.path,
        statusCode,
        code: errorCode
    };

    if (statusCode >= 500) {
        // Server errors need diagnostic details in protected server logs.
        console.error({
            ...logEntry,
            message: err.message,
            stack: err.stack
        });
    } else {
        // Client errors are expected operational outcomes.
        // Do not dump complete stacks for rejected CORS or validation requests.
        console.warn(logEntry);
    }

    return res.status(statusCode).json({
        success: false,
        error: {
            code: errorCode,
            message:
                statusCode >= 500
                    ? "An unexpected error occurred"
                    : err.message
        },
        requestId: req.id
    });
});


module.exports = app;
