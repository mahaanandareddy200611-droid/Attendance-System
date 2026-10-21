"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildEndpointUrl, buildLecturerSiteUrl, runDeploymentSmoke } = require("../scripts/deployment-smoke");

function healthyJson(url) {
  const name = new URL(url).pathname.split("/").at(-1);
  if (name === "livez") return { success: true, status: "alive" };
  if (name === "health") return { success: true, status: "healthy" };
  return {
    success: true,
    status: "ready",
    dependencies: { mongodb: true, redis: true, biometricProvider: true, privateObjectStorage: true, email: true },
    requirements: { privateStorage: true, email: true },
  };
}

function fullSmokeFetch(urlValue, options = {}) {
  const url = new URL(String(urlValue));
  if (options.method === "OPTIONS") {
    return Promise.resolve(new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": options.headers.Origin,
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": options.headers["Access-Control-Request-Headers"],
      },
    }));
  }
  if (url.hostname === "lecturer.example.test" && url.pathname === "/") {
    return Promise.resolve(new Response(
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script></body></html>',
      { status: 200, headers: { "content-type": "text/html" } },
    ));
  }
  if (url.hostname === "lecturer.example.test" && url.pathname === "/assets/index-abc123.js") {
    return Promise.resolve(new Response("const app = true;", { status: 200, headers: { "content-type": "application/javascript" } }));
  }
  return Promise.resolve(new Response(JSON.stringify(healthyJson(url)), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

test("smoke URL normalizes API prefix and rejects credentialed URLs", () => {
  assert.equal(buildEndpointUrl("https://api.example.test", "livez").href, "https://api.example.test/api/v1/livez");
  assert.equal(buildEndpointUrl("https://api.example.test/api/v1/", "readyz").href, "https://api.example.test/api/v1/readyz");
  assert.throws(() => buildEndpointUrl("https://u:p@example.test", "health"), /credentials/);
});

test("lecturer web URL must be an HTTPS origin outside local development", () => {
  assert.equal(buildLecturerSiteUrl("https://lecturer.example.test"), "https://lecturer.example.test");
  assert.throws(() => buildLecturerSiteUrl("http://lecturer.example.test"), /must use HTTPS/);
  assert.throws(() => buildLecturerSiteUrl("https://u:p@lecturer.example.test"), /origin/);
  assert.throws(() => buildLecturerSiteUrl("https://lecturer.example.test/subpath"), /origin/);
});

test("smoke checks backend health, lecturer bundle, and exact-origin CORS preflight", async () => {
  const result = await runDeploymentSmoke({
    baseUrl: "https://api.example.test/api/v1",
    lecturerWebBaseUrl: "https://lecturer.example.test",
    fetchImpl: fullSmokeFetch,
  });
  assert.deepEqual(Object.keys(result), ["livez", "health", "readyz", "lecturerWeb", "cors"]);
  assert.deepEqual(result.lecturerWeb, { status: 200, bundleStatus: 200 });
  assert.equal(result.cors.allowedOrigin, "https://lecturer.example.test");
});

test("smoke fails if the deployed web does not serve a JS production bundle", async () => {
  const fetchImpl = async (urlValue, options = {}) => {
    const url = new URL(String(urlValue));
    if (options.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": options.headers.Origin,
      "access-control-allow-methods": "GET",
    } });
    if (url.hostname === "lecturer.example.test") {
      return new Response("<html><body><div id='root'></div></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response(JSON.stringify(healthyJson(url)), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(
    runDeploymentSmoke({ baseUrl: "https://api.example.test", lecturerWebBaseUrl: "https://lecturer.example.test", fetchImpl }),
    /does not reference a production JavaScript bundle/,
  );
});

test("smoke fails if CORS does not allow the deployed lecturer origin", async () => {
  const fetchImpl = async (urlValue, options = {}) => {
    const url = new URL(String(urlValue));
    if (options.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": "https://wrong.example.test",
        "access-control-allow-methods": "GET,POST,OPTIONS",
      } });
    }
    if (url.hostname === "lecturer.example.test" && url.pathname === "/") {
      return new Response('<html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>', { status: 200 });
    }
    if (url.hostname === "lecturer.example.test") {
      return new Response("const app=true", { status: 200, headers: { "content-type": "application/javascript" } });
    }
    return new Response(JSON.stringify(healthyJson(url)), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(
    runDeploymentSmoke({ baseUrl: "https://api.example.test", lecturerWebBaseUrl: "https://lecturer.example.test", fetchImpl }),
    /Backend CORS does not allow/,
  );
});

test("smoke fails when backend readiness fails", async () => {
  const fetchImpl = async (urlValue, options = {}) => {
    const url = new URL(String(urlValue));
    if (options.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": options.headers.Origin,
        "access-control-allow-methods": "GET",
      } });
    }
    if (url.pathname.endsWith("/readyz")) {
      return new Response(JSON.stringify({ success: false, status: "not_ready" }), { status: 503 });
    }
    if (url.hostname === "lecturer.example.test" && url.pathname === "/") {
      return new Response('<html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>', { status: 200 });
    }
    if (url.hostname === "lecturer.example.test") return new Response("bundle", { status: 200 });
    return new Response(JSON.stringify(healthyJson(url)), { status: 200 });
  };
  await assert.rejects(
    runDeploymentSmoke({ baseUrl: "https://api.example.test", lecturerWebBaseUrl: "https://lecturer.example.test", fetchImpl }),
    /readyz is not healthy/,
  );
});
