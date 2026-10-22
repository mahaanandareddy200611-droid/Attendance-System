const crypto = require("crypto");
const { redisClient } = require("../../config/redis");

const mongoose =
    require("mongoose");


const ClassSection =
    require("../../models/ClassSection.model");

const Enrollment =
    require("../../models/Enrollment.model");

const AttendanceSessionStudent =
    require("../../models/AttendanceSessionStudent.model");

const AttendanceSession =
    require("../../models/AttendanceSession.model");

const {
    createOrGetAttendanceRecord
} = require("./AttendanceRecordService");

const {
    validateAssertion: validateBiometricAssertion,
    reserveAssertion,
    releaseAssertionReservation,
    finalizeAssertionReservation
} = require("../Biometric/BiometricService");

const {
    distanceMeters
} = require("../../utils/geo");

const {
    getCurrentChallenge,
    verifyChallenge,
    claimQrUse,
    completeQrUse,
    releaseQrUse
} = require("./QrChallengeService");

const AttendanceAttempt =
    require("../../models/AttendanceAttempt.model");



const AuditEvent =
    require("../../models/AuditEvent.model");

const AppError =
    require("../../utils/AppError");

const CHECKIN_INTENT_TTL_MS =
    Number(process.env.ATTENDANCE_CHECKIN_INTENT_TTL_MS) || 10 * 60 * 1000;
const checkinIntentKey = (intentId) => `attendance:checkin:intent:${intentId}`;

const {
    generateAttendanceToken,
    verifyAttendanceToken,
    isSlotFresh
} = require("../../utils/attendanceToken");

const {
    emitAttendanceMarked,
    emitSessionEnded
} = require(
    "../../socket/socket"
);
const {
    getIdempotencyResult,
    claimIdempotency,
    completeIdempotency,
    releaseIdempotency
} = require("./IdempotencyService");



/**
 * Atomically expire stale attendance sessions and finalize every unmarked
 * roster entry as ABSENT. A caller may supply its existing Mongo transaction.
 * Background sweeps process bounded batches so one transaction cannot grow
 * with the entire semester's session history.
 */
const expireExpiredSessions = async ({ sessionId, sectionId, dbSession: suppliedSession } = {}) => {
    const ownsSession = !suppliedSession;
    const transactionSession = suppliedSession || await mongoose.startSession();

    try {
        let expiredPublicIds = [];

        const expireWork = async (activeSession) => {
            expiredPublicIds = [];
            const now = new Date();
            const filter = { status: "ACTIVE", expiresAt: { $lte: now } };
            if (sessionId) filter.sessionId = sessionId;
            if (sectionId) filter.sectionId = sectionId;

            const candidates = await AttendanceSession.find(filter)
                .select("_id sessionId sectionId lecturerId")
                .sort({ expiresAt: 1 })
                .limit(sessionId || sectionId ? 1 : 100)
                .session(activeSession)
                .lean();

            if (!candidates.length) return;

            const candidateIds = candidates.map((item) => item._id);
            const currentlyExpired = await AttendanceSession.find({
                _id: { $in: candidateIds },
                status: "ACTIVE",
                expiresAt: { $lte: now }
            })
                .select("_id sessionId sectionId lecturerId")
                .session(activeSession)
                .lean();

            if (!currentlyExpired.length) return;

            const expiredIds = currentlyExpired.map((item) => item._id);
            await AttendanceSession.updateMany(
                { _id: { $in: expiredIds }, status: "ACTIVE", expiresAt: { $lte: now } },
                { $set: { status: "EXPIRED", endedAt: now }, $inc: { version: 1 } },
                { session: activeSession }
            );

            await AttendanceSessionStudent.updateMany(
                { sessionId: { $in: expiredIds }, status: { $in: ["ELIGIBLE", "LATE"] } },
                { $set: { status: "ABSENT" } },
                { session: activeSession }
            );

            await AuditEvent.insertMany(
                currentlyExpired.map((item) => ({
                    event: "ATTENDANCE_SESSION_EXPIRED",
                    userId: item.lecturerId,
                    sessionId: item._id,
                    metadata: {
                        publicSessionId: item.sessionId,
                        sectionId: String(item.sectionId),
                        reason: "AUTOMATIC_EXPIRY"
                    }
                })),
                { session: activeSession, ordered: true }
            );

            expiredPublicIds = currentlyExpired.map((item) => item.sessionId);
        };

        if (ownsSession) {
            await transactionSession.withTransaction(async () => expireWork(transactionSession));
        } else {
            await expireWork(transactionSession);
        }

        return expiredPublicIds;
    } finally {
        if (ownsSession) await transactionSession.endSession();
    }
};

