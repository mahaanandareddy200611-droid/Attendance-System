"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAttendanceEvidenceService,
  CONSENT_VERSION,
} = require("../src/modules/AttendanceEvidence/AttendanceEvidenceService");

const STUDENT_ID = "507f1f77bcf86cd799439012";
const OTHER_STUDENT_ID = "507f1f77bcf86cd799439014";
const ATTENDANCE_ID = "507f1f77bcf86cd799439011";
const EVIDENCE_ID = "507f1f77bcf86cd799439013";

function query(getValue) {
  return {
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    lean() { return Promise.resolve(getValue()); },
    then(resolve, reject) { return Promise.resolve(getValue()).then(resolve, reject); },
  };
}

function fixture({ now = new Date("2026-10-20T12:00:00.000Z"), status = "ACTIVE" } = {}) {
  const state = {
    doc: null,
    uploads: 0,
    deletes: 0,
    urlRequests: 0,
    databaseQueries: 0,
  };
  const clock = () => new Date(now);
  const evidenceModel = {
    async create(payload) {
      state.doc = {
        ...payload,
        _id: EVIDENCE_ID,
        createdAt: clock(),
        updatedAt: clock(),
        deletedAt: null,
        save: async function save() { state.doc = this; },
      };
      return state.doc;
    },
    async findOneAndUpdate(filter, update) {
      if (!state.doc || String(state.doc._id) !== String(filter._id) || state.doc.status !== filter.status) return null;
      Object.assign(state.doc, update.$set);
      return state.doc;
    },
    updateOne(filter, update) {
      if (!state.doc || String(state.doc._id) !== String(filter._id)) return Promise.resolve({ modifiedCount: 0 });
      if (typeof filter.status === "string" && state.doc.status !== filter.status) return Promise.resolve({ modifiedCount: 0 });
      if (filter.status && typeof filter.status === "object" && filter.status.$in && !filter.status.$in.includes(state.doc.status)) {
        return Promise.resolve({ modifiedCount: 0 });
      }
      Object.assign(state.doc, update.$set);
      return Promise.resolve({ modifiedCount: 1, matchedCount: 1 });
    },
    findOne(filter) {
      state.databaseQueries += 1;
      const matches = () => {
        const doc = state.doc;
        if (!doc || String(doc._id) !== String(filter._id) || String(doc.studentId) !== String(filter.studentId)) return null;
        if (filter.status && doc.status !== filter.status) return null;
        if (filter.expiresAt?.$gt && new Date(doc.expiresAt) <= filter.expiresAt.$gt) return null;
        return doc;
      };
      return query(matches);
    },
    find() {
      return query(() => state.doc ? [state.doc] : []);
    },
  };
  const attendanceRecordModel = {
    findOne(filter) {
      state.databaseQueries += 1;
      return {
        select() { return this; },
        lean: async () => filter._id === ATTENDANCE_ID && filter.studentId === STUDENT_ID
          ? { _id: ATTENDANCE_ID }
          : null,
      };
    },
  };
  const storage = {
    async uploadObject() { state.uploads += 1; },
    async removeObjects(keys) { state.deletes += keys.length; },
    async createSignedUrl() { state.urlRequests += 1; return "https://private.example/signed"; },
  };
  const service = createAttendanceEvidenceService({
    evidenceModel,
    attendanceRecordModel,
    storage,
    env: { OBJECT_STORAGE_BUCKET: "unit-test-private", ATTENDANCE_EVIDENCE_RETENTION_DAYS: "7" },
    clock,
  });
  return { service, state, storage, evidenceModel, attendanceRecordModel, clock };
}

test("retained evidence requires explicit current consent and valid JPEG bytes", async () => {
  const { service, state } = fixture();
  const base = {
    studentId: STUDENT_ID,
    attendanceRecordId: ATTENDANCE_ID,
    imageBuffer: Buffer.from("normalized-jpeg"),
    mimeType: "image/jpeg",
    retentionConsent: true,
    consentVersion: CONSENT_VERSION,
  };
  await assert.rejects(service.upload({ ...base, retentionConsent: false }), (e) => e.statusCode === 400);
  await assert.rejects(service.upload({ ...base, consentVersion: "old-version" }), (e) => e.statusCode === 400);
  await assert.rejects(service.upload({ ...base, mimeType: "image/png" }), (e) => e.statusCode === 400);
  assert.equal(state.uploads, 0);
  assert.equal(state.doc, null);
});

