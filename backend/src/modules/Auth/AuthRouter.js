const express = require("express");

const AuthRoute = express.Router();

const validate = require("../../utils/validate");

const { signup,login,forgotPassword: forgotPasswordSchema,otp,newpassword } = require("./AuthValidator");
const {
    Signup,
    Login,
    forgotPassword,
    verifyResetOtp,
    newPassword
} = require("./AuthController");



AuthRoute.post("/signup",Signup);

AuthRoute.post("/login",validate(login), Login);

AuthRoute.post("/forget-password",validate(forgotPasswordSchema), forgotPassword);

AuthRoute.post("/verify-reset-otp",validate(otp), verifyResetOtp);

AuthRoute.post("/reset-password",validate(newpassword), newPassword);

module.exports = AuthRoute;