const crypto =
    require("crypto");

const AppError = require("../../utils/AppError");

const {
    redisClient
} = require("../../config/redis");

const {
    getCurrentSlot,
    getSlotExpiry
} = require("../../utils/attendanceToken");


/*
 * Must survive the current slot
 * and the allowed clock skew.
 */
const QR_CHALLENGE_TTL_MS =
    Number(
        process.env.QR_CHALLENGE_TTL_MS
    ) || 8000;


/*
 * Short ownership lease while the
 * attendance transaction is running.
 */
const QR_USE_CLAIM_MS =
    Number(
        process.env.QR_USE_CLAIM_MS
    ) || 5000;


/*
 * Token freshness already limits replay,
 * so we only need a short replay record.
 */
const QR_REPLAY_TTL_MS =
    Number(
        process.env.QR_REPLAY_TTL_MS
    ) || 10000;


function challengeKey(
    sessionId,
    slot
) {

    return (
        `attendance:qr:challenge:${sessionId}:${slot}`
    );
}


function replayKey({
    sessionId,
    studentId,
    slot,
    nonce
}) {

    return (
        `attendance:qr:replay:` +
        `${sessionId}:` +
        `${studentId}:` +
        `${slot}:` +
        `${nonce}`
    );
}


/*
--------------------------------------------------
ISSUE / GET CURRENT QR CHALLENGE
--------------------------------------------------
*/

exports.getCurrentChallenge =
    async ({
        sessionId
    }) => {

        const slot =
            getCurrentSlot();


        const key =
            challengeKey(
                sessionId,
                slot
            );


        let nonce =
            await redisClient.get(
                key
            );


        if (!nonce) {

            nonce =
                crypto
                    .randomBytes(18)
                    .toString("base64url");


            const result =
                await redisClient.set(
                    key,
                    nonce,
                    {
                        NX: true,
                        PX:
                            QR_CHALLENGE_TTL_MS
                    }
                );


            /*
             * Another Node server may have
             * created the challenge first.
             */
            if (result !== "OK") {

                nonce =
                    await redisClient.get(
                        key
                    );
            }
        }


        if (!nonce) {

            throw new Error(
                "Unable to create QR challenge"
            );
        }


        return {
            slot,
            nonce,

            expiresAt:
                getSlotExpiry(slot)
        };
    };


/*
--------------------------------------------------
VERIFY QR CHALLENGE AGAINST REDIS
--------------------------------------------------
*/

exports.verifyChallenge =
    async ({
        sessionId,
        slot,
        nonce
    }) => {

        const key =
            challengeKey(
                sessionId,
                slot
            );


        const storedNonce =
            await redisClient.get(
                key
            );


        if (!storedNonce) {
            return false;
        }


        const received =
            Buffer.from(nonce);

        const stored =
            Buffer.from(
                storedNonce
            );


        if (
            received.length !==
            stored.length
        ) {
            return false;
        }


        return crypto.timingSafeEqual(
            received,
            stored
        );
    };


/*
--------------------------------------------------
CLAIM QR USE
--------------------------------------------------
*/

exports.claimQrUse =
    async ({
        sessionId,
        studentId,
        slot,
        nonce
    }) => {

        const key =
            replayKey({
                sessionId,
                studentId,
                slot,
                nonce
            });


        const ownerToken =
            crypto.randomUUID();


        const result =
            await redisClient.set(
                key,
                `PROCESSING:${ownerToken}`,
                {
                    NX: true,
                    PX:
                        QR_USE_CLAIM_MS
                }
            );


        if (result === "OK") {

            return {
                status: "CLAIMED",
                key,
                ownerToken
            };
        }


        const existing =
            await redisClient.get(
                key
            );


        if (
            existing &&
            existing.startsWith(
                "CONSUMED:"
            )
        ) {

            return {
                status: "CONSUMED"
            };
        }


        return {
            status: "PROCESSING"
        };
    };


/*
--------------------------------------------------
FINALIZE QR USE
--------------------------------------------------
*/

exports.completeQrUse =
    async ({
        key,
        ownerToken
    }) => {

        const script = `
            if redis.call(
                "GET",
                KEYS[1]
            ) == ARGV[1]
            then
                redis.call(
                    "SET",
                    KEYS[1],
                    ARGV[2],
                    "PX",
                    ARGV[3]
                )
                return 1
            end

            return 0
        `;


        return redisClient.eval(
            script,
            {
                keys: [key],

                arguments: [
                    `PROCESSING:${ownerToken}`,

                    `CONSUMED:${ownerToken}`,

                    String(
                        QR_REPLAY_TTL_MS
                    )
                ]
            }
        );
    };


/*
--------------------------------------------------
RELEASE QR USE
--------------------------------------------------
*/

exports.releaseQrUse =
    async ({
        key,
        ownerToken
    }) => {

        const script = `
            if redis.call(
                "GET",
                KEYS[1]
            ) == ARGV[1]
            then
                return redis.call(
                    "DEL",
                    KEYS[1]
                )
            end

            return 0
        `;


        return redisClient.eval(
            script,
            {
                keys: [key],

                arguments: [
                    `PROCESSING:${ownerToken}`
                ]
            }
        );
    };



