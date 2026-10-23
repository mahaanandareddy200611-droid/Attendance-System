export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  "https://attendance-backend-staging-n04q.onrender.com/api/v1"
).replace(/\/+$/, "");

export type ApiEnvelope<T> = {
  success?: boolean;
  message?: string;
  data?: T;
  token?: string;
  error?: { code?: string; message?: string; details?: unknown };
  requestId?: string;
  [key: string]: unknown;
};

export class ApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

type RequestOptions = {
  method?: string;
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export async function apiRequest<T = any>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiEnvelope<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 20000,
  );
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload: ApiEnvelope<T> = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { message: raw ? "Server returned an invalid response." : "Empty server response." };
    }
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const message = response.status === 429
        ? Number.isFinite(retryAfter) && retryAfter > 0
          ? `Too many requests. Wait ${Math.ceil(retryAfter)} seconds before retrying; you do not need to reload.`
          : "Too many requests. Wait a moment before retrying; do not keep submitting the same image."
        : payload.error?.message || payload.message || `Request failed (${response.status})`;
      throw new ApiError(
        message,
        response.status,
        payload.error?.code,
        payload.requestId,
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as Error)?.name === "AbortError") {
      throw new Error("The request timed out. Check the connection and retry.");
    }
    if (error instanceof TypeError) {
      throw new Error(
        `Cannot reach ${API_BASE_URL}. For a physical phone on local Wi-Fi, set EXPO_PUBLIC_API_BASE_URL to your computer's LAN IP and backend port.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
