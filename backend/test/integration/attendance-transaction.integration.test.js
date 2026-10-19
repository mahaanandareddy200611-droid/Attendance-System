
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const testMongoUrl = process.env.TEST_MONGO_URL;

if (!testMongoUrl) {
    test(
        "MongoDB attendance transaction rollback and commit",
        {
            skip: "Set TEST_MONGO_URL to a dedicated attendance_test replica-set database"
        },
        () => {}
    );
} else {
    const databaseName = decodeURIComponent(
        new URL(testMongoUrl).pathname
            .replace(/^\/+/, "")
            .split("/")[0]
    );

    if (databaseName !== "attendance_test") {
        throw new Error(
            "Safety check failed: TEST_MONGO_URL must target the attendance_test database"
        );
    }

    const mongoose = require("mongoose");

    const AttendanceRecord = require(
        "../../src/models/AttendanceRecord.model"
    );

    const AttendanceSessionStudent = require(
        "../../src/models/AttendanceSessionStudent.model"
    );

    const Idempotency = require(
        "../../src/models/Idempotency.model"
    );

    const AuditEvent = require(
        "../../src/models/AuditEvent.model"
    );

    test(
        "MongoDB rolls back all attendance writes together and commits them together",
        async () => {
            let connected = false;
            let dbSession;

            const testRunId = crypto.randomUUID();
            const sessionId = new mongoose.Types.ObjectId();
            const studentId = new mongoose.Types.ObjectId();
            const enrollmentId = new mongoose.Types.ObjectId();
            const idempotencyKey = `mongo-integration-${testRunId}`;

            const attendanceFilter = {
                sessionId,
                studentId
            };

            const auditFilter = {
                "metadata.testRunId": testRunId
            };

            const cleanup = async () => {
                await Promise.all([
                    AttendanceRecord.deleteMany(attendanceFilter),
                    AttendanceSessionStudent.deleteMany(attendanceFilter),
                    Idempotency.deleteMany({ key: idempotencyKey }),
                    AuditEvent.deleteMany(auditFilter)
                ]);
            };

            try {
                await mongoose.connect(testMongoUrl, {
                    serverSelectionTimeoutMS: 5000
                });

                connected = true;

                // Ensure collections and unique indexes exist before
                // beginning a transaction.
                await Promise.all([
                    AttendanceRecord.init(),
                    AttendanceSessionStudent.init(),
                    Idempotency.init(),
                    AuditEvent.init()
                ]);

                const writeAllDocuments = async (session) => {
                    await AttendanceRecord.create(
                        [{
                            sessionId,
                            studentId,
                            courseCode: "TEST101",
                            section: "A",
                            verification: {
                                qr: true,
                                device: true,
                                biometric: true,
                                proximity: false
                            },
                            gps: {
                                latitude: 15.4589,
                                longitude: 75.0078,
                                accuracyMeters: 10,
                                capturedAt: new Date(),
                                distanceFromClassroomMeters: 8
                            }
                        }],
                        { session }
                    );

                    await AttendanceSessionStudent.create(
                        [{
                            sessionId,
                            studentId,
                            enrollmentId,
                            rollNumber: `IT-${testRunId.slice(0, 8)}`,
                            status: "PRESENT"
                        }],
                        { session }
                    );

                    await Idempotency.create(
                        [{
                            key: idempotencyKey,
                            fingerprint: "integration-test-fingerprint",
                            studentId,
                            sessionId,
                            status: "COMPLETED",
                            responseStatus: 201,
                            responseBody: {
                                success: true,
                                testRunId
                            }
                        }],
                        { session }
                    );

                    await AuditEvent.create(
                        [{
                            event: "ATTENDANCE_INTEGRATION_TEST",
                            userId: studentId,
                            sessionId,
                            metadata: {
                                testRunId,
                                phase: "transaction-test"
                            }
                        }],
                        { session }
                    );
                };

                const countAllDocuments = async () => Promise.all([
                    AttendanceRecord.countDocuments(attendanceFilter),
                    AttendanceSessionStudent.countDocuments(attendanceFilter),
                    Idempotency.countDocuments({ key: idempotencyKey }),
                    AuditEvent.countDocuments(auditFilter)
                ]);

                dbSession = await mongoose.startSession();

                // Phase A: force an error after all four writes.
                await assert.rejects(
                    dbSession.withTransaction(async () => {
                        await writeAllDocuments(dbSession);
                        throw new Error("FORCED_TRANSACTION_ABORT");
                    }),
                    /FORCED_TRANSACTION_ABORT/
                );

                assert.deepEqual(
                    await countAllDocuments(),
                    [0, 0, 0, 0],
                    "Every write must disappear after rollback"
                );

                // Phase B: execute the same writes and commit normally.
                await dbSession.withTransaction(async () => {
                    await writeAllDocuments(dbSession);
                });

                assert.deepEqual(
                    await countAllDocuments(),
                    [1, 1, 1, 1],
                    "Every write must exist after commit"
                );
            } finally {
                if (dbSession) {
                    await dbSession.endSession();
                }

                if (connected) {
                    try {
                        await cleanup();
                    } finally {
                        await mongoose.disconnect();
                    }
                }
            }
        }
    );
}
