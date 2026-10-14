require("dotenv").config();

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../src/models/Auth.model");

async function createInitialAdmin() {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_MOBILE } = process.env;
  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD || !ADMIN_MOBILE) {
    throw new Error("Set ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD and ADMIN_MOBILE before running this command.");
  }
  if (ADMIN_PASSWORD.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
  }
  if (!process.env.MONGO_URL) {
    throw new Error("MONGO_URL is not configured.");
  }

  await mongoose.connect(process.env.MONGO_URL);
  const existingAdmin = await User.exists({ role: "Admin" });
  if (existingAdmin) {
    throw new Error("An Admin account already exists. Initial Admin creation is disabled.");
  }

  const password = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await User.create({
    Name: ADMIN_NAME.trim(),
    email: ADMIN_EMAIL.trim().toLowerCase(),
    password,
    mobileNumber: ADMIN_MOBILE.trim(),
    role: "Admin",
    status: "ACTIVE",
  });
  console.log("Initial Admin account created.");
}

createInitialAdmin()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
