import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const value = String(process.env.VITE_API_BASE_URL || "").trim();
const staleHost = "attendance-backend-staging.onrender.com";

function fail(message) {
  console.error("Built API-origin check failed: " + message);
  process.exitCode = 1;
}

let expected;
try {
  expected = new URL(value);
} catch {
  fail("VITE_API_BASE_URL must be configured before checking the production bundle.");
}

if (expected) {
  const path = expected.pathname.replace(/\/+$/, "");
  if (
    expected.protocol !== "https:" ||
    expected.username ||
    expected.password ||
    expected.search ||
    expected.hash ||
    path !== "/api/v1"
  ) {
    fail("VITE_API_BASE_URL must be public HTTPS and end exactly in /api/v1.");
  } else {
    const assetsDir = join(process.cwd(), "dist", "assets");
    let assets = [];
    try {
      assets = readdirSync(assetsDir)
        .filter((name) => /\.(?:js|mjs|css)$/.test(name))
        .map((name) => readFileSync(join(assetsDir, name), "utf8"));
    } catch {
      fail("The production dist/assets directory is missing. Run the build first.");
    }

    if (!assets.length) fail("No built JavaScript/CSS assets were found.");
    const bundle = assets.join("\n");
    if (!bundle.includes(value)) fail("The built frontend does not contain the configured API origin.");
    if (bundle.includes(staleHost)) fail("The built frontend still references the retired staging backend host.");
    if (process.exitCode !== 1) console.log("Built API-origin check passed.");
  }
}
