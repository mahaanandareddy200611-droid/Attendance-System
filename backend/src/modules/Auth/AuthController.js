const asyncHandler = require("../../middlewares/asyncHandler");
const authservice = require("./AuthService");

exports.Signup = asyncHandler(async (req, res) => {
    const {
        name,
        RollNumber,
        email,
        password,
        role,
        faceImage_url,
        mobileNumber
    } = req.body;

    const data = await authservice.Signup(
        name,
        RollNumber,
        email,
        password,
        role,
        faceImage_url,
        mobileNumber
    );

    console.log("New user created");

    return res.status(201).json({
        success: true,
        message: "Account created successfully",
        data: {
            id: data._id,
            email: data.email,
            RollNumber: data.RollNumber,
            name: data.Name,
            mobileNumber: data.mobileNumber,
            role: data.role,
            faceImage_url: data.faceImage_url
        }
    });
});


exports.Login = asyncHandler(async (req, res) => {
    const {
        email,
        password
    } = req.body;

    const data = await authservice.Login(email, password);

    console.log("User logged in");

    return res.status(200).json({
        success: true,
        message: "Login successful",
        data: {
            id: data.user._id,
            email: data.user.email,
            RollNumber: data.user.RollNumber,
            name: data.user.Name,
            mobileNumber: data.user.mobileNumber,
            role: data.user.role,
            faceImage_url: data.user.faceImage_url
        },
        token: data.token
    });
});


exports.forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;

    await authservice.forgotPassword(email);

    return res.status(200).json({
        success: true,
        message: "If an account with this email exists, an OTP has been sent."
    });
});


exports.verifyResetOtp = asyncHandler(async (req, res) => {
    const { otp, email } = req.body;

    await authservice.verifyResetOTP(otp, email);

    return res.status(200).json({
        success: true,
        message: "OTP verified successfully"
    });
});


exports.newPassword = asyncHandler(async (req, res) => {
    const { password, email } = req.body;

    await authservice.password(password, email);

    return res.status(200).json({
        success: true,
        message: "Password changed successfully"
    });
});