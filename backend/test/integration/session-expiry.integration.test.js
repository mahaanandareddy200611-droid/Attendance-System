const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const testMongoUrl = process.env.TEST_MONGO_URL;

if (!testMongoUrl) {
    test("expired attendance sessions finalize roster entries as ABSENT", {
        skip: "Set TEST_MONGO_URL to a dedicated attendance_test replica-set database"
    }, () => {});
} else {
    const databaseName = decodeURIComponent(
        new URL(testMongoUrl).pathname.replace(/^\/+/, "").split("/")[0]
    );
    if (databaseName !== "attendance_test") {
        throw new Error("Safety check failed: TEST_MONGO_URL must target attendance_test");
    }

    process.env.REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL || "redis://127.0.0.1:6379/15";

    const mongoose = require("mongoose");
    const AttendanceSession = require("../../src/models/AttendanceSession.model");
    const AttendanceSessionStudent = require("../../src/models/AttendanceSessionStudent.model");
    const AuditEvent = require("../../src/models/AuditEvent.model");
    const { expireExpiredSessions } = require("../../src/modules/Attendance/AttendanceService");

    test("expired session transitions atomically and eligible roster becomes absent", async () => {
        let connected = false;
        let sessionDoc;
        const publicSessionId = "expiry-" + crypto.randomUUID();
        const studentId = new mongoose.Types.ObjectId();
        const enrollmentId = new mongoose.Types.ObjectId();
        const lecturerId = new mongoose.Types.ObjectId();
        const sectionId = new mongoose.Types.ObjectId();

        try {
            await mongoose.connect(testMongoUrl, { serverSelectionTimeoutMS: 5000 });
            connected = true;
            await Promise.all([
                AttendanceSession.init(),
                AttendanceSessionStudent.init(),
                AuditEvent.init()
            ]);

            sessionDoc = await AttendanceSession.create({
                sessionId: publicSessionId,
                sectionId,
                courseCode: "TEST101",
                section: "A",
                lecturerId,
                status: "ACTIVE",
                startedAt: new Date(Date.now() - 120000),
                expiresAt: new Date(Date.now() - 60000),
                classroomSnapshot: {
                    code: "B105",
                    latitude: 15.4589,
                    longitude: 75.0078,
                    geofenceRadiusMeters: 100
                },
                eligibleStudentCount: 1,
                version: 1
            });

            await AttendanceSessionStudent.create({
                sessionId: sessionDoc._id,
                studentId,
                enrollmentId,
                rollNumber: "T-" + crypto.randomUUID().slice(0, 8),
                status: "ELIGIBLE"
            });

            const expired = await expireExpiredSessions({ sessionId: publicSessionId });
            assert.deepEqual(expired, [publicSessionId]);

            const [updatedSession, roster, auditCount] = await Promise.all([
                AttendanceSession.findById(sessionDoc._id).lean(),
                AttendanceSessionStudent.findOne({ sessionId: sessionDoc._id, studentId }).lean(),
                AuditEvent.countDocuments({ event: "ATTENDANCE_SESSION_EXPIRED", sessionId: sessionDoc._id })
            ]);

            assert.equal(updatedSession.status, "EXPIRED");
            assert.ok(updatedSession.endedAt);
            assert.equal(roster.status, "ABSENT");
            assert.equal(auditCount, 1);

            // Re-running the worker is idempotent and must not create duplicate audit events.
            assert.deepEqual(await expireExpiredSessions({ sessionId: publicSessionId }), []);
            assert.equal(
                await AuditEvent.countDocuments({ event: "ATTENDANCE_SESSION_EXPIRED", sessionId: sessionDoc._id }),
                1
            );
        } finally {
            if (connected) {
                if (sessionDoc) {
                    await Promise.all([
                        AttendanceSessionStudent.deleteMany({ sessionId: sessionDoc._id }),
                        AuditEvent.deleteMany({ sessionId: sessionDoc._id }),
                        AttendanceSession.deleteOne({ _id: sessionDoc._id })
                    ]);
                }
                await mongoose.disconnect();
            }
        }
    });
}
