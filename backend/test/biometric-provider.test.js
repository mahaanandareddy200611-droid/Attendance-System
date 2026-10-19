
const { test } = require("node:test");
const assert = require("node:assert/strict");

// Test-only configuration. Never put real API keys in test files.
process.env.BIOMETRIC_BASE_URL = "http://biometric.test";
process.env.BIOMETRIC_API_KEY = "test-only-key";
process.env.BIOMETRIC_COLLECTION_ID = "students";
process.env.BIOMETRIC_MATCH_THRESHOLD = "0.40";

const provider = require(
    "../src/modules/Biometric/LocalBiometricProvider"
);

const STUDENT_ID = "student-123";

function createProviderResponse({
    liveness = {
        status: "ok",
        is_live: true,
        live_score: 0.98
    },
    matches = [
        {
            person: {
                id: "provider-person-123",
                external_id: STUDENT_ID
            },
            similarity: 0.91
        }
    ]
} = {}) {
    return {
        request_id: "test-request-123",
        searched_face: { liveness },
        matches
    };
}

function mockFetch(t, payload, {
    ok = true,
    status = 200
} = {}) {
    return t.mock.method(
        globalThis,
        "fetch",
        async (url, options) => {
            assert.equal(
                url,
                "http://biometric.test/v1/collections/students/search"
            );

            assert.equal(options.method, "POST");

            // Ensure the server uses the configured provider credential.
            assert.equal(
                options.headers.Authorization,
                "Bearer test-only-key"
            );

            assert.ok(options.body instanceof FormData);

            return {
                ok,
                status,
                json: async () => payload
            };
        }
    );
}

function verifyStudent() {
    return provider.verify({
        userId: STUDENT_ID,
        imageBuffer: Buffer.from("test-image"),
        mimeType: "image/jpeg"
    });
}

function assertStatus(expectedStatus) {
    return (error) => {
        assert.equal(error.statusCode, expectedStatus);
        return true;
    };
}

test("accepts a live face matching the logged-in student", async (t) => {
    mockFetch(t, createProviderResponse());

    const result = await verifyStudent();

    assert.equal(result.verified, true);
    assert.equal(result.livenessPassed, true);
    assert.equal(result.faceMatchPassed, true);
    assert.equal(result.providerUserId, STUDENT_ID);
    assert.equal(result.similarity, 0.91);
    assert.equal(result.verificationId, "test-request-123");
});

test("fails closed when liveness information is missing", async (t) => {
    mockFetch(t, {
        request_id: "test-request-124",
        searched_face: {},
        matches: createProviderResponse().matches
    });

    await assert.rejects(
        verifyStudent(),
        assertStatus(502)
    );
});

test("rejects a face that fails the liveness check", async (t) => {
    mockFetch(
        t,
        createProviderResponse({
            liveness: {
                status: "ok",
                is_live: false,
                live_score: 0.05
            }
        })
    );

    await assert.rejects(
        verifyStudent(),
        assertStatus(401)
    );
});

test("rejects a live face when no enrolled match exists", async (t) => {
    mockFetch(
        t,
        createProviderResponse({ matches: [] })
    );

    await assert.rejects(
        verifyStudent(),
        assertStatus(401)
    );
});

test("rejects a match belonging to another student", async (t) => {
    mockFetch(
        t,
        createProviderResponse({
            matches: [
                {
                    person: {
                        external_id: "another-student"
                    },
                    similarity: 0.99
                }
            ]
        })
    );

    await assert.rejects(
        verifyStudent(),
        assertStatus(401)
    );
});

test("rejects a face below the configured similarity threshold", async (t) => {
    mockFetch(
        t,
        createProviderResponse({
            matches: [
                {
                    person: {
                        external_id: STUDENT_ID
                    },
                    similarity: 0.20
                }
            ]
        })
    );

    await assert.rejects(
        verifyStudent(),
        assertStatus(401)
    );
});

test("rejects provider errors instead of treating them as success", async (t) => {
    mockFetch(
        t,
        {
            error: {
                code: "PROVIDER_UNAVAILABLE",
                message: "Provider unavailable"
            }
        },
        { ok: false, status: 503 }
    );

    await assert.rejects(
        verifyStudent(),
        assertStatus(503)
    );
});
