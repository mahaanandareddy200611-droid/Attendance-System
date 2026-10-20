"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { performance } = require("node:perf_hooks");

const mongoUrl = process.env.TEST_MONGO_URL;
const configuredRedisUrl = process.env.TEST_REDIS_URL;

if (!mongoUrl || !configuredRedisUrl) {
  test("300-client attendance API concurrency test", {
    skip: "Set TEST_MONGO_URL and TEST_REDIS_URL to dedicated test services",
  }, () => {});
} else {
  const mongoDatabase = decodeURIComponent(
    new URL(mongoUrl).pathname.replace(/^\/+/, "").split("/")[0],
  );
  if (mongoDatabase !== "attendance_test") {
    throw new Error("Safety check: TEST_MONGO_URL must use attendance_test");
  }

  const isolatedRedisUrl = new URL(configuredRedisUrl);
  isolatedRedisUrl.pathname = "/14";
  process.env.REDIS_URL = isolatedRedisUrl.toString();

  process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
  process.env.JWT_EXPIRES_IN = "1h";
  process.env.ATTENDANCE_TOKEN_SECRET ||= crypto.randomBytes(32).toString("hex");
  process.env.QR_REFRESH_MS = "30000";
  process.env.QR_ALLOWED_SKEW_SLOTS = "2";
  process.env.QR_CHALLENGE_TTL_MS = "90000";
  process.env.QR_USE_CLAIM_MS = "15000";
  process.env.QR_REPLAY_TTL_MS = "60000";
  process.env.ATTENDANCE_SESSION_MINUTES = "60";
  process.env.ATTENDANCE_MAX_GPS_ACCURACY_METERS = "100";
  process.env.ATTENDANCE_MAX_GPS_AGE_MS = "120000";
  process.env.ATTENDANCE_STUDENT_RATE_CAPACITY = "10";
  process.env.ATTENDANCE_STUDENT_RATE_REFILL = "1";
  process.env.ATTENDANCE_IP_RATE_CAPACITY = "2000";
  process.env.ATTENDANCE_IP_RATE_REFILL = "1000";

  const mongoose = require("mongoose");
  const { redisClient } = require("../../src/config/redis");
  const app = require("../../src/app");
  const User = require("../../src/models/Auth.model");
  const Course = require("../../src/models/Course.model");
  const ClassSection = require("../../src/models/ClassSection.model");
  const Enrollment = require("../../src/models/Enrollment.model");
  const AttendanceSession = require("../../src/models/AttendanceSession.model");
  const AttendanceSessionStudent = require("../../src/models/AttendanceSessionStudent.model");
  const AttendanceRecord = require("../../src/models/AttendanceRecord.model");
  const AttendanceAttempt = require("../../src/models/AttendanceAttempt.model");
  const AuditEvent = require("../../src/models/AuditEvent.model");
  const Idempotency = require("../../src/models/Idempotency.model");
  const DeviceCredential = require("../../src/models/DeviceCredential.model");
  const BiometricEnrollment = require("../../src/models/BiometricEnrollment.model");
  const { buildAttendanceSignaturePayload } = require("../../src/modules/Device/attendanceSignaturePayload");

  const CLIENT_COUNT = 300;

  function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return Number(sorted[index].toFixed(2));
  }

  test("300 distinct eligible students can submit attendance concurrently without duplicates", {
    timeout: 180000,
  }, async (t) => {
    let server;
    let connectedMongo = false;
    let connectedRedis = false;
    let lecturer;
    let course;
    let section;
    let sessionDoc;
    let users = [];
    let enrollments = [];
    let deviceCredentials = [];
    let biometricEnrollments = [];
    const assertionIds = [];
    const runId = crypto.randomUUID();
    const suffix = runId.replace(/-/g, "").slice(0, 8).toUpperCase();
    const room = {
      code: "LOAD-" + suffix,
      latitude: 15.4589,
      longitude: 75.0078,
      geofenceRadiusMeters: 100,
    };

    async function api(path, { method = "GET", token, body, headers = {} } = {}) {
      const requestHeaders = { ...headers };
      if (token) requestHeaders.Authorization = "Bearer " + token;
      if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
      const start = performance.now();
      const response = await fetch(
        "http://127.0.0.1:" + server.address().port + path,
        {
          method,
          headers: requestHeaders,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(45000),
        },
      );
      const elapsedMs = performance.now() - start;
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = { message: "Non-JSON response" }; }
      return { status: response.status, elapsedMs, data };
    }

    t.after(async () => {
      if (server) {
        await new Promise((resolve) => server.close(() => resolve()));
      }

      if (connectedMongo) {
        const studentIds = users.map((item) => item._id);
        try {
          if (sessionDoc) {
            await Promise.all([
              AttendanceRecord.deleteMany({ sessionId: sessionDoc._id }),
              AttendanceSessionStudent.deleteMany({ sessionId: sessionDoc._id }),
              AttendanceAttempt.deleteMany({ sessionId: sessionDoc._id }),
              AuditEvent.deleteMany({ sessionId: sessionDoc._id }),
              AttendanceSession.deleteMany({ _id: sessionDoc._id }),
            ]);
          }
          if (studentIds.length) {
            await Promise.all([
              Idempotency.deleteMany({ studentId: { $in: studentIds } }),
              BiometricEnrollment.deleteMany({ userId: { $in: studentIds } }),
              DeviceCredential.deleteMany({ userId: { $in: studentIds } }),
              Enrollment.deleteMany({ studentId: { $in: studentIds } }),
              User.deleteMany({ _id: { $in: studentIds } }),
            ]);
          }
          if (lecturer) await User.deleteOne({ _id: lecturer._id });
          if (section) await ClassSection.deleteOne({ _id: section._id });
          if (course) await Course.deleteOne({ _id: course._id });
        } finally {
          if (connectedRedis && redisClient.isOpen) {
            for (const assertionId of assertionIds) {
              await redisClient.del("biometric:assertion:" + assertionId).catch(() => {});
            }
          }
          await mongoose.disconnect().catch(() => {});
          if (redisClient.isOpen) await redisClient.quit().catch(() => {});
        }
      }
    });

    await mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 10000 });
    connectedMongo = true;
    if (!redisClient.isOpen) await redisClient.connect();
    connectedRedis = true;

    // The test uses database 14 only. Do not flush another application's Redis database.
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    const passwordHash = await bcrypt.hash("Load-Test-Password-Only-Not-For-Login!", 4);
    lecturer = await User.create({
      Name: "Load Test Lecturer " + suffix,
      email: "load-lecturer-" + suffix.toLowerCase() + "@example.test",
      password: passwordHash,
      mobileNumber: "600" + String(Date.now()).slice(-7),
      role: "Lecturer",
      status: "ACTIVE",
      tokenVersion: 0,
    });

    users = await User.insertMany(Array.from({ length: CLIENT_COUNT }, (_, index) => ({
      Name: "Load Student " + suffix + "-" + index,
      RollNumber: "LD" + suffix + String(index).padStart(3, "0"),
      email: "load-" + suffix.toLowerCase() + "-" + index + "@example.test",
      password: passwordHash,
      mobileNumber: "7" + suffix.slice(0, 2) + String(index).padStart(7, "0"),
      role: "Student",
      status: "ACTIVE",
      tokenVersion: 0,
    })), { ordered: true });

    course = await Course.create({
      code: "LD" + suffix,
      name: "Attendance Concurrency Test",
      department: "CSE",
      semester: 5,
      status: "ACTIVE",
    });

    section = await ClassSection.create({
      courseId: course._id,
      name: "L" + suffix.slice(0, 5),
      academicYear: "2026-2027",
      semester: 5,
      room,
      lecturers: [lecturer._id],
      status: "ACTIVE",
    });

    enrollments = await Enrollment.insertMany(users.map((student, index) => ({
      studentId: student._id,
      sectionId: section._id,
      rollNumber: student.RollNumber || ("LD" + suffix + String(index).padStart(3, "0")),
      status: "ACTIVE",
    })), { ordered: true });

    const keyPairs = users.map(() => crypto.generateKeyPairSync("ed25519"));
    deviceCredentials = await DeviceCredential.insertMany(users.map((student, index) => ({
      userId: student._id,
      deviceId: "load-device-" + suffix + "-" + index,
      algorithm: "Ed25519",
      publicKey: keyPairs[index].publicKey.export({ type: "spki", format: "pem" }),
      status: "ACTIVE",
    })), { ordered: true });

    biometricEnrollments = await BiometricEnrollment.insertMany(users.map((student) => ({
      userId: student._id,
      provider: "LOCAL",
      providerUserId: String(student._id),
      modelVersion: "load-test-seeded-assertion",
      status: "ACTIVE",
    })), { ordered: true });

    const lecturerToken = jwt.sign(
      { id: String(lecturer._id), role: "Lecturer", tokenVersion: 0 },
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );

    const startSession = await api("/api/v1/attendance/sessions", {
      method: "POST",
      token: lecturerToken,
      body: { sectionId: String(section._id) },
    });
    assert.equal(startSession.status, 201, JSON.stringify(startSession.data));
    const publicSessionId = startSession.data.data.sessionId;
    sessionDoc = await AttendanceSession.findOne({ sessionId: publicSessionId });
    assert.ok(sessionDoc, "Session must exist after API creation");
    assert.equal(sessionDoc.eligibleStudentCount, CLIENT_COUNT);

    const qr = await api("/api/v1/attendance/sessions/" + publicSessionId + "/qr", {
      token: lecturerToken,
    });
    assert.equal(qr.status, 200, JSON.stringify(qr.data));
    const token = qr.data.data.token;
    assert.ok(token);

    // These test-only assertions bypass ML inference intentionally. This test
    // isolates the final API/device/Redis/database transaction under contention.
    // Live face/liveness capacity is measured separately with the real provider.
    const fixture = await Promise.all(users.map(async (student, index) => {
      const assertionId = crypto.randomUUID();
      assertionIds.push(assertionId);
      const assertion = {
        userId: String(student._id),
        sessionId: publicSessionId,
        livenessPassed: true,
        faceMatchPassed: true,
        activeLivenessPassed: true,
        livenessMode: "LOAD_TEST_ONLY",
        providerUserId: String(student._id),
      };
      const stored = await redisClient.set(
        "biometric:assertion:" + assertionId,
        JSON.stringify(assertion),
        { NX: true, PX: 120000 },
      );
      if (stored !== "OK") throw new Error("Could not seed test-only assertion");

      const idempotencyKey = crypto.randomUUID();
      const capturedAt = new Date().toISOString();
      const deviceId = deviceCredentials[index].deviceId;
      const payloadString = buildAttendanceSignaturePayload({
        deviceId,
        sessionId: publicSessionId,
        token,
        idempotencyKey,
        biometricAssertionId: assertionId,
        latitude: room.latitude,
        longitude: room.longitude,
        accuracyMeters: 5,
        capturedAt,
      });
      const signature = crypto.sign(
        null,
        Buffer.from(payloadString, "utf8"),
        keyPairs[index].privateKey,
      ).toString("base64url");

      return {
        token: jwt.sign(
          { id: String(student._id), role: "Student", tokenVersion: 0 },
          process.env.JWT_SECRET,
          { expiresIn: "1h" },
        ),
        idempotencyKey,
        body: {
          token,
          deviceId,
          deviceSignature: signature,
          biometricAssertionId: assertionId,
          latitude: room.latitude,
          longitude: room.longitude,
          accuracyMeters: 5,
          capturedAt,
        },
      };
    }));

    const batchStart = performance.now();
    const results = await Promise.allSettled(fixture.map(async (item) => {
      const started = performance.now();
      const response = await fetch(
        "http://127.0.0.1:" + server.address().port + "/api/v1/attendance/verify",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + item.token,
            "Content-Type": "application/json",
            "Idempotency-Key": item.idempotencyKey,
          },
          body: JSON.stringify(item.body),
          signal: AbortSignal.timeout(45000),
        },
      );
      const elapsedMs = performance.now() - started;
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = { message: "Non-JSON response" }; }
      return { status: response.status, elapsedMs, data };
    }));
    const totalMs = performance.now() - batchStart;
    const responses = results.map((item) => item.status === "fulfilled"
      ? item.value
      : { status: 0, elapsedMs: 0, data: { message: String(item.reason?.message || "network failure") } });
    const statuses = {};
    for (const response of responses) {
      statuses[response.status] = (statuses[response.status] || 0) + 1;
    }
    const latencies = responses.filter((response) => response.status > 0).map((response) => response.elapsedMs);
    const metrics = {
      simulatedStudents: CLIENT_COUNT,
      successfulResponses: statuses[201] || 0,
      statusCounts: statuses,
      totalBatchMs: Number(totalMs.toFixed(2)),
      requestsPerSecond: Number((CLIENT_COUNT / (totalMs / 1000)).toFixed(2)),
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: Number(Math.max(0, ...latencies).toFixed(2)),
      },
      sampleErrors: responses
        .filter((response) => response.status !== 201)
        .slice(0, 5)
        .map((response) => ({
          status: response.status,
          code: response.data?.error?.code,
          message: response.data?.error?.message || response.data?.message,
        })),
    };
    console.log("ATTENDANCE_CONCURRENCY_METRICS " + JSON.stringify(metrics));

    assert.equal(results.length, CLIENT_COUNT);
    assert.equal(
      statuses[201] || 0,
      CLIENT_COUNT,
      "All unique students should submit successfully; metrics are printed above",
    );

    const recordCount = await AttendanceRecord.countDocuments({ sessionId: sessionDoc._id });
    const presentRosterCount = await AttendanceSessionStudent.countDocuments({
      sessionId: sessionDoc._id,
      status: "PRESENT",
    });
    const markedAuditCount = await AuditEvent.countDocuments({
      sessionId: sessionDoc._id,
      event: "ATTENDANCE_MARKED",
    });
    assert.equal(recordCount, CLIENT_COUNT, "Exactly one durable attendance record per student");
    assert.equal(presentRosterCount, CLIENT_COUNT, "Every successful roster entry must be PRESENT");
    assert.equal(markedAuditCount, CLIENT_COUNT, "Every success should have one attendance audit event");
  });
}
