"use strict";

require("dotenv").config();
const { sendMail } = require("../src/utils/sendMail");

function isValidAddress(value) {
    if (typeof value !== "string") return false;
    const address = value.trim();
    const at = address.indexOf("@");
    if (
        at < 1 ||
        at !== address.lastIndexOf("@") ||
        address.split("").some((character) => character.charCodeAt(0) <= 32) ||
        at >= address.length - 1
    ) {
        return false;
    }

    const domain = address.slice(at + 1);
    const dot = domain.lastIndexOf(".");
    return dot > 0 && dot < domain.length - 1 && !domain.startsWith(".") && !domain.endsWith(".");
}

async function runMailSmoke({ recipient = process.env.MAIL_SMOKE_TO, send = sendMail } = {}) {
    if (!isValidAddress(recipient)) {
        throw new Error("Set MAIL_SMOKE_TO to a test inbox address");
    }
    const result = await send({
        to: recipient.trim(),
        subject: "Attendance System email delivery check",
        text: "This is a one-time email delivery check for the Attendance System staging configuration. No account code or personal data is included.",
        html: "<p>This is a one-time email delivery check for the Attendance System staging configuration. No account code or personal data is included.</p>",
    });
    return { accepted: true, messageId: result?.messageId || null };
}

if (require.main === module) {
    runMailSmoke()
        .then(({ messageId }) => {
            console.log("EMAIL SMOKE TEST PASSED; message accepted by mail transport.");
            if (messageId) console.log("Provider message ID was returned.");
        })
        .catch((error) => {
            console.error("EMAIL SMOKE TEST FAILED:", error.message);
            process.exitCode = 1;
        });
}

module.exports = { isValidAddress, runMailSmoke };
