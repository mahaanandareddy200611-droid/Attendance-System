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
    initializeSocket
} = require("./src/socket/socket");

const mongoose =
    require("mongoose");

const PORT =
    Number(process.env.PORT) || 3000;

let httpServer;

let shuttingDown = false;


const startServer = async () => {

    try {

        await connectDB();

        await connectRedis();


        httpServer =
            http.createServer(app);


        await initializeSocket(
            httpServer
        );


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


const shutdown =
    async (signal) => {

        if (shuttingDown) {
            return;
        }

        shuttingDown = true;

        console.log(
            `${signal} received. Shutting down...`
        );


        /*
        Stop accepting new HTTP
        connections.
        */
        if (httpServer) {

            await new Promise(
                (resolve) => {

                    httpServer.close(
                        resolve
                    );
                }
            );
        }


        /*
        Close MongoDB.
        */
        await mongoose.connection.close();


        /*
        Close Redis.
        */
        if (
            redisClient.isOpen
        ) {
            await redisClient.quit();
        }


        console.log(
            "Shutdown complete ✅"
        );

        process.exit(0);
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
            "uncaughtException"
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
            "unhandledRejection"
        );
    }
);


startServer();