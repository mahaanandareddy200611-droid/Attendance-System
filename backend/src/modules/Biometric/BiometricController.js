const asyncHandler =
    require("../../middlewares/asyncHandler");

const AppError =
    require("../../utils/AppError");

const biometricService =
    require("./BiometricService");


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
                challengeId
            } = req.body;


            const result =
                await biometricService.verify({
                    userId:
                        req.user.id,

                    sessionId,

                    challengeId,

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