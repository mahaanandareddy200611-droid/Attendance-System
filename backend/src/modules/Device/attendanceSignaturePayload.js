"use strict";

function canonicalNumber(value, fieldName) {
    if (
        value === null ||
        value === undefined ||
        (typeof value === "string" && value.trim() === "")
    ) {
        throw new TypeError(`${fieldName} must be a finite number`);
    }

    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new TypeError(`${fieldName} must be a finite number`);
    }

    // Avoid two textual representations of numeric negative zero.
    return Object.is(number, -0) ? "0" : String(number);
}

function canonicalTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new TypeError("capturedAt must be a valid timestamp");
    }
    return date.toISOString();
}

/**
 * Canonical Ed25519 attendance-signature payload, version 2.
 * Always serialize a fixed-order JSON array of strings so separators inside
 * request values cannot create ambiguous signed messages.
 */
function buildAttendanceSignaturePayload({
    deviceId,
    sessionId,
    token,
    idempotencyKey,
    biometricAssertionId,
    latitude,
    longitude,
    accuracyMeters,
    capturedAt
} = {}) {
    const values = [
        "ATTENDANCE_V2",
        String(deviceId ?? ""),
        String(sessionId ?? ""),
        String(token ?? ""),
        String(idempotencyKey ?? ""),
        String(biometricAssertionId ?? ""),
        canonicalNumber(latitude, "latitude"),
        canonicalNumber(longitude, "longitude"),
        canonicalNumber(accuracyMeters, "accuracyMeters"),
        canonicalTimestamp(capturedAt)
    ];

    return JSON.stringify(values);
}

module.exports = { buildAttendanceSignaturePayload };