exports.expireExpiredSessions = expireExpiredSessions;


/*
==================================================
CREATE ATTENDANCE SESSION
==================================================
*/

exports.createSession = async ({
    lecturerId,
    sectionId
}) => {

    if (!sectionId) {
        throw new AppError(
            "sectionId is required",
            400
        );
    }

    const dbSession =
        await mongoose.startSession();

    try {

        let createdSession;

        await dbSession.withTransaction(
            async () => {

                /*
                --------------------------------------------------
                1. FIND ACTIVE SECTION
                --------------------------------------------------
                */

                const section = await ClassSection.findOneAndUpdate(
                    { _id: sectionId, status: "ACTIVE" },
                    { $inc: { locationVersion: 1 } },
                    { new: true, session: dbSession }
                ).populate("courseId", "code name");

                if (!section) {
                    throw new AppError(
                        "Active class section not found",
                        404
                    );
                }


                /*
                --------------------------------------------------
                2. VERIFY LECTURER ASSIGNMENT
                --------------------------------------------------
                */

                const lecturerAssigned =
                    section.lecturers.some(
                        (id) =>
                            String(id) ===
                            String(lecturerId)
                    );

                if (!lecturerAssigned) {
                    throw new AppError(
                        "You are not assigned to this class section",
                        403
                    );
                }


                /*
                --------------------------------------------------
                3. EXPIRE OLD SESSION
                --------------------------------------------------
                */

                const now =
                    new Date();

                await expireExpiredSessions({ sectionId, dbSession });


                /*
                --------------------------------------------------
                4. CHECK ACTIVE SESSION
                --------------------------------------------------
                */

                const existingSession =
                    await AttendanceSession.findOne({
                        sectionId,
                        status: "ACTIVE",
                        expiresAt: {
                            $gt: now
                        }
                    }).session(dbSession);

                if (existingSession) {
                    throw new AppError(
                        "An active attendance session already exists for this section",
                        409
                    );
                }


                /*
                --------------------------------------------------
                5. GET ACTIVE ENROLLMENTS
                --------------------------------------------------
                */

                const enrollments =
                    await Enrollment
                        .find({
                            sectionId,
                            status: "ACTIVE"
                        })
                        .select(
                            "_id studentId rollNumber"
                        )
                        .lean()
                        .session(dbSession);

                if (
                    enrollments.length === 0
                ) {
                    throw new AppError(
                        "No active students are enrolled in this section",
                        400
                    );
                }


                /*
                --------------------------------------------------
                6. SESSION TIMING
                --------------------------------------------------
                */

                const durationMinutes =
                    Number(
                        process.env
                            .ATTENDANCE_SESSION_MINUTES
                    ) || 60;

                const startedAt =
                    now;

                const expiresAt =
                    new Date(
                        startedAt.getTime() +
                        durationMinutes *
                        60 *
                        1000
                    );


                /*
                --------------------------------------------------
                7. CREATE PUBLIC SESSION ID
                --------------------------------------------------
                */

                const sessionId =
                    crypto.randomUUID();


                /*
                --------------------------------------------------
                8. CREATE SESSION
                --------------------------------------------------
                */

                const sessionDocuments =
                    await AttendanceSession.create(
                        [
                            {
                                sessionId,

                                sectionId,

                                courseCode:
                                    section
                                        .courseId
                                        .code,

                                section:
                                    section.name,

                                lecturerId,

                                status:
                                    "ACTIVE",

                                startedAt,

                                expiresAt,

                                endedAt:
                                    null,

                                classroomSnapshot: {
                                    code:
                                        section
                                            .room
                                            .code,

                                    latitude:
                                        section
                                            .room
                                            .latitude,

                                    longitude:
                                        section
                                            .room
                                            .longitude,

                                    geofenceRadiusMeters:
                                        section
                                            .room
                                            .geofenceRadiusMeters
                                },

                                eligibleStudentCount:
                                    enrollments.length,

                                version:
                                    1
                            }
                        ],
                        {
                            session:
                                dbSession
                        }
                    );

                createdSession =
                    sessionDocuments[0];


                /*
                --------------------------------------------------
                9. FREEZE SESSION ROSTER
                --------------------------------------------------
                */

                const rosterDocuments =
                    enrollments.map(
                        (enrollment) => ({
                            sessionId:
                                createdSession._id,

                            studentId:
                                enrollment.studentId,

                            enrollmentId:
                                enrollment._id,

                            rollNumber:
                                enrollment.rollNumber,

                            status:
                                "ELIGIBLE"
                        })
                    );

                await AttendanceSessionStudent
                    .insertMany(
                        rosterDocuments,
                        {
                            session:
                                dbSession
                        }
                    );


                /*
                --------------------------------------------------
                10. AUDIT
                --------------------------------------------------
                */

                await AuditEvent.create(
                    [
                        {
                            event:
                                "ATTENDANCE_SESSION_CREATED",

                            userId:
                                lecturerId,

                            sessionId:
                                createdSession._id,

                            metadata: {
                                publicSessionId:
                                    sessionId,

                                sectionId,

                                courseCode:
                                    section
                                        .courseId
                                        .code,

                                section:
                                    section.name,

                                eligibleStudentCount:
                                    enrollments.length
                            }
                        }
                    ],
                    {
                        session:
                            dbSession
                    }
                );
            }
        );


        return createdSession;


    } catch (error) {

        /*
        --------------------------------------------------
        CONCURRENT SESSION CREATION
        --------------------------------------------------

        The partial unique index guarantees that only
        one ACTIVE attendance session can exist for
        a section.
        */

        if (
            error.code === 11000
        ) {

            throw new AppError(
                "An active attendance session already exists for this section",
                409
            );
        }

        throw error;

    } finally {

        await dbSession.endSession();
    }
};


