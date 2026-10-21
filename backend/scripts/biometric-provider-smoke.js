"use strict";

require("dotenv").config();
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const pathModule = require("node:path");

function getProviderBaseUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error("Set BIOMETRIC_BASE_URL to the provider origin"); }
  const localHttp = ["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:";
  if (url.protocol !== "https:" && !localHttp) throw new Error("BIOMETRIC_BASE_URL must use HTTPS outside local development");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("BIOMETRIC_BASE_URL must be an origin without credentials, query, fragment, or path");
  }
  return url.origin;
}

function getImageType(filePath) {
  const extension = pathModule.extname(filePath).toLowerCase();
  const types = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
  if (!types[extension]) throw new Error("Smoke images must be JPEG, PNG, or WebP files");
  return types[extension];
}

async function readSmokeImage(env, key) {
  const filePath = String(env[key] || "").trim();
  if (!filePath) throw new Error("Set " + key + " to a local consenting test-subject image path");
  const type = getImageType(filePath);
  const imageBuffer = await fs.readFile(filePath);
  if (imageBuffer.length === 0 || imageBuffer.length > 10 * 1024 * 1024) {
    throw new Error(key + " must be a non-empty file no larger than 10 MiB");
  }
  return { imageBuffer, type, fileName: pathModule.basename(filePath) };
}

async function requestJson({ baseUrl, apiKey, path, method = "GET", body, fetchImpl, timeoutMs }) {
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  let requestBody = body;
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("Biometric provider request could not be completed for " + path);
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    throw new Error("Biometric provider request failed for " + path + " (HTTP " + response.status + ")");
  }
  return { response, data };
}

async function assertLiveFace({ baseUrl, apiKey, image, collectionId, fetchImpl, timeoutMs }) {
  const form = new FormData();
  form.append("image", new Blob([image.imageBuffer], { type: image.type }), image.fileName);
  form.append("max_faces", "2");
  form.append("collection_id", collectionId);
  const { data } = await requestJson({
    baseUrl, apiKey, path: "/v1/detect", method: "POST",
    body: form, fetchImpl, timeoutMs,
  });
  if (!Array.isArray(data?.faces) || data.faces.length !== 1) {
    throw new Error("Provider must detect exactly one face in each smoke image");
  }
  const face = data.faces[0];
  const liveness = face?.liveness;
  const score = Number(liveness?.live_score);
  if (liveness?.status !== "ok" || liveness?.is_live !== true ||
      !Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error("Provider did not return a passing, evaluated liveness result");
  }
  if (!face.landmarks && !face.keypoints) {
    throw new Error("Provider did not return the face landmarks required by active liveness");
  }
  return true;
}

