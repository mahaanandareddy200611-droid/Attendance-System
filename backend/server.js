const dotenv = require("dotenv");
dotenv.config();

const app = require("./src/app");
const connectDB = require("./src/config/mongoDb");

const { connectRedis } = require("./src/config/redis");

const startServer = async () => {
    try {
        await connectDB();

        await connectRedis();

        const server = app.listen(
            config.port,
            () => {
                console.log(
                    `Attendance backend running on port ${config.port}`
                );
            }
        );

        const shutdown = async (signal) => {
            console.log(`${signal} received. Shutting down...`);

            server.close(async () => {
                try {
                    const mongoose = require("mongoose");

                    await mongoose.connection.close();

                    console.log("MongoDB connection closed");

                    process.exit(0);
                } catch (error) {
                    console.error(
                        "Shutdown failed:",
                        error
                    );

                    process.exit(1);
                }
            });
        };

        process.on("SIGINT", () => shutdown("SIGINT"));
        process.on("SIGTERM", () => shutdown("SIGTERM"));

    } catch (error) {
        console.error(
            "Server startup failed:",
            error.message
        );

        process.exit(1);
    }
};

startServer();