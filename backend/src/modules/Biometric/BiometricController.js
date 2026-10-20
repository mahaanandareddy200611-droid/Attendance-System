const asyncHandler =
    require("../../middlewares/asyncHandler");

const AppError =
    require("../../utils/AppError");

const biometricService =
    require("./BiometricService");

exports.getMyEnrollment = asyncHandler(async (req, res) => {
    const enrollment = await biometricService.getMyEnrollment({ userId: req.user.id });
    return res.status(200).json({ success: true, data: enrollment });
});


exports.enroll =
    asyncHandler(
        async (req, res) => {

            if (!req.file) {

                throw new AppError(
                    "Enrollment image is required",
                    400
                );
            }


            const enrollment =
                await biometricService.enroll({
                    userId:
                        req.user.id,

                    imageBuffer:
                        req.file.buffer,

                    mimeType:
                        req.file.mimetype
                });


            return res.status(201).json({
                success: true,

                message:
                    "Biometric enrollment completed",

                data: {
                    status:
                        enrollment.status,

                    enrolledAt:
                        enrollment.enrolledAt
                },

                requestId:
                    req.id
            });
        }
    );


exports.createChallenge =
    asyncHandler(
        async (req, res) => {

            const {
                sessionId
            } = req.body;


            if (!sessionId) {

                throw new AppError(
                    "sessionId is required",
                    400
                );
            }


            const result =
                await biometricService
                    .createChallenge({
                        userId:
                            req.user.id,

                        sessionId
                    });


            return res.status(200).json({
                success: true,

                data:
                    result,

                requestId:
                    req.id
            });
        }
    );


exports.verify =
    asyncHandler(
        async (req, res) => {

            if (!req.file) {

                throw new AppError(
                    "Verification image is required",
                    400
                );
            }


            const {
                sessionId,
                challengeId,
                challenge
            } = req.body;


            const result =
                await biometricService.verify({
                    userId:
                        req.user.id,

                    sessionId,

                    challengeId,
                    challenge,
                    imageBuffer:
                        req.file.buffer,

                    mimeType:
                        req.file.mimetype
                });


            return res.status(200).json({
    success: true,

    data: {
        verified:
            result.verified,

        livenessPassed:
            result.livenessPassed,

        faceMatchPassed:
            result.faceMatchPassed,

        similarity:
            result.similarity,

        verificationId:
            result.verificationId,

        assertionId:
            result.assertionId
    },

    requestId:
        req.id
});
        }
    );


exports.createActiveChallenge = asyncHandler(async (req, res) => {
    const result = await biometricService.createActiveChallenge({ userId: req.user.id, sessionId: req.body.sessionId });
    return res.status(200).json({ success: true, data: result, requestId: req.id });
});

exports.verifyActiveSequence = asyncHandler(async (req, res) => {
    if (!Array.isArray(req.files) || req.files.length !== 3) throw new AppError('Exactly three liveness frames are required', 400);
    const { sessionId, challengeId, challenge } = req.body;
    const result = await biometricService.verifyActiveSequence({
        userId: req.user.id,
        sessionId,
        challengeId,
        challenge,
        frames: req.files.map((file) => ({ imageBuffer: file.buffer, mimeType: file.mimetype }))
    });
    return res.status(200).json({ success: true, data: result, requestId: req.id });
});


exports.revokeMyEnrollment = asyncHandler(async (req, res) => {
    const result = await biometricService.revokeEnrollment({ userId: req.user.id });
    return res.status(200).json({
        success: true,
        message: result.status === "REVOKED" ? "Biometric enrollment deleted or already absent" : "Biometric deletion pending",
        data: result,
        requestId: req.id
    });
});
