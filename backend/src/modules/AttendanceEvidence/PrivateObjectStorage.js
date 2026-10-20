"use strict";

const DEFAULT_BUCKET = "attendance-evidence-private";
const DEFAULT_TIMEOUT_MS = 10000;
const EVIDENCE_PREFIX = "attendance-evidence/";

class StorageUnavailableError extends Error {
    constructor(message = "Private object storage is unavailable") {
        super(message);
        this.name = "StorageUnavailableError";
        this.statusCode = 503;
        this.code = "PRIVATE_STORAGE_UNAVAILABLE";
    }
}

function readConfig(env = process.env) {
    const rawUrl = String(env.SUPABASE_URL || "").trim();
    const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    const bucket = String(env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET).trim();
    const timeoutMs = Number(env.SUPABASE_STORAGE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

    if (!rawUrl || !serviceRoleKey) {
        throw new StorageUnavailableError(
            "Private object storage is not configured"
        );
    }

    let baseUrl;
    try {
        baseUrl = new URL(rawUrl);
    } catch {
        throw new StorageUnavailableError("Private object storage URL is invalid");
    }

    const localHost = ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname);
    if (
        (baseUrl.protocol !== "https:" && !(localHost && baseUrl.protocol === "http:")) ||
        baseUrl.username ||
        baseUrl.password ||
        (baseUrl.pathname !== "/" && baseUrl.pathname !== "")
    ) {
        throw new StorageUnavailableError(
            "Private object storage must use an HTTPS project origin"
        );
    }

    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(bucket)) {
        throw new StorageUnavailableError("Private object storage bucket name is invalid");
    }

    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
        throw new StorageUnavailableError(
            "SUPABASE_STORAGE_TIMEOUT_MS must be between 1000 and 60000"
        );
    }

    return {
        baseUrl: baseUrl.origin,
        serviceRoleKey,
        bucket,
        timeoutMs
    };
}

function encodeObjectPath(objectKey) {
    if (
        typeof objectKey !== "string" ||
        !objectKey.startsWith(EVIDENCE_PREFIX) ||
        objectKey.startsWith("/") ||
        objectKey.includes("\\") ||
        objectKey.split("/").some((segment) =>
            !segment || segment === "." || segment === ".."
        )
    ) {
        throw new TypeError("Invalid attendance evidence object key");
    }

    return objectKey.split("/").map(encodeURIComponent).join("/");
}