async function runBiometricProviderSmoke({
  env = process.env,
  fetchImpl = globalThis.fetch,
  readImage = readSmokeImage,
} = {}) {
  const baseUrl = getProviderBaseUrl(env.BIOMETRIC_BASE_URL);
  const apiKey = String(env.BIOMETRIC_API_KEY || "");
  const collectionId = String(env.BIOMETRIC_COLLECTION_ID || "students").trim();
  if (!apiKey) throw new Error("Set BIOMETRIC_API_KEY in your local environment");
  if (!collectionId || !/^[A-Za-z0-9._-]{1,64}$/.test(collectionId)) throw new Error("BIOMETRIC_COLLECTION_ID is invalid");

  const timeoutMs = Math.max(1000, Math.min(Number(env.BIOMETRIC_TIMEOUT_MS) || 15000, 60000));
  const threshold = Number(env.BIOMETRIC_MATCH_THRESHOLD || 0.40);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("BIOMETRIC_MATCH_THRESHOLD must be between 0 and 1");

  const health = await requestJson({ baseUrl, apiKey: "", path: "/v1/health", fetchImpl, timeoutMs });
  if (health.data?.status !== "ready" || health.data?.auth_enabled !== true) {
    throw new Error("Provider must be ready with API-key authentication enabled");
  }

  const collection = await requestJson({
    baseUrl, apiKey, path: "/v1/collections/" + encodeURIComponent(collectionId), fetchImpl, timeoutMs,
  });
  if (!collection.data?.collection) throw new Error("Configured biometric collection was not returned");

  const enrollmentImage = await readImage(env, "BIOMETRIC_SMOKE_ENROLL_IMAGE_PATH");
  const verificationImage = await readImage(env, "BIOMETRIC_SMOKE_VERIFY_IMAGE_PATH");
  if (crypto.createHash("sha256").update(enrollmentImage.imageBuffer).digest("hex") ===
      crypto.createHash("sha256").update(verificationImage.imageBuffer).digest("hex")) {
    throw new Error("Use two different captures of the same consenting test subject");
  }

  await assertLiveFace({ baseUrl, apiKey, image: enrollmentImage, collectionId, fetchImpl, timeoutMs });
  await assertLiveFace({ baseUrl, apiKey, image: verificationImage, collectionId, fetchImpl, timeoutMs });

  const smokeExternalId = "attendance-smoke-" + crypto.randomUUID();
  const enrollment = new FormData();
  enrollment.append("id", smokeExternalId);
  enrollment.append("external_id", smokeExternalId);
  enrollment.append("review_mode", "strict");
  enrollment.append("images", new Blob([enrollmentImage.imageBuffer], { type: enrollmentImage.type }), enrollmentImage.fileName);

  let providerPersonId = null;
  try {
    const created = await requestJson({
      baseUrl, apiKey, path: "/v1/collections/" + encodeURIComponent(collectionId) + "/persons",
      method: "POST", body: enrollment, fetchImpl, timeoutMs,
    });
    providerPersonId = created.data?.person?.id || null;
    if (!providerPersonId || !Array.isArray(created.data?.faces) || created.data.faces.length < 1 ||
        (Array.isArray(created.data?.rejected_images) && created.data.rejected_images.length > 0)) {
      throw new Error("Provider enrollment did not accept the test image cleanly");
    }

    const search = new FormData();
    search.append("image", new Blob([verificationImage.imageBuffer], { type: verificationImage.type }), verificationImage.fileName);
    search.append("limit", "5");
    search.append("threshold", String(threshold));
    const verified = await requestJson({
      baseUrl, apiKey, path: "/v1/collections/" + encodeURIComponent(collectionId) + "/search",
      method: "POST", body: search, fetchImpl, timeoutMs,
    });
    const live = verified.data?.searched_face?.liveness;
    if (live?.status !== "ok" || live?.is_live !== true) {
      throw new Error("Provider search did not return passing live-face evidence");
    }
    const match = (verified.data?.matches || []).find((item) =>
      String(item?.person?.external_id || "") === smokeExternalId
    );
    if (!match || !Number.isFinite(Number(match.similarity)) || Number(match.similarity) < threshold) {
      throw new Error("Provider did not match the second capture to the enrolled test identity");
    }
  } finally {
    if (providerPersonId) {
      const deletion = await requestJson({
        baseUrl, apiKey,
        path: "/v1/collections/" + encodeURIComponent(collectionId) + "/persons/" + encodeURIComponent(providerPersonId),
        method: "DELETE", fetchImpl, timeoutMs,
      });
      if (deletion.response.status !== 204 && deletion.response.status !== 200) {
        throw new Error("Provider smoke identity cleanup was not confirmed");
      }
    }
  }

  return {
    providerReady: true,
    apiKeyAuthEnabled: true,
    collectionAccessible: true,
    faceDetection: true,
    stillImageLiveness: true,
    identityMatch: true,
    temporaryEnrollmentDeleted: true,
  };
}

if (require.main === module) {
  runBiometricProviderSmoke()
    .then((result) => {
      for (const [name, passed] of Object.entries(result)) {
        console.log((passed ? "PASS " : "FAIL ") + name);
      }
      console.log("BIOMETRIC PROVIDER SMOKE PASSED");
      console.log("Note: this does not replace active video liveness/PAD replay testing or a supervised pilot.");
    })
    .catch((error) => {
      console.error("BIOMETRIC PROVIDER SMOKE FAILED:", error.message);
      process.exitCode = 1;
    });
}

module.exports = { getProviderBaseUrl, getImageType, runBiometricProviderSmoke };
