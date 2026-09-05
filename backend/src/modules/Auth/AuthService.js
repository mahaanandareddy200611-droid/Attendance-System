const User = require("../../models/Auth.model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
exports.Signup = async (
    name,
    RollNumber,
    email,
    password,
    role,
    faceImage_url,
    mobileNumber
) => {
    // Check existing email
    const existingEmail = await User.findOne({ email });

    if (existingEmail) {
        throw new Error("Email already registered");
    }

    // Check existing roll number
    if (RollNumber) {
        const existingRoll = await User.findOne({ RollNumber });

        if (existingRoll) {
            throw new Error("Roll number already registered");
        }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const user = await User.create({
        Name: name,
        RollNumber,
        email,
        password: passwordHash,
        mobileNumber,
        faceImage_url,
        role: role || "Student"
    });

    return user;
};


exports.Login = async (email, password) => {

    const user = await User
        .findOne({ email })
        .select("+password");

    if (!user) {
        throw new Error("Invalid email or password");
    }

    const isPasswordValid = await bcrypt.compare(
        password,
        user.password
    );

    if (!isPasswordValid) {
        throw new Error("Invalid email or password");
    }

    const token = jwt.sign(
        {
            userId: user._id,
            role: user.role
        },
        process.env.JWT_SECRET,
        {
            expiresIn: process.env.JWT_EXPIRES_IN || "1d"
        }
    );

    return {
        user,
        token
    };
};