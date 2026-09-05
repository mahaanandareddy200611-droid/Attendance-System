const express = require("express");

const AuthRoute = express.Router();

const {
    Signup,Login
} = require("./AuthController");

// AuthRoute.post("/register", register);
AuthRoute.post("/signup", Signup);
AuthRoute.post("/login", Login);
AuthRoute.post("/forget-password",forgotPassword)
AuthRoute.post("/verify-reset-otp",verifyResetOtp)
AuthRoute.post("/reset-password",newPassword)

module.exports = AuthRoute;