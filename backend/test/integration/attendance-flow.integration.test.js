const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.ATTENDANCE_STUDENT_RATE_CAPACITY = "30";
process.env.ATTENDANCE_STUDENT_RATE_REFILL = "20";
process.env.AUTH_IP_RATE_CAPACITY = "1000";
process.env.AUTH_IP_RATE_REFILL = "50";
process.env.AUTH_LOGIN_EMAIL_CAPACITY = "8";
process.env.AUTH_LOGIN_EMAIL_REFILL = "0.01";

const mongoUrl = process.env.TEST_MONGO_URL;
const testRedisUrl = process.env.TEST_REDIS_URL;

if (!mongoUrl || !testRedisUrl) {
    test(
        "full attendance API workflow",
        {
            skip: "Set TEST_MONGO_URL and TEST_REDIS_URL"
        },
        () => {}
    );
} else {
    const databaseName = decodeURIComponent(
        new URL(mongoUrl).pathname
            .replace(/^\/+/, "")
            .split("/")[0]
    );

    if (databaseName !== "attendance_test") {
        throw new Error(
            "Safety check: TEST_MONGO_URL must use attendance_test"
        );
    }

    // Set configuration before importing application modules.
    process.env.REDIS_URL = testRedisUrl;
    process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
    process.env.ATTENDANCE_TOKEN_SECRET ||=
        crypto.randomBytes(32).toString("hex");
    process.env.QR_REFRESH_MS = "30000";
    process.env.QR_ALLOWED_SKEW_SLOTS = "2";
    process.env.QR_CHALLENGE_TTL_MS = "90000";
    process.env.QR_USE_CLAIM_MS = "10000";
    process.env.QR_REPLAY_TTL_MS = "60000";
    process.env.ATTENDANCE_SESSION_MINUTES = "60";
    process.env.ATTENDANCE_MAX_GPS_ACCURACY_METERS = "100";
    process.env.ATTENDANCE_MAX_GPS_AGE_MS = "120000";

    const mongoose = require("mongoose");
    const bcrypt = require("bcryptjs");
    const sharp = require("sharp");

    const { redisClient } = require("../../src/config/redis");
    const app = require("../../src/app");

    const User = require("../../src/models/Auth.model");
    const Course = require("../../src/models/Course.model");
    const ClassSection = require("../../src/models/ClassSection.model");
    const Enrollment = require("../../src/models/Enrollment.model");

    const AttendanceSession = require(
        "../../src/models/AttendanceSession.model"
    );

    const AttendanceSessionStudent = require(
        "../../src/models/AttendanceSessionStudent.model"
    );

    const AttendanceRecord = require(
        "../../src/models/AttendanceRecord.model"
    );

    const AttendanceAttempt = require(
        "../../src/models/AttendanceAttempt.model"
    );

    const AuditEvent = require("../../src/models/AuditEvent.model");
    const Idempotency = require("../../src/models/Idempotency.model");

    const DeviceCredential = require(
        "../../src/models/DeviceCredential.model"
    );

    const BiometricEnrollment = require(
        "../../src/models/BiometricEnrollment.model"
    );

    const biometricProvider = require(
        "../../src/modules/Biometric/LocalBiometricProvider"
    );

    test(
        "lecturer to student check-in succeeds once and identical retry replays",
        async (t) => {
            let server;
            let sessionDoc;
            let lecturer;
            let student;
            let course;
            let section;
            let enrollment;
            let connectedMongo = false;
            let connectedRedis = false;

            const runId = crypto.randomUUID();
            const suffix = runId.replace(/-/g, "").slice(0, 10);
            const emailSuffix = suffix.toLowerCase();
            const password = "Integration-Test-Password-123!";
            const deviceId = `test-device-${suffix}`;
            const idempotencyKey = crypto.randomUUID();

            const room = {
                code: "TEST-ROOM",
                latitude: 15.4589,
                longitude: 75.0078,
                geofenceRadiusMeters: 100
            };

            async function api(path, {
                method = "GET",
                token,
                body,
                formData,
                headers = {}
            } = {}) {
                const requestHeaders = { ...headers };

                if (token) {
                    requestHeaders.Authorization = `Bearer ${token}`;
                }

                let requestBody;

                if (formData) {
                    requestBody = formData;
                } else if (body !== undefined) {
                    requestHeaders["Content-Type"] = "application/json";
                    requestBody = JSON.stringify(body);
                }

                const response = await fetch(
                    `http://127.0.0.1:${server.address().port}${path}`,
                    {
                        method,
                        headers: requestHeaders,
                        body: requestBody
                    }
                );

                const responseText = await response.text();
                let data;

                try {
                    data = JSON.parse(responseText);
                } catch {
                    data = { raw: responseText };
                }

                return { response, data };
            }

            t.after(async () => {
                if (server) {
                    await new Promise((resolve) => {
                        server.close(() => resolve());
                    });
                }

                if (sessionDoc) {
                    await Promise.all([
                        AttendanceRecord.deleteMany({
                            sessionId: sessionDoc._id
                        }),

                        AttendanceSessionStudent.deleteMany({
                            sessionId: sessionDoc._id
                        }),

                        AttendanceAttempt.deleteMany({
                            sessionId: sessionDoc._id
                        }),

                        AuditEvent.deleteMany({
                            sessionId: sessionDoc._id
                        }),

                        AttendanceSession.deleteMany({
                            _id: sessionDoc._id
                        })
                    ]);
                }

                if (student) {
                    await Promise.all([
                        BiometricEnrollment.deleteMany({
                            userId: student._id
                        }),

                        DeviceCredential.deleteMany({
                            userId: student._id
                        }),

                        Enrollment.deleteMany({
                            studentId: student._id
                        }),

                        User.deleteMany({
                            _id: student._id
                        })
                    ]);
                }

                if (lecturer) {
                    await User.deleteMany({ _id: lecturer._id });
                }

                if (section) {
                    await ClassSection.deleteMany({
                        _id: section._id
                    });
                }

                if (course) {
                    await Course.deleteMany({
                        _id: course._id
                    });
                }

                await Idempotency.deleteMany({
                    key: idempotencyKey
                }).catch(() => {});

                if (connectedRedis && redisClient.isOpen) {
                    await redisClient.quit().catch(() => {});
                }

                if (connectedMongo) {
                    await mongoose.disconnect().catch(() => {});
                }
            });

            // Connect to the dedicated test services.
            await mongoose.connect(mongoUrl, {
                serverSelectionTimeoutMS: 5000
            });

            connectedMongo = true;

            if (!redisClient.isOpen) {
                await redisClient.connect();
            }

            connectedRedis = true;

            server = app.listen(0, "127.0.0.1");

            await new Promise((resolve, reject) => {
                server.once("listening", resolve);
                server.once("error", reject);
            });

            // 1. Prepare isolated lecturer and student accounts.
            const passwordHash = await bcrypt.hash(password, 4);

            lecturer = await User.create({
                Name: `Test Lecturer ${suffix}`,
                email: `lecturer-${emailSuffix}@example.com`,
                password: passwordHash,
                mobileNumber: "9000000001",
                role: "Lecturer",
                status: "ACTIVE"
            });

            const rollNumber =
                `26BIT${String(Date.now() % 1000).padStart(3, "0")}`;

            student = await User.create({
                Name: `Test Student ${suffix}`,
                RollNumber: rollNumber,
                email: `student-${emailSuffix}@example.com`,
                password: passwordHash,
                mobileNumber: "9000000002",
                role: "Student",
                status: "ACTIVE"
            });

            course = await Course.create({
                code: `IT${suffix.slice(0, 8)}`,
                name: "Attendance Integration Testing",
                department: "CSE",
                semester: 5,
                status: "ACTIVE"
            });

            section = await ClassSection.create({
                courseId: course._id,
                name: `T${suffix.slice(0, 5)}`,
                academicYear: "2026-2027",
                semester: 5,
                room,
                lecturers: [lecturer._id],
                status: "ACTIVE"
            });

            enrollment = await Enrollment.create({
                studentId: student._id,
                sectionId: section._id,
                rollNumber,
                status: "ACTIVE"
            });

            // 2. Login through the real authentication endpoints.
            const lecturerLogin = await api("/api/v1/auth/login", {
                method: "POST",
                body: {
                    email: lecturer.email,
                    password
                }
            });

            assert.equal(
                lecturerLogin.response.status,
                200,
                JSON.stringify(lecturerLogin.data)
            );

            const lecturerToken = lecturerLogin.data.token;
            assert.ok(lecturerToken);

            const studentLogin = await api("/api/v1/auth/login", {
                method: "POST",
                body: {
                    email: student.email,
                    password
                }
            });

            
            // Security: repeated failed logins against one account
            // must eventually hit the account-specific Redis limit.
            const failedLoginAttempts = [];

            for (let attempt = 0; attempt < 12; attempt += 1) {
                const result = await api("/api/v1/auth/login", {
                    method: "POST",
                    body: {
                        email: lecturer.email,
                        password: `Incorrect-Password-${attempt}!`
                    }
                });

                failedLoginAttempts.push(result);
            }

            assert.ok(
                failedLoginAttempts.some(
                    (result) => result.response.status === 429
                ),
                "Repeated failed login attempts should trigger HTTP 429"
            );

            assert.ok(
                failedLoginAttempts.every(
                    (result) =>
                        result.response.status === 401 ||
                        result.response.status === 429
                ),
                "Failed login attempts should be rejected or rate-limited"
            );

            const rateLimitedLogin = failedLoginAttempts.find(
                (result) => result.response.status === 429
            );

            assert.equal(
                rateLimitedLogin.data.error.code,
                "RATE_LIMIT_EXCEEDED"
            );


            assert.equal(
                studentLogin.response.status,
                200,
                JSON.stringify(studentLogin.data)
            );

            const studentToken = studentLogin.data.token;
            assert.ok(studentToken);

            // Security: students must not create lecturer attendance sessions.
            const studentSessionAttempt = await api(
                "/api/v1/attendance/sessions",
                {
                    method: "POST",
                    token: studentToken,
                    body: {
                        sectionId: String(section._id)
                    }
                }
            );

            assert.equal(
                studentSessionAttempt.response.status,
                403,
                JSON.stringify(studentSessionAttempt.data)
            );

            // 3. Register an Ed25519 device using the real challenge flow.
            const keyPair = crypto.generateKeyPairSync("ed25519");

            const publicKey = keyPair.publicKey.export({
                type: "spki",
                format: "pem"
            });

            const registrationChallenge = await api(
                "/api/v1/devices/registration-challenge",
                {
                    method: "POST",
                    token: studentToken,
                    body: {}
                }
            );

            assert.equal(
                registrationChallenge.response.status,
                200,
                JSON.stringify(registrationChallenge.data)
            );

            const deviceChallenge = registrationChallenge.data.data;

            const registrationSignature = crypto.sign(
                null,
                Buffer.from(deviceChallenge.challenge, "utf8"),
                keyPair.privateKey
            ).toString("base64url");

            const deviceRegistration = await api(
                "/api/v1/devices/register",
                {
                    method: "POST",
                    token: studentToken,
                    body: {
                        challengeId: deviceChallenge.challengeId,
                        deviceId,
                        publicKey,
                        signature: registrationSignature
                    }
                }
            );

            assert.equal(
                deviceRegistration.response.status,
                201,
                JSON.stringify(deviceRegistration.data)
            );

            // 4. Seed a biometric enrollment. The real provider is mocked,
            // so the test never uploads real biometric data externally.
            await BiometricEnrollment.create({
                userId: student._id,
                provider: "LOCAL",
                providerUserId: String(student._id),
                modelVersion: "integration-test",
                status: "ACTIVE"
            });

            t.mock.method(
                biometricProvider,
                "verify",
                async ({ userId }) => ({
                    verified: true,
                    livenessPassed: true,
                    faceMatchPassed: true,
                    similarity: 0.98,
                    verificationId: crypto.randomUUID(),
                    providerUserId: String(userId)
                })
            );

            // 5. Lecturer opens attendance; retrieve the live QR.
            const createSession = await api(
                "/api/v1/attendance/sessions",
                {
                    method: "POST",
                    token: lecturerToken,
                    body: {
                        sectionId: String(section._id)
                    }
                }
            );

            assert.equal(
                createSession.response.status,
                201,
                JSON.stringify(createSession.data)
            );

            const publicSessionId = createSession.data.data.sessionId;

            // Security: only students may request their biometric challenge.
            const lecturerChallengeAttempt = await api(
                "/api/v1/biometric/challenge",
                {
                    method: "POST",
                    token: lecturerToken,
                    body: {
                        sessionId: publicSessionId
                    }
                }
            );

            assert.equal(
                lecturerChallengeAttempt.response.status,
                403,
                JSON.stringify(lecturerChallengeAttempt.data)
            );

            // Security: attendance submission requires authentication.
            const unauthenticatedAttempt = await api(
                "/api/v1/attendance/verify",
                {
                    method: "POST",
                    headers: {
                        "Idempotency-Key": crypto.randomUUID()
                    },
                    body: {}
                }
            );

            assert.equal(
                unauthenticatedAttempt.response.status,
                401,
                JSON.stringify(unauthenticatedAttempt.data)
            );

            sessionDoc = await AttendanceSession.findOne({
                sessionId: publicSessionId
            });

            assert.ok(sessionDoc, "Created attendance session must exist");

            const qrResponse = await api(
                `/api/v1/attendance/sessions/${publicSessionId}/qr`,
                {
                    token: lecturerToken
                }
            );

            assert.equal(
                qrResponse.response.status,
                200,
                JSON.stringify(qrResponse.data)
            );

            const token = qrResponse.data.data.token;
            assert.ok(token);

            // 6. Obtain biometric challenge, then verify a valid test image.
            const biometricChallengeResponse = await api(
                "/api/v1/biometric/challenge",
                {
                    method: "POST",
                    token: studentToken,
                    body: {
                        sessionId: publicSessionId
                    }
                }
            );

            assert.equal(
                biometricChallengeResponse.response.status,
                200,
                JSON.stringify(biometricChallengeResponse.data)
            );

            const biometricChallenge =
                biometricChallengeResponse.data.data;

            const imageBuffer = await sharp({
                create: {
                    width: 32,
                    height: 32,
                    channels: 3,
                    background: { r: 60, g: 100, b: 150 }
                }
            }).jpeg().toBuffer();

            const imageForm = new FormData();

            imageForm.append("sessionId", publicSessionId);

            imageForm.append(
                "challengeId",
                biometricChallenge.challengeId
            );

            imageForm.append(
                "image",
                new Blob([imageBuffer], { type: "image/jpeg" }),
                "test-face.jpg"
            );

            const biometricResponse = await api(
                "/api/v1/biometric/verify",
                {
                    method: "POST",
                    token: studentToken,
                    formData: imageForm
                }
            );

            assert.equal(
                biometricResponse.response.status,
                200,
                JSON.stringify(biometricResponse.data)
            );

            const assertionId = biometricResponse.data.data.assertionId;
            assert.ok(assertionId);

            // 7. Sign the attendance operation with the registered device.
            const deviceMessage = [
                "ATTENDANCE_V1",
                publicSessionId,
                token,
                idempotencyKey
            ].join("|");

            const deviceSignature = crypto.sign(
                null,
                Buffer.from(deviceMessage, "utf8"),
                keyPair.privateKey
            ).toString("base64url");

            const capturedAt = new Date().toISOString();

            const attendancePayload = {
                token,
                deviceId,
                deviceSignature,
                biometricAssertionId: assertionId,
                latitude: room.latitude,
                longitude: room.longitude,
                accuracyMeters: 5,
                capturedAt
            };

            // Reject an out-of-geofence location before consuming the assertion.
            const gpsAttackKey = crypto.randomUUID();

            const gpsAttackSignature = crypto.sign(
                null,
                Buffer.from([
                    "ATTENDANCE_V1",
                    publicSessionId,
                    token,
                    gpsAttackKey
                ].join("|"), "utf8"),
                keyPair.privateKey
            ).toString("base64url");

            const gpsAttackResponse = await api(
                "/api/v1/attendance/verify",
                {
                    method: "POST",
                    token: studentToken,
                    headers: {
                        "Idempotency-Key": gpsAttackKey
                    },
                    body: {
                        ...attendancePayload,
                        deviceSignature: gpsAttackSignature,
                        latitude: 0,
                        longitude: 0,
                        capturedAt: new Date().toISOString()
                    }
                }
            );

            assert.equal(
                gpsAttackResponse.response.status,
                403,
                JSON.stringify(gpsAttackResponse.data)
            );

            assert.equal(
                await AttendanceRecord.countDocuments({
                    sessionId: sessionDoc._id,
                    studentId: student._id
                }),
                0,
                "An out-of-geofence attempt must not create attendance"
            );

            // 8. Race two identical first-time submissions.
            const concurrentSubmissions = await Promise.all([
                api("/api/v1/attendance/verify", {
                    method: "POST",
                    token: studentToken,
                    headers: {
                        "Idempotency-Key": idempotencyKey
                    },
                    body: attendancePayload
                }),

                api("/api/v1/attendance/verify", {
                    method: "POST",
                    token: studentToken,
                    headers: {
                        "Idempotency-Key": idempotencyKey
                    },
                    body: attendancePayload
                })
            ]);

            const successfulSubmissions =
                concurrentSubmissions.filter(
                    (result) => result.response.status === 201
                );

            assert.ok(
                successfulSubmissions.length >= 1,
                JSON.stringify(
                    concurrentSubmissions.map((result) => ({
                        status: result.response.status,
                        body: result.data
                    }))
                )
            );

            assert.ok(
                concurrentSubmissions.every(
                    (result) =>
                        result.response.status === 201 ||
                        result.response.status === 409
                ),
                "Concurrent submissions must succeed or conflict, never fail unexpectedly"
            );

            const attendanceResponse = successfulSubmissions[0];

            assert.equal(attendanceResponse.data.success, true);

            assert.equal(
                attendanceResponse.data.alreadyMarked,
                false
            );

            if (successfulSubmissions.length === 2) {
                assert.deepEqual(
                    successfulSubmissions[0].data,
                    successfulSubmissions[1].data,
                    "Concurrent successful retries must return the same response"
                );
            }

            // 9. Retry exactly the same request. It must replay the
            // saved response without consuming the assertion again.
            const retryResponse = await api(
                "/api/v1/attendance/verify",
                {
                    method: "POST",
                    token: studentToken,
                    headers: {
                        "Idempotency-Key": idempotencyKey
                    },
                    body: attendancePayload
                }
            );

            assert.equal(
                retryResponse.response.status,
                attendanceResponse.response.status,
                JSON.stringify(retryResponse.data)
            );

            assert.deepEqual(
                retryResponse.data,
                attendanceResponse.data
            );

            // Reusing a completed idempotency key with changed GPS must conflict.
            const modifiedReplay = await api(
                "/api/v1/attendance/verify",
                {
                    method: "POST",
                    token: studentToken,
                    headers: {
                        "Idempotency-Key": idempotencyKey
                    },
                    body: {
                        ...attendancePayload,
                        latitude: room.latitude + 0.001
                    }
                }
            );

            assert.equal(
                modifiedReplay.response.status,
                409,
                JSON.stringify(modifiedReplay.data)
            );

            // A new operation key cannot reuse the already-consumed assertion.
            const secondOperationKey = crypto.randomUUID();

            const secondDeviceSignature = crypto.sign(
                null,
                Buffer.from([
                    "ATTENDANCE_V1",
                    publicSessionId,
                    token,
                    secondOperationKey
                ].join("|"), "utf8"),
                keyPair.privateKey
            ).toString("base64url");

            const assertionReplay = await api(
                "/api/v1/attendance/verify",
                {
                    method: "POST",
                    token: studentToken,
                    headers: {
                        "Idempotency-Key": secondOperationKey
                    },
                    body: {
                        ...attendancePayload,
                        deviceSignature: secondDeviceSignature
                    }
                }
            );

            assert.ok(
                [401, 409].includes(assertionReplay.response.status),
                JSON.stringify(assertionReplay.data)
            );

            assert.equal(
                await AttendanceRecord.countDocuments({
                    sessionId: sessionDoc._id,
                    studentId: student._id
                }),
                1,
                "Replay attempts must not create duplicate attendance"
            );

            // 10. Verify durable database state—not just the HTTP response.
            assert.equal(
                await AttendanceRecord.countDocuments({
                    sessionId: sessionDoc._id,
                    studentId: student._id
                }),
                1
            );

            const roster = await AttendanceSessionStudent.findOne({
                sessionId: sessionDoc._id,
                studentId: student._id
            });

            assert.ok(roster);
            assert.equal(roster.status, "PRESENT");

            const idempotencyRecord = await Idempotency.findOne({
                key: idempotencyKey
            });

            assert.ok(idempotencyRecord);
            assert.equal(idempotencyRecord.status, "COMPLETED");

            assert.equal(
                await AuditEvent.countDocuments({
                    sessionId: sessionDoc._id,
                    event: "ATTENDANCE_MARKED"
                }),
                1
            );

            // Ending the session must not invalidate a previously completed
            // idempotency key. A retry should return its original response.
            const endSessionResponse = await api(
                `/api/v1/attendance/sessions/${publicSessionId}/end`,
                {
                    method: "POST",
                    token: lecturerToken,
                    body: {}
                }
            );

            assert.equal(
                endSessionResponse.response.status,
                200,
                JSON.stringify(endSessionResponse.data)
            );

            const replayAfterSessionEnd = await api(
                "/api/v1/attendance/verify",
                {
                    method: "POST",
                    token: studentToken,
                    headers: {
                        "Idempotency-Key": idempotencyKey
                    },
                    body: attendancePayload
                }
            );

            assert.equal(
                replayAfterSessionEnd.response.status,
                attendanceResponse.response.status,
                JSON.stringify(replayAfterSessionEnd.data)
            );

            assert.deepEqual(
                replayAfterSessionEnd.data,
                attendanceResponse.data
            );

            assert.equal(
                await AttendanceRecord.countDocuments({
                    sessionId: sessionDoc._id,
                    studentId: student._id
                }),
                1
            );

            // Students can revoke their own registered device.
            const revokeResponse = await api(
                "/api/v1/devices/me",
                {
                    method: "DELETE",
                    token: studentToken
                }
            );

            assert.equal(
                revokeResponse.response.status,
                200,
                JSON.stringify(revokeResponse.data)
            );

            assert.equal(
                revokeResponse.data.data.status,
                "REVOKED"
            );

            assert.equal(
                await DeviceCredential.countDocuments({
                    userId: student._id,
                    status: "ACTIVE"
                }),
                0
            );
        }
    );
}