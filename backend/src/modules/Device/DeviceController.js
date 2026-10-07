const asyncHandler =
    require("../../middlewares/asyncHandler");

const deviceService =
    require("./DeviceService");


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