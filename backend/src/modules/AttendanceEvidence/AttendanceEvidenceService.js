"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");
const AttendanceEvidence = require("../../models/AttendanceEvidence.model");
const AttendanceRecord = require("../../models/AttendanceRecord.model");
const AppError = require("../../utils/AppError");
const objectStorage = require("../../infrastructure/storage/PrivateObjectStorage");

const defaultStorage = {
    uploadObject: (key, buffer, contentType) =>
        objectStorage.putObject({ key, body: buffer, contentType }),
    removeObjects: async (keys) =>
        Promise.all(keys.map((key) => objectStorage.deleteObject({ key }))),
    createSignedUrl: (key, expiresInSeconds) =>
        objectStorage.createDownloadUrl({ key, expiresInSeconds })
};

const CONSENT_VERSION = "attendance-evidence-v1";
const DEFAULT_RETENTION_DAYS = 7;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 30;
const SIGNED_URL_TTL_SECONDS = 60;
const MAX_SWEEP_BATCH = 100;
const OBJECT_PREFIX = "attendance-evidence/";

function configuredRetentionDays(env = process.env) {
    const value = Number(env.ATTENDANCE_EVIDENCE_RETENTION_DAYS);
    const days = Number.isInteger(value) ? value : DEFAULT_RETENTION_DAYS;
    if (days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
        throw new AppError(
            "ATTENDANCE_EVIDENCE_RETENTION_DAYS must be between 1 and 30",
            500
        );
    }
    return days;
}

function isObjectId(value) {
    return typeof value === "string" && mongoose.isValidObjectId(value);
}

function safePublicEvidence(doc) {
    return {
        id: String(doc._id),
        status: doc.status,
        mimeType: doc.mimeType,
        size: doc.size,
        createdAt: doc.createdAt,
        expiresAt: doc.expiresAt,
        deletedAt: doc.deletedAt || null,
        consentVersion: doc.consentVersion
    };
}