test("evidence upload checks attendance ownership and returns only safe metadata", async () => {
  const { service, state } = fixture();
  const result = await service.upload({
    studentId: STUDENT_ID,
    attendanceRecordId: ATTENDANCE_ID,
    imageBuffer: Buffer.from("normalized-jpeg"),
    mimeType: "image/jpeg",
    retentionConsent: true,
    consentVersion: CONSENT_VERSION,
  });
  assert.equal(result.id, EVIDENCE_ID);
  assert.equal(result.status, "ACTIVE");
  assert.equal(result.consentVersion, CONSENT_VERSION);
  assert.equal(Object.hasOwn(result, "objectKey"), false);
  assert.equal(Object.hasOwn(result, "studentId"), false);
  assert.equal(state.uploads, 1);
  assert.equal(state.doc.bucket, "unit-test-private");
  assert.equal(state.doc.expiresAt.getTime() - state.doc.consentAt.getTime(), 7 * 24 * 60 * 60 * 1000);
});

test("evidence upload returns 404 without disclosing another student's attendance", async () => {
  const { service, state } = fixture();
  await assert.rejects(service.upload({
    studentId: OTHER_STUDENT_ID,
    attendanceRecordId: ATTENDANCE_ID,
    imageBuffer: Buffer.from("normalized-jpeg"),
    mimeType: "image/jpeg",
    retentionConsent: true,
    consentVersion: CONSENT_VERSION,
  }), (e) => e.statusCode === 404);
  assert.equal(state.uploads, 0);
  assert.equal(state.doc, null);
});

test("signed URL is owner-scoped, short-lived and rechecks active metadata", async () => {
  const { service, state } = fixture();
  state.doc = {
    _id: EVIDENCE_ID,
    studentId: STUDENT_ID,
    objectKey: "attendance-evidence/2026/10/example.jpg",
    status: "ACTIVE",
    expiresAt: new Date("2026-10-27T12:00:00.000Z"),
    createdAt: new Date("2026-10-20T12:00:00.000Z"),
  };
  await assert.rejects(
    service.createDownloadUrl({ studentId: OTHER_STUDENT_ID, evidenceId: EVIDENCE_ID }),
    (e) => e.statusCode === 404,
  );
  assert.equal(state.urlRequests, 0);
  const result = await service.createDownloadUrl({ studentId: STUDENT_ID, evidenceId: EVIDENCE_ID });
  assert.equal(result.url, "https://private.example/signed");
  assert.equal(result.expiresInSeconds, 60);
  assert.equal(state.urlRequests, 1);
});

test("delete blocks future signed URLs before attempting remote deletion", async () => {
  const { service, state, storage } = fixture();
  state.doc = {
    _id: EVIDENCE_ID,
    studentId: STUDENT_ID,
    objectKey: "attendance-evidence/2026/10/example.jpg",
    status: "ACTIVE",
    expiresAt: new Date("2026-10-27T12:00:00.000Z"),
    save: async function save() {},
  };
  storage.removeObjects = async () => { throw new Error("storage offline"); };
  await assert.rejects(
    service.deleteEvidence({ studentId: STUDENT_ID, evidenceId: EVIDENCE_ID }),
    (e) => e.statusCode === 503,
  );
  assert.equal(state.doc.status, "DELETE_PENDING");
  await assert.rejects(
    service.createDownloadUrl({ studentId: STUDENT_ID, evidenceId: EVIDENCE_ID }),
    (e) => e.statusCode === 410,
  );
  assert.equal(state.urlRequests, 0);
});

test("expired-evidence cleanup records successful remote deletion", async () => {
  const { service, state } = fixture({ now: new Date("2026-10-30T12:00:00.000Z") });
  state.doc = {
    _id: EVIDENCE_ID,
    studentId: STUDENT_ID,
    objectKey: "attendance-evidence/2026/10/example.jpg",
    status: "ACTIVE",
    expiresAt: new Date("2026-10-27T12:00:00.000Z"),
    createdAt: new Date("2026-10-20T12:00:00.000Z"),
  };
  const result = await service.cleanupExpiredEvidence({ limit: 25 });
  assert.deepEqual(result, { examined: 1, deleted: 1, failed: 0 });
  assert.equal(state.doc.status, "DELETED");
  assert.equal(state.doc.deletionReason, "RETENTION_EXPIRED");
  assert.equal(state.deletes, 1);
});
