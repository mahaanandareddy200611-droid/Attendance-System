"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const mongoUrl = process.env.TEST_MONGO_URL;
if (!mongoUrl) {
  test("private media lifecycle integration", {
    skip: "Set TEST_MONGO_URL to a dedicated attendance_test database",
  }, () => {});
} else {
  const databaseName = decodeURIComponent(
    new URL(mongoUrl).pathname.replace(/^\/+/, "").split("/")[0],
  );
  if (databaseName !== "attendance_test") {
    throw new Error("Safety check: TEST_MONGO_URL must use attendance_test");
  }

  process.env.OBJECT_STORAGE_ENDPOINT = "https://example-account.r2.cloudflarestorage.com";
  process.env.OBJECT_STORAGE_BUCKET = "attendance-private";
  process.env.OBJECT_STORAGE_REGION = "auto";
  process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "integration-test-access-key";
  process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "integration-test-secret-never-use";
  process.env.OBJECT_STORAGE_TIMEOUT_MS = "1000";
  process.env.MEDIA_RETENTION_DAYS = "30";
  process.env.MEDIA_URL_TTL_SECONDS = "60";

  const mongoose = require("mongoose");
  const AttendanceSession = require("../../src/models/AttendanceSession.model");
  const MediaAsset = require("../../src/models/MediaAsset.model");
  const AuditEvent = require("../../src/models/AuditEvent.model");
  const mediaService = require("../../src/modules/Media/MediaService");

  test("upload, list, authorize, signed access, delete and retention cleanup", {
    timeout: 30000,
  }, async (t) => {
    let connected = false;
    const originalFetch = global.fetch;
    const objects = new Map();
    const sessionIds = [];
    const ownerIds = [];
    let auditIds = [];
    const runId = crypto.randomUUID();
    const suffix = runId.replace(/-/g, "").slice(0, 12);

    const lecturerId = new mongoose.Types.ObjectId();
    const intruderId = new mongoose.Types.ObjectId();
    const sectionId = new mongoose.Types.ObjectId();
    ownerIds.push(lecturerId, intruderId);

    global.fetch = async (urlValue, options = {}) => {
      const url = new URL(String(urlValue));
      const method = options.method || "GET";
      const keyPath = url.pathname.replace(/^\/attendance-private\//, "");
      if (!url.pathname.startsWith("/attendance-private/")) {
        return new Response("unexpected endpoint", { status: 404 });
      }

      if (method === "PUT") {
        const body = Buffer.from(options.body || []);
        objects.set(keyPath, body);
        return new Response(null, { status: 200 });
      }
      if (method === "DELETE") {
        if (!objects.has(keyPath)) return new Response(null, { status: 404 });
        objects.delete(keyPath);
        return new Response(null, { status: 204 });
      }
      if (method === "GET") {
        const signature = url.searchParams.get("X-Amz-Signature");
        const expires = Number(url.searchParams.get("X-Amz-Expires"));
        if (!signature || !/^[a-f0-9]{64}$/.test(signature) || !expires) {
          return new Response("access denied", { status: 403 });
        }
        const body = objects.get(keyPath);
        if (!body) return new Response("not found", { status: 404 });
        return new Response(body, { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      return new Response("method not allowed", { status: 405 });
    };

    t.after(async () => {
      global.fetch = originalFetch;
      if (connected) {
        await Promise.all([
          MediaAsset.deleteMany({ sessionId: { $in: sessionIds } }),
          AuditEvent.deleteMany({ sessionId: { $in: sessionIds } }),
          AttendanceSession.deleteMany({ _id: { $in: sessionIds } }),
        ]);
        await mongoose.disconnect();
      }
    });

    await mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    await Promise.all([AttendanceSession.init(), MediaAsset.init(), AuditEvent.init()]);

    const sessionId = "media-" + suffix;
    const session = await AttendanceSession.create({
      sessionId,
      sectionId,
      courseCode: "MEDIA101",
      section: "A",
      lecturerId,
      status: "ACTIVE",
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      classroomSnapshot: {
        code: "TEST-ROOM",
        latitude: 15.4589,
        longitude: 75.0078,
        geofenceRadiusMeters: 100,
      },
      eligibleStudentCount: 1,
    });
    sessionIds.push(session._id);

    const image = Buffer.from("normalized jpeg bytes used only by storage integration test");
    const uploaded = await mediaService.uploadSessionEvidence({
      actorId: lecturerId,
      role: "Lecturer",
      sessionId,
      imageBuffer: image,
      contentType: "image/jpeg",
      originalName: "../../private-photo.jpg",
    });
    assert.equal(uploaded.status, "ACTIVE");
    assert.equal(uploaded.sizeBytes, image.length);
    assert.equal(uploaded.originalName, undefined, "public response must not expose the original filename or storage key");

    const listed = await mediaService.listSessionEvidence({
      sessionId,
      actorId: lecturerId,
      role: "Lecturer",
    });
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0].id, uploaded.id);

    await assert.rejects(
      mediaService.listSessionEvidence({
        sessionId,
        actorId: intruderId,
        role: "Lecturer",
      }),
      (error) => error.statusCode === 404,
    );

    const download = await mediaService.createDownloadUrl({
      assetId: uploaded.id,
      actorId: lecturerId,
      role: "Lecturer",
    });
    const downloaded = await fetch(download.url);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), image);

    await assert.rejects(
      mediaService.createDownloadUrl({
        assetId: uploaded.id,
        actorId: intruderId,
        role: "Lecturer",
      }),
      (error) => error.statusCode === 404,
    );

    const deleted = await mediaService.deleteMediaAsset({
      assetId: uploaded.id,
      actorId: lecturerId,
      role: "Lecturer",
    });
    assert.equal(deleted.status, "DELETED");
    const hiddenAfterDelete = await mediaService.listSessionEvidence({
      sessionId,
      actorId: lecturerId,
      role: "Lecturer",
    });
    assert.equal(hiddenAfterDelete.data.length, 0);
    const metadataAfterDelete = await MediaAsset.findById(uploaded.id).select("+objectKey").lean();
    assert.equal(metadataAfterDelete.status, "DELETED");
    assert.ok(metadataAfterDelete.deletedAt);
    assert.equal(objects.size, 0);

    // Retention expiry uses the same retryable deletion path and retains audit metadata.
    const expiredKey = "evidence/" + String(lecturerId) + "/" + crypto.randomUUID() + ".jpg";
    const expiredAsset = await MediaAsset.create({
      ownerId: lecturerId,
      sessionId: session._id,
      purpose: "SESSION_EVIDENCE",
      objectKey: expiredKey,
      contentType: "image/jpeg",
      sizeBytes: image.length,
      sha256: crypto.createHash("sha256").update(image).digest("hex"),
      originalName: "expired.jpg",
      retentionUntil: new Date(Date.now() - 1000),
      status: "ACTIVE",
    });
    const cleanup = await mediaService.sweepExpiredMediaAssets({ limit: 10 });
    assert.ok(cleanup.deleted >= 1);
    const expiredAfter = await MediaAsset.findById(expiredAsset._id).lean();
    assert.equal(expiredAfter.status, "DELETED");
  });
}
