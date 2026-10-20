"use strict";

const dotenv = require("dotenv");
dotenv.config();

const mongoose = require("mongoose");
const connectDB = require("../src/config/mongoDb");
const { service } = require("../src/modules/AttendanceEvidence/AttendanceEvidenceService");

async function main() {
    try {
        await connectDB();
        const result = await service.runMaintenance();
        // Counts only: never log student IDs, object keys, signed URLs, or provider payloads.
        console.info("Attendance evidence maintenance completed", result);
    } finally {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
    }
}

main().catch((error) => {
    console.error("Attendance evidence maintenance failed", {
        name: error?.name || "Error",
        code: error?.code || "UNKNOWN"
    });
    process.exitCode = 1;
});
