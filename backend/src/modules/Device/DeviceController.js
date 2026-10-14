const asyncHandler =
    require("../../middlewares/asyncHandler");

const deviceService =
    require("./DeviceService");

exports.getMyDevice = asyncHandler(async (req, res) => {
    const device = await deviceService.getMyDevice({ userId: req.user.id });
    return res.status(200).json({ success: true, data: device });
});

exports.revokeMyDevice = asyncHandler(async (req, res) => {
    const device = await deviceService.revokeMyDevice({ userId: req.user.id });
    return res.status(200).json({
        success: true,
        message: device ? "Registered device revoked." : "No active device was registered.",
        data: device,
    });
});


exports.registrationChallenge =
    asyncHandler(
        async (req, res) => {

            const result =
                await deviceService
                    .issueRegistrationChallenge({
                        userId:
                            req.user.id
                    });


            return res.status(200).json({
                success: true,

                data: result
            });
        }
    );


exports.registerDevice =
    asyncHandler(
        async (req, res) => {

            const {
                challengeId,
                deviceId,
                publicKey,
                signature
            } = req.body;


            const device =
                await deviceService
                    .registerDevice({
                        userId:
                            req.user.id,

                        challengeId,

                        deviceId,

                        publicKey,

                        signature
                    });


            return res.status(201).json({
                success: true,

                message:
                    "Device registered successfully",

                data: {
                    deviceId:
                        device.deviceId,

                    algorithm:
                        device.algorithm,

                    status:
                        device.status
                }
            });
        }
    );
