const http = require("http");
const dotenv = require("dotenv");

dotenv.config();

const app =
    require("./src/app");

const connectDB =
    require("./src/config/mongoDb");

const {
    connectRedis,
    redisClient
} = require("./src/config/redis");

const {
    initializeSocket,
    closeSocket
} = require("./src/socket/socket");

const { expireExpiredSessions } = require("./src/modules/Attendance/AttendanceService");
const { sweepExpiredMediaAssets } = require("./src/modules/Media/MediaService");

const mongoose =
    require("mongoose");

const PORT =
    Number(process.env.PORT) || 3000;

let httpServer;

let shuttingDown = false;
let expirationSweepTimer;
let expirationSweepRunning = false;

const runExpirationSweep = async () => {
    if (expirationSweepRunning || shuttingDown) return;
    expirationSweepRunning = true;
    try {
        const expiredSessionIds = await expireExpiredSessions();
        if (expiredSessionIds.length > 0) {
            console.info("Expired attendance sessions finalized", { count: expiredSessionIds.length });
        }
        const mediaCleanup = await sweepExpiredMediaAssets({ limit: 25 });
        if (mediaCleanup.deleted > 0 || mediaCleanup.failed > 0) {
            console.info("Retained media cleanup cycle completed", mediaCleanup);
        }
    } catch (error) {
        // Do not emit database details or student identifiers into routine logs.
        console.error("Attendance session expiry sweep failed", {
            name: error?.name || "Error",
            code: error?.code || "UNKNOWN"
        });
    } finally {
        expirationSweepRunning = false;
    }
};


const startServer = async () => {

    try {

        await connectDB();

        await connectRedis();


        httpServer =
            http.createServer(app);


        await initializeSocket(
            httpServer
        );

        const expirySweepMs = Math.max(5000, Number(process.env.SESSION_EXPIRY_SWEEP_MS) || 15000);
        expirationSweepTimer = setInterval(() => { void runExpirationSweep(); }, expirySweepMs);
        expirationSweepTimer.unref();
        void runExpirationSweep();


        httpServer.listen(
            PORT,
            () => {

                console.log(
                    `Attendance backend running on port ${PORT}`
                );
            }
        );


    } catch (error) {

        console.error(
            "Server startup failed ❌"
        );

        console.error(
            error
        );

        process.exit(1);
    }
};


const shutdown = async (signal, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`${signal} received. Shutting down...`);

    if (expirationSweepTimer) clearInterval(expirationSweepTimer);

    // A stuck HTTP/WebSocket connection must not prevent the process from
    // terminating forever during a platform rollout or fatal exception.
    const forceExitTimer = setTimeout(() => {
        console.error("Graceful shutdown timed out");
        process.exit(1);
    }, 10000);

    try {
        try {
            // PATCH: wait for active attendance-session expiry sweep before closing dependencies.
            // The shutdown path must clear the timer and prevent new sweeps first.
            while (expirationSweepRunning) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            await closeSocket();
        } catch (error) {
            exitCode = 1;
            console.error("Socket shutdown failed", { name: error?.name || "Error" });
        }

        if (httpServer?.listening) {
            await new Promise((resolve) => httpServer.close(() => resolve()));
        }

        try {
            await mongoose.connection.close();
        } catch (error) {
            exitCode = 1;
            console.error("MongoDB shutdown failed", { name: error?.name || "Error" });
        }

        if (redisClient.isOpen) {
            try {
                await redisClient.quit();
            } catch (error) {
                exitCode = 1;
                console.error("Redis shutdown failed", { name: error?.name || "Error" });
            }
        }

        console.log("Shutdown complete");
    } catch (error) {
        exitCode = 1;
        console.error("Shutdown failed", { name: error?.name || "Error" });
    } finally {
        clearTimeout(forceExitTimer);
        process.exit(exitCode);
    }
};


process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);


process.on(
    "uncaughtException",
    (error) => {

        console.error(
            "UNCAUGHT EXCEPTION:",
            error
        );

        shutdown(
            "uncaughtException",
            1
        );
    }
);


process.on(
    "unhandledRejection",
    (error) => {

        console.error(
            "UNHANDLED REJECTION:",
            error
        );

        shutdown(
            "unhandledRejection",
            1
        );
    }
);


startServer();