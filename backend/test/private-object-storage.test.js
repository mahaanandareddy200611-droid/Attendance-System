const test = require("node:test");
const assert = require("node:assert/strict");

const storage = require("../src/infrastructure/storage/PrivateObjectStorage");

const ENV_KEYS = [
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "OBJECT_STORAGE_TIMEOUT_MS",
];

function setStorageEnvironment(t) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.OBJECT_STORAGE_ENDPOINT = "https://example-account.r2.cloudflarestorage.com";
  process.env.OBJECT_STORAGE_BUCKET = "attendance-private";
  process.env.OBJECT_STORAGE_REGION = "auto";
  process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "test-access-key";
  process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "test-secret-key-never-use";
  process.env.OBJECT_STORAGE_TIMEOUT_MS = "1000";
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test("object key encoding rejects path traversal and safely encodes path segments", () => {
  assert.equal(storage._test.canonicalKey("evidence/abc/photo.jpg"), "/evidence/abc/photo.jpg");
  assert.equal(storage._test.awsEncode("image name!.jpg"), "image%20name%21.jpg");
  assert.throws(() => storage._test.canonicalKey("../secret.jpg"), /Object storage key is invalid/);
  assert.throws(() => storage._test.canonicalKey("/absolute.jpg"), /Object storage key is invalid/);
});

test("object storage configuration fails closed when credentials are absent", (t) => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  assert.throws(
    () => storage._test.getConfiguration(),
    (error) => error.statusCode === 503 && /not configured/.test(error.message),
  );
});

test("private upload signs a bounded PUT request and does not make the object public", async (t) => {
  setStorageEnvironment(t);
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(null, { status: 200 });
  };
  t.after(() => { global.fetch = originalFetch; });

  const body = Buffer.from("normalized evidence test bytes");
  await storage.putObject({
    key: "evidence/507f1f77bcf86cd799439011/8cb9f8f8-9c75-4b9a-bd45-4cb0424e1e2c.jpg",
    body,
    contentType: "image/jpeg",
  });

  assert.equal(captured.options.method, "PUT");
  assert.match(captured.url, /^https:\/\/example-account\.r2\.cloudflarestorage\.com\/attendance-private\/evidence\//);
  assert.match(captured.options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\//);
  assert.match(captured.options.headers.Authorization, /Signature=[a-f0-9]{64}$/);
  assert.equal(
    captured.options.headers["x-amz-content-sha256"],
    storage._test.sha256(body),
  );
  assert.equal(captured.options.headers["content-type"], "image/jpeg");
  assert.equal(captured.options.headers["x-amz-acl"], undefined);
});

test("download URL is signed, expires quickly, and is not a public object URL", async (t) => {
  setStorageEnvironment(t);
  const urlText = await storage.createDownloadUrl({
    key: "evidence/507f1f77bcf86cd799439011/8cb9f8f8-9c75-4b9a-bd45-4cb0424e1e2c.jpg",
    expiresInSeconds: 60,
  });
  const url = new URL(urlText);
  assert.equal(url.protocol, "https:");
  assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
  assert.match(url.searchParams.get("X-Amz-Credential"), /^test-access-key\/\d{8}\/auto\/s3\/aws4_request$/);
  assert.equal(url.searchParams.has("X-Amz-Signature"), true);
  await assert.rejects(
    storage.createDownloadUrl({ key: "evidence/a/b.jpg", expiresInSeconds: 3600 }),
    (error) => error.statusCode === 500,
  );
});

test("object deletion treats a missing object as an idempotent success", async (t) => {
  setStorageEnvironment(t);
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(null, { status: 404 });
  };
  t.after(() => { global.fetch = originalFetch; });

  await storage.deleteObject({ key: "evidence/507f1f77bcf86cd799439011/8cb9f8f8-9c75-4b9a-bd45-4cb0424e1e2c.jpg" });
  assert.equal(captured.options.method, "DELETE");
  assert.match(captured.options.headers.Authorization, /Signature=[a-f0-9]{64}$/);
});

test("storage errors do not expose provider response bodies", async (t) => {
  setStorageEnvironment(t);
  const originalFetch = global.fetch;
  global.fetch = async () => new Response("sensitive-provider-detail", { status: 403 });
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(
    storage.putObject({ key: "evidence/a/b.jpg", body: Buffer.from("image"), contentType: "image/jpeg" }),
    (error) => error.statusCode === 503 && !error.message.includes("sensitive-provider-detail"),
  );
});
