const express = require("express");

const AuthRoute = express.Router();

const {
    Signup,
    Login,
    forgotPassword,
    verifyResetOtp,
    newPassword
} = require("./AuthController");

AuthRoute.post("/signup", Signup);

AuthRoute.post("/login", Login);

AuthRoute.post("/forget-password", forgotPassword);

AuthRoute.post("/verify-reset-otp", verifyResetOtp);

AuthRoute.post("/reset-password", newPassword);

module.exports = AuthRoute;