const express = require("express");
const Joi = require("joi");

const Auth = require("../../middlewares/Auth");
const authorize = require("../../middlewares/authorize");
const validate = require("../../utils/validate");
const upload = require("../Biometric/BiometricUpload");
const controller = require("./MediaController");

const router = express.Router();
const evidenceSchema = Joi.object({
  sessionId: Joi.string().trim().min(8).max(200).required(),
});

router.post(
  "/evidence",
  Auth,
  authorize("Lecturer", "Admin"),
  upload.single("image"),
  upload.validateImageBytes,
  validate(evidenceSchema),
  controller.uploadEvidence,
);

router.get(
  "/:assetId/url",
  Auth,
  authorize("Lecturer", "Admin"),
  controller.getDownloadUrl,
);

router.delete(
  "/:assetId",
  Auth,
  authorize("Lecturer", "Admin"),
  controller.deleteMedia,
);

module.exports = router;