/*
==================================================
GET CURRENT QR
==================================================
*/

exports.getCurrentQr = async ({
    sessionId,
    lecturerId
}) => {

    const session =
        await AttendanceSession.findOne({
            sessionId,
            lecturerId
        });


    if (!session) {
        throw new AppError(
            "Attendance session not found",
            404
        );
    }


    if (
        session.status !==
        "ACTIVE"
    ) {

        throw new AppError(
            "Attendance session is not active",
            400
        );
    }


    if (Date.now() >= new Date(session.expiresAt).getTime()) {
        await expireExpiredSessions({ sessionId: session.sessionId });
        throw new AppError("Attendance session expired", 400);
    }


    const challenge =
        await getCurrentChallenge({
            sessionId:
                session.sessionId
        });


    const token =
        generateAttendanceToken({
            sessionId:
                session.sessionId,

            slot:
                challenge.slot,

            nonce:
                challenge.nonce
        });


    return {
        sessionId:
            session.sessionId,

        token,

        expiresAt:
            session.expiresAt,

        refreshMs:
            Number(
                process.env.QR_REFRESH_MS
            ) || 3000
    };
};


/*
==================================================
END ATTENDANCE SESSION
==================================================
*/

exports.endSession = async ({
    sessionId,
    lecturerId
}) => {

    const dbSession =
        await mongoose.startSession();

    try {

        let endedSession;

        await dbSession.withTransaction(
            async () => {

                const session =
                    await AttendanceSession
                        .findOneAndUpdate(
                            {
                                sessionId,
                                lecturerId,
                                status: "ACTIVE"
                            },
                            {
                                $set: {
                                    status:
                                        "ENDED",

                                    endedAt:
                                        new Date()
                                },

                                $inc: {
                                    version: 1
                                }
                            },
                            {
                                returnDocument: "after",
                                session:
                                    dbSession
                            }
                        );

                if (!session) {

                    const existing =
                        await AttendanceSession
                            .findOne({
                                sessionId,
                                lecturerId
                            })
                            .session(dbSession);

                    if (!existing) {

                        throw new AppError(
                            "Attendance session not found",
                            404
                        );
                    }

                    if (
                        existing.status ===
                        "ENDED"
                    ) {
                        endedSession =
                            existing;

                        return;
                    }

                    throw new AppError(
                        "Attendance session cannot be ended",
                        409
                    );
                }

                endedSession =
                    session;

                // Freeze every student who did not check in as absent when the session ends.
                await AttendanceSessionStudent.updateMany(
                    {
                        sessionId: session._id,
                        status: { $in: ["ELIGIBLE", "LATE"] }
                    },
                    { $set: { status: "ABSENT" } },
                    { session: dbSession }
                );

                await AuditEvent.create(
                    [
                        {
                            event:
                                "ATTENDANCE_SESSION_ENDED",

                            userId:
                                lecturerId,

                            sessionId:
                                session._id,

                            metadata: {
                                publicSessionId:
                                    session.sessionId
                            }
                        }
                    ],
                    {
                        session:
                            dbSession
                    }
                );
            }
        );

        emitSessionEnded({
            sessionId:
                endedSession.sessionId,

            endedAt:
                endedSession.endedAt
        });

        return endedSession;

    } finally {

        await dbSession.endSession();
    }
};


