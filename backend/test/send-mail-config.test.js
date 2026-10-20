"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readMailConfig, createMailer } = require("../src/utils/sendMail");

test("SMTP configuration honors explicit host and port", () => {
    const config = readMailConfig({
        MAIL_USER: "mailer@example.test",
        MAIL_PASSWORD: "test-secret",
        MAIL_HOST: "smtp.example.test",
        MAIL_PORT: "587"
    });
    assert.equal(config.host, "smtp.example.test");
    assert.equal(config.port, 587);
    assert.equal(config.secure, false);
    assert.equal(config.auth.user, "mailer@example.test");
});

test("SMTP configuration rejects missing or invalid port", () => {
    assert.throws(
        () => readMailConfig({ MAIL_USER: "a@b.test", MAIL_PASSWORD: "x", MAIL_HOST: "smtp.example.test" }),
        /MAIL_PORT/
    );
    assert.throws(
        () => readMailConfig({ MAIL_USER: "a@b.test", MAIL_PASSWORD: "x", MAIL_HOST: "smtp.example.test", MAIL_PORT: "70000" }),
        /MAIL_PORT/
    );
});

test("legacy Gmail configuration remains available when no host is specified", () => {
    const config = readMailConfig({ MAIL_USER: "mailer@example.test", MAIL_PASSWORD: "app-password" });
    assert.equal(config.service, "gmail");
    assert.equal(config.auth.pass, "app-password");
});

test("mailer initializes lazily and never returns message body", async () => {
    let transportConfig;
    let message;
    const mailer = createMailer({
        env: { MAIL_USER: "mailer@example.test", MAIL_PASSWORD: "x", MAIL_HOST: "smtp.example.test", MAIL_PORT: "465" },
        createTransport(config) {
            transportConfig = config;
            return { async sendMail(input) { message = input; return { messageId: "provider-id", response: "secret response" }; } };
        }
    });
    const result = await mailer.sendMail({ to: "student@example.test", subject: "Test", text: "body", html: "<p>body</p>" });
    assert.equal(transportConfig.secure, true);
    assert.equal(message.to, "student@example.test");
    assert.deepEqual(result, { messageId: "provider-id" });
});
