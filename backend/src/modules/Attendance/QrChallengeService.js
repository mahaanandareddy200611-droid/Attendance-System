const crypto =
    require("crypto");

const {
    redisClient
} = require("../../config/redis");

const {
    getCurrentSlot
} = require("../../utils/attendanceToken");


const QR_REFRESH_MS =
    Number(
        process.env.QR_REFRESH_MS
    ) || 250;


/*
 * Must survive the current slot
 * and the allowed clock skew.
 */
const QR_CHALLENGE_TTL_MS =
    Number(
        process.env.QR_CHALLENGE_TTL_MS
    ) || 1500;


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
                new Date(
                    Date.now() +
                    Math.max(
                        0,
                        QR_REFRESH_MS
                    )
                )
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
    