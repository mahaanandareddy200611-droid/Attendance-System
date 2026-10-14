const express =
    require("express");

const Auth =
    require("../../middlewares/Auth");

const authorize =
    require("../../middlewares/authorize");
const validate = require("../../utils/validate");
const { registerDevice: registerDeviceSchema } = require("./DeviceValidator");

const {
    registrationChallenge,
    registerDevice,
    getMyDevice,
    revokeMyDevice
} = require("./DeviceController");


const router =
    express.Router();

router.get("/me", Auth, authorize("Student"), getMyDevice);
router.delete("/me", Auth, authorize("Student"), revokeMyDevice);


router.post(
    "/registration-challenge",
    Auth,
    authorize("Student"),
    registrationChallenge
);


router.post(
    "/register",
    Auth,
    authorize("Student"),
    validate(registerDeviceSchema),
    registerDevice
);


module.exports =
    router;
