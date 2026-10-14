const express =
    require("express");

const Auth =
    require("../../middlewares/Auth");

const authorize =
    require("../../middlewares/authorize");
const validate = require("../../utils/validate");
const { challenge: challengeSchema, verify: verifySchema } = require("./BiometricValidator");

const upload =
    require("./BiometricUpload");

const {
    enroll,
    createChallenge,
    verify,
    getMyEnrollment
} = require("./BiometricController");


const router =
    express.Router();

router.get("/me", Auth, authorize("Student"), getMyEnrollment);


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
    validate(challengeSchema),
    createChallenge
);


router.post(
    "/verify",
    Auth,
    authorize("Student"),
    upload.single("image"),
    validate(verifySchema),
    verify
);


module.exports =
    router;
