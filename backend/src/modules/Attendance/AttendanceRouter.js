const express = require("express");

const AttendanceRouter =
    express.Router();

const Auth = require("../../middlewares/Auth");

const authorize = require("../../middlewares/authorize");

const {
    createSession,
    getQr,
    endSession,
    verifyAttendance,
    prepareAttendanceCheckin,
    listSessions,
    listAvailableStudentSessions,
    listSessionRecords,
    listMyRecords,
    listAdminRecords
} = require("./AttendanceController");

const { createRateLimiter } = require("../../middlewares/rateLimiter");
const validate = require("../../utils/validate");
const validateIdempotencyKey = require("../../middlewares/validateIdempotencyKey");
const { createSession: createSessionSchema, preflightQr: preflightQrSchema, verifyAttendance: verifyAttendanceSchema } = require("./AttendanceValidator");

const studentAttendanceRateLimit =
    createRateLimiter({
        keyGenerator: (req) =>
            `student:${req.user.id}`,

        capacity:
            Number(
                process.env
                    .ATTENDANCE_STUDENT_RATE_CAPACITY
            ) || 5,

        refillPerSecond:
            Number(
                process.env
                    .ATTENDANCE_STUDENT_RATE_REFILL
            ) || 1
    });


const ipAttendanceRateLimit =
    createRateLimiter({
        keyGenerator: (req) =>
            `ip:${req.ip}`,

        capacity:
            Number(
                process.env
                    .ATTENDANCE_IP_RATE_CAPACITY
            ) || 300,

        refillPerSecond:
            Number(
                process.env
                    .ATTENDANCE_IP_RATE_REFILL
            ) || 50
    });

// LECTURER

AttendanceRouter.get("/sessions", Auth, authorize("Lecturer", "Admin"), listSessions);
AttendanceRouter.get(
    "/sessions/available",
    Auth,
    authorize("Student"),
    listAvailableStudentSessions
);
AttendanceRouter.get(
    "/sessions/:sessionId/records",
    Auth,
    authorize("Lecturer", "Admin"),
    listSessionRecords
);
AttendanceRouter.get("/records/me", Auth, authorize("Student"), listMyRecords);
AttendanceRouter.get("/records", Auth, authorize("Admin", "Lecturer"), listAdminRecords);

// Start attendance
AttendanceRouter.post(
    "/sessions",
    Auth,
    authorize("Lecturer"),
    validate(createSessionSchema),
    createSession
);


// Get current QR
AttendanceRouter.get("/sessions/:sessionId/qr",Auth,
    authorize("Lecturer"),
    getQr
);


// End attendance
AttendanceRouter.post(
    "/sessions/:sessionId/end",
    Auth,
    authorize("Lecturer"),
    endSession
);


/*
STUDENT
*/

// Validate the QR while it is fresh. This issues a student-bound Redis
// intent so face/liveness can finish after the rotating QR changes.
AttendanceRouter.post(
    "/preflight",
    Auth,
    authorize("Student"),
    studentAttendanceRateLimit,
    ipAttendanceRateLimit,
    validate(preflightQrSchema),
    prepareAttendanceCheckin
);

// Scan/verify attendance
AttendanceRouter.post(
    "/verify",
    Auth,
    authorize("Student"),
    studentAttendanceRateLimit,
    ipAttendanceRateLimit,
    validate(verifyAttendanceSchema),
    validateIdempotencyKey,
    verifyAttendance
);


module.exports =
    AttendanceRouter;
