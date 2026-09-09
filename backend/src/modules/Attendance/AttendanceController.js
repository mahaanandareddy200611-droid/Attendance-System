const asyncHandler =
    require("../../middlewares/asyncHandler");

const attendanceService =
    require("./AttendanceService");


exports.createSession =
    asyncHandler(async (req, res) => {

        const {
            courseCode,
            section
        } = req.body;

        const session =
            await attendanceService.createSession({
                lecturerId:
                    req.user.id,
                courseCode,
                section
            });

        res.status(201).json({
            success: true,
            message:
                "Attendance session created",
            data: {
                sessionId:
                    session.sessionId,
                courseCode:
                    session.courseCode,
                section:
                    session.section,
                status:
                    session.status,
                startedAt:
                    session.startedAt,
                expiresAt:
                    session.expiresAt
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
            token
        } = req.body;

        const idempotencyKey =
            req.get("Idempotency-Key");

        const result =
            await attendanceService
                .verifyAttendance({
                    studentId:
                        req.user.id,

                    token,

                    idempotencyKey,

                    ipAddress:
                        req.ip,

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