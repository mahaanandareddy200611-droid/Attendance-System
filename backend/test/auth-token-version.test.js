
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET ||= "test-only-jwt-secret-not-for-production";

const User = require("../src/models/Auth.model");
const Auth = require("../src/middlewares/Auth");

function makeToken(overrides = {}) {
    return jwt.sign(
        {
            id: "test-user-123",
            role: "Student",
            tokenVersion: 0,
            ...overrides
        },
        process.env.JWT_SECRET,
        { expiresIn: "5m" }
    );
}

function mockUser(t, user) {
  t.mock.method(User, "findById", () => ({
    select() {
      return {
        lean: async () => user,
      };
    },
  }));
}

async function runAuth(token, t, user) {
    mockUser(t, user);

    const req = {
        headers: {
            authorization: `Bearer ${token}`
        }
    };

    let nextCalled = false;
    let nextError;

    await Auth(req, {}, (error) => {
        nextCalled = true;
        nextError = error;
    });

    return { req, nextCalled, nextError };
}

function activeUser(tokenVersion = 0) {
    return {
        _id: "test-user-123",
        role: "Student",
        status: "ACTIVE",
        tokenVersion
    };
}

test("accepts a token whose version matches the database", async (t) => {
    const result = await runAuth(
        makeToken({ tokenVersion: 0 }),
        t,
        activeUser(0)
    );

    assert.equal(result.nextCalled, true);
    assert.equal(result.nextError, undefined);
    assert.equal(result.req.user.id, "test-user-123");
});

test("rejects an old token after its version is incremented", async (t) => {
    const result = await runAuth(
        makeToken({ tokenVersion: 0 }),
        t,
        activeUser(1)
    );

    assert.equal(result.nextError.statusCode, 401);
    assert.match(result.nextError.message, /revoked/i);
});

test("rejects legacy tokens without a version claim", async (t) => {
    const token = jwt.sign(
        {
            id: "test-user-123",
            role: "Student"
        },
        process.env.JWT_SECRET,
        { expiresIn: "5m" }
    );

    const result = await runAuth(token, t, activeUser(0));

    assert.equal(result.nextError.statusCode, 401);
});

test("uses the database role rather than a stale JWT role", async (t) => {
    const result = await runAuth(
        makeToken({ role: "Admin", tokenVersion: 0 }),
        t,
        {
            ...activeUser(0),
            role: "Student"
        }
    );

    assert.equal(result.nextError, undefined);
    assert.equal(result.req.user.role, "Student");
});