function createAttendanceEvidenceService({
    evidenceModel = AttendanceEvidence,
    attendanceRecordModel = AttendanceRecord,
    storage = defaultStorage,
    env = process.env,
    clock = () => new Date()
} = {}) {
    async function markDeleted(evidenceId, reason) {
        return evidenceModel.updateOne(
            { _id: evidenceId, status: "DELETE_PENDING" },
            {
                $set: {
                    status: "DELETED",
                    deletedAt: clock(),
                    deletionReason: reason
                }
            }
        );
    }

    async function deleteRemoteThenFinalize(doc, reason) {
        // The metadata is changed to DELETE_PENDING before calling Storage so
        // signed-url issuance is blocked even if the provider is temporarily down.
        if (doc.status !== "DELETE_PENDING") {
            await evidenceModel.updateOne(
                { _id: doc._id, status: { $in: ["ACTIVE", "PENDING_UPLOAD"] } },
                { $set: { status: "DELETE_PENDING", deletionReason: reason } }
            );
        }

        await storage.removeObjects([doc.objectKey]);
        await markDeleted(doc._id, reason);
    }

    async function upload({
        studentId,
        attendanceRecordId,
        imageBuffer,
        mimeType,
        retentionConsent,
        consentVersion
    }) {
        if (!isObjectId(attendanceRecordId)) {
            throw new AppError("attendanceRecordId must be a valid ID", 400);
        }
        if (retentionConsent !== true) {
            throw new AppError("Explicit consent is required to retain attendance evidence", 400);
        }
        if (consentVersion !== CONSENT_VERSION) {
            throw new AppError("Evidence retention notice must be acknowledged", 400);
        }
        if (
            !Buffer.isBuffer(imageBuffer) ||
            imageBuffer.length < 1 ||
            imageBuffer.length > 2 * 1024 * 1024 ||
            mimeType !== "image/jpeg"
        ) {
            throw new AppError("A normalized JPEG image no larger than 2 MiB is required", 400);
        }

        const attendance = await attendanceRecordModel.findOne({
            _id: attendanceRecordId,
            studentId
        }).select("_id").lean();

        if (!attendance) {
            // Do not disclose whether another student's attendance record exists.
            throw new AppError("Attendance record not found", 404);
        }

        const now = clock();
        const retentionDays = configuredRetentionDays(env);
        const expiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
        const objectKey = `${OBJECT_PREFIX}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.jpg`;

        let pending;
        try {
            pending = await evidenceModel.create({
                studentId,
                attendanceRecordId,
                objectKey,
                bucket: String(env.OBJECT_STORAGE_BUCKET || ""),
                mimeType: "image/jpeg",
                size: imageBuffer.length,
                status: "PENDING_UPLOAD",
                consentVersion: CONSENT_VERSION,
                consentAt: now,
                expiresAt
            });
        } catch (error) {
            if (error?.code === 11000) {
                throw new AppError("Attendance evidence has already been submitted for this record", 409);
            }
            throw error;
        }

        try {
            await storage.uploadObject(objectKey, imageBuffer, "image/jpeg");
            const active = await evidenceModel.findOneAndUpdate(
                { _id: pending._id, status: "PENDING_UPLOAD" },
                { $set: { status: "ACTIVE" } },
                { new: true }
            );
            if (!active) {
                throw new AppError("Evidence upload could not be finalized", 503);
            }
            return safePublicEvidence(active);
        } catch {
            // Compensation is best-effort. A failed compensation stays pending
            // for the scheduled sweeper, and is never downloadable.
            try {
                await evidenceModel.updateOne(
                    { _id: pending._id, status: "PENDING_UPLOAD" },
                    { $set: { status: "DELETE_PENDING", deletionReason: "UPLOAD_FAILED" } }
                );
                await storage.removeObjects([objectKey]);
                await markDeleted(pending._id, "UPLOAD_FAILED");
            } catch {
                // Keep DELETE_PENDING for retry; do not log image or provider details.
            }
            throw new AppError("Evidence could not be safely retained; retry later", 503);
        }
    }

    async function createDownloadUrl({ studentId, evidenceId }) {
        if (!isObjectId(evidenceId)) throw new AppError("Evidence ID is invalid", 400);
        const doc = await evidenceModel.findOne({ _id: evidenceId, studentId }).lean();
        if (!doc) throw new AppError("Evidence not found", 404);
        if (doc.status !== "ACTIVE" || new Date(doc.expiresAt).getTime() <= clock().getTime()) {
            throw new AppError("Evidence is expired, deleted, or unavailable", 410);
        }

        const signedUrl = await storage.createSignedUrl(doc.objectKey, SIGNED_URL_TTL_SECONDS);

        // Re-check after the network call to narrow the deletion/signing race.
        const stillActive = await evidenceModel.findOne({
            _id: doc._id,
            studentId,
            status: "ACTIVE",
            expiresAt: { $gt: clock() }
        }).select("_id").lean();

        if (!stillActive) throw new AppError("Evidence is no longer available", 410);

        return {
            url: signedUrl,
            expiresInSeconds: SIGNED_URL_TTL_SECONDS
        };
    }

    async function deleteEvidence({ studentId, evidenceId }) {
        if (!isObjectId(evidenceId)) throw new AppError("Evidence ID is invalid", 400);
        const doc = await evidenceModel.findOne({ _id: evidenceId, studentId });
        if (!doc) throw new AppError("Evidence not found", 404);
        if (doc.status === "DELETED") {
            return { id: String(doc._id), status: "DELETED", alreadyDeleted: true };
        }

        if (doc.status !== "DELETE_PENDING") {
            doc.status = "DELETE_PENDING";
            doc.deletionReason = "USER_REQUEST";
            await doc.save();
        }

        try {
            await storage.removeObjects([doc.objectKey]);
            await markDeleted(doc._id, "USER_REQUEST");
        } catch {
            // Deletion has already revoked signed-link issuance. Leave the job
            // pending for retry and do not report deletion as complete.
            throw new AppError("Deletion is queued for retry; evidence access is disabled", 503);
        }

        return { id: String(doc._id), status: "DELETED", alreadyDeleted: false };
    }

    async function cleanupExpiredEvidence({ limit = MAX_SWEEP_BATCH } = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SWEEP_BATCH) {
            throw new TypeError(`limit must be between 1 and ${MAX_SWEEP_BATCH}`);
        }

        const now = clock();
        const stalePendingBefore = new Date(now.getTime() - 15 * 60 * 1000);
        const candidates = await evidenceModel.find({
            $or: [
                { status: "ACTIVE", expiresAt: { $lte: now } },
                { status: "DELETE_PENDING" },
                { status: "PENDING_UPLOAD", createdAt: { $lte: stalePendingBefore } }
            ]
        }).sort({ createdAt: 1 }).limit(limit).lean();

        let deleted = 0;
        let failed = 0;
        for (const doc of candidates) {
            const reason = doc.deletionReason || (
                doc.status === "ACTIVE" ? "RETENTION_EXPIRED" :
                doc.status === "PENDING_UPLOAD" ? "UPLOAD_FAILED" :
                "USER_REQUEST"
            );

            try {
                await deleteRemoteThenFinalize(doc, reason);
                deleted += 1;
            } catch {
                // Do not log student/object identifiers. The next scheduled run retries.
                failed += 1;
            }
        }

        return { examined: candidates.length, deleted, failed };
    }

    async function runMaintenance() {
        const retention = await cleanupExpiredEvidence();
        return { retention };
    }

    return {
        upload,
        createDownloadUrl,
        deleteEvidence,
        cleanupExpiredEvidence,
        runMaintenance
    };
}

const service = createAttendanceEvidenceService();

module.exports = {
    createAttendanceEvidenceService,
    configuredRetentionDays,
    safePublicEvidence,
    CONSENT_VERSION,
    DEFAULT_RETENTION_DAYS,
    MIN_RETENTION_DAYS,
    MAX_RETENTION_DAYS,
    service
};
