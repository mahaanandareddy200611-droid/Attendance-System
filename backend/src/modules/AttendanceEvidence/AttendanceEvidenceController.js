"use strict";

const asyncHandler = require("../../middlewares/asyncHandler");
const { service } = require("./AttendanceEvidenceService");

exports.upload = asyncHandler(async (req, res) => {
    const evidence = await service.upload({
        studentId: req.user.id,
        attendanceRecordId: req.body.attendanceRecordId,
        imageBuffer: req.file?.buffer,
        mimeType: req.file?.mimetype,
        retentionConsent: req.body.retentionConsent === "true",
        consentVersion: req.body.consentVersion
    });

    res.setHeader("Cache-Control", "no-store");
    return res.status(201).json({
        success: true,
        message: "Private attendance evidence retained under the stated retention policy",
        data: evidence,
        requestId: req.id
    });
});

exports.createDownloadUrl = asyncHandler(async (req, res) => {
    const data = await service.createDownloadUrl({
        studentId: req.user.id,
        evidenceId: req.params.evidenceId
    });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
        success: true,
        data,
        requestId: req.id
    });
});

exports.deleteEvidence = asyncHandler(async (req, res) => {
    const data = await service.deleteEvidence({
        studentId: req.user.id,
        evidenceId: req.params.evidenceId
    });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
        success: true,
        data,
        requestId: req.id
    });
});
