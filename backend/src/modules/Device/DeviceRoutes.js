const express =
    require("express");

const Auth =
    require("../../middlewares/Auth");

const authorize =
    require("../../middlewares/authorize");

const {
    registrationChallenge,
    registerDevice
} = require("./DeviceController");


const router =
    express.Router();


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
    registerDevice
);


module.exports =
    router;