export function resolveApiBaseUrl(configuredValue, { dev = false } = {}) {
  const configured = String(configuredValue || "").trim();

  if (!configured) {
    if (dev) return "http://localhost:3000/api/v1";
    throw new Error("VITE_API_BASE_URL must be set to the deployed HTTPS API base ending in /api/v1.");
  }

  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("VITE_API_BASE_URL must be a valid absolute URL.");
  }

  const localHttpAllowed =
    dev &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);

  if (
    (url.protocol !== "https:" && !localHttpAllowed) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, "") !== "/api/v1"
  ) {
    throw new Error("VITE_API_BASE_URL must use HTTPS and end exactly in /api/v1 (without credentials or query parameters).");
  }

  return url.origin + "/api/v1";
}
