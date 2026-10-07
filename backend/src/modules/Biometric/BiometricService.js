const crypto =
    require("crypto");

const BiometricEnrollment =
    require("../../models/BiometricEnrollment.model");

const AppError =
    require("../../utils/AppError");

const {
    redisClient
} = require("../../config/redis");

const provider =
    require("./LocalBiometricProvider");


const CHALLENGE_TTL_MS =
    Number(
        process.env
            .BIOMETRIC_CHALLENGE_TTL_MS
    ) || 30000;


const challengeKey =
    (challengeId) =>
        `biometric:challenge:${challengeId}`;


/*
--------------------------------------------------
CREATE CHALLENGE
--------------------------------------------------
*/

exports.createChallenge =
    async ({
        userId,
        sessionId
    }) => {

        const enrollment =
            await BiometricEnrollment.findOne({
                userId,
                status: "ACTIVE"
            });


        if (!enrollment) {

            throw new AppError(
                "Biometric enrollment not found",
                409
            );
        }


        const challengeId =
            crypto.randomUUID();


        const challenge =
            crypto
                .randomBytes(32)
                .toString("base64url");


        const stored = {
            userId:
                String(userId),

            sessionId:
                String(sessionId),

            challenge
        };


        await redisClient.set(
            challengeKey(
                challengeId
            ),

            JSON.stringify(
                stored
            ),

            {
                NX: true,

                PX:
                    CHALLENGE_TTL_MS
            }
        );


        return {
            challengeId,

            challenge,

            expiresInMs:
                CHALLENGE_TTL_MS
        };
    };


/*
--------------------------------------------------
ENROLL
--------------------------------------------------
*/

exports.enroll =
    async ({
        userId,
        imageBuffer,
        mimeType
    }) => {

        const existing =
            await BiometricEnrollment.findOne({
                userId,
                status: "ACTIVE"
            });


        if (existing) {

            throw new AppError(
                "Biometric enrollment already exists",
                409
            );
        }


        const result =
            await provider.enroll({
                userId,
                imageBuffer,
                mimeType
            });


        try {

            const enrollment =
                await BiometricEnrollment.create({
                    userId,

                    provider:
                        "LOCAL",

                    providerUserId:
                        result.providerUserId,

                    modelVersion:
                        process.env
                            .BIOMETRIC_MODEL_VERSION ||
                        "insightface",

                    status:
                        "ACTIVE"
                });


            return enrollment;

        } catch (error) {

            if (
                error.code === 11000
            ) {

                throw new AppError(
                    "Biometric enrollment already exists",
                    409
                );
            }

            throw error;
        }
    };


/*
--------------------------------------------------
VERIFY
--------------------------------------------------
*/

exports.verify =
    async ({
        userId,
        sessionId,
        challengeId,
        imageBuffer,
        mimeType
    }) => {

        const key =
            challengeKey(
                challengeId
            );


        const raw =
            await redisClient.get(
                key
            );


        if (!raw) {

            throw new AppError(
                "Biometric challenge expired or invalid",
                401
            );
        }


        let stored;

        try {

            stored =
                JSON.parse(
                    raw
                );

        } catch {

            throw new AppError(
                "Invalid biometric challenge",
                500
            );
        }


        if (
            String(
                stored.userId
            ) !==
            String(userId)
        ) {

            throw new AppError(
                "Biometric challenge does not belong to this student",
                403
            );
        }


        if (
            String(
                stored.sessionId
            ) !==
            String(sessionId)
        ) {

            throw new AppError(
                "Biometric challenge does not belong to this session",
                403
            );
        }


        const result =
            await provider.verify({
                userId,

                imageBuffer,

                mimeType
            });


        /*
         * Consume the challenge atomically
         * after successful verification.
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
                        key
                    ],

                    arguments: [
                        raw
                    ]
                }
            );


        if (
            Number(deleted) !== 1
        ) {

            throw new AppError(
                "Biometric challenge was already used",
                409
            );
        }


        await BiometricEnrollment.updateOne(
            {
                userId,

                status:
                    "ACTIVE"
            },
            {
                $set: {
                    lastVerifiedAt:
                        new Date()
                }
            }
        );


        return result;
    };