"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createPrivateObjectStorage,
    readConfig,
    encodeObjectPath,
    makeSignedUrl
} = require("../src/modules/AttendanceEvidence/PrivateObjectStorage");

const env = {
    SUPABASE_URL: "https://project-ref.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-real",
    SUPABASE_STORAGE_BUCKET: "attendance-evidence-private",
    SUPABASE_STORAGE_TIMEOUT_MS: "5000"
};

function jsonResponse(status, value) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() { return JSON.stringify(value); }
    };
}

test("requires a private storage URL and service credential", () => {
    assert.throws(() => readConfig({}), /not configured/i);
    assert.throws(() => readConfig({
        ...env,
        SUPABASE_URL: "http://storage.example"
    }), /HTTPS/i);
    assert.throws(() => readConfig({
        ...env,
        SUPABASE_URL: "https://user:password@project-ref.supabase.co"
    }), /HTTPS/i);
});

test("restricts keys to the attendance-evidence namespace and rejects traversal", () => {
    assert.equal(
        encodeObjectPath("attendance-evidence/2026/10/abc.jpg"),
        "attendance-evidence/2026/10/abc.jpg"
    );
    assert.throws(() => encodeObjectPath("../private.jpg"), /Invalid/i);
    assert.throws(() => encodeObjectPath("attendance-evidence/../private.jpg"), /Invalid/i);
    assert.throws(() => encodeObjectPath("attendance-evidence//private.jpg"), /Invalid/i);
});

test("never accepts signed URLs that point outside the configured storage project", () => {
    assert.throws(
        () => makeSignedUrl("https://attacker.example/storage/v1/object/sign/bucket/key", env.SUPABASE_URL),
        /outside the configured project/i
    );
    assert.throws(
        () => makeSignedUrl("/object/public/bucket/key", env.SUPABASE_URL),
        /outside the configured project/i
    );
    assert.equal(
        makeSignedUrl("/object/sign/bucket/key?token=abc", env.SUPABASE_URL),
        "https://project-ref.supabase.co/storage/v1/object/sign/bucket/key?token=abc"
    );
});

test("uploads use the private Storage API without upsert and never expose the service key", async () => {
    const calls = [];
    const storage = createPrivateObjectStorage({
        env,
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), options });
            return jsonResponse(200, { Key: "stored" });
        }
    });

    await storage.uploadObject(
        "attendance-evidence/2026/10/abc.jpg",
        Buffer.from("jpeg-bytes"),
        "image/jpeg"
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, "POST");
    assert.match(calls[0].url, /\/storage\/v1\/object\/attendance-evidence-private\/attendance-evidence\/2026\/10\/abc\.jpg$/);
    assert.equal(calls[0].options.headers["content-type"], "image/jpeg");
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.equal(calls[0].options.headers["x-upsert"], undefined);
    assert.ok(Buffer.isBuffer(calls[0].options.body));
});

test("signed URLs are short-lived and deletion only accepts evidence keys", async () => {
    const calls = [];
    const storage = createPrivateObjectStorage({
        env,
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), options });
            if (options.method === "POST") {
                return jsonResponse(200, { signedURL: "/object/sign/attendance-evidence-private/attendance-evidence%2F2026%2F10%2Fabc.jpg?token=abc" });
            }
            return jsonResponse(200, { message: "deleted" });
        }
    });

    const signed = await storage.createSignedUrl("attendance-evidence/2026/10/abc.jpg", 60);
    assert.match(signed, /^https:\/\/project-ref\.supabase\.co\/storage\/v1\/object\/sign\//);
    assert.throws(() => storage.createSignedUrl("attendance-evidence/2026/10/abc.jpg", 3600), /expiry/i);

    await storage.removeObjects(["attendance-evidence/2026/10/abc.jpg"]);
    assert.equal(calls[1].options.method, "DELETE");
    assert.deepEqual(JSON.parse(calls[1].options.body), {
        prefixes: ["attendance-evidence/2026/10/abc.jpg"]
    });
    await assert.rejects(
        () => storage.removeObjects(["unrelated-bucket-prefix/object.jpg"]),
        /Invalid attendance evidence object key/
    );
});

test("provider errors are sanitized and returned as retryable 503 errors", async () => {
    const storage = createPrivateObjectStorage({
        env,
        fetchImpl: async () => ({
            ok: false,
            status: 500,
            async text() { return "secret internal provider details"; }
        })
    });

    await assert.rejects(
        () => storage.removeObjects(["attendance-evidence/2026/10/abc.jpg"]),
        (error) => {
            assert.equal(error.statusCode, 503);
            assert.doesNotMatch(error.message, /secret internal/i);
            return true;
        }
    );
});
