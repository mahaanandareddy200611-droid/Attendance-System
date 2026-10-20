const asyncHandler =
    require("../../middlewares/asyncHandler");

const attendanceService =
    require("./AttendanceService");
const attendanceQueryService = require("./AttendanceQueryService");

exports.listSessions = asyncHandler(async (req, res) => {
    const result = await attendanceQueryService.listSessions({
        userId: req.user.id,
        role: req.user.role,
        query: req.query
    });
    return res.status(200).json({ success: true, ...result });
});

exports.listAvailableStudentSessions = asyncHandler(async (req, res) => {
    const result = await attendanceQueryService.listAvailableStudentSessions({
        studentId: req.user.id
    });
    return res.status(200).json({ success: true, ...result });
});

exports.listSessionRecords = asyncHandler(async (req, res) => {
    const result = await attendanceQueryService.listSessionRecords({
        sessionId: req.params.sessionId,
        userId: req.user.id,
        role: req.user.role,
        query: req.query
    });
    return res.status(200).json({ success: true, ...result });
});

exports.listMyRecords = asyncHandler(async (req, res) => {
    const result = await attendanceQueryService.listStudentRecords({
        studentId: req.user.id,
        query: req.query
    });
    return res.status(200).json({ success: true, ...result });
});

exports.listAdminRecords = asyncHandler(async (req, res) => {
    const result = await attendanceQueryService.listAdminRecords({
        userId: req.user.id,
        role: req.user.role,
        query: req.query
    });
    return res.status(200).json({ success: true, ...result });
});

exports.createSession =
    asyncHandler(async (req, res) => {

        const {
            sectionId
        } = req.body;

        const session =
            await attendanceService
                .createSession({
                    lecturerId:
                        req.user.id,

                    sectionId
                });

        return res.status(201).json({
            success: true,
            message:
                "Attendance session created",

            data: {
                sessionId:
                    session.sessionId,

                sectionId:
                    session.sectionId,

                courseCode:
                    session.courseCode,

                section:
                    session.section,

                status:
                    session.status,

                startedAt:
                    session.startedAt,

                expiresAt:
                    session.expiresAt,

                eligibleStudentCount:
                    session.eligibleStudentCount
            }
        });
    });

exports.getQr =
    asyncHandler(async (req, res) => {

        const {
            sessionId
        } = req.params;

        const data =
            await attendanceService.getCurrentQr({
                sessionId,
                lecturerId:
                    req.user.id
            });

        res.status(200).json({
            success: true,
            data
        });
    });


exports.endSession =
    asyncHandler(async (req, res) => {

        const {
            sessionId
        } = req.params;

        const session =
            await attendanceService.endSession({
                sessionId,
                lecturerId:
                    req.user.id
            });

        res.status(200).json({
            success: true,
            message:
                "Attendance session ended",
            data: {
                sessionId:
                    session.sessionId,
                status:
                    session.status
            }
        });
    });


exports.verifyAttendance =
    asyncHandler(async (req, res) => {

        const {
    token,
    deviceId,
    deviceSignature,
    biometricAssertionId,
    latitude,
    longitude,
    accuracyMeters,
    capturedAt
} = req.body;

        const idempotencyKey =
            req.idempotencyKey || req.get("Idempotency-Key");

    const result =
        await attendanceService.verifyAttendance({
    studentId: req.user.id,

    token,

    deviceId,

    deviceSignature,

    biometricAssertionId,

    latitude,

    longitude,

    accuracyMeters,

    capturedAt,

    idempotencyKey,

    ipAddress: req.ip,

    userAgent:
        req.get("User-Agent")
});

        if (result.replayed) {

            return res.status(
                result.status
            ).json(
                result.body
            );
        }

        return res.status(201).json(
            result
        );
    });
