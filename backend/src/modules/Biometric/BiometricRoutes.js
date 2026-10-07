const express =
    require("express");

const Auth =
    require("../../middlewares/Auth");

const authorize =
    require("../../middlewares/authorize");

const upload =
    require("./BiometricUpload");

const {
    enroll,
    createChallenge,
    verify
} = require("./BiometricController");


const router =
    express.Router();


router.post(
    "/enroll",
    Auth,
    authorize("Student"),
    upload.single("image"),
    enroll
);


router.post(
    "/challenge",
    Auth,
    authorize("Student"),
    createChallenge
);


router.post(
    "/verify",
    Auth,
    authorize("Student"),
    upload.single("image"),
    verify
);


module.exports =
    router;