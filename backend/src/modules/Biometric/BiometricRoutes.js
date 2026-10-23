
const express = require("express");

const Auth = require("../../middlewares/Auth");
const authorize = require("../../middlewares/authorize");
const validate = require("../../utils/validate");

const {
    challenge: challengeSchema,
    verify: verifySchema
} = require("./BiometricValidator");

const upload = require("./BiometricUpload");
const sequenceUpload = require("./BiometricSequenceUpload");
const activeVerifySchema = require("./BiometricValidator").activeVerify;
const { createRateLimiter } = require("../../middlewares/rateLimiter");
const AttendanceSession = require("../../models/AttendanceSession.model");
const AttendanceSessionStudent = require("../../models/AttendanceSessionStudent.model");
const AppError = require("../../utils/AppError");

const {
    enroll,
    createChallenge,
    verify,
    getMyEnrollment,
    listEnrollmentApprovals,
    approveEnrollment,
    rejectEnrollment
} = require("./BiometricController");

const router = express.Router();

// A large campus may share a NAT address, so the IP bucket allows a burst
// while the authenticated user bucket provides the tighter abuse boundary.
function createBiometricLimiters(scope, defaults) {
    const prefix = `BIOMETRIC_${scope.toUpperCase()}`;
    const configured = (suffix, fallback) => {
        const value = Number(process.env[`${prefix}_${suffix}`]);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    };

    return {
        ip: createRateLimiter({
            keyGenerator: (req) => `biometric:${scope}:ip:${req.ip}`,
            capacity: configured("IP_CAPACITY", defaults.ipCapacity),
            refillPerSecond: configured("IP_REFILL", defaults.ipRefill)
        }),
        user: createRateLimiter({
            keyGenerator: (req) => `biometric:${scope}:user:${req.user.id}`,
            capacity: configured("USER_CAPACITY", defaults.userCapacity),
            refillPerSecond: configured("USER_REFILL", defaults.userRefill)
        })
    };
}

const enrollmentLimits = createBiometricLimiters("ENROLL", {
    ipCapacity: 300, ipRefill: 10,
    userCapacity: 3, userRefill: 1 / 3600
});
const challengeLimits = createBiometricLimiters("CHALLENGE", {
    ipCapacity: 600, ipRefill: 15,
    userCapacity: 6, userRefill: 0.1
});
const verifyLimits = createBiometricLimiters("VERIFY", {
    ipCapacity: 600, ipRefill: 15,
    userCapacity: 6, userRefill: 0.1
});

async function requireActiveEligibleSession(req, res, next) {
    try {
        const sessionId = String(req.body?.sessionId || "").trim();
        if (!sessionId) {
            throw new AppError("sessionId is required", 400);
        }

        const session = await AttendanceSession.findOne({
            sessionId,
            status: "ACTIVE",
            expiresAt: { $gt: new Date() }
        }).select("_id sessionId expiresAt").lean();

        if (!session) {
            throw new AppError("Attendance session is inactive or expired", 409);
        }

        const rosterEntry = await AttendanceSessionStudent.findOne({
            sessionId: session._id,
            studentId: req.user.id,
            status: { $in: ["ELIGIBLE", "LATE"] }
        }).select("_id").lean();

        if (!rosterEntry) {
            throw new AppError("Student is not eligible for this attendance session", 403);
        }

        req.attendanceSession = session;
        return next();
    } catch (error) {
        return next(error);
    }
}

router.get(
    "/enrollment-approvals",
    Auth,
    authorize("Lecturer", "Admin"),
    listEnrollmentApprovals
);

router.post(
    "/enrollment-approvals/:studentId/approve",
    Auth,
    authorize("Lecturer", "Admin"),
    approveEnrollment
);

router.post(
    "/enrollment-approvals/:studentId/reject",
    Auth,
    authorize("Lecturer", "Admin"),
    rejectEnrollment
);

router.get(
    "/me",
    Auth,
    authorize("Student"),
    getMyEnrollment
);

router.delete(
    "/me",
    Auth,
    authorize("Student"),
    require("./BiometricController").revokeMyEnrollment
);

router.post(
    "/enroll",
    enrollmentLimits.ip,
    Auth,
    authorize("Student"),
    enrollmentLimits.user,
    upload.single("image"),
    upload.validateImageBytes,
    enroll
);

router.post(
    "/challenge",
    challengeLimits.ip,
    Auth,
    authorize("Student"),
    challengeLimits.user,
    validate(challengeSchema),
    requireActiveEligibleSession,
    createChallenge
);

router.post(
    "/verify",
    verifyLimits.ip,
    Auth,
    authorize("Student"),
    verifyLimits.user,
    upload.single("image"),
    upload.validateImageBytes,
    validate(verifySchema),
    requireActiveEligibleSession,
    verify
);



// Optional active-sequence API; the current one-image endpoints stay compatible.
router.post(
    "/challenge-active",
    challengeLimits.ip,
    Auth,
    authorize("Student"),
    challengeLimits.user,
    validate(challengeSchema),
    requireActiveEligibleSession,
    require("./BiometricController").createActiveChallenge
);

router.post(
    "/verify-active",
    verifyLimits.ip,
    Auth,
    authorize("Student"),
    verifyLimits.user,
    sequenceUpload.array("frames", 3),
    sequenceUpload.validateFrameBytes,
    validate(activeVerifySchema),
    requireActiveEligibleSession,
    require("./BiometricController").verifyActiveSequence
);

module.exports = router;
