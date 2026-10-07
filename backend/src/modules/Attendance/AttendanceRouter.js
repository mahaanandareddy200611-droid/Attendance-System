const express = require("express");

const AttendanceRouter =
    express.Router();

const Auth = require("../../middlewares/Auth");

const authorize = require("../../middlewares/authorize");

const {createSession,getQr,endSession,verifyAttendance} = require("./AttendanceController");

const { createRateLimiter } = require("../../middlewares/rateLimiter");

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

// Start attendance
AttendanceRouter.post("/sessions",Auth,authorize("Lecturer"),createSession);


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

// Scan/verify attendance
AttendanceRouter.post(
    "/verify",
    Auth,
    authorize("Student"),
    studentAttendanceRateLimit,
    ipAttendanceRateLimit,
    verifyAttendance
);


module.exports =
    AttendanceRouter;