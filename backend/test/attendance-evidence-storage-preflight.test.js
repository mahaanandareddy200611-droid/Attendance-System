"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAttendanceEvidenceService,
  CONSENT_VERSION,
} = require("../src/modules/AttendanceEvidence/AttendanceEvidenceService");

test("evidence upload fails closed before database access when private storage is unconfigured", async () => {
  let databaseTouched = false;
  const evidenceModel = {
    create: async () => { databaseTouched = true; throw new Error("metadata should not be created"); },
  };
  const attendanceRecordModel = {
    findOne: () => {
      databaseTouched = true;
      throw new Error("attendance should not be queried before storage preflight");
    },
  };
  const service = createAttendanceEvidenceService({
    evidenceModel,
    attendanceRecordModel,
    env: {
      ATTENDANCE_EVIDENCE_RETENTION_DAYS: "7",
      OBJECT_STORAGE_ENDPOINT: "",
      OBJECT_STORAGE_BUCKET: "",
      OBJECT_STORAGE_ACCESS_KEY_ID: "",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "",
    },
  });

  await assert.rejects(
    service.upload({
      studentId: "507f1f77bcf86cd799439012",
      attendanceRecordId: "507f1f77bcf86cd799439011",
      imageBuffer: Buffer.from("normalized-image"),
      mimeType: "image/jpeg",
      retentionConsent: true,
      consentVersion: CONSENT_VERSION,
    }),
    (error) => error.statusCode === 503 && /not configured/.test(error.message),
  );
  assert.equal(databaseTouched, false);
});
