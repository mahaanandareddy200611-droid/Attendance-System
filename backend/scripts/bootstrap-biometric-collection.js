"use strict";

require("dotenv").config();

function getBaseUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error("Set BIOMETRIC_BASE_URL to the deployed provider origin"); }
  const localHttp = ["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:";
  if (url.protocol !== "https:" && !localHttp) throw new Error("BIOMETRIC_BASE_URL must use HTTPS outside local development");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("BIOMETRIC_BASE_URL must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

async function request({ baseUrl, apiKey, path, method = "GET", body, fetchImpl, timeoutMs }) {
  const headers = { Accept: "application/json", Authorization: "Bearer " + apiKey };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetchImpl(new URL(path, baseUrl), {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const label = error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "timed out"
      : "could not be reached";
    throw new Error("Biometric provider " + method + " " + path + " " + label + " (" + String(error?.name || "Error") + "). Check provider origin, Render service health, and API-key configuration.");
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

async function bootstrapBiometricCollection({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = getBaseUrl(env.BIOMETRIC_BASE_URL);
  const apiKey = String(env.BIOMETRIC_API_KEY || "");
  if (apiKey.length < 32) throw new Error("Set BIOMETRIC_API_KEY to the provider API key (at least 32 characters)");
  const collectionId = String(env.BIOMETRIC_COLLECTION_ID || "students").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(collectionId)) throw new Error("BIOMETRIC_COLLECTION_ID is invalid");
  const timeoutMs = Math.max(1000, Math.min(Number(env.BIOMETRIC_TIMEOUT_MS) || 10000, 30000));
  const collectionPath = "/v1/collections/" + encodeURIComponent(collectionId);

  const existing = await request({ baseUrl, apiKey, path: collectionPath, fetchImpl, timeoutMs });
  if (existing.status === 200 && existing.data?.collection?.id === collectionId) {
    return { providerAuthenticated: true, collectionAvailable: true, created: false };
  }
  if (existing.status !== 404) {
    throw new Error("Provider collection lookup failed (HTTP " + existing.status + ")");
  }

  const created = await request({
    baseUrl, apiKey, path: "/v1/collections", method: "POST", fetchImpl, timeoutMs,
    body: { id: collectionId, name: "Attendance students", threshold: Number(env.BIOMETRIC_MATCH_THRESHOLD) || 0.4 },
  });
  if (created.status === 201 && created.data?.collection?.id === collectionId) {
    return { providerAuthenticated: true, collectionAvailable: true, created: true };
  }
  if (created.status === 409) {
    const retry = await request({ baseUrl, apiKey, path: collectionPath, fetchImpl, timeoutMs });
    if (retry.status === 200 && retry.data?.collection?.id === collectionId) {
      return { providerAuthenticated: true, collectionAvailable: true, created: false };
    }
  }
  throw new Error("Provider collection creation could not be confirmed (HTTP " + created.status + ")");
}

if (require.main === module) {
  // Print the target origin and collection to make local-vs-remote config clear.
  // Never log the API key.
  let validConfiguration = true;
  try {
    console.log("Provider origin: " + getBaseUrl(process.env.BIOMETRIC_BASE_URL));
    console.log("Collection ID: " + String(process.env.BIOMETRIC_COLLECTION_ID || "students").trim());
  } catch (error) {
    console.error("BIOMETRIC COLLECTION CONFIGURATION FAILED:", error.message);
    validConfiguration = false;
    process.exitCode = 1;
  }
  if (validConfiguration) bootstrapBiometricCollection()
    .then((result) => {
      console.log("PASS provider authentication");
      console.log("PASS collection available");
      console.log(result.created ? "PASS collection created" : "PASS collection already existed");
    })
    .catch((error) => {
      console.error("BIOMETRIC COLLECTION BOOTSTRAP FAILED:", error.message);
      process.exitCode = 1;
    });
}

module.exports = { getBaseUrl, bootstrapBiometricCollection };
