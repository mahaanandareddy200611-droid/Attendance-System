const crypto = require("crypto");

const QR_REFRESH_MS =
    Number(process.env.QR_REFRESH_MS) || 500;

const SECRET =
    process.env.ATTENDANCE_TOKEN_SECRET;

if (!SECRET) {
    throw new Error(
        "ATTENDANCE_TOKEN_SECRET is not configured"
    );
}

function getCurrentSlot(time = Date.now()) {
    return Math.floor(time / QR_REFRESH_MS);
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
        .createHmac("sha256", SECRET)
        .update(payloadBase64)
        .digest("base64url");
}

function generateAttendanceToken(sessionId) {

    const slot = getCurrentSlot();

    const payload = {
        sid: sessionId,
        slot
    };

    const payloadBase64 =
        base64UrlEncode(
            JSON.stringify(payload)
        );

    const signature =
        sign(payloadBase64);

    return `${payloadBase64}.${signature}`;
}

function verifyAttendanceToken(token) {

    if (
        typeof token !== "string" ||
        !token.includes(".")
    ) {
        return {
            valid: false,
            reason: "INVALID_TOKEN_FORMAT"
        };
    }

    const [payloadBase64, receivedSignature] =
        token.split(".");

    if (!payloadBase64 || !receivedSignature) {
        return {
            valid: false,
            reason: "INVALID_TOKEN_FORMAT"
        };
    }

    let payload;

    try {
        payload = JSON.parse(
            base64UrlDecode(payloadBase64)
        );
    } catch {
        return {
            valid: false,
            reason: "INVALID_TOKEN_PAYLOAD"
        };
    }

    const expectedSignature =
        sign(payloadBase64);

    const receivedBuffer =
        Buffer.from(receivedSignature);

    const expectedBuffer =
        Buffer.from(expectedSignature);

    if (
        receivedBuffer.length !==
        expectedBuffer.length
    ) {
        return {
            valid: false,
            reason: "INVALID_SIGNATURE"
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
            reason: "INVALID_SIGNATURE"
        };
    }

    return {
        valid: true,
        payload
    };
}

function isSlotFresh(slot) {

    const currentSlot =
        getCurrentSlot();

    const allowedSkew =
        Number(
            process.env.QR_ALLOWED_SKEW_SLOTS
        ) || 1;

    return (
        Math.abs(
            currentSlot - Number(slot)
        ) <= allowedSkew
    );
}

module.exports = {
    generateAttendanceToken,
    verifyAttendanceToken,
    isSlotFresh,
    getCurrentSlot
};