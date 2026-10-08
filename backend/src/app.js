const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const crypto = require("crypto");
const mongoose =
    require("mongoose");

const {
    redisClient
} = require("./config/redis");
const academicRoutes =
    require("./modules/academic/AcademicRoutes");

const DeviceRoutes =
    require("./modules/Device/DeviceRoutes");
    

const BiometricRoutes =
    require("./modules/Biometric/BiometricRoutes");

const AuthRoutes =
    require("./modules/Auth/AuthRouter");

const app = express();


app.disable("x-powered-by");  // to hide it was by this express framw work or some other 

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

      const allowedOrigins = (process.env.CORS_ORIGINS)
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
 *
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
    req.id = crypto.randomUUID(); // for each request we set an id for the use od distributed systems
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
app.get(
    "/api/v1/livez",
    (req, res) => {

        res.status(200).json({
            success: true,
            status: "alive",
            requestId: req.id
        });
    }
);

app.get(
    "/api/v1/readyz",
    (req, res) => {

        const mongoReady =
            mongoose.connection.readyState === 1;

        const redisReady =
            redisClient.isReady;

        const ready =
            mongoReady &&
            redisReady;

        return res
            .status(
                ready
                    ? 200
                    : 503
            )
            .json({
                success: ready,
                status: ready
                    ? "ready"
                    : "not_ready",

                dependencies: {
                    mongodb:
                        mongoReady,

                    redis:
                        redisReady
                },

                requestId:
                    req.id
            });
    }
);
//================================================================================================
/// routes for all the development 
//=======================================================================================================


app.use(
    "/api/v1/auth",
    AuthRoutes
);

app.use(
    "/api/v1/academic",
    academicRoutes
);

app.use(
    "/api/v1/devices",
    DeviceRoutes
);  



app.use(
    "/api/v1/biometric",
    BiometricRoutes
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