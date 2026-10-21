"use strict";

require("dotenv").config();
const crypto = require("node:crypto");
const storage = require("../src/infrastructure/storage/PrivateObjectStorage");

async function main() {
  const bucket = process.env.OBJECT_STORAGE_BUCKET;
  const endpointValue = process.env.OBJECT_STORAGE_ENDPOINT;
  if (!bucket || !endpointValue) {
    throw new Error("Set OBJECT_STORAGE_ENDPOINT and OBJECT_STORAGE_BUCKET in your local environment first.");
  }

  const endpoint = new URL(endpointValue);
  const key = "smoke-tests/" + crypto.randomUUID() + ".bin";
  // A real 1x1 JPEG, so the smoke test exercises an image content type
  // rather than uploading text while claiming it is an image.
  const payload = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=",
    "base64",
  );
  const rawUrl = new URL("/" + encodeURIComponent(bucket) + "/" + key.split("/").map(encodeURIComponent).join("/"), endpoint.origin);
  let uploaded = false;

  try {
    await storage.putObject({ key, body: payload, contentType: "image/jpeg" });
    uploaded = true;
    console.log("PASS: first signed upload returned successfully");

    // Write the same unique key twice so the real smoke verifies that the
    // permanent-purge path removes multiple B2 file versions, not just a
    // single current version. Content is intentionally identical to keep the
    // smoke payload a valid tiny JPEG while still creating another version.
    await storage.putObject({ key, body: payload, contentType: "image/jpeg" });
    console.log("PASS: second upload created an additional object version");

    const versionsBeforeDelete = await storage._test.listObjectVersions(key);
    if (versionsBeforeDelete.length < 2) {
      throw new Error("Version-list check failed: expected at least two versions before permanent deletion");
    }
    console.log("PASS: provider version listing returned " + versionsBeforeDelete.length + " versions before deletion");

    const publicResponse = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
    if (publicResponse.ok) {
      throw new Error("Privacy check failed: the object can be fetched without a signed URL. Make the bucket private.");
    }
    console.log("PASS: unsigned object request is denied (HTTP " + publicResponse.status + ")");

    const signedUrl = await storage.createDownloadUrl({ key, expiresInSeconds: 60 });
    const signedResponse = await fetch(signedUrl, { signal: AbortSignal.timeout(10000) });
    if (!signedResponse.ok) throw new Error("Signed download failed with HTTP " + signedResponse.status);
    const downloaded = Buffer.from(await signedResponse.arrayBuffer());
    if (!downloaded.equals(payload)) throw new Error("Downloaded object did not match uploaded bytes");
    console.log("PASS: signed download returned the exact uploaded bytes");

    await storage.deleteObject({ key });
    const afterDeleteUrl = await storage.createDownloadUrl({ key, expiresInSeconds: 60 });
    const afterDelete = await fetch(afterDeleteUrl, { signal: AbortSignal.timeout(10000) });
    if (afterDelete.ok) throw new Error("Deletion check failed: object remains readable after delete");
    const versionsAfterDelete = await storage._test.listObjectVersions(key);
    if (versionsAfterDelete.length !== 0) {
      throw new Error("Permanent deletion check failed: " + versionsAfterDelete.length + " object versions remain");
    }
    uploaded = false;
    console.log("PASS: deleted object is no longer readable (HTTP " + afterDelete.status + ")");
    console.log("PASS: provider version listing confirms zero versions remain");
    console.log("PRIVATE OBJECT STORAGE SMOKE TEST PASSED");
  } finally {
    if (uploaded) {
      try { await storage.deleteObject({ key }); }
      catch { console.error("Warning: smoke-test cleanup failed; remove the temporary object from the private bucket."); }
    }
  }
}

main().catch((error) => {
  console.error("PRIVATE OBJECT STORAGE SMOKE TEST FAILED:", error.message);
  process.exitCode = 1;
});
