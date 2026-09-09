require("dotenv").config();

const express = require("express");
const cors = require("cors");

const connectDB =
    require("./src/config/mongoDb");

const AttendanceRouter =require("./src/modules/Attendance/AttendanceRouter");

const AuthRouter =require("./src/modules/Auth/AuthRouter");

const app = express();


app.use(
    cors({
        origin: true,
        credentials: true
    })
);

app.use(
    express.json({
        limit: "1mb"
    })
);




app.get("/", (req, res) => {

    res.status(200).json({
        success: true,
        message:
            "Attendance system backend running 🚀"})
    })



app.use(
    "/auth",
    AuthRouter
);




app.use(
    "/attendance",
    AttendanceRouter
);




app.use(
    (req, res) => {

        res.status(404).json({
            success: false,
            message:
                `Route not found: ${req.method} ${req.originalUrl}`
        });
    }
);



app.use(
    (err, req, res, next) => {

        console.error(err);

        const statusCode =
            err.statusCode || 500;

        res.status(statusCode).json({
            success: false,

            message:
                err.message ||
                "Internal Server Error"
        });
    }
);




connectDB()
    .then(() => {

        const PORT =
            process.env.PORT || 3000;

        app.listen(
            PORT,
            () => {

                console.log(
                    `Server running on port ${PORT}`
                );
            }
        );
    })
    .catch((error) => {

        console.error(
            "Server startup failed:",
            error.message
        );

        process.exit(1);
    });