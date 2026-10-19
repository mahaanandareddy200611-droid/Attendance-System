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

exports.getMyEnrollment = async ({ userId }) => {
    const enrollment = await BiometricEnrollment.findOne({
        userId,
        status: "ACTIVE"
    }).select("status provider modelVersion enrolledAt lastVerifiedAt").lean();
    return enrollment || null;
};


const CHALLENGE_TTL_MS =
    Number(
        process.env
            .BIOMETRIC_CHALLENGE_TTL_MS
    ) || 30000;

const ASSERTION_TTL_MS =
    Number(
        process.env.BIOMETRIC_ASSERTION_TTL_MS
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

exports.verify = async ({
    userId,
    sessionId,
    challengeId,
    imageBuffer,
    mimeType
}) => {
    if (!challengeId) {
        throw new AppError(
            "Biometric challenge is required",
            400
        );
    }

    const key = challengeKey(challengeId);

    // 1. Load the challenge. Redis errors propagate and fail closed.
    const raw = await redisClient.get(key);

    if (!raw) {
        throw new AppError(
            "Biometric challenge expired or invalid",
            401
        );
    }

    let stored;

    try {
        stored = JSON.parse(raw);
    } catch {
        throw new AppError(
            "Invalid biometric challenge",
            500
        );
    }

    // 2. Check ownership BEFORE consuming the challenge.
    if (String(stored.userId) !== String(userId)) {
        throw new AppError(
            "Biometric challenge does not belong to this student",
            403
        );
    }

    if (String(stored.sessionId) !== String(sessionId)) {
        throw new AppError(
            "Biometric challenge does not belong to this session",
            403
        );
    }

    // 3. Atomically consume the exact challenge value.
    // Redis executes this script as one indivisible operation.
    const consumeScript = `
        local value = redis.call("GET", KEYS[1])

        if value == ARGV[1] then
            return redis.call("DEL", KEYS[1])
        end

        return 0
    `;

    const consumed = await redisClient.eval(
        consumeScript,
        {
            keys: [key],
            arguments: [raw]
        }
    );

    if (Number(consumed) !== 1) {
        throw new AppError(
            "Biometric challenge was already used",
            409
        );
    }

    // SECURITY BOUNDARY:
    // Only the request that consumed the challenge reaches the provider.
    // Provider errors intentionally require a fresh challenge on retry.
    const result = await provider.verify({
        userId,
        imageBuffer,
        mimeType
    });

    // Defense in depth: do not mint an assertion from an incomplete result.
    if (
        result?.verified !== true ||
        result?.livenessPassed !== true ||
        result?.faceMatchPassed !== true ||
        String(result?.providerUserId) !== String(userId)
    ) {
        throw new AppError(
            "Biometric verification did not complete successfully",
            502
        );
    }

    const assertionId = crypto.randomUUID();
    const assertionKey = `biometric:assertion:${assertionId}`;

    // 4. Store a short-lived assertion only after successful verification.
    const storedAssertion = await redisClient.set(
        assertionKey,
        JSON.stringify({
            userId: String(userId),
            sessionId: String(sessionId),
            verificationId: result.verificationId,
            providerUserId: result.providerUserId,
            livenessPassed: true,
            faceMatchPassed: true,
            similarity: result.similarity
        }),
        {
            NX: true,
            PX: ASSERTION_TTL_MS
        }
    );

    if (storedAssertion !== "OK") {
        throw new AppError(
            "Could not create biometric assertion; request a new challenge",
            503
        );
    }

    try {
        // Ensure the enrollment is still active, including if it was
        // revoked while the external provider was processing the image.
        const update = await BiometricEnrollment.updateOne(
            {
                userId,
                status: "ACTIVE"
            },
            {
                $set: {
                    lastVerifiedAt: new Date()
                }
            }
        );

        if (update.matchedCount !== 1) {
            throw new AppError(
                "Active biometric enrollment was not found",
                409
            );
        }
    } catch (error) {
        // Never return a valid assertion if finalization fails.
        try {
            await redisClient.del(assertionKey);
        } catch {
            // The assertion is unguessable and expires automatically.
            // Cleanup errors must not replace the original failure.
        }

        throw error;
    }

    return {
        verified: true,
        livenessPassed: true,
        faceMatchPassed: true,
        similarity: result.similarity,
        verificationId: result.verificationId,
        assertionId
    };
};



exports.consumeAssertion =
    async ({
        assertionId,
        userId,
        sessionId
    }) => {

        if (!assertionId) {

            throw new AppError(
                "Biometric assertion is required",
                401
            );
        }


        const key =
            `biometric:assertion:${assertionId}`;


        const raw =
            await redisClient.get(
                key
            );


        if (!raw) {

            throw new AppError(
                "Biometric assertion expired or already used",
                401
            );
        }


        let assertion;

        try {

            assertion =
                JSON.parse(raw);

        } catch {

            throw new AppError(
                "Invalid biometric assertion",
                500
            );
        }


        if (
            String(
                assertion.userId
            ) !==
            String(userId)
        ) {

            throw new AppError(
                "Biometric assertion does not belong to this student",
                403
            );
        }


        if (
            String(
                assertion.sessionId
            ) !==
            String(sessionId)
        ) {

            throw new AppError(
                "Biometric assertion does not belong to this session",
                403
            );
        }


        if (
            assertion.livenessPassed !== true ||
            assertion.faceMatchPassed !== true
        ) {

            throw new AppError(
                "Biometric verification is incomplete",
                401
            );
        }


        /*
        --------------------------------------------------
        ATOMIC CONSUME
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
                "Biometric assertion was already used",
                409
            );
        }


        return assertion;
    };

exports.validateAssertion = async ({ assertionId, userId, sessionId }) => {
    if (!assertionId) {
        throw new AppError("Biometric assertion is required", 401);
    }

    const raw = await redisClient.get(`biometric:assertion:${assertionId}`);
    if (!raw) {
        throw new AppError("Biometric assertion expired or already used", 401);
    }

    let assertion;
    try {
        assertion = JSON.parse(raw);
    } catch {
        throw new AppError("Invalid biometric assertion", 500);
    }

    if (String(assertion.userId) !== String(userId)) {
        throw new AppError("Biometric assertion does not belong to this student", 403);
    }
    if (String(assertion.sessionId) !== String(sessionId)) {
        throw new AppError("Biometric assertion does not belong to this session", 403);
    }
    if (assertion.livenessPassed !== true || assertion.faceMatchPassed !== true) {
        throw new AppError("Biometric verification is incomplete", 401);
    }

    return assertion;
};



/**
 * Reserve a biometric assertion for one attendance operation.
 *
 * The assertion remains in Redis during the MongoDB transaction.
 * A reservation ID should be the idempotency key of the operation.
 */
exports.reserveAssertion = async ({
    assertionId,
    userId,
    sessionId,
    reservationId
}) => {
    if (
        !assertionId ||
        !reservationId
    ) {
        throw new AppError(
            "Assertion and reservation identifiers are required",
            400
        );
    }

    const key = `biometric:assertion:${assertionId}`;
    const raw = await redisClient.get(key);

    if (!raw) {
        throw new AppError(
            "Biometric assertion expired or is unavailable",
            401
        );
    }

    let assertion;

    try {
        assertion = JSON.parse(raw);
    } catch {
        throw new AppError(
            "Invalid biometric assertion",
            500
        );
    }

    if (String(assertion.userId) !== String(userId)) {
        throw new AppError(
            "Biometric assertion does not belong to this student",
            403
        );
    }

    if (String(assertion.sessionId) !== String(sessionId)) {
        throw new AppError(
            "Biometric assertion does not belong to this session",
            403
        );
    }

    if (
        assertion.livenessPassed !== true ||
        assertion.faceMatchPassed !== true
    ) {
        throw new AppError(
            "Biometric verification is incomplete",
            401
        );
    }

    // A retry of the same idempotent operation may reuse its reservation.
    if (assertion.reservationId) {
        if (
            assertion.reservationId === reservationId &&
            assertion.state === "RESERVED"
        ) {
            return {
                ...assertion,
                assertionId,
                reservationId
            };
        }

        throw new AppError(
            "Biometric assertion is reserved by another operation",
            409
        );
    }

    // Compare-and-set and preserve the original remaining TTL.
    const script = `
        local current = redis.call("GET", KEYS[1])

        if not current or current ~= ARGV[1] then
            return 0
        end

        local ttl = redis.call("PTTL", KEYS[1])

        if ttl <= 0 then
            return 0
        end

        local assertion = cjson.decode(current)

        if assertion.reservationId then
            return 0
        end

        assertion.reservationId = ARGV[2]
        assertion.state = "RESERVED"

        redis.call(
            "SET",
            KEYS[1],
            cjson.encode(assertion),
            "PX",
            ttl
        )

        return 1
    `;

    const reserved = await redisClient.eval(script, {
        keys: [key],
        arguments: [raw, reservationId]
    });

    if (Number(reserved) !== 1) {
        throw new AppError(
            "Biometric assertion was claimed by another request",
            409
        );
    }

    return {
        ...assertion,
        assertionId,
        reservationId,
        state: "RESERVED"
    };
};

/**
 * Release a reservation after a confirmed database rollback.
 * It never releases a reservation owned by another operation.
 */
exports.releaseAssertionReservation = async ({
    assertionId,
    reservationId
}) => {
    const key = `biometric:assertion:${assertionId}`;

    const script = `
        local current = redis.call("GET", KEYS[1])

        if not current then
            return 0
        end

        local assertion = cjson.decode(current)

        if assertion.reservationId ~= ARGV[1]
           or assertion.state ~= "RESERVED" then
            return 0
        end

        local ttl = redis.call("PTTL", KEYS[1])

        if ttl <= 0 then
            redis.call("DEL", KEYS[1])
            return 0
        end

        assertion.reservationId = nil
        assertion.state = nil

        redis.call(
            "SET",
            KEYS[1],
            cjson.encode(assertion),
            "PX",
            ttl
        )

        return 1
    `;

    const released = await redisClient.eval(script, {
        keys: [key],
        arguments: [reservationId]
    });

    return Number(released) === 1;
};

/**
 * Finalize a reservation after the attendance transaction commits.
 * Deleting the assertion makes it permanently unavailable until expiry.
 */
exports.finalizeAssertionReservation = async ({
    assertionId,
    reservationId
}) => {
    const key = `biometric:assertion:${assertionId}`;

    const script = `
        local current = redis.call("GET", KEYS[1])

        if not current then
            return 0
        end

        local assertion = cjson.decode(current)

        if assertion.reservationId ~= ARGV[1]
           or assertion.state ~= "RESERVED" then
            return 0
        end

        return redis.call("DEL", KEYS[1])
    `;

    const finalized = await redisClient.eval(script, {
        keys: [key],
        arguments: [reservationId]
    });

    return Number(finalized) === 1;
};
