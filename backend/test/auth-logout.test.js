"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const User = require("../src/models/Auth.model");
const authService = require("../src/modules/Auth/AuthService");

test("logout increments tokenVersion for the active authenticated account", async (t) => {
  let filterSeen;
  let updateSeen;
  t.mock.method(User, "updateOne", async (filter, update) => {
    filterSeen = filter;
    updateSeen = update;
    return { matchedCount: 1, modifiedCount: 1 };
  });

  assert.deepEqual(await authService.Logout("user-logout-123"), { revoked: true });
  assert.deepEqual(filterSeen, { _id: "user-logout-123", status: "ACTIVE" });
  assert.equal(updateSeen.$inc.tokenVersion, 1);
});

test("logout rejects when the account is no longer active or cannot be found", async (t) => {
  t.mock.method(User, "updateOne", async () => ({ matchedCount: 0, modifiedCount: 0 }));
  await assert.rejects(
    authService.Logout("user-missing-123"),
    (error) => error.statusCode === 401,
  );
});

test("logout requires an authenticated user identifier", async (t) => {
  let called = false;
  t.mock.method(User, "updateOne", async () => {
    called = true;
    return { matchedCount: 1, modifiedCount: 1 };
  });
  await assert.rejects(authService.Logout(""), (error) => error.statusCode === 401);
  assert.equal(called, false);
});
