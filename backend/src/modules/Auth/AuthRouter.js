const express = require("express");

const AuthRoute = express.Router();

const validate = require("../../utils/validate");
const authenticate = require("../../middlewares/Auth");
const authorize = require("../../middlewares/authorize");

const {
  signup,
  login,
  forgotPassword: forgotPasswordSchema,
  otp,
  newpassword,
  createLecturer,
} = require("./AuthValidator");

const {
  Signup,
  Login,
  Me,
  forgotPassword,
  verifyResetOtp,
  newPassword,
  CreateLecturer,
} = require("./AuthController");

// Public authentication routes
AuthRoute.post("/signup", validate(signup), Signup);
AuthRoute.post("/login", validate(login), Login);

// Protected route: requires a valid JWT
AuthRoute.get("/me", authenticate, Me);
AuthRoute.post(
  "/lecturers",
  authenticate,
  authorize("Admin"),
  validate(createLecturer),
  CreateLecturer,
);

// Password recovery routes
AuthRoute.post(
  "/forget-password",
  validate(forgotPasswordSchema),
  forgotPassword,
);

AuthRoute.post("/verify-reset-otp", validate(otp), verifyResetOtp);

AuthRoute.post("/reset-password", validate(newpassword), newPassword);

module.exports = AuthRoute;
