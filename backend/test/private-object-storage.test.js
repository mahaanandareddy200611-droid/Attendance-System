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

test("version listing parses Backblaze S3 XML and preserves version IDs", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <ListVersionsResult>
    <Version><Key>attendance-evidence/a.jpg</Key><VersionId>v1</VersionId><IsLatest>false</IsLatest></Version>
    <DeleteMarker><Key>attendance-evidence/a.jpg</Key><VersionId>marker1</VersionId><IsLatest>true</IsLatest></DeleteMarker>
    <Version><Key>attendance-evidence/other.jpg</Key><VersionId>other1</VersionId></Version>
  </ListVersionsResult>`;
  assert.deepEqual(storage._test.parseObjectVersions(xml), [
    { key: "attendance-evidence/a.jpg", versionId: "v1", kind: "Version" },
    { key: "attendance-evidence/a.jpg", versionId: "marker1", kind: "DeleteMarker" },
    { key: "attendance-evidence/other.jpg", versionId: "other1", kind: "Version" },
  ]);
});

test("version listing rejects incomplete provider metadata", () => {
  assert.throws(
    () => storage._test.parseObjectVersions("<ListVersionsResult><Version><Key>a.jpg</Key></Version></ListVersionsResult>"),
    /invalid version metadata/,
  );
});

test("SigV4 query parameters are encoded and sorted canonically", () => {
  assert.equal(
    storage._test.canonicalizeQuery([["versionId", "a+b/="], ["versions", ""]]),
    "versionId=a%2Bb%2F%3D&versions=",
  );
});

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

test("storage failures expose only sanitized HTTP status and provider error code", async (t) => {
  setStorageEnvironment(t);
  const previousPurge = process.env.OBJECT_STORAGE_PURGE_VERSIONS;
  process.env.OBJECT_STORAGE_PURGE_VERSIONS = "false";
  t.after(() => {
    if (previousPurge === undefined) delete process.env.OBJECT_STORAGE_PURGE_VERSIONS;
    else process.env.OBJECT_STORAGE_PURGE_VERSIONS = previousPurge;
  });

  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    "<Error><Code>AccessDenied</Code><Message>not logged</Message></Error>",
    { status: 403, headers: { "content-type": "application/xml" } },
  );
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(
    storage.deleteObject({ key: "evidence/507f1f77bcf86cd799439011/example.jpg" }),
    (error) => error.statusCode === 503 &&
      error.storageStatus === 403 &&
      error.storageCode === "AccessDenied" &&
      !("providerResponse" in error),
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

test("Backblaze version purge deletes every version and confirms no versions remain", async (t) => {
  setStorageEnvironment(t);
  const previousPurge = process.env.OBJECT_STORAGE_PURGE_VERSIONS;
  process.env.OBJECT_STORAGE_PURGE_VERSIONS = "true";
  t.after(() => {
    if (previousPurge === undefined) delete process.env.OBJECT_STORAGE_PURGE_VERSIONS;
    else process.env.OBJECT_STORAGE_PURGE_VERSIONS = previousPurge;
  });

  const originalFetch = global.fetch;
  let versionsRemaining = [
    { key: "attendance-evidence/a.jpg", versionId: "old-version", kind: "Version" },
    { key: "attendance-evidence/a.jpg", versionId: "hide-marker", kind: "DeleteMarker" },
  ];
  const deleted = [];
  global.fetch = async (urlValue, options = {}) => {
    const url = new URL(String(urlValue));
    if ((options.method || "GET") === "GET" && url.searchParams.has("versions")) {
      const xml = versionsRemaining.map((v) =>
        "<" + v.kind + "><Key>" + v.key + "</Key><VersionId>" + v.versionId +
        "</VersionId></" + v.kind + ">"
      ).join("");
      return new Response("<ListVersionsResult>" + xml + "</ListVersionsResult>", { status: 200 });
    }
    if (options.method === "DELETE") {
      const versionId = url.searchParams.get("versionId");
      assert.ok(versionId, "purge must specify the exact version ID");
      deleted.push(versionId);
      versionsRemaining = versionsRemaining.filter((v) => v.versionId !== versionId);
      return new Response(null, { status: 204 });
    }
    return new Response("unexpected request", { status: 400 });
  };
  t.after(() => { global.fetch = originalFetch; });

  await storage.deleteObject({ key: "attendance-evidence/a.jpg" });
  assert.deepEqual(deleted.sort(), ["hide-marker", "old-version"]);
  assert.equal(versionsRemaining.length, 0);
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


function expectedSigV4Signature({ method, url, headers, secretAccessKey, region, query = "", payloadHash, amzDate = headers["x-amz-date"] }) {
  const dateStamp = amzDate.slice(0, 8);
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => name + ":" + String(headers[name]).trim())
    .join("\n") + "\n";
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const hash = (value) => require("node:crypto").createHash("sha256").update(value).digest("hex");
  const hmac = (key, value, encoding) => require("node:crypto").createHmac("sha256", key).update(value).digest(encoding);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    dateStamp + "/" + region + "/s3/aws4_request",
    hash(canonicalRequest),
  ].join("\n");
  const dateKey = hmac("AWS4" + secretAccessKey, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  return hmac(signingKey, stringToSign, "hex");
}

test("SigV4 authorization includes the required newline after canonical headers", async (t) => {
  setStorageEnvironment(t);
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: new URL(String(url)), options };
    return new Response(null, { status: 200 });
  };
  t.after(() => { global.fetch = originalFetch; });

  const body = Buffer.from("canonical-signature-test");
  await storage.putObject({ key: "evidence/test/photo.jpg", body, contentType: "image/jpeg" });

  const expectedHeaders = {
    host: captured.url.host,
    "content-type": "image/jpeg",
    "x-amz-content-sha256": storage._test.sha256(body),
    "x-amz-date": captured.options.headers["x-amz-date"],
  };
  const expected = expectedSigV4Signature({
    method: "PUT",
    url: captured.url,
    headers: expectedHeaders,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    region: process.env.OBJECT_STORAGE_REGION,
    query: "",
    payloadHash: storage._test.sha256(body),
  });
  assert.equal(captured.options.headers.Authorization.match(/Signature=([a-f0-9]{64})$/)?.[1], expected);
});

test("presigned download URLs use the same valid canonical-header boundary", async (t) => {
  setStorageEnvironment(t);
  const url = new URL(await storage.createDownloadUrl({ key: "evidence/test/photo.jpg", expiresInSeconds: 60 }));
  const actualSignature = url.searchParams.get("X-Amz-Signature");
  url.searchParams.delete("X-Amz-Signature");
  const awsEncode = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    "%" + character.charCodeAt(0).toString(16).toUpperCase()
  );
  const canonicalQuery = Array.from(url.searchParams.entries())
    .map(([name, value]) => [awsEncode(name), awsEncode(value)])
    .sort(([nameA, valueA], [nameB, valueB]) => nameA === nameB
      ? (valueA === valueB ? 0 : valueA < valueB ? -1 : 1)
      : nameA < nameB ? -1 : 1)
    .map(([name, value]) => name + "=" + value)
    .join("&");
  const expected = expectedSigV4Signature({
    method: "GET",
    url,
    headers: { host: url.host },
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    region: process.env.OBJECT_STORAGE_REGION,
    query: canonicalQuery,
    payloadHash: "UNSIGNED-PAYLOAD",
    amzDate: url.searchParams.get("X-Amz-Date"),
  });
  assert.equal(actualSignature, expected);
});
