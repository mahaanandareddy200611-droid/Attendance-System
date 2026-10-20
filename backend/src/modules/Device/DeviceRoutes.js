const express =
    require("express");

const Auth =
    require("../../middlewares/Auth");

const authorize =
    require("../../middlewares/authorize");
const validate = require("../../utils/validate");
const { createRateLimiter } = require("../../middlewares/rateLimiter");
const { registerDevice: registerDeviceSchema } = require("./DeviceValidator");

const {
    registrationChallenge,
    registerDevice,
    getMyDevice,
    revokeMyDevice
} = require("./DeviceController");


const router =
    express.Router();

const deviceIpRateLimit = createRateLimiter({
    keyGenerator: (req) => `device:ip:${req.ip}:${req.path}`,
    capacity: Number(process.env.DEVICE_IP_RATE_CAPACITY) || 500,
    refillPerSecond: Number(process.env.DEVICE_IP_RATE_REFILL) || 10
});

const deviceUserRateLimit = createRateLimiter({
    keyGenerator: (req) => `device:user:${req.user.id}`,
    capacity: Number(process.env.DEVICE_USER_RATE_CAPACITY) || 10,
    refillPerSecond: Number(process.env.DEVICE_USER_RATE_REFILL) || 0.05
});

router.get("/me", Auth, authorize("Student"), getMyDevice);
router.delete("/me", Auth, authorize("Student"), revokeMyDevice);


router.post(
    "/registration-challenge",
    deviceIpRateLimit,
    Auth,
    authorize("Student"),
    deviceUserRateLimit,
    registrationChallenge
);


router.post(
    "/register",
    deviceIpRateLimit,
    Auth,
    authorize("Student"),
    deviceUserRateLimit,
    validate(registerDeviceSchema),
    registerDevice
);


module.exports =
    router;
