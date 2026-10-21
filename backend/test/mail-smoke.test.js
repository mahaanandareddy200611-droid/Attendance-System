"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidAddress, runMailSmoke } = require("../scripts/mail-smoke");

test("mail smoke requires a syntactically valid test recipient", async () => {
  let called = false;
  await assert.rejects(
    runMailSmoke({ recipient: "", send: async () => { called = true; return {}; } }),
    /MAIL_SMOKE_TO/,
  );
  assert.equal(called, false);
  assert.equal(isValidAddress("student@example.test"), true);
  assert.equal(isValidAddress("not-an-address"), false);
  assert.equal(isValidAddress("two@@example.test"), false);
  assert.equal(isValidAddress("student@.example.test"), false);
  assert.equal(isValidAddress(" student@example.test "), true);
});

test("mail smoke sends a non-sensitive message and returns no credentials", async () => {
  let message;
  const result = await runMailSmoke({
    recipient: "qa@example.test",
    send: async (value) => { message = value; return { messageId: "provider-msg-1" }; },
  });
  assert.equal(message.to, "qa@example.test");
  assert.match(message.subject, /email delivery check/i);
  assert.equal(message.text.includes("OTP"), false);
  assert.deepEqual(result, { accepted: true, messageId: "provider-msg-1" });
});
