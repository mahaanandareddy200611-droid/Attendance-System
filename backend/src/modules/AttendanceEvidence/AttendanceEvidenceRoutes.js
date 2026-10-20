"use strict";

const express = require("express");
const Auth = require("../../middlewares/Auth");
const authorize = require("../../middlewares/authorize");
const upload = require("../Biometric/BiometricUpload");
const { createRateLimiter } = require("../../middlewares/rateLimiter");
const AppError = require("../../utils/AppError");
const controller = require("./AttendanceEvidenceController");

const router = express.Router();

const uploadRateLimit = createRateLimiter({
    keyGenerator: (req) => `attendance-evidence:upload:${req.user.id}`,
    capacity: 3,
    refillPerSecond: 1 / 3600
});

function validateEvidenceNotice(req, res, next) {
    if (req.body?.retentionConsent !== "true") {
        return next(new AppError("Explicit retention consent is required", 400));
    }
    if (req.body?.consentVersion !== "attendance-evidence-v1") {
        return next(new AppError("Please acknowledge the current evidence retention notice", 400));
    }
    if (!req.body?.attendanceRecordId) {
        return next(new AppError("attendanceRecordId is required", 400));
    }
    return next();
}

// Only a student can retain a single, explicitly consented corroborative image
// for an attendance record that belongs to them. Biometric challenge frames are
// never stored by this route.
router.post(
    "/",
    Auth,
    authorize("Student"),
    uploadRateLimit,
    upload.single("image"),
    upload.validateImageBytes,
    validateEvidenceNotice,
    controller.upload
);

router.get(
    "/:evidenceId/signed-url",
    Auth,
    authorize("Student"),
    controller.createDownloadUrl
);

router.delete(
    "/:evidenceId",
    Auth,
    authorize("Student"),
    controller.deleteEvidence
);

module.exports = router;
