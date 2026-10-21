"use strict";

const { URL } = require("node:url");
const isTrue = (value) => String(value || "").trim().toLowerCase() === "true";

function isUrl(value, protocols, { allowCredentials = false } = {}) {
    try {
        const url = new URL(String(value || ""));
        return protocols.includes(url.protocol) &&
            (allowCredentials || (!url.username && !url.password));
    } catch {
        return false;
    }
}

function validateRuntimeConfig(env = process.env) {
    const invalid = [];
    const jwtSecret = String(env.JWT_SECRET || "");
    const attendanceSecret = String(env.ATTENDANCE_TOKEN_SECRET || "");

    for (const key of ["MONGO_URL", "REDIS_URL", "JWT_SECRET", "ATTENDANCE_TOKEN_SECRET"]) {
        if (!String(env[key] || "").trim()) invalid.push(key);
    }

    for (const key of ["JWT_SECRET", "ATTENDANCE_TOKEN_SECRET"]) {
        const value = String(env[key] || "");
        if (value && value.length < 32) invalid.push(key + " (must be at least 32 characters)");
    }
    if (jwtSecret && attendanceSecret && jwtSecret === attendanceSecret) {
        invalid.push("JWT_SECRET and ATTENDANCE_TOKEN_SECRET (must be different values)");
    }

    if (env.MONGO_URL && !isUrl(env.MONGO_URL, ["mongodb:", "mongodb+srv:"], { allowCredentials: true })) {
        invalid.push("MONGO_URL (invalid MongoDB URI)");
    }
    if (env.REDIS_URL && !isUrl(env.REDIS_URL, ["redis:", "rediss:"], { allowCredentials: true })) {
        invalid.push("REDIS_URL (invalid Redis URI)");
    }

    if (isTrue(env.ATTENDANCE_REQUIRE_BIOMETRIC)) {
        if (!isUrl(env.BIOMETRIC_BASE_URL, env.NODE_ENV === "production" ? ["https:"] : ["http:", "https:"])) invalid.push("BIOMETRIC_BASE_URL (HTTPS required in production)");
        if (!String(env.BIOMETRIC_API_KEY || "").trim()) invalid.push("BIOMETRIC_API_KEY");
    }

    if (isTrue(env.ATTENDANCE_REQUIRE_PRIVATE_STORAGE)) {
        const storageKeys = [
            "OBJECT_STORAGE_ENDPOINT",
            "OBJECT_STORAGE_BUCKET",
            "OBJECT_STORAGE_ACCESS_KEY_ID",
            "OBJECT_STORAGE_SECRET_ACCESS_KEY"
        ];
        for (const key of storageKeys) {
            if (!String(env[key] || "").trim()) invalid.push(key);
        }
        if (!storageKeys.some((key) => !String(env[key] || "").trim())) {
            try {
                require("../infrastructure/storage/PrivateObjectStorage").getConfiguration(env);
            } catch {
                invalid.push("OBJECT_STORAGE_* (invalid configuration)");
            }
        }
    }

    if (isTrue(env.ATTENDANCE_REQUIRE_EMAIL)) {
        try {
            require("../utils/sendMail").readMailConfig(env);
        } catch {
            invalid.push("MAIL_USER / MAIL_PASSWORD / MAIL_HOST / MAIL_PORT");
        }
    } else if (String(env.MAIL_HOST || "").trim()) {
        const port = Number(env.MAIL_PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            invalid.push("MAIL_PORT (required when MAIL_HOST is set)");
        }
    }

    if (
        isTrue(env.ATTENDANCE_REQUIRE_BIOMETRIC) ||
        isTrue(env.ATTENDANCE_REQUIRE_PRIVATE_STORAGE) ||
        isTrue(env.ATTENDANCE_REQUIRE_EMAIL)
    ) {
        if (!String(env.CORS_ORIGINS || "").trim()) invalid.push("CORS_ORIGINS");
    }

    if (invalid.length) {
        const error = new Error("Required runtime configuration is missing or invalid");
        error.missingOrInvalid = [...new Set(invalid)];
        throw error;
    }

    return { valid: true };
}

module.exports = { validateRuntimeConfig };
