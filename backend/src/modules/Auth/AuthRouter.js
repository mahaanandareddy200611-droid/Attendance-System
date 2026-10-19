
const express = require("express");

const AuthRoute = express.Router();

const validate = require("../../utils/validate");
const authenticate = require("../../middlewares/Auth");
const authorize = require("../../middlewares/authorize");
const { createRateLimiter } = require("../../middlewares/rateLimiter");

const {
    signup,
    login,
    forgotPassword: forgotPasswordSchema,
    otp,
    newpassword,
    createLecturer
} = require("./AuthValidator");

const {
    Signup,
    Login,
    Me,
    forgotPassword,
    verifyResetOtp,
    newPassword,
    CreateLecturer
} = require("./AuthController");

// Broad IP protection: the capacity accommodates legitimate
// users sharing a university/campus network.
const authIpRateLimit = createRateLimiter({
    keyGenerator: (req) => `auth:ip:${req.ip}`,
    capacity: Number(process.env.AUTH_IP_RATE_CAPACITY) || 120,
    refillPerSecond:
        Number(process.env.AUTH_IP_RATE_REFILL) || 2
});

// Strict per-email limit prevents repeated password guesses against
// one account, even if requests come from a single client using
// several different source IP addresses.
const loginEmailRateLimit = createRateLimiter({
    keyGenerator: (req) =>
        `auth:login:email:${String(req.body.email).trim().toLowerCase()}`,
    capacity: Number(process.env.AUTH_LOGIN_EMAIL_CAPACITY) || 8,
    refillPerSecond:
        Number(process.env.AUTH_LOGIN_EMAIL_REFILL) || 0.1
});

// Share a separate account-level bucket across password recovery
// operations to limit repeated OTP requests and verification attempts.
const recoveryEmailRateLimit = createRateLimiter({
    keyGenerator: (req) =>
        `auth:recovery:email:${String(req.body.email).trim().toLowerCase()}`,
    capacity:
        Number(process.env.AUTH_RECOVERY_EMAIL_CAPACITY) || 5,
    refillPerSecond:
        Number(process.env.AUTH_RECOVERY_EMAIL_REFILL) || 0.05
});

// Public registration: count even malformed attempts against the IP.
AuthRoute.post(
    "/signup",
    authIpRateLimit,
    validate(signup),
    Signup
);

// Login: IP protection first, then schema validation, then account limit.
AuthRoute.post(
    "/login",
    authIpRateLimit,
    validate(login),
    loginEmailRateLimit,
    Login
);

// Protected current-user endpoint.
AuthRoute.get("/me", authenticate, Me);

// Only administrators can create lecturer accounts.
AuthRoute.post(
    "/lecturers",
    authenticate,
    authorize("Admin"),
    validate(createLecturer),
    CreateLecturer
);

// Password recovery operations share an account-level rate limit.
AuthRoute.post(
    "/forget-password",
    authIpRateLimit,
    validate(forgotPasswordSchema),
    recoveryEmailRateLimit,
    forgotPassword
);

AuthRoute.post(
    "/verify-reset-otp",
    authIpRateLimit,
    validate(otp),
    recoveryEmailRateLimit,
    verifyResetOtp
);

AuthRoute.post(
    "/reset-password",
    authIpRateLimit,
    validate(newpassword),
    recoveryEmailRateLimit,
    newPassword
);

module.exports = AuthRoute;
