const INTERNAL_ORIGIN = "https://attendance.local";

export function safeReturnPath(location, fallback) {
  const pathname = location && location.pathname;
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("\\")
  ) {
    return fallback;
  }

  try {
    const candidate = new URL(
      pathname + (location.search || "") + (location.hash || ""),
      INTERNAL_ORIGIN,
    );
    if (candidate.origin !== INTERNAL_ORIGIN) return fallback;
    if (candidate.pathname === "/login" || candidate.pathname === "/signup") {
      return fallback;
    }
    return candidate.pathname + candidate.search + candidate.hash;
  } catch {
    return fallback;
  }
}
