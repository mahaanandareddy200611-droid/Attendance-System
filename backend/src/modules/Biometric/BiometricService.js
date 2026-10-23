const crypto =
    require("crypto");
const mongoose = require("mongoose");
const ClassSection = require("../../models/ClassSection.model");
const Enrollment = require("../../models/Enrollment.model");
const User = require("../../models/Auth.model");
const AuditEvent = require("../../models/AuditEvent.model");

const BiometricEnrollment =
    require("../../models/BiometricEnrollment.model");

const AppError =
    require("../../utils/AppError");

const {
    redisClient
} = require("../../config/redis");

const provider =
    require("./LocalBiometricProvider");

const safeDiagnosticCode = (value) => {
    if (value === undefined || value === null) return undefined;
    const code = String(value);
    return /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : undefined;
};

function biometricDeletionFailureDetails(error) {
    const details = {
        errorName: safeDiagnosticCode(error?.name) || "Error",
        failureKind: error instanceof TypeError
            ? "NETWORK_OR_URL"
            : Number.isInteger(Number(error?.statusCode))
                ? "PROVIDER_HTTP"
                : "PROVIDER_OR_INTERNAL"
    };

    const httpStatus = Number(error?.statusCode);
    const providerCode = safeDiagnosticCode(error?.providerCode);
    const causeName = safeDiagnosticCode(error?.cause?.name);
    const causeCode = safeDiagnosticCode(error?.cause?.code);
    const errorCode = safeDiagnosticCode(error?.code);

    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) {
        details.providerHttpStatus = httpStatus;
    }
    if (providerCode) details.providerCode = providerCode;
    if (causeName) details.causeName = causeName;
    if (causeCode) details.causeCode = causeCode;
    if (errorCode) details.code = errorCode;

    // Deliberately do not log provider response bodies, URLs, user IDs,
    // person identifiers, request headers, images, or credentials.
    return details;
}

