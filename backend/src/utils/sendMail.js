"use strict";

const nodemailer = require("nodemailer");

function readMailConfig(env = process.env) {
    const user = String(env.MAIL_USER || "").trim();
    const password = String(env.MAIL_PASSWORD || "");
    const host = String(env.MAIL_HOST || "").trim();
    const portValue = env.MAIL_PORT;
    const secureValue = String(env.MAIL_SECURE || "").trim().toLowerCase();

    if (!user || !password) {
        throw new Error("Email delivery is not configured");
    }

    if (host) {
        const port = Number(portValue);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error("MAIL_PORT must be a valid TCP port when MAIL_HOST is set");
        }
        return {
            host,
            port,
            secure: secureValue ? secureValue === "true" : port === 465,
            auth: { user, pass: password }
        };
    }

    // Backward-compatible default for existing deployments.
    return {
        service: "gmail",
        auth: { user, pass: password }
    };
}

function createMailer({ env = process.env, createTransport = nodemailer.createTransport } = {}) {
    let transporter;
    return {
        async sendMail({ to, subject, text, html }) {
            if (!transporter) {
                transporter = createTransport(readMailConfig(env));
            }
            const user = String(env.MAIL_USER || "").trim();
            const info = await transporter.sendMail({
                from: `"Attendance System" <${user}>`,
                to,
                subject,
                text,
                html
            });
            // Message IDs are sufficient for operational correlation; never log
            // recipient addresses, OTPs, message bodies, or provider credentials.
            return { messageId: info.messageId };
        }
    };
}

const mailer = createMailer();

async function sendMail(message) {
    return mailer.sendMail(message);
}

module.exports = {
    sendMail,
    readMailConfig,
    createMailer
};
