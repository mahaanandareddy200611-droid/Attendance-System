"use strict";

const value = String(process.env.VITE_API_BASE_URL || "").trim();

function fail(message) {
  console.error("Production API configuration error: " + message);
  process.exitCode = 1;
}

if (!value) {
  fail("VITE_API_BASE_URL is required for production builds.");
} else {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("VITE_API_BASE_URL must be an absolute HTTPS URL ending in /api/v1.");
  }

  if (url) {
    const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    const retiredHost = url.hostname === "attendance-backend-staging.onrender.com";
    const path = url.pathname.replace(/\/+$/, "");
    if (
      url.protocol !== "https:" ||
      localHost ||
      retiredHost ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      path !== "/api/v1"
    ) {
      fail("VITE_API_BASE_URL must use public HTTPS and end exactly in /api/v1, with no credentials or query parameters.");
    } else {
      console.log("Production API origin configuration passed.");
    }
  }
}