exports.getMyEnrollment = async ({ userId }) => {
    const enrollment = await BiometricEnrollment.findOne({
        userId,
        status: { $in: ["PENDING_APPROVAL", "ACTIVE", "DELETE_PENDING", "REJECTED"] }
    }).sort({ updatedAt: -1 }).select("status provider modelVersion enrolledAt lastVerifiedAt reviewDecision reviewedAt approvedAt").lean();
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

exports.enroll = async ({ userId, imageBuffer, mimeType, consentVersion = null, consentedAt = null }) => {
    // One Redis reservation per student prevents duplicate provider enrollments
    // when multiple stateless API instances receive concurrent requests.
    const reservationKey = `biometric:enrollment-reservation:${String(userId)}`;
    const reservationToken = crypto.randomUUID();
    const reservationMs = Math.max(10000, Math.min(Number(process.env.BIOMETRIC_ENROLLMENT_RESERVATION_MS) || 30000, 120000));
    const reserved = await redisClient.set(reservationKey, reservationToken, { NX: true, PX: reservationMs });
    if (reserved !== "OK") {
        throw new AppError("A face enrollment request is already being processed. Please retry shortly.", 409);
    }

    try {
        const existing = await BiometricEnrollment.findOne({
            userId,
            status: { $in: ["PENDING_APPROVAL", "ACTIVE", "DELETE_PENDING"] }
        }).select("status").lean();

        if (existing?.status === "DELETE_PENDING") {
            throw new AppError("Biometric enrollment deletion is still pending; retry after provider cleanup completes", 409);
        }
        if (existing?.status === "PENDING_APPROVAL") {
            throw new AppError("Face enrollment is already waiting for lecturer approval", 409);
        }
        if (existing?.status === "ACTIVE") {
            throw new AppError("Biometric enrollment already exists", 409);
        }

        let result;
        try {
            result = await provider.enroll({ userId, imageBuffer, mimeType });
        } catch (providerError) {
            if (providerError?.cleanupProviderUserId) {
                try {
                    await BiometricEnrollment.create({
                        userId,
                        provider: "LOCAL",
                        providerUserId: String(providerError.cleanupProviderUserId),
                        modelVersion: process.env.BIOMETRIC_MODEL_VERSION || "insightface",
                        status: "DELETE_PENDING",
                        reviewDecision: "REJECTED",
                        consentVersion: consentVersion || null,
                        consentedAt: consentVersion && consentedAt ? consentedAt : null,
                        revokedAt: new Date()
                    });
                } catch (persistError) {
                    console.error("Rejected biometric profile cleanup could not be queued", {
                        errorName: persistError?.name || "Error",
                        statusCode: Number.isInteger(persistError?.statusCode) ? persistError.statusCode : undefined
                    });
                    throw new AppError(
                        "The provider rejected this face image, but automatic cleanup could not be queued. Contact an administrator before retrying.",
                        503
                    );
                }
                throw new AppError(
                    "No usable face was accepted. Provider cleanup is pending; refresh enrollment status before retrying.",
                    503
                );
            }
            throw providerError;
        }

        try {
            return await BiometricEnrollment.create({
                userId,
                provider: "LOCAL",
                providerUserId: result.providerUserId,
                modelVersion: process.env.BIOMETRIC_MODEL_VERSION || "insightface",
                status: "PENDING_APPROVAL",
                reviewDecision: "PENDING",
                consentVersion: consentVersion || null,
                consentedAt: consentVersion && consentedAt ? consentedAt : null
            });
        } catch (error) {
            // Avoid leaving a provider-side face profile orphaned if persistence
            // fails after the provider accepted an enrollment.
            try { await provider.deletePerson({ providerUserId: result.providerUserId }); } catch { /* Don't log private provider data. */ }
            if (error.code === 11000) {
                throw new AppError("Biometric enrollment already exists or is pending review", 409);
            }
            throw error;
        }
    } finally {
        const releaseScript = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0';
        await redisClient.eval(releaseScript, { keys: [reservationKey], arguments: [reservationToken] }).catch(() => {});
    }
};


/*
--------------------------------------------------
VERIFY
--------------------------------------------------
*/

exports.verify = async ({ userId, sessionId, challengeId, challenge, imageBuffer, mimeType }) => {
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
    // Require proof that the caller received the server-generated nonce.
    // This is challenge-response validation, not by itself proof of a live camera.
    if (typeof challenge !== "string" || typeof stored.challenge !== "string") {
        throw new AppError("Biometric challenge response is required", 400);
    }

    const expectedChallenge = Buffer.from(stored.challenge, "utf8");
    const suppliedChallenge = Buffer.from(challenge, "utf8");
    if (
        expectedChallenge.length !== suppliedChallenge.length ||
        !crypto.timingSafeEqual(expectedChallenge, suppliedChallenge)
    ) {
        throw new AppError("Biometric challenge response is invalid", 401);
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


// ---------------------------------------------------------------------------
// Demo-grade active sequence challenge. The separate key namespace prevents
// an active challenge from being consumed through the legacy one-image path.
// ---------------------------------------------------------------------------
const activeChallengeKey = (challengeId) => 'biometric:active-challenge:' + challengeId;

exports.createActiveChallenge = async ({ userId, sessionId }) => {
    const enrollment = await BiometricEnrollment.findOne({ userId, status: 'ACTIVE' });
    if (!enrollment) throw new AppError('Biometric enrollment not found', 409);
    const challengeId = crypto.randomUUID();
    const challenge = crypto.randomBytes(32).toString('base64url');
    const directions = crypto.randomInt(0, 2) === 0
        ? ['TURN_LEFT', 'TURN_RIGHT']
        : ['TURN_RIGHT', 'TURN_LEFT'];
    const steps = ['CENTER', ...directions];
    const stored = {
        mode: 'ACTIVE_SEQUENCE_V1',
        userId: String(userId),
        sessionId: String(sessionId),
        challenge,
        steps,
        createdAt: Date.now()
    };
    const saved = await redisClient.set(activeChallengeKey(challengeId), JSON.stringify(stored), { NX: true, PX: CHALLENGE_TTL_MS });
    if (saved !== 'OK') throw new AppError('Could not create an active liveness challenge', 503);
    const instructions = {
        CENTER: 'Face the camera straight on.',
        TURN_LEFT: 'Turn your face so your nose moves toward the left edge of the image.',
        TURN_RIGHT: 'Turn your face so your nose moves toward the right edge of the image.'
    };
    return { challengeId, challenge, mode: stored.mode, steps: steps.map((step, index) => ({ index, step, instruction: instructions[step] })), expiresInMs: CHALLENGE_TTL_MS };
};

exports.verifyActiveSequence = async ({ userId, sessionId, challengeId, challenge, frames }) => {
    const ActiveLiveness = require('./ActiveLiveness');
    if (!challengeId || !challenge) throw new AppError('Active biometric challenge and nonce are required', 400);
    if (!Array.isArray(frames) || frames.length !== 3 || frames.some((frame) => !Buffer.isBuffer(frame?.imageBuffer))) {
        throw new AppError('Exactly three validated liveness frames are required', 400);
    }
    const key = activeChallengeKey(challengeId);
    const raw = await redisClient.get(key);
    if (!raw) throw new AppError('Active biometric challenge expired or invalid', 401);
    let stored;
    try { stored = JSON.parse(raw); } catch { throw new AppError('Invalid active biometric challenge', 500); }
    if (stored.mode !== 'ACTIVE_SEQUENCE_V1' || String(stored.userId) !== String(userId)) {
        throw new AppError('Active biometric challenge does not belong to this student', 403);
    }
    if (String(stored.sessionId) !== String(sessionId)) throw new AppError('Active biometric challenge does not belong to this session', 403);
    const expected = Buffer.from(String(stored.challenge || ''));
    const supplied = Buffer.from(String(challenge));
    if (expected.length !== supplied.length || expected.length === 0 || !crypto.timingSafeEqual(expected, supplied)) {
        throw new AppError('Active biometric challenge nonce is invalid', 401);
    }
    const consumeScript = 'local value = redis.call("GET", KEYS[1])\nif value == ARGV[1] then return redis.call("DEL", KEYS[1]) end\nreturn 0';
    const consumed = await redisClient.eval(consumeScript, { keys: [key], arguments: [raw] });
    if (Number(consumed) !== 1) throw new AppError('Active biometric challenge was already used', 409);

    // Check provider liveness and head-turn evidence for each frame. Serial
    // provider calls bound inference concurrency better during campus peaks.
    const detections = [];
    for (const frame of frames) {
        detections.push(await provider.detect({ imageBuffer: frame.imageBuffer, mimeType: frame.mimeType || 'image/jpeg' }));
    }
    const movement = ActiveLiveness.assertActiveSequence(stored.steps, detections.map((item) => item.landmarks));

    // Bind the final frame to the authenticated student's enrolled identity.
    // Use the center-facing first frame for identity matching; a turned-face final frame can reduce recognition accuracy.
    const result = await provider.verify({ userId, imageBuffer: frames[0].imageBuffer, mimeType: frames[0].mimeType || 'image/jpeg' });
    if (result?.verified !== true || result?.livenessPassed !== true || result?.faceMatchPassed !== true || String(result?.providerUserId) !== String(userId)) {
        throw new AppError('Active biometric identity verification failed', 401);
    }
    const assertionId = crypto.randomUUID();
    const assertionKey = 'biometric:assertion:' + assertionId;
    const assertion = {
        userId: String(userId),
        sessionId: String(sessionId),
        verificationId: result.verificationId,
        providerUserId: result.providerUserId,
        livenessPassed: true,
        faceMatchPassed: true,
        activeLivenessPassed: true,
        livenessMode: movement.version,
        similarity: result.similarity
    };
    const savedAssertion = await redisClient.set(assertionKey, JSON.stringify(assertion), { NX: true, PX: ASSERTION_TTL_MS });
    if (savedAssertion !== 'OK') throw new AppError('Could not create biometric assertion; request a new challenge', 503);
    try {
        const update = await BiometricEnrollment.updateOne({ userId, status: 'ACTIVE' }, { $set: { lastVerifiedAt: new Date() } });
        if (update.matchedCount !== 1) throw new AppError('Active biometric enrollment was not found', 409);
    } catch (error) {
        try { await redisClient.del(assertionKey); } catch { /* Assertion expires automatically. */ }
        throw error;
    }
    return { verified: true, livenessPassed: true, faceMatchPassed: true, activeLivenessPassed: true, livenessMode: movement.version, similarity: result.similarity, verificationId: result.verificationId, assertionId };
};


/**
 * Delete the active biometric enrollment from the provider. We first mark it
 * DELETE_PENDING so attendance stops using it even if provider deletion fails.
 * The periodic sweeper retries pending deletions until the provider confirms
 * deletion (a provider 404 is treated as already deleted).
 */

/*
 * Lecturers may review only students enrolled in an active section assigned
 * to them. Admins may review all student submissions. Provider identifiers
 * and biometric samples are never exposed by these review endpoints.
 */
async function assertReviewerCanReviewStudent({ studentId, reviewerId, role }) {
    if (!mongoose.isValidObjectId(studentId)) throw new AppError("Invalid student identifier", 400);
    if (role === "Admin") return;
    if (role !== "Lecturer") throw new AppError("Only lecturers or administrators can review face enrollment", 403);

    const sections = await ClassSection.find({ lecturers: reviewerId, status: "ACTIVE" }).select("_id").lean();
    const sectionIds = sections.map((section) => section._id);
    if (!sectionIds.length) throw new AppError("You are not assigned to a section containing this student", 403);

    const enrollment = await Enrollment.findOne({
        studentId,
        sectionId: { $in: sectionIds },
        status: "ACTIVE"
    }).select("_id").lean();
    if (!enrollment) throw new AppError("You may review only students enrolled in your active sections", 403);
}

exports.listPendingEnrollmentApprovals = async ({ reviewerId, role }) => {
    if (!["Admin", "Lecturer"].includes(role)) throw new AppError("Only lecturers or administrators can review face enrollment", 403);

    const sectionFilter = { status: "ACTIVE" };
    if (role === "Lecturer") sectionFilter.lecturers = reviewerId;
    const sections = await ClassSection.find(sectionFilter)
        .select("_id name academicYear courseId")
        .populate("courseId", "code name")
        .lean();
    const sectionMap = new Map(sections.map((section) => [String(section._id), section]));
    const sectionIds = sections.map((section) => section._id);
    const activeEnrollments = sectionIds.length
        ? await Enrollment.find({ sectionId: { $in: sectionIds }, status: "ACTIVE" })
            .select("studentId sectionId rollNumber").lean()
        : [];

    const eligibleStudentIds = [...new Set(activeEnrollments.map((item) => String(item.studentId)))];
    const pendingFilter = { status: "PENDING_APPROVAL" };
    if (role === "Lecturer") {
        if (!eligibleStudentIds.length) return [];
        pendingFilter.userId = { $in: eligibleStudentIds };
    }

    const pending = await BiometricEnrollment.find(pendingFilter)
        .select("userId status enrolledAt createdAt")
        .sort({ enrolledAt: 1 })
        .limit(200)
        .lean();
    if (!pending.length) return [];

    const users = await User.find({
        _id: { $in: pending.map((item) => item.userId) },
        role: "Student",
        status: "ACTIVE"
    }).select("Name RollNumber email").lean();
    const userMap = new Map(users.map((item) => [String(item._id), item]));

    return pending.flatMap((item) => {
        const studentId = String(item.userId);
        const user = userMap.get(studentId);
        if (!user) return [];
        const classLinks = activeEnrollments
            .filter((enrollment) => String(enrollment.studentId) === studentId)
            .map((enrollment) => {
                const section = sectionMap.get(String(enrollment.sectionId));
                return {
                    sectionId: String(enrollment.sectionId),
                    sectionName: section?.name || "",
                    academicYear: section?.academicYear || "",
                    courseCode: section?.courseId?.code || "",
                    courseName: section?.courseId?.name || "",
                    rollNumber: enrollment.rollNumber || user.RollNumber || ""
                };
            });
        return [{
            studentId,
            name: user.Name,
            rollNumber: user.RollNumber || classLinks[0]?.rollNumber || "",
            email: user.email,
            status: item.status,
            enrolledAt: item.enrolledAt || item.createdAt,
            sections: classLinks
        }];
    });
};

exports.approveEnrollment = async ({ studentId, reviewerId, role }) => {
    await assertReviewerCanReviewStudent({ studentId, reviewerId, role });
    const reviewedAt = new Date();
    const dbSession = await mongoose.startSession();
    let updated;
    try {
        await dbSession.withTransaction(async () => {
            const query = BiometricEnrollment.findOneAndUpdate(
                { userId: studentId, status: "PENDING_APPROVAL" },
                { $set: {
                    status: "ACTIVE",
                    reviewDecision: "APPROVED",
                    reviewedBy: reviewerId,
                    reviewedAt,
                    approvedBy: reviewerId,
                    approvedAt: reviewedAt
                } },
                { new: true, session: dbSession }
            ).select("userId status reviewedAt approvedAt");
            updated = await query.lean();
            if (!updated) throw new AppError("No pending face enrollment was found for this student", 409);
            await AuditEvent.create([{
                event: "BIOMETRIC_ENROLLMENT_APPROVED",
                userId: reviewerId,
                metadata: { studentId: String(studentId) }
            }], { session: dbSession });
        });
    } finally {
        await dbSession.endSession();
    }
    return { studentId: String(updated.userId), status: updated.status, approvedAt: updated.approvedAt };
};

exports.rejectEnrollment = async ({ studentId, reviewerId, role }) => {
    await assertReviewerCanReviewStudent({ studentId, reviewerId, role });
    const reviewedAt = new Date();
    const pending = await BiometricEnrollment.findOneAndUpdate(
        { userId: studentId, status: "PENDING_APPROVAL" },
        { $set: {
            status: "DELETE_PENDING",
            reviewDecision: "REJECTED",
            reviewedBy: reviewerId,
            reviewedAt,
            revokedAt: reviewedAt
        } },
        { new: true }
    ).select("userId provider providerUserId modelVersion status").lean();

    if (!pending) throw new AppError("No pending face enrollment was found for this student", 409);
    try {
        await provider.deletePerson({ providerUserId: pending.providerUserId });
    } catch {
        throw new AppError("Rejection was recorded, but biometric provider deletion is pending retry", 503);
    }

    const dbSession = await mongoose.startSession();
    try {
        await dbSession.withTransaction(async () => {
            const finalUpdate = await BiometricEnrollment.updateOne(
                { userId: studentId, status: "DELETE_PENDING", reviewDecision: "REJECTED" },
                { $set: { status: "REJECTED", revokedAt: new Date() } },
                { session: dbSession }
            );
            if (finalUpdate.matchedCount !== 1) {
                throw new AppError("Provider deletion completed but the enrollment state changed", 409);
            }
            await AuditEvent.create([{
                event: "BIOMETRIC_ENROLLMENT_REJECTED",
                userId: reviewerId,
                metadata: { studentId: String(studentId), providerDeletionConfirmed: true }
            }], { session: dbSession });
        });
    } catch {
        // Provider deletion is idempotent; the retry sweeper will finish this
        // durable DELETE_PENDING state without re-enabling attendance.
        throw new AppError("Biometric provider deletion is confirmed, but review finalization is pending retry", 503);
    } finally {
        await dbSession.endSession();
    }
    return { studentId: String(studentId), status: "REJECTED" };
};

exports.revokeEnrollment = async ({ userId }) => {
    const enrollment = await BiometricEnrollment.findOne({
        userId,
        status: { $in: ["PENDING_APPROVAL", "ACTIVE", "DELETE_PENDING"] }
    });

    if (!enrollment) return { status: "REVOKED", alreadyDeleted: true };

    if (enrollment.status === "ACTIVE" || enrollment.status === "PENDING_APPROVAL") {
        await BiometricEnrollment.updateOne(
            { _id: enrollment._id, status: enrollment.status },
            { $set: {
                status: "DELETE_PENDING",
                revokedAt: new Date(),
                ...(enrollment.status === "PENDING_APPROVAL" ? { reviewDecision: "WITHDRAWN" } : {})
            } }
        );
    }

    try {
        await provider.deletePerson({ providerUserId: enrollment.providerUserId });
    } catch {
        throw new AppError("Biometric deletion is pending because the provider is unavailable", 503);
    }

    const finalStatus = enrollment.reviewDecision === "REJECTED" ? "REJECTED" : "REVOKED";
    await BiometricEnrollment.updateOne(
        { _id: enrollment._id, status: "DELETE_PENDING" },
        { $set: { status: finalStatus, revokedAt: new Date() } }
    );

    try {
        await AuditEvent.create({
            event: finalStatus === "REJECTED" ? "BIOMETRIC_ENROLLMENT_REJECTED" : "BIOMETRIC_ENROLLMENT_DELETED",
            userId,
            metadata: { provider: enrollment.provider, modelVersion: enrollment.modelVersion }
        });
    } catch (error) {
        console.error("Biometric deletion audit event failed", { errorName: error?.name || "Error" });
    }

    return { status: finalStatus, alreadyDeleted: false };
};

exports.sweepPendingBiometricDeletes = async ({ limit = 10 } = {}) => {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const pending = await BiometricEnrollment.find({ status: "DELETE_PENDING" })
        .select("userId provider providerUserId modelVersion reviewDecision")
        .sort({ updatedAt: 1 })
        .limit(boundedLimit)
        .lean();

    const result = { scanned: pending.length, deleted: 0, failed: 0 };
    for (const enrollment of pending) {
        try {
            await provider.deletePerson({ providerUserId: enrollment.providerUserId });
            const finalStatus = enrollment.reviewDecision === "REJECTED" ? "REJECTED" : "REVOKED";
            const update = await BiometricEnrollment.updateOne(
                { userId: enrollment.userId, status: "DELETE_PENDING" },
                { $set: { status: finalStatus, revokedAt: new Date() } }
            );
            if (update.modifiedCount === 1) {
                try {
                    await AuditEvent.create({
                        event: finalStatus === "REJECTED" ? "BIOMETRIC_ENROLLMENT_REJECTED" : "BIOMETRIC_ENROLLMENT_DELETED",
                        userId: enrollment.userId,
                        metadata: { provider: enrollment.provider, modelVersion: enrollment.modelVersion, reason: "PENDING_DELETE_RETRY" }
                    });
                } catch (error) {
                    console.error("Biometric deletion audit event failed", { errorName: error?.name || "Error" });
                }
                result.deleted += 1;
            }
        } catch (error) {
            result.failed += 1;
            console.error("Pending biometric deletion retry failed", biometricDeletionFailureDetails(error));
        }
    }
    return result;
};
