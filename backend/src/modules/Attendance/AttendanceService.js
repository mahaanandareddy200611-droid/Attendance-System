const crypto = require("crypto");

const mongoose =
    require("mongoose");

const ClassSection =
    require("../../models/ClassSection.model");

const {
    verify:
        verifyBiometric
} = require("../Biometric/BiometricService");

const Enrollment =
    require("../../models/Enrollment.model");

const AttendanceSessionStudent =
    require("../../models/AttendanceSessionStudent.model");

const AttendanceSession =
    require("../../models/AttendanceSession.model");

const {
    verifyAttendanceDevice
} = require("../Device/DeviceService");

const {
    createOrGetAttendanceRecord
} = require("./AttendanceRecordService");

const {
    consumeAssertion:
        consumeBiometricAssertion
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

const {
    claimIdempotency,
    completeIdempotency
} = require("./IdempotencyService");

const AuditEvent =
    require("../../models/AuditEvent.model");

const AppError =
    require("../../utils/AppError");

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



const classroom =
    session.classroomSnapshot;

const distance =
    distanceMeters({
        latitude1:
            studentLatitude,

        longitude1:
            studentLongitude,

        latitude2:
            classroom.latitude,

        longitude2:
            classroom.longitude
    });


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

                const section =
                    await ClassSection
                        .findOne({
                            _id: sectionId,
                            status: "ACTIVE"
                        })
                        .populate(
                            "courseId",
                            "code name"
                        )
                        .session(dbSession);

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

                await AttendanceSession.updateMany(
                    {
                        sectionId,
                        status: "ACTIVE",
                        expiresAt: {
                            $lte: now
                        }
                    },
                    {
                        $set: {
                            status: "EXPIRED",
                            endedAt: now
                        },
                        $inc: {
                            version: 1
                        }
                    }
                ).session(dbSession);


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


    if (
        new Date() >
        session.expiresAt
    ) {

        session.status =
            "EXPIRED";

        session.endedAt =
            new Date();

        await session.save();

        throw new AppError(
            "Attendance session expired",
            400
        );
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
            ) || 250
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
                                new: true,
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

exports.verifyAttendance = async ({
    studentId,
    token,
    deviceId,
    deviceSignature,
    biometricAssertionId,
    idempotencyKey,
    ipAddress,
    userAgent
}) => {

    /*
    --------------------------------------------------
    1. VALIDATE REQUIRED INPUT
    --------------------------------------------------
    */

    if (!token) {
        throw new AppError(
            "Attendance token is required",
            400
        );
    }

    if (!idempotencyKey) {
        throw new AppError(
            "Idempotency-Key header is required",
            400
        );
    }


    /*
    --------------------------------------------------
    2. VERIFY QR SIGNATURE
    --------------------------------------------------
    */

    const tokenResult =
        verifyAttendanceToken(token);

    if (!tokenResult.valid) {

        await AttendanceAttempt.create({
            studentId,

            result:
                "INVALID_TOKEN",

            ipAddress,

            userAgent
        });

        throw new AppError(
            "Invalid attendance token",
            401
        );
    }

    const {
        sid,
        slot
    } = tokenResult.payload;


    /*
    --------------------------------------------------
    3. VERIFY TIME SLOT
    --------------------------------------------------
    */

    if (!isSlotFresh(slot)) {

        throw new AppError(
            "Attendance QR has expired",
            401
        );
    }


    /*
    --------------------------------------------------
    4. FIND SESSION
    --------------------------------------------------
    */

    const session =
        await AttendanceSession.findOne({
            sessionId: sid
        });

    if (!session) {

        throw new AppError(
            "Attendance session not found",
            404
        );
    }


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


    if (
        new Date() >
        session.expiresAt
    ) {

        session.status =
            "EXPIRED";

        session.endedAt =
            new Date();

        await session.save();

        throw new AppError(
            "Attendance session expired",
            400
        );
    }


    const studentLatitude =
    Number(latitude);

const studentLongitude =
    Number(longitude);

const studentAccuracy =
    Number(accuracyMeters);

const gpsCapturedAt =
    new Date(capturedAt);

if (
    !Number.isFinite(studentLatitude) ||
    !Number.isFinite(studentLongitude) ||
    !Number.isFinite(studentAccuracy) ||
    Number.isNaN(
        gpsCapturedAt.getTime()
    )
) {
    throw new AppError(
        "Valid GPS data is required",
        400
    );
}   
        const allowedDistance =
    classroom.geofenceRadiusMeters +
    studentAccuracy;

if (
    distance >
    allowedDistance
) {

    await AttendanceAttempt.create({
        sessionId: session._id,
        studentId,
        result:
            "GPS_OUTSIDE_GEOFENCE",
        ipAddress,
        userAgent
    });

    throw new AppError(
        "Student location is outside the attendance area",
        403
    );
}


    /*
    --------------------------------------------------
    6. VERIFY REDIS QR CHALLENGE
    --------------------------------------------------
    */

    const challengeValid =
        await verifyChallenge({
            sessionId:
                session.sessionId,

            slot,

            nonce:
                tokenResult.payload.nonce
        });


    if (!challengeValid) {

        throw new AppError(
            "Attendance QR challenge is invalid or expired",
            401
        );
    }


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

    /*
    --------------------------------------------------
    9. ATOMIC IDEMPOTENCY CLAIM
    --------------------------------------------------
    */

    const idempotencyResult =
        await claimIdempotency({
            key:
                idempotencyKey,

            studentId,

            sessionId:
                session._id,

            token,
            deviceId
        });


    if (
        idempotencyResult.replayed
    ) {

        return {
            replayed:
                true,

            status:
                idempotencyResult
                    .responseStatus,

            body:
                idempotencyResult
                    .responseBody
        };
    }

    

    


    const {
        ownerToken
    } = idempotencyResult;



    /*
--------------------------------------------------
BIOMETRIC ASSERTION
--------------------------------------------------
*/

const biometricAssertion =
    await consumeBiometricAssertion({
        assertionId:
            biometricAssertionId,

        userId:
            studentId,

        sessionId:
            session.sessionId
    });
    /*
    --------------------------------------------------
    8. DEVICE CRYPTOGRAPHIC VERIFICATION
    --------------------------------------------------
    */

    if (
        !deviceId ||
        !deviceSignature
    ) {

        throw new AppError(
            "Registered device proof is required",
            401
        );
    }


    await verifyAttendanceDevice({
        userId:
            studentId,

        deviceId,

        signature:
            deviceSignature,

        sessionId:
            session.sessionId,

        token,

        idempotencyKey
    });


    

    /*
    --------------------------------------------------
    10. QR REPLAY CLAIM
    --------------------------------------------------
    */

    const qrUse =
        await claimQrUse({
            sessionId:
                session._id.toString(),

            studentId:
                studentId.toString(),

            slot,

            nonce:
                tokenResult.payload.nonce
        });


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

    try{    
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

     catch (error) {

    await completeIdempotency({
        key: idempotencyKey,
        ownerToken,

        responseStatus:
            error.statusCode || 401,

        responseBody: {
            success: false,
            error: {
                code:
                    "DEVICE_VERIFICATION_FAILED",
                message:
                    error.message
            }
        }
    });

    throw error;
}}

    /*
--------------------------------------------------
BIOMETRIC VERIFICATION
--------------------------------------------------
*/

if (
    !biometricChallengeId ||
    !biometricAssertion
) {

    throw new AppError(
        "Biometric verification is required",
        401
    );
}


const biometricResult =
    await verifyBiometric({
        userId:
            studentId,

        sessionId:
            session.sessionId,

        challengeId:
            biometricChallengeId,

        assertion:
            biometricAssertion
    });


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
            device: true,
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
                                new:
                                    true,

                                session:
                                    dbSession
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
            }
        );


    } catch (error) {

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

        throw error;


    } finally {

        await dbSession.endSession();
    }


    /*
    --------------------------------------------------
    12. COMPLETE IDEMPOTENCY RESPONSE
    --------------------------------------------------
    */

    if (!attendanceCreated) {

        const response = {
            success:
                true,

            message:
                "Attendance already marked",

            attendanceId:
                attendanceRecord._id,

            alreadyMarked:
                true
        };


        await completeIdempotency({
            key:
                idempotencyKey,

            ownerToken,

            responseStatus:
                200,

            responseBody:
                response
        });


        await completeQrUse({
            key:
                qrUse.key,

            ownerToken:
                qrUse.ownerToken
        });


        return response;
    }


    /*
    --------------------------------------------------
    13. SUCCESS RESPONSE
    --------------------------------------------------
    */

    const response = {
        success:
            true,

        message:
            "Attendance marked successfully",

        attendanceId:
            attendanceRecord._id,

        alreadyMarked:
            false
    };


    /*
    --------------------------------------------------
    14. COMPLETE IDEMPOTENCY RESPONSE
    --------------------------------------------------
    */

    await completeIdempotency({
        key:
            idempotencyKey,

        ownerToken,

        responseStatus:
            201,

        responseBody:
            response
    });


    /*
    --------------------------------------------------
    15. COMPLETE QR CLAIM
    --------------------------------------------------
    */

    await completeQrUse({
        key:
            qrUse.key,

        ownerToken:
            qrUse.ownerToken
    });

    emitAttendanceMarked({
    sessionId:
        session.sessionId,

    attendanceId:
        String(
            attendanceRecord._id
        ),

    rollNumber:
        rosterEntry.rollNumber,

    markedAt:
        attendanceRecord.markedAt,

    alreadyMarked:
        false
});


    return response;
};