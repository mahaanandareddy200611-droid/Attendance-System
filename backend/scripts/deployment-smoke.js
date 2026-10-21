"use strict";

function buildEndpointUrl(base, part) {
  let url;
  try {
    url = new URL(String(base || ""));
  } catch {
    throw new Error("STAGING_BASE_URL must be a valid HTTP(S) URL");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("STAGING_BASE_URL must not contain credentials, query, or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = (path.endsWith("/api/v1") ? path : path + "/api/v1") + "/" + part;
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  return url;
}

function buildLecturerSiteUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Set LECTURER_WEB_BASE_URL to the deployed lecturer web origin");
  }
  const localHttp = ["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:";
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("LECTURER_WEB_BASE_URL must use HTTPS outside local development");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("LECTURER_WEB_BASE_URL must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

async function fetchWithTimeout(fetchImpl, url, options = {}, label) {
  try {
    return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error(label + " could not be reached");
  }
}

async function verifyLecturerSite({ lecturerWebBaseUrl, fetchImpl }) {
  const origin = buildLecturerSiteUrl(lecturerWebBaseUrl);
  const indexResponse = await fetchWithTimeout(
    fetchImpl,
    origin + "/",
    { headers: { accept: "text/html" } },
    "Lecturer web site",
  );
  if (!indexResponse.ok) {
    throw new Error("Lecturer web site returned HTTP " + indexResponse.status);
  }

  let html;
  try {
    html = await indexResponse.text();
  } catch {
    throw new Error("Lecturer web site did not return readable HTML");
  }
  if (!/<html[\s>]/i.test(html) || !/id=["']root["']/i.test(html)) {
    throw new Error("Lecturer web response does not look like the built React application");
  }

  const scriptMatch = /<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/i.exec(html);
  if (!scriptMatch) {
    throw new Error("Lecturer web HTML does not reference a production JavaScript bundle");
  }
  const bundleUrl = new URL(scriptMatch[1], origin);
  if (bundleUrl.origin !== origin) {
    throw new Error("Lecturer web bundle unexpectedly points to a different origin");
  }
  const bundleResponse = await fetchWithTimeout(
    fetchImpl,
    bundleUrl.href,
    { headers: { accept: "application/javascript, text/javascript, */*" } },
    "Lecturer web JavaScript bundle",
  );
  if (!bundleResponse.ok) {
    throw new Error("Lecturer web JavaScript bundle returned HTTP " + bundleResponse.status);
  }
  const contentType = String(bundleResponse.headers?.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html")) {
    throw new Error("Lecturer web JavaScript bundle URL returned HTML instead of JavaScript");
  }
  const bundleText = await bundleResponse.text();
  if (!bundleText.trim()) {
    throw new Error("Lecturer web JavaScript bundle is empty");
  }
  return { status: indexResponse.status, bundleStatus: bundleResponse.status, origin };
}

async function verifyCors({ baseUrl, lecturerOrigin, fetchImpl }) {
  const response = await fetchWithTimeout(
    fetchImpl,
    buildEndpointUrl(baseUrl, "livez"),
    {
      method: "OPTIONS",
      headers: {
        Origin: lecturerOrigin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    },
    "Backend CORS preflight",
  );
  const allowedOrigin = response.headers?.get("access-control-allow-origin");
  const allowedMethods = String(response.headers?.get("access-control-allow-methods") || "")
    .split(",")
    .map((value) => value.trim().toUpperCase());
  if (!response.ok || allowedOrigin !== lecturerOrigin || !allowedMethods.includes("GET")) {
    throw new Error("Backend CORS does not allow the deployed lecturer origin to make API requests");
  }
  return { status: response.status, allowedOrigin };
}

async function runDeploymentSmoke({
  baseUrl = process.env.STAGING_BASE_URL,
  lecturerWebBaseUrl = process.env.LECTURER_WEB_BASE_URL,
  fetchImpl = globalThis.fetch,
  requireBiometric = String(process.env.ATTENDANCE_REQUIRE_BIOMETRIC || "").toLowerCase() === "true",
} = {}) {
  if (!baseUrl) throw new Error("Set STAGING_BASE_URL to the deployed API URL");
  if (!lecturerWebBaseUrl) throw new Error("Set LECTURER_WEB_BASE_URL to the deployed lecturer web origin");

  const result = {};
  for (const name of ["livez", "health", "readyz"]) {
    const response = await fetchWithTimeout(
      fetchImpl,
      buildEndpointUrl(baseUrl, name),
      { headers: { accept: "application/json" } },
      "/api/v1/" + name,
    );
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("/api/v1/" + name + " did not return JSON");
    }
    if (!response.ok || body.success !== true) {
      throw new Error("/api/v1/" + name + " is not healthy (" + (body.status || response.status) + ")");
    }
    if (name === "livez" && body.status !== "alive") throw new Error("Invalid liveness status");
    if (name === "health" && body.status !== "healthy") throw new Error("Invalid health status");
    if (name === "readyz") {
      if (body.status !== "ready" || body.dependencies?.mongodb !== true || body.dependencies?.redis !== true) {
        throw new Error("Readiness did not confirm MongoDB and Redis");
      }
      if (requireBiometric && body.dependencies?.biometricProvider !== true) {
        throw new Error("Readiness did not confirm biometric provider");
      }
      if (body.requirements?.privateStorage && body.dependencies?.privateObjectStorage !== true) {
        throw new Error("Readiness did not confirm private storage");
      }
      if (body.requirements?.email && body.dependencies?.email !== true) {
        throw new Error("Readiness did not confirm email configuration");
      }
    }
    result[name] = { status: response.status, state: body.status };
  }

  const lecturer = await verifyLecturerSite({ lecturerWebBaseUrl, fetchImpl });
  result.lecturerWeb = { status: lecturer.status, bundleStatus: lecturer.bundleStatus };
  result.cors = await verifyCors({ baseUrl, lecturerOrigin: lecturer.origin, fetchImpl });
  return result;
}

if (require.main === module) {
  runDeploymentSmoke()
    .then((result) => {
      for (const [name, value] of Object.entries(result)) {
        if (name === "cors") {
          console.log("PASS CORS: HTTP " + value.status + ", allowed origin " + value.allowedOrigin);
        } else if (name === "lecturerWeb") {
          console.log("PASS lecturer web: HTTP " + value.status + ", JavaScript bundle HTTP " + value.bundleStatus);
        } else {
          console.log("PASS " + name + ": HTTP " + value.status + ", " + value.state);
        }
      }
    })
    .catch((error) => {
      console.error("STAGING SMOKE FAILED:", error.message);
      process.exitCode = 1;
    });
}

module.exports = { buildEndpointUrl, buildLecturerSiteUrl, runDeploymentSmoke, verifyLecturerSite, verifyCors };