/*
==================================================
VERIFY ATTENDANCE
==================================================
*/

exports.prepareAttendanceCheckin = async ({ studentId, token, expectedSessionId }) => {
    if (!token || typeof token !== "string") {
        throw new AppError("Scan the lecturer's current QR code first", 400);
    }

    const tokenResult = verifyAttendanceToken(token);
    if (!tokenResult.valid) {
        throw new AppError("This QR is invalid. Scan the current QR shown by your lecturer.", 401);
    }

    const { sid, slot, nonce } = tokenResult.payload;
    if (expectedSessionId && String(sid) !== String(expectedSessionId)) {
        throw new AppError("This QR belongs to a different session. Select the matching active class and scan again.", 409);
    }
    if (!isSlotFresh(slot)) {
        throw new AppError("This QR has expired. Scan the lecturer's current QR again.", 401);
    }

    const session = await AttendanceSession.findOne({ sessionId: sid });
    if (!session) {
        throw new AppError("Attendance session not found", 404);
    }
    if (session.status !== "ACTIVE") {
        throw new AppError("This attendance session has ended", 409);
    }
    if (Date.now() >= new Date(session.expiresAt).getTime()) {
        await expireExpiredSessions({ sessionId: session.sessionId });
        throw new AppError("Attendance session has expired", 409);
    }

    // A scanned string is not enough: confirm its nonce against Redis while
    // the QR slot is fresh, before allowing the face/liveness interaction.
    const challengeValid = await verifyChallenge({ sessionId: sid, slot, nonce });
    if (!challengeValid) {
        throw new AppError("This QR challenge has expired. Scan a fresh QR.", 401);
    }

    const rosterEntry = await AttendanceSessionStudent.findOne({
        sessionId: session._id,
        studentId
    });

    if (!rosterEntry) {
        throw new AppError("You are not enrolled in this attendance session", 403);
    }
    if (rosterEntry.status === "PRESENT") {
        throw new AppError("Attendance has already been marked for this session", 409);
    }
    if (!["ELIGIBLE", "LATE"].includes(rosterEntry.status)) {
        throw new AppError("You are not eligible to check in to this session", 403);
    }

    const checkinIntentId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + CHECKIN_INTENT_TTL_MS);
    const intent = {
        studentId: String(studentId),
        sessionId: session.sessionId,
        token,
        slot,
        nonce,
        createdAt: Date.now()
    };
    const saved = await redisClient.set(
        checkinIntentKey(checkinIntentId),
        JSON.stringify(intent),
        { NX: true, PX: CHECKIN_INTENT_TTL_MS }
    );
    if (saved !== "OK") {
        throw new AppError("Could not prepare check-in. Scan the QR again.", 503);
    }

    return {
        checkinIntentId,
        sessionId: session.sessionId,
        courseCode: session.courseCode,
        section: session.section,
        expiresAt,
        expiresInMs: CHECKIN_INTENT_TTL_MS
    };
};


