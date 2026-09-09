const mongoose = require("mongoose");

const connectDB = async () => {

    try {

        if (!process.env.MONGO_URL) {
            throw new Error(
                "MONGO_URL is not configured"
            );
        }

        await mongoose.connect(
            process.env.MONGO_URL
        );

        console.log(
            "MongoDB Connected ✅"
        );

    } catch (error) {

        console.error(
            "MongoDB Connection Failed ❌"
        );

        console.error(
            error.message
        );

        throw error;
    }
};

module.exports =
    connectDB;