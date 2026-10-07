const crypto =
    require("crypto");

const DeviceCredential =
    require("../../models/DeviceCredential.model");

const User =
    require("../../models/Auth.model");

const {
    redisClient
} = require("../../config/redis");

const AppError =
    require("../../utils/AppError");


const REGISTRATION_TTL_MS =
    Number(
        process.env
            .DEVICE_REGISTRATION_CHALLENGE_TTL_MS
    ) || 120000;


/*
--------------------------------------------------
REDIS KEY
--------------------------------------------------
*/

const registrationKey =
    (challengeId) =>
        `device:registration:${challengeId}`;


/*
--------------------------------------------------
ISSUE REGISTRATION CHALLENGE
--------------------------------------------------
*/

exports.issueRegistrationChallenge =
    async ({
        userId
    }) => {

        const user =
            await User.findOne({
                _id: userId,
                role: "Student",
                status: "ACTIVE"
            });

        if (!user) {
            throw new AppError(
                "Active student not found",
                404
            );
        }


        const existingDevice =
            await DeviceCredential.findOne({
                userId,
                status: "ACTIVE"
            });

        if (existingDevice) {

            throw new AppError(
                "Student already has an active device",
                409
            );
        }


        const challengeId =
            crypto.randomUUID();


        const challenge =
            crypto
                .randomBytes(32)
                .toString("base64url");


        await redisClient.set(
            registrationKey(
                challengeId
            ),
            JSON.stringify({
                userId:
                    String(userId),

                challenge
            }),
            {
                NX: true,

                PX:
                    REGISTRATION_TTL_MS
            }
        );


        return {
            challengeId,

            challenge,

            expiresInMs:
                REGISTRATION_TTL_MS
        };
    };


/*
--------------------------------------------------
REGISTER DEVICE
--------------------------------------------------
*/

exports.registerDevice =
    async ({
        userId,
        challengeId,
        deviceId,
        publicKey,
        signature
    }) => {

        if (
            !deviceId ||
            typeof deviceId !== "string"
        ) {
            throw new AppError(
                "deviceId is required",
                400
            );
        }


        if (
            !publicKey ||
            typeof publicKey !== "string"
        ) {
            throw new AppError(
                "publicKey is required",
                400
            );
        }


        if (
            !signature ||
            typeof signature !== "string"
        ) {
            throw new AppError(
                "signature is required",
                400
            );
        }


        const challengeData =
            await redisClient.get(
                registrationKey(
                    challengeId
                )
            );


        if (!challengeData) {

            throw new AppError(
                "Device registration challenge expired or invalid",
                401
            );
        }


        let challenge;

        try {

            challenge =
                JSON.parse(
                    challengeData
                );

        } catch {

            throw new AppError(
                "Invalid device registration challenge",
                500
            );
        }


        if (
            String(
                challenge.userId
            ) !== String(userId)
        ) {
            throw new AppError(
                "Device registration challenge does not belong to this user",
                403
            );
        }


        /*
        --------------------------------------------------
        VERIFY PUBLIC KEY
        --------------------------------------------------
        */

        let publicKeyObject;

        try {

            publicKeyObject =
                crypto.createPublicKey(
                    publicKey
                );

        } catch {

            throw new AppError(
                "Invalid public key",
                400
            );
        }


        if (
            publicKeyObject.asymmetricKeyType !==
            "ed25519"
        ) {

            throw new AppError(
                "Only Ed25519 device keys are supported",
                400
            );
        }


        /*
        --------------------------------------------------
        VERIFY PROOF OF PRIVATE KEY
        --------------------------------------------------
        */

        let receivedSignature;

        try {

            receivedSignature =
                Buffer.from(
                    signature,
                    "base64url"
                );

        } catch {

            throw new AppError(
                "Invalid device signature",
                400
            );
        }


        const validSignature =
            crypto.verify(
                null,

                Buffer.from(
                    challenge.challenge,
                    "utf8"
                ),

                publicKeyObject,

                receivedSignature
            );


        if (!validSignature) {

            throw new AppError(
                "Device proof verification failed",
                401
            );
        }


        /*
        --------------------------------------------------
        ATOMIC CHALLENGE CONSUMPTION
        --------------------------------------------------
        */

        const deleteScript = `
            local value =
                redis.call(
                    "GET",
                    KEYS[1]
                )

            if value == ARGV[1] then
                return redis.call(
                    "DEL",
                    KEYS[1]
                )
            end

            return 0
        `;


        const deleted =
            await redisClient.eval(
                deleteScript,
                {
                    keys: [
                        registrationKey(
                            challengeId
                        )
                    ],

                    arguments: [
                        challengeData
                    ]
                }
            );


        if (
            Number(deleted) !== 1
        ) {

            throw new AppError(
                "Device registration challenge was already used",
                409
            );
        }


        /*
        --------------------------------------------------
        CHECK ACTIVE DEVICE AGAIN
        --------------------------------------------------
        */

        const existingDevice =
            await DeviceCredential.findOne({
                userId,
                status: "ACTIVE"
            });


        if (existingDevice) {

            throw new AppError(
                "Student already has an active device",
                409
            );
        }


        /*
        --------------------------------------------------
        CREATE DEVICE
        --------------------------------------------------
        */

        try {

            const device =
                await DeviceCredential.create({
                    userId,

                    deviceId,

                    algorithm:
                        "Ed25519",

                    publicKey,

                    status:
                        "ACTIVE"
                });


            return device;

        } catch (error) {

            if (
                error.code === 11000
            ) {

                throw new AppError(
                    "Device is already registered",
                    409
                );
            }

            throw error;
        }
    };


/*
--------------------------------------------------
VERIFY ATTENDANCE DEVICE SIGNATURE
--------------------------------------------------
*/

exports.verifyAttendanceDevice =
    async ({
        userId,
        deviceId,
        signature,
        sessionId,
        token,
        idempotencyKey
    }) => {

        const device =
            await DeviceCredential.findOne({
                userId,
                deviceId,
                status: "ACTIVE"
            });


        if (!device) {

            throw new AppError(
                "Active device not found",
                401
            );
        }


        const message =
            [
                "ATTENDANCE_V1",
                sessionId,
                token,
                idempotencyKey
            ].join("|");


        let receivedSignature;

        try {

            receivedSignature =
                Buffer.from(
                    signature,
                    "base64url"
                );

        } catch {

            throw new AppError(
                "Invalid device signature",
                401
            );
        }


        let publicKeyObject;

        try {

            publicKeyObject =
                crypto.createPublicKey(
                    device.publicKey
                );

        } catch {

            throw new AppError(
                "Stored device key is invalid",
                500
            );
        }


        const valid =
            crypto.verify(
                null,

                Buffer.from(
                    message,
                    "utf8"
                ),

                publicKeyObject,

                receivedSignature
            );


        if (!valid) {

            throw new AppError(
                "Device signature verification failed",
                401
            );
        }


        /*
        * Best-effort usage timestamp.
        *
        * Attendance correctness does not depend
        * on this update.
        */
        await DeviceCredential.updateOne(
            {
                _id:
                    device._id,

                status:
                    "ACTIVE"
            },
            {
                $set: {
                    lastUsedAt:
                        new Date()
                }
            }
        );


        return {
            verified: true,

            deviceId:
                device.deviceId
        };
    };