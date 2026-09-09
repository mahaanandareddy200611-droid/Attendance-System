const express = require("express");

const AttendanceRouter =
    express.Router();

const Auth = require("../../middlewares/Auth");

const authorize = require("../../middlewares/authorize");

const {createSession,getQr,endSession,verifyAttendance} = require("./AttendanceController");


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
    verifyAttendance
);


module.exports =
    AttendanceRouter;