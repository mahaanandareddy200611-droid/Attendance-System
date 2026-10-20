"use strict";

const mongoose = require("mongoose");

const AttendanceEvidenceSchema = new mongoose.Schema(
    {
        studentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },
        attendanceRecordId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AttendanceRecord",
            required: true
        },
        objectKey: {
            type: String,
            required: true,
            unique: true
        },
        bucket: {
            type: String,
            required: true
        },
        mimeType: {
            type: String,
            enum: ["image/jpeg"],
            required: true
        },
        size: {
            type: Number,
            min: 1,
            max: 2 * 1024 * 1024,
            required: true
        },
        status: {
            type: String,
            enum: ["PENDING_UPLOAD", "ACTIVE", "DELETE_PENDING", "DELETED"],
            default: "PENDING_UPLOAD",
            required: true,
            index: true
        },
        consentVersion: {
            type: String,
            enum: ["attendance-evidence-v1"],
            required: true
        },
        consentAt: {
            type: Date,
            required: true
        },
        expiresAt: {
            type: Date,
            required: true
        },
        deletedAt: {
            type: Date,
            default: null
        },
        deletionReason: {
            type: String,
            enum: ["USER_REQUEST", "RETENTION_EXPIRED", "UPLOAD_FAILED", "ORPHAN_CLEANUP"],
            default: null
        }
    },
    {
        timestamps: true,
        minimize: false
    }
);

// One explicitly retained evidence image per marked attendance. Keep a deleted
// tombstone so a client cannot repeatedly create retained images for one check-in.
AttendanceEvidenceSchema.index(
    { attendanceRecordId: 1, studentId: 1 },
    { unique: true }
);

// Do NOT add a Mongo TTL index: metadata must remain until remote object deletion
// succeeds. The scheduled cleanup worker performs remote deletion first.
AttendanceEvidenceSchema.index({ status: 1, expiresAt: 1 });
AttendanceEvidenceSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model("AttendanceEvidence", AttendanceEvidenceSchema);
