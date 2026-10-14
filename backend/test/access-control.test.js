const { test } = require("node:test");
const assert = require("node:assert/strict");
const authorize = require("../src/middlewares/authorize");
const { signup } = require("../src/modules/Auth/AuthValidator");

test("public signup removes a client supplied privileged role", () => {
  const result = signup.validate(
    {
      name: "Example Student",
      RollNumber: "24BCS001",
      email: "student@example.edu",
      password: "safe-password",
      mobileNumber: "1234567890",
      role: "Admin",
    },
    { stripUnknown: true },
  );

  assert.equal(result.error, undefined);
  assert.equal(Object.hasOwn(result.value, "role"), false);
});

test("authorization allows only an explicitly listed role", () => {
  const middleware = authorize("Admin");
  let nextError;
  let nextCalled = false;

  middleware(
    { user: { id: "admin-id", role: "Admin" } },
    {},
    (error) => {
      nextCalled = true;
      nextError = error;
    },
  );

  assert.equal(nextCalled, true);
  assert.equal(nextError, undefined);
});

test("authorization rejects a different role with HTTP 403", () => {
  let nextError;
  authorize("Admin")(
    { user: { id: "student-id", role: "Student" } },
    {},
    (error) => { nextError = error; },
  );

  assert.equal(nextError.statusCode, 403);
});

test("authorization rejects missing authentication with HTTP 401", () => {
  let nextError;
  authorize("Lecturer")({}, {}, (error) => { nextError = error; });

  assert.equal(nextError.statusCode, 401);
});
