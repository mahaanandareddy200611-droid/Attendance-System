const crypto =
    require("crypto");


const QR_REFRESH_MS =
    Number(
        process.env.QR_REFRESH_MS
    ) || 3000;

const configuredSkewSlots = process.env.QR_ALLOWED_SKEW_SLOTS;
const parsedSkewSlots =
    configuredSkewSlots === undefined || String(configuredSkewSlots).trim() === ""
        ? NaN
        : Number(configuredSkewSlots);

// Zero is a valid policy: accepting no previous-slot QR challenges.
// Do not use "|| 1" here because that silently turns a configured zero into one.
const QR_ALLOWED_SKEW_SLOTS =
    Number.isSafeInteger(parsedSkewSlots) && parsedSkewSlots >= 0
        ? parsedSkewSlots
        : 1;


const getSecret = () => {
    const secret = process.env.ATTENDANCE_TOKEN_SECRET;
    if (!secret) {
        const error = new Error("ATTENDANCE_TOKEN_SECRET is not configured");
        error.statusCode = 503;
        throw error;
    }
    return secret;
};


function getCurrentSlot(
    time = Date.now()
) {
    return Math.floor(
        time / QR_REFRESH_MS
    );
}


function base64UrlEncode(value) {

    return Buffer
        .from(value)
        .toString("base64url");
}


function base64UrlDecode(value) {

    return Buffer
        .from(value, "base64url")
        .toString("utf8");
}


function sign(payloadBase64) {

    return crypto
        .createHmac(
            "sha256",
            getSecret()
        )
        .update(payloadBase64)
        .digest("base64url");
}


function generateAttendanceToken({
    sessionId,
    slot,
    nonce
}) {

    const payload = {
        sid: sessionId,
        slot,
        nonce
    };


    const payloadBase64 =
        base64UrlEncode(
            JSON.stringify(payload)
        );


    const signature =
        sign(payloadBase64);


    return (
        `${payloadBase64}.${signature}`
    );
}


function verifyAttendanceToken(
    token
) {

    if (
        typeof token !== "string" ||
        !token.includes(".")
    ) {

        return {
            valid: false,
            reason:
                "INVALID_TOKEN_FORMAT"
        };
    }


    const parts =
        token.split(".");


    if (parts.length !== 2) {

        return {
            valid: false,
            reason:
                "INVALID_TOKEN_FORMAT"
        };
    }


    const [
        payloadBase64,
        receivedSignature
    ] = parts;


    if (
        !payloadBase64 ||
        !receivedSignature
    ) {

        return {
            valid: false,
            reason:
                "INVALID_TOKEN_FORMAT"
        };
    }


    let payload;

    try {

        payload =
            JSON.parse(
                base64UrlDecode(
                    payloadBase64
                )
            );

    } catch {

        return {
            valid: false,
            reason:
                "INVALID_TOKEN_PAYLOAD"
        };
    }


    if (
        !payload ||
        typeof payload.sid !== "string" ||
        typeof payload.nonce !== "string" ||
        typeof payload.slot !== "number" ||
        !Number.isSafeInteger(payload.slot)
    ) {

        return {
            valid: false,
            reason:
                "INVALID_TOKEN_PAYLOAD"
        };
    }


    const expectedSignature =
        sign(payloadBase64);


    const receivedBuffer =
        Buffer.from(
            receivedSignature
        );

    const expectedBuffer =
        Buffer.from(
            expectedSignature
        );


    if (
        receivedBuffer.length !==
        expectedBuffer.length
    ) {

        return {
            valid: false,
            reason:
                "INVALID_SIGNATURE"
        };
    }


    if (
        !crypto.timingSafeEqual(
            receivedBuffer,
            expectedBuffer
        )
    ) {

        return {
            valid: false,
            reason:
                "INVALID_SIGNATURE"
        };
    }


    return {
        valid: true,
        payload
    };
}


function isSlotFresh(
    slot,
    time = Date.now()
) {
    // Tokens are issued by this server, so clock-skew handling must never
    // authorize a slot from the future. Require the canonical numeric slot
    // type as well as an integer to reject coerced values and fractional slots.
    if (!Number.isSafeInteger(slot)) {
        return false;
    }

    const currentSlot = getCurrentSlot(time);
    const slotsBehind = currentSlot - slot;

    return (
        slotsBehind >= 0 &&
        slotsBehind <= QR_ALLOWED_SKEW_SLOTS
    );
}

function getSlotExpiry(slot) {
    if (!Number.isSafeInteger(slot)) {
        throw new TypeError("slot must be a safe integer");
    }

    // Slots are server-clock intervals. The slot remains fresh through the
    // configured previous-slot grace; it expires at the next slot boundary.
    return new Date(
        (slot + QR_ALLOWED_SKEW_SLOTS + 1) * QR_REFRESH_MS
    );
}


module.exports = {
    generateAttendanceToken,
    verifyAttendanceToken,
    isSlotFresh,
    getCurrentSlot,
    getSlotExpiry
};