exports.verifyAttendance = async ({
    studentId,
    checkinIntentId,
    biometricAssertionId,
    latitude,
    longitude,
    accuracyMeters,
    capturedAt,
    idempotencyKey,
    ipAddress,
    userAgent
}) => {
    if (!idempotencyKey) {
        throw new AppError("Idempotency-Key header is required", 400);
    }
    if (!checkinIntentId || typeof checkinIntentId !== "string") {
        throw new AppError("Scan and validate the lecturer's QR before checking in", 400);
    }

    const rawIntent = await redisClient.get(checkinIntentKey(checkinIntentId));
    if (!rawIntent) {
        throw new AppError("This QR check-in expired. Scan a fresh QR and try again.", 410);
    }

    let intent;
    try {
        intent = JSON.parse(rawIntent);
    } catch {
        throw new AppError("This QR check-in is invalid. Scan the QR again.", 401);
    }
    if (String(intent.studentId) !== String(studentId)) {
        throw new AppError("This QR check-in belongs to another student", 403);
    }

    const token = intent.token;
    const tokenResult = verifyAttendanceToken(token);
    if (
        !tokenResult.valid ||
        tokenResult.payload.sid !== intent.sessionId ||
        tokenResult.payload.slot !== intent.slot ||
        tokenResult.payload.nonce !== intent.nonce
    ) {
        throw new AppError("The validated QR could not be verified. Scan it again.", 401);
    }

    const { sid, slot } = tokenResult.payload;
    const session = await AttendanceSession.findOne({ sessionId: sid });
    if (!session) {
        throw new AppError("Attendance session not found", 404);
    }

    // Build a fingerprint of the complete attendance request.
    const idempotencyRequest = {
        key: idempotencyKey,
        studentId,
        sessionId: session._id,
        token,
        deviceId: null,
        deviceSignature: null,
        biometricAssertionId,
        latitude,
        longitude,
        accuracyMeters,
        capturedAt
    };

    // A completed retry must be handled before checking whether
    // the QR expired, the session ended, or the roster says PRESENT.
    const previousResult = await getIdempotencyResult(
        idempotencyRequest
    );

    if (previousResult?.replayed) {
        return {
            replayed: true,
            status: previousResult.responseStatus,
            body: previousResult.responseBody
        };
    }

    // QR signature, slot freshness, and Redis nonce were verified when the
    // short-lived intent was created. Face/liveness is allowed to outlast a QR
    // refresh interval, but the intent itself expires in Redis.

    /*
    --------------------------------------------------
    5. VERIFY SESSION STATUS
    --------------------------------------------------
    */

    if (
        session.status !==
        "ACTIVE"
    ) {

        throw new AppError(
            "Attendance session is not active",
            400
        );
    }


    if (Date.now() >= new Date(session.expiresAt).getTime()) {
        await expireExpiredSessions({ sessionId: session.sessionId });
        throw new AppError("Attendance session expired", 400);
    }


    // No browser-device registration or client-held signing key is required.
    // Attendance remains bound to the authenticated student, server-validated
    // QR intent, fresh biometric assertion, and server-checked classroom location.
    const studentLatitude = Number(latitude);
    const studentLongitude = Number(longitude);
    const studentAccuracy = Number(accuracyMeters);
    const gpsCapturedAt = new Date(capturedAt);

    if (
        !Number.isFinite(studentLatitude) ||
        !Number.isFinite(studentLongitude) ||
        !Number.isFinite(studentAccuracy) ||
        Number.isNaN(gpsCapturedAt.getTime())
    ) {
        throw new AppError("Valid GPS data is required", 400);
    }

    const now = Date.now();
    const maxGpsAccuracy = Number(process.env.ATTENDANCE_MAX_GPS_ACCURACY_METERS) || 150;
    const maxGpsAgeMs = Number(process.env.ATTENDANCE_MAX_GPS_AGE_MS) || 120000;
    const gpsAgeMs = now - gpsCapturedAt.getTime();
    if (
        studentAccuracy > maxGpsAccuracy ||
        gpsAgeMs > maxGpsAgeMs ||
        gpsAgeMs < -30000
    ) {
        await AttendanceAttempt.create({
            sessionId: session._id,
            studentId,
            result: "GPS_UNRELIABLE",
            ipAddress,
            userAgent
        });
        throw new AppError(
            "Location is too imprecise or out of date. Enable precise location and try again.",
            422
        );
    }

    const classroom = session.classroomSnapshot;
    const distance = distanceMeters({
        latitude1: studentLatitude,
        longitude1: studentLongitude,
        latitude2: classroom.latitude,
        longitude2: classroom.longitude
    });

    const allowedDistance = classroom.geofenceRadiusMeters + studentAccuracy;
    if (distance > allowedDistance) {
        await AttendanceAttempt.create({
            sessionId: session._id,
            studentId,
            result: "GPS_OUTSIDE_GEOFENCE",
            ipAddress,
            userAgent
        });
        throw new AppError("Student location is outside the attendance area", 403);
    }


    /*
    --------------------------------------------------
    6. VERIFY REDIS QR CHALLENGE
    --------------------------------------------------
    */

    // The nonce was verified against Redis by /preflight while the QR was
    // fresh. Do not re-require the rotating QR nonce after face/liveness.

    /*
    --------------------------------------------------
    7. VERIFY SESSION ROSTER
    --------------------------------------------------
    */

    const rosterEntry =
        await AttendanceSessionStudent.findOne({
            sessionId:
                session._id,

            studentId
        });


    /*
    --------------------------------------------------
    STUDENT NOT IN FROZEN ROSTER
    --------------------------------------------------
    */

    if (!rosterEntry) {

        await AttendanceAttempt.create({
            sessionId:
                session._id,

            studentId,

            result:
                "NOT_ELIGIBLE",

            ipAddress,

            userAgent
        });

        throw new AppError(
            "You are not eligible for this attendance session",
            403
        );
    }


    /*
    --------------------------------------------------
    ALREADY PRESENT
    --------------------------------------------------
    */

    if (
        rosterEntry.status ===
        "PRESENT"
    ) {

        await AttendanceAttempt.create({
            sessionId:
                session._id,

            studentId,

            result:
                "ALREADY_MARKED",

            ipAddress,

            userAgent
        });

        throw new AppError(
            "Attendance has already been marked",
            409
        );
    }


    /*
    --------------------------------------------------
    ONLY ELIGIBLE / LATE CAN CONTINUE
    --------------------------------------------------
    */

    if (
        ![
            "ELIGIBLE",
            "LATE"
        ].includes(
            rosterEntry.status
        )
    ) {

        throw new AppError(
            "Student cannot mark attendance in the current state",
            403
        );
    }


    // Check the assertion before claiming idempotency; consume it only after a replay check.
    await validateBiometricAssertion({
        assertionId: biometricAssertionId,
        userId: studentId,
        sessionId: session.sessionId
    });


    /*
    --------------------------------------------------
    10. ATOMIC IDEMPOTENCY CLAIM
    --------------------------------------------------
    */

    const idempotencyResult = await claimIdempotency(
        idempotencyRequest
    );

    if (idempotencyResult.replayed) {
        return {
            replayed: true,
            status: idempotencyResult.responseStatus,
            body: idempotencyResult.responseBody
        };
    }

    const { ownerToken } = idempotencyResult;

    const assertionReservation = {
        assertionId: biometricAssertionId,
        userId: studentId,
        sessionId: session.sessionId,
        reservationId: idempotencyKey
    };

    const releaseReservedAssertion = async () => {
        try {
            await releaseAssertionReservation(
                assertionReservation
            );
        } catch (error) {
            console.error(
                "Failed to release biometric assertion reservation:",
                error
            );
        }
    };

    try {
        await reserveAssertion(assertionReservation);
    } catch (error) {
        await releaseIdempotency({
            key: idempotencyKey,
            ownerToken
        }).catch((cleanupError) => {
            console.error(
                "Failed to release idempotency claim:",
                cleanupError
            );
        });

        throw error;
    }


    /*
    --------------------------------------------------
    11. QR REPLAY CLAIM
    --------------------------------------------------
    */

    let qrUse;
    try {
        qrUse = await claimQrUse({
            sessionId:
                session._id.toString(),

            studentId:
                studentId.toString(),

            slot,

            nonce:
                tokenResult.payload.nonce
        });
    } catch (error) {
        await releaseReservedAssertion();
        await releaseIdempotency({ key: idempotencyKey, ownerToken });
        throw error;
    }


    /*
    --------------------------------------------------
    QR ALREADY CONSUMED
    --------------------------------------------------
    */

    if (
        qrUse.status ===
        "CONSUMED"
    ) {

        const response = {
            success:
                false,

            error: {
                code:
                    "QR_REPLAYED",

                message:
                    "This attendance QR has already been used"
            }
        };

        await releaseReservedAssertion();

        await completeIdempotency({
            key:
                idempotencyKey,

            ownerToken,

            responseStatus:
                409,

            responseBody:
                response
        });


        return {
            replayed:
                true,

            status:
                409,

            body:
                response
        };
    }

    /*
    --------------------------------------------------
    QR ALREADY PROCESSING
    --------------------------------------------------
    */

    if (
        qrUse.status ===
        "PROCESSING"
    ) {

        const response = {
            success:
                false,

            error: {
                code:
                    "QR_ALREADY_PROCESSING",

                message:
                    "This attendance QR verification is already being processed"
            }
        };


        await releaseReservedAssertion();

        await completeIdempotency({
            key:
                idempotencyKey,

            ownerToken,

            responseStatus:
                409,

            responseBody:
                response
        });


        return {
            replayed:
                true,

            status:
                409,

            body:
                response
        };
    }


    /*
    --------------------------------------------------
    11. ATOMIC ATTENDANCE TRANSACTION
    --------------------------------------------------

    The following operations are committed
    together or rolled back together:

        AttendanceRecord
        AttendanceSessionStudent
        AttendanceAttempt
        AuditEvent
    --------------------------------------------------
    */

    const dbSession =
        await mongoose.startSession();

    let attendanceRecord;

    let attendanceCreated =
        false;

    let attendanceResponse;
    let attendanceResponseStatus;

    try {

        await dbSession.withTransaction(
            async () => {

                /*
                ------------------------------------------
                11.1 CREATE / GET ATTENDANCE RECORD
                ------------------------------------------
                */

                const attendanceResult =
                    await createOrGetAttendanceRecord({
                        sessionId:
                            session._id,

                        studentId,

                        courseCode:
                            session.courseCode,

                        section:
                            session.section,

                        verification: {
                            qr: true,
                            device: false,
                            proximity: false,
                            biometric: true
                        },

                        gps: {
                            latitude:
                                studentLatitude,

                            longitude:
                                studentLongitude,

                            accuracyMeters:
                                studentAccuracy,

                            capturedAt:
                                gpsCapturedAt,

                            distanceFromClassroomMeters:
                                distance
                        },

                        dbSession
                    });


                attendanceRecord =
                    attendanceResult.record;

                attendanceCreated =
                    attendanceResult.created;


                /*
                ------------------------------------------
                11.2 UPDATE SESSION ROSTER
                ------------------------------------------
                */

                const rosterUpdate =
                    await AttendanceSessionStudent
                        .findOneAndUpdate(
                            {
                                sessionId:
                                    session._id,

                                studentId,

                                status: {
                                    $in: [
                                        "ELIGIBLE",
                                        "LATE"
                                    ]
                                }
                            },
                            {
                                $set: {
                                    status:
                                        "PRESENT"
                                }
                            },
                            {
    returnDocument: "after",
    session: dbSession
}
                        );


                /*
                ------------------------------------------
                If another concurrent request changed
                the roster first, do not silently report
                successful attendance.
                ------------------------------------------
                */

                if (!rosterUpdate) {

                    throw new AppError(
                        "Attendance state changed during verification",
                        409
                    );
                }


                /*
                ------------------------------------------
                11.3 ATTEMPT LOG
                ------------------------------------------
                */

                await AttendanceAttempt.create(
                    [
                        {
                            sessionId:
                                session._id,

                            studentId,

                            result:
                                attendanceCreated
                                    ? "SUCCESS"
                                    : "ALREADY_MARKED",

                            ipAddress,

                            userAgent
                        }
                    ],
                    {
                        session:
                            dbSession
                    }
                );


                /*
                ------------------------------------------
                11.4 AUDIT LOG
                ------------------------------------------
                */

                await AuditEvent.create(
                    [
                        {
                            event:
                                attendanceCreated
                                    ? "ATTENDANCE_MARKED"
                                    : "ATTENDANCE_ALREADY_MARKED",

                            userId:
                                studentId,

                            sessionId:
                                session._id,

                            metadata: {
                                attendanceId:
                                    attendanceRecord._id
                            }
                        }
                    ],
                    {
                        session:
                            dbSession
                    }
                );

                attendanceResponse = attendanceCreated
                    ? {
                        success: true,
                        message: "Attendance marked successfully",
                        attendanceId: attendanceRecord._id,
                        alreadyMarked: false
                    }
                    : {
                        success: true,
                        message: "Attendance already marked",
                        attendanceId: attendanceRecord._id,
                        alreadyMarked: true
                    };

                attendanceResponseStatus = attendanceCreated ? 201 : 200;

                await completeIdempotency({
                    key: idempotencyKey,
                    ownerToken,
                    responseStatus: attendanceResponseStatus,
                    responseBody: attendanceResponse,
                    dbSession
                });
            }
        );


    } catch (error) {

        await releaseReservedAssertion();

        /*
        --------------------------------------------------
        TRANSACTION FAILED
        --------------------------------------------------

        Release the QR claim so another valid retry
        can process the attendance.
        */

        await releaseQrUse({
            key:
                qrUse.key,

            ownerToken:
                qrUse.ownerToken
        }).catch(
            (releaseError) => {

                console.error(
                    "Failed to release QR claim:",
                    releaseError
                );
            }
        );

        await releaseIdempotency({
            key: idempotencyKey,
            ownerToken
        }).catch((cleanupError) => {
            console.error(
                "Failed to release idempotency claim after transaction failure:",
                cleanupError
            );
        });

        throw error;


    } finally {

        await dbSession.endSession();
    }


    /*
     * The MongoDB transaction has committed at this point.
     * Do not undo committed attendance if Redis cleanup fails.
     */

    // Consume the biometric assertion after the successful commit.
    try {
        const finalized = await finalizeAssertionReservation({
            assertionId: biometricAssertionId,
            reservationId: idempotencyKey
        });

        if (!finalized) {
            console.error(
                "Attendance committed, but biometric assertion finalization was not confirmed",
                { idempotencyKey }
            );
        }
    } catch (error) {
        console.error(
            "Attendance committed, but biometric assertion cleanup failed:",
            error
        );
    }

    // The QR claim is also external to MongoDB. Fail closed if cleanup fails,
    // while preserving the committed response for an idempotent retry.
    try {
        await completeQrUse({
            key: qrUse.key,
            ownerToken: qrUse.ownerToken
        });
    } catch (error) {
        console.error(
            "Attendance committed, but QR claim finalization failed:",
            error
        );
    }

    if (attendanceCreated) {
        emitAttendanceMarked({
            sessionId: session.sessionId,
            attendanceId: String(attendanceRecord._id),
            rollNumber: rosterEntry.rollNumber,
            markedAt: attendanceRecord.markedAt,
            alreadyMarked: false
        });
    }

    return attendanceResponse;
};