/*
 * Keeps a server-validated scan valid while the front-camera face/liveness
 * check runs. This ticket is authenticated-user and session bound.
 */
const QR_VALIDATION_TTL_MS =
    Number(process.env.ATTENDANCE_QR_VALIDATION_TTL_MS) || 180000;
const qrValidationKey = (validationId) => "attendance:qr-validation:" + validationId;

exports.createQrValidationTicket = async ({
    studentId, sessionId, sessionRecordId, token, slot, nonce
}) => {
    const validationId = crypto.randomUUID();
    const ticket = {
        studentId: String(studentId),
        sessionId: String(sessionId),
        sessionRecordId: String(sessionRecordId),
        token,
        slot,
        nonce,
        state: "ISSUED",
        createdAt: Date.now()
    };
    const saved = await redisClient.set(
        qrValidationKey(validationId),
        JSON.stringify(ticket),
        { NX: true, PX: QR_VALIDATION_TTL_MS }
    );
    if (saved !== "OK") {
        throw new AppError("Could not create QR validation ticket. Scan the QR again.", 503);
    }
    return { validationId, expiresInMs: QR_VALIDATION_TTL_MS };
};

exports.getQrValidationTicket = async ({ validationId }) => {
    if (!validationId) return null;
    const raw = await redisClient.get(qrValidationKey(validationId));
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        throw new AppError("QR validation ticket is invalid. Scan the QR again.", 500);
    }
};


/*
 * Atomically reserve a validated QR ticket for exactly one idempotent
 * attendance operation. PTTL is preserved so a retry cannot extend the
 * authorization window. Safe across API instances sharing Redis.
 */
exports.claimQrValidationTicket = async ({ validationId, studentId, idempotencyKey }) => {
    const key = qrValidationKey(validationId);
    const script = `
        local current = redis.call("GET", KEYS[1])
        if not current then return -1 end
        local ticket = cjson.decode(current)
        if tostring(ticket.studentId) ~= ARGV[1] then return -2 end
        if ticket.state == "CONSUMED" then
            if ticket.consumedBy == ARGV[2] then return 2 end
            return 0
        end
        if ticket.state == "CLAIMED" then
            if ticket.claimKey == ARGV[2] then return 2 end
            return 0
        end
        if ticket.state and ticket.state ~= "ISSUED" then return 0 end
        local ttl = redis.call("PTTL", KEYS[1])
        if ttl <= 0 then return -1 end
        ticket.state = "CLAIMED"
        ticket.claimKey = ARGV[2]
        redis.call("SET", KEYS[1], cjson.encode(ticket), "PX", ttl)
        return 1
    `;
    const result = Number(await redisClient.eval(script, {
        keys: [key],
        arguments: [String(studentId), String(idempotencyKey)]
    }));
    if (result === -1) throw new AppError("QR validation ticket expired. Scan the QR again.", 401);
    if (result === -2) throw new AppError("QR validation ticket does not belong to this student.", 403);
    if (result === 0) throw new AppError("QR validation ticket has already been used or is being processed. Scan the QR again.", 409);
    return { key, idempotencyKey: String(idempotencyKey), claimed: true, sameOperation: result === 2 };
};

/* Restore an uncommitted claim only if this request still owns it. */
exports.releaseQrValidationTicket = async ({ validationId, idempotencyKey }) => {
    const key = qrValidationKey(validationId);
    const script = `
        local current = redis.call("GET", KEYS[1])
        if not current then return 0 end
        local ticket = cjson.decode(current)
        if ticket.state ~= "CLAIMED" or ticket.claimKey ~= ARGV[1] then return 0 end
        local ttl = redis.call("PTTL", KEYS[1])
        if ttl <= 0 then redis.call("DEL", KEYS[1]); return 0 end
        ticket.state = "ISSUED"
        ticket.claimKey = nil
        redis.call("SET", KEYS[1], cjson.encode(ticket), "PX", ttl)
        return 1
    `;
    return Number(await redisClient.eval(script, {
        keys: [key],
        arguments: [String(idempotencyKey)]
    })) === 1;
};

/* Called only after attendance's Mongo transaction has committed. */
exports.finalizeQrValidationTicket = async ({ validationId, idempotencyKey }) => {
    const key = qrValidationKey(validationId);
    const script = `
        local current = redis.call("GET", KEYS[1])
        if not current then return 0 end
        local ticket = cjson.decode(current)
        if ticket.state == "CONSUMED" and ticket.consumedBy == ARGV[1] then return 2 end
        if ticket.state ~= "CLAIMED" or ticket.claimKey ~= ARGV[1] then return 0 end
        local ttl = redis.call("PTTL", KEYS[1])
        if ttl <= 0 then redis.call("DEL", KEYS[1]); return 0 end
        ticket.state = "CONSUMED"
        ticket.consumedBy = ARGV[1]
        ticket.claimKey = nil
        redis.call("SET", KEYS[1], cjson.encode(ticket), "PX", ttl)
        return 1
    `;
    const result = Number(await redisClient.eval(script, {
        keys: [key],
        arguments: [String(idempotencyKey)]
    }));
    return result === 1 || result === 2;
};
