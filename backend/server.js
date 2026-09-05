require("dotenv").config();

const express = require("express");
const connectDB = require("./src/config/mongoDb");

const app = express();

// Body parser
app.use(express.json());

// Routes
const AuthRouter = require("./src/modules/Auth/AuthRouter");

app.use("/auth", AuthRouter);

app.get("/", (req, res) => {
    res.send("Attendance system is Backend Running 🚀");
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err);

    res.status(500).json({
        success: false,
        message: err.message || "Internal Server Error"
    });
});

// Database
connectDB();

// Server
app.listen(process.env.PORT, () => {
    console.log("Server is running on port", process.env.PORT);
});