function makeSignedUrl(rawSignedUrl, baseUrl) {
    if (typeof rawSignedUrl !== "string" || !rawSignedUrl.trim()) {
        throw new StorageUnavailableError("Storage did not return a signed URL");
    }

    const origin = new URL(baseUrl).origin;
    let parsed;

    try {
        if (/^https?:\/\//i.test(rawSignedUrl)) {
            parsed = new URL(rawSignedUrl);
        } else {
            // Storage API versions may return either "object/sign/..." or
            // "/object/sign/...". Resolve both against this project's API path.
            const route = rawSignedUrl
                .replace(/^\/storage\/v1\//, "")
                .replace(/^\/+/, "");
            parsed = new URL(route, `${origin}/storage/v1/`);
        }
    } catch {
        throw new StorageUnavailableError("Storage returned an invalid signed URL");
    }

    if (
        parsed.origin !== origin ||
        !parsed.pathname.startsWith("/storage/v1/object/sign/") ||
        parsed.username ||
        parsed.password
    ) {
        throw new StorageUnavailableError(
            "Storage returned a signed URL outside the configured project"
        );
    }

    return parsed.toString();
}

function createPrivateObjectStorage({
    env = process.env,
    fetchImpl = globalThis.fetch
} = {}) {
    if (typeof fetchImpl !== "function") {
        throw new StorageUnavailableError("This Node.js runtime does not support fetch");
    }

    const config = () => readConfig(env);

    async function request(route, {
        method = "GET",
        jsonBody,
        body,
        contentType
    } = {}) {
        const settings = config();
        const url = new URL(`/storage/v1/${route}`, settings.baseUrl);
        const headers = {
            apikey: settings.serviceRoleKey,
            Authorization: `Bearer ${settings.serviceRoleKey}`
        };

        if (jsonBody !== undefined) {
            headers["content-type"] = "application/json";
            body = JSON.stringify(jsonBody);
        } else if (contentType) {
            headers["content-type"] = contentType;
        }

        try {
            const response = await fetchImpl(url, {
                method,
                headers,
                body,
                signal: AbortSignal.timeout(settings.timeoutMs)
            });

            if (!response.ok) {
                // Never propagate provider response bodies: they may contain
                // infrastructure details or request identifiers.
                throw new StorageUnavailableError(
                    `Private object storage request failed (HTTP ${response.status})`
                );
            }

            if (response.status === 204) return null;
            const responseText = await response.text();
            if (!responseText) return null;

            try {
                return JSON.parse(responseText);
            } catch {
                throw new StorageUnavailableError(
                    "Private object storage returned an invalid response"
                );
            }
        } catch (error) {
            if (error instanceof StorageUnavailableError) throw error;
            throw new StorageUnavailableError();
        }
    }

    return {
        async uploadObject(objectKey, buffer, mimeType = "image/jpeg") {
            const safeKey = encodeObjectPath(objectKey);
            if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > 2 * 1024 * 1024) {
                throw new TypeError("Evidence image must be a non-empty Buffer no larger than 2 MiB");
            }
            if (mimeType !== "image/jpeg") {
                throw new TypeError("Only normalized JPEG evidence may be retained");
            }

            return request(
                `object/${encodeURIComponent(config().bucket)}/${safeKey}`,
                {
                    method: "POST",
                    body: buffer,
                    contentType: mimeType
                }
            );
        },

        async removeObjects(objectKeys) {
            if (!Array.isArray(objectKeys) || objectKeys.length === 0 || objectKeys.length > 100) {
                throw new TypeError("Delete operation must contain 1 to 100 object keys");
            }
            const safeKeys = objectKeys.map(encodeObjectPath);
            return request(
                `object/${encodeURIComponent(config().bucket)}`,
                {
                    method: "DELETE",
                    jsonBody: { prefixes: safeKeys }
                }
            );
        },

        async createSignedUrl(objectKey, expiresInSeconds = 60) {
            const safeKey = encodeObjectPath(objectKey);
            if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 300) {
                throw new TypeError("Signed URL expiry must be between 1 and 300 seconds");
            }

            const settings = config();
            const result = await request(
                `object/sign/${encodeURIComponent(settings.bucket)}/${safeKey}`,
                {
                    method: "POST",
                    jsonBody: { expiresIn: expiresInSeconds }
                }
            );

            return makeSignedUrl(
                result?.signedURL || result?.signedUrl,
                settings.baseUrl
            );
        },

        async listObjects(prefix, { limit = 100, offset = 0 } = {}) {
            if (
                typeof prefix !== "string" ||
                !(prefix === "attendance-evidence" || prefix.startsWith(EVIDENCE_PREFIX)) ||
                !Number.isInteger(limit) ||
                limit < 1 ||
                limit > 1000 ||
                !Number.isInteger(offset) ||
                offset < 0
            ) {
                throw new TypeError("Invalid private evidence listing request");
            }

            const settings = config();
            const result = await request(
                `object/list/${encodeURIComponent(settings.bucket)}`,
                {
                    method: "POST",
                    jsonBody: {
                        prefix,
                        limit,
                        offset,
                        sortBy: { column: "name", order: "asc" }
                    }
                }
            );

            if (!Array.isArray(result)) {
                throw new StorageUnavailableError("Storage returned an invalid object listing");
            }
            return result;
        },

        async listEvidenceObjects({ maxObjects = 5000 } = {}) {
            if (!Number.isInteger(maxObjects) || maxObjects < 1 || maxObjects > 20000) {
                throw new TypeError("maxObjects must be between 1 and 20000");
            }

            const files = [];
            const visitedDirectories = new Set();
            const queue = ["attendance-evidence"];

            while (queue.length > 0 && files.length < maxObjects) {
                const directory = queue.shift();
                if (visitedDirectories.has(directory)) continue;
                visitedDirectories.add(directory);

                let offset = 0;
                while (files.length < maxObjects) {
                    const rows = await this.listObjects(directory, { limit: 100, offset });
                    for (const row of rows) {
                        if (!row || typeof row.name !== "string" || !row.name || row.name.includes("/")) {
                            continue;
                        }
                        const objectKey = `${directory}/${row.name}`;
                        const isDirectory = row.id == null && row.metadata == null;

                        if (isDirectory) {
                            if (queue.length + visitedDirectories.size < 2000) queue.push(objectKey);
                            continue;
                        }

                        files.push({
                            objectKey,
                            createdAt: row.created_at || row.updated_at || null,
                            size: Number(row.metadata?.size) || null
                        });
                        if (files.length >= maxObjects) break;
                    }
                    if (rows.length < 100) break;
                    offset += rows.length;
                }
            }
            return files;
        }
    };
}

const defaultStorage = createPrivateObjectStorage();

module.exports = {
    createPrivateObjectStorage,
    readConfig,
    encodeObjectPath,
    makeSignedUrl,
    StorageUnavailableError,
    defaultStorage
};
