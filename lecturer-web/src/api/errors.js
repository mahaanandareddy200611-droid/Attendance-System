export function normalizeApiError(
  error,
  fallback = "Something went wrong. Please try again.",
) {
  const status = error?.response?.status ?? null;
  const data = error?.response?.data;

  const isTimeout =
    error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT";

  const isNetworkError =
    !error?.response && Boolean(error?.request) && !isTimeout;

  let message = fallback;

  if (isTimeout) {
    message = "The request timed out. Please try again.";
  } else if (isNetworkError) {
    message = "Could not reach the server. Check your connection.";
  } else if (typeof data?.message === "string" && data.message.trim()) {
    message = data.message.trim();
  } else if (
    typeof data?.error?.message === "string" &&
    data.error.message.trim()
  ) {
    message = data.error.message.trim();
  } else if (typeof data?.error === "string" && data.error.trim()) {
    message = data.error.trim();
  } else if (status === 400) {
    message = "Invalid request. Check the submitted information.";
  } else if (status === 401) {
    message = "Authentication failed. Please log in again.";
  } else if (status === 403) {
    message = "You do not have permission to perform this action.";
  } else if (status === 404) {
    message = "The requested resource was not found.";
  } else if (status === 409) {
    message = "This operation conflicts with existing data.";
  } else if (status === 429) {
    message = "Too many requests. Please try again later.";
  } else if (status >= 500) {
    message = "A server error occurred. Please try again later.";
  } else if (error?.message && !error?.isAxiosError) {
    message = error.message;
  }

  if (status === 429) {
    const retryAfter = Number(error?.response?.headers?.["retry-after"]);
    message = Number.isFinite(retryAfter) && retryAfter > 0
      ? `You’ve reached the short-term request limit. Wait ${Math.ceil(retryAfter)} seconds before trying again; you do not need to reload.`
      : "You’ve reached the short-term request limit. Wait a moment before trying again; you do not need to reload.";
  }

  return {
    status,
    message,
    code: data?.code ?? error?.code ?? null,
    details: data?.details ?? data?.errors ?? null,
    requestId:
      data?.requestId ?? error?.response?.headers?.["x-request-id"] ?? null,
    isTimeout,
    isNetworkError,
  };
}

// Backwards-compatible helper used by Login.jsx and Signup.jsx.
export function getApiErrorMessage(
  error,
  fallback = "Something went wrong. Please try again.",
) {
  return normalizeApiError(error, fallback).message;
}
