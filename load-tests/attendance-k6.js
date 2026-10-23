import http from "k6/http";
import { check } from "k6";

const BASE_URL = String(__ENV.BASE_URL || "").replace(/\/+$/, "");
const TEST_PATH = String(__ENV.TEST_PATH || "/livez");
const TARGET_RPS = Number(__ENV.TARGET_RPS || 100);
const TARGET_DURATION = String(__ENV.TARGET_DURATION || "30s");
const AUTH_TOKEN_VALUES = String(__ENV.STAGING_BEARER_TOKENS || "")
  .split(/[\r\n,]+/)
  .map((value) => value.trim().replace(/^Bearer\s+/i, ""))
  .filter(Boolean);

const ALLOWED_PATHS = new Set(["/livez", "/health", "/auth/me"]);
const ALLOWED_RATES = new Set([50, 100, 300, 1000, 3000]);
const ALLOWED_DURATIONS = new Set(["30s", "60s", "120s"]);

if (!BASE_URL) throw new Error("BASE_URL is required.");
let parsedBase;
try {
  parsedBase = new URL(BASE_URL);
} catch {
  throw new Error("BASE_URL must be a valid HTTPS staging API base ending in /api/v1.");
}
if (parsedBase.protocol !== "https:") {
  throw new Error("The load test is HTTPS-only.");
}
if (!parsedBase.hostname.toLowerCase().includes("staging")) {
  throw new Error("Refusing to load test a non-staging hostname.");
}
const basePath = parsedBase.pathname.endsWith("/") ? parsedBase.pathname.slice(0, -1) : parsedBase.pathname;
if (basePath !== "/api/v1" || parsedBase.search || parsedBase.hash) {
  throw new Error("BASE_URL must end in exactly /api/v1 and have no query or fragment.");
}
if (!ALLOWED_PATHS.has(TEST_PATH)) {
  throw new Error("TEST_PATH must be /livez, /health, or /auth/me. Write endpoints are deliberately excluded.");
}
if (!ALLOWED_RATES.has(TARGET_RPS)) {
  throw new Error("TARGET_RPS must be one of 50, 100, 300, 1000, or 3000.");
}
if (!ALLOWED_DURATIONS.has(TARGET_DURATION)) {
  throw new Error("TARGET_DURATION must be 30s, 60s, or 120s.");
}
if (TEST_PATH === "/auth/me" && AUTH_TOKEN_VALUES.length === 0) {
  throw new Error("The read-only /auth/me test requires STAGING_BEARER_TOKENS containing dedicated synthetic-user tokens.");
}

const tokenPoolSize = AUTH_TOKEN_VALUES.length;
const maxVUs = Math.min(Math.max(100, TARGET_RPS * 2), 6000);
const preAllocatedVUs = Math.min(Math.max(50, Math.ceil(TARGET_RPS * 0.5)), 2000);

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: {
    gradual_arrival_rate: {
      executor: "ramping-arrival-rate",
      startRate: Math.min(20, TARGET_RPS),
      timeUnit: "1s",
      preAllocatedVUs,
      maxVUs,
      stages: [
        { target: Math.min(100, TARGET_RPS), duration: "15s" },
        { target: Math.min(300, TARGET_RPS), duration: "20s" },
        { target: Math.min(1000, TARGET_RPS), duration: "20s" },
        { target: TARGET_RPS, duration: TARGET_DURATION },
        { target: 0, duration: "10s" },
      ],
      gracefulStop: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    http_req_duration: ["p(95)<750", "p(99)<1500"],
  },
};

export default function () {
  const headers = {
    Accept: "application/json",
    "User-Agent": "attendance-system-staging-load-test/1.0",
  };

  if (TEST_PATH === "/auth/me") {
    // Rotate through synthetic test identities so a single per-user limiter
    // does not turn a read-path capacity test into a single-account abuse test.
    const tokenIndex = ((__VU + __ITER) % tokenPoolSize + tokenPoolSize) % tokenPoolSize;
    headers.Authorization = `Bearer ${AUTH_TOKEN_VALUES[tokenIndex]}`;
  }

  const response = http.get(`${BASE_URL}${TEST_PATH}`, {
    headers,
    timeout: "10s",
    tags: { endpoint: TEST_PATH },
  });

  check(response, {
    "endpoint returned HTTP 200": (result) => result.status === 200,
  });
}
