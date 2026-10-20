"use strict";

const crypto = require("node:crypto");
const AppError = require("../../utils/AppError");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    "%" + character.charCodeAt(0).toString(16).toUpperCase()
  );
}

function getConfiguration(env = process.env) {
  const endpointValue = env.OBJECT_STORAGE_ENDPOINT;
  const bucket = env.OBJECT_STORAGE_BUCKET;
  const accessKeyId = env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  const region = env.OBJECT_STORAGE_REGION || "auto";

  if (!endpointValue || !bucket || !accessKeyId || !secretAccessKey) {
    throw new AppError("Private object storage is not configured", 503);
  }

  let endpoint;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new AppError("Private object storage endpoint is invalid", 503);
  }

  const localHttpAllowed =
    ["localhost", "127.0.0.1", "host.docker.internal"].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== "https:" && !(localHttpAllowed && endpoint.protocol === "http:")) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "")
  ) {
    throw new AppError("Private object storage endpoint must be an HTTPS origin", 503);
  }

  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(bucket)) {
    throw new AppError("Private object storage bucket name is invalid", 503);
  }
  if (!/^[A-Za-z0-9/_-]+$/.test(region)) {
    throw new AppError("Private object storage region is invalid", 503);
  }

  return { endpoint, bucket, accessKeyId, secretAccessKey, region };
}

function canonicalKey(key) {
  if (
    typeof key !== "string" ||
    !key ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new AppError("Object storage key is invalid", 500);
  }
  return "/" + key.split("/").map(awsEncode).join("/");
}

function buildPath(config, key) {
  return "/" + awsEncode(config.bucket) + canonicalKey(key);
}

function signingKey(secretAccessKey, dateStamp, region) {
  const dateKey = hmac("AWS4" + secretAccessKey, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function makeSignature({ config, date, canonicalRequest }) {
  const amzDate = formatAmzDate(date);
  const dateStamp = amzDate.slice(0, 8);
  const scope = dateStamp + "/" + config.region + "/s3/aws4_request";
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = hmac(
    signingKey(config.secretAccessKey, dateStamp, config.region),
    stringToSign,
    "hex"
  );
  return { amzDate, scope, signature };
}

async function requestSigned({ method, key, body, contentType }) {
  const config = getConfiguration();
  const path = buildPath(config, key);
  const url = new URL(path, config.endpoint.origin);
  const payloadHash = sha256(body || Buffer.alloc(0));
  const date = new Date();
  const amzDate = formatAmzDate(date);

  const headerValues = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headerValues["content-type"] = contentType;

  const signedHeaders = Object.keys(headerValues).sort().join(";");
  const canonicalHeaders =
    Object.keys(headerValues)
      .sort()
      .map((name) => name + ":" + String(headerValues[name]).trim() + "\n")
      .join("");
  const canonicalRequest = [
    method,
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const { scope, signature } = makeSignature({
    config,
    date,
    canonicalRequest,
  });
  const headers = {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    Authorization:
      "AWS4-HMAC-SHA256 Credential=" + config.accessKeyId + "/" + scope +
      ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
  };
  if (contentType) headers["content-type"] = contentType;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(method === "PUT" ? { body } : {}),
      signal: AbortSignal.timeout(Number(process.env.OBJECT_STORAGE_TIMEOUT_MS) || 10000),
    });
  } catch {
    throw new AppError("Private object storage is temporarily unavailable", 503);
  }

  if (method === "DELETE" && response.status === 404) return;
  if (!response.ok) {
    throw new AppError("Private object storage request failed", 503);
  }
}

exports.putObject = async ({ key, body, contentType = "image/jpeg" }) => {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new AppError("A non-empty image buffer is required", 400);
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    throw new AppError("Unsupported retained media type", 415);
  }
  await requestSigned({ method: "PUT", key, body, contentType });
};

exports.getConfiguration = getConfiguration;

exports.deleteObject = async ({ key }) => {
  await requestSigned({ method: "DELETE", key });
};

exports.createDownloadUrl = async ({ key, expiresInSeconds }) => {
  const config = getConfiguration();
  const expiration = Number(expiresInSeconds) || 60;
  if (!Number.isInteger(expiration) || expiration < 1 || expiration > 900) {
    throw new AppError("Media URL lifetime must be between 1 and 900 seconds", 500);
  }

  const url = new URL(buildPath(config, key), config.endpoint.origin);
  const date = new Date();
  const amzDate = formatAmzDate(date);
  const dateStamp = amzDate.slice(0, 8);
  const scope = dateStamp + "/" + config.region + "/s3/aws4_request";
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", config.accessKeyId + "/" + scope],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiration)],
    ["X-Amz-SignedHeaders", "host"],
  ].sort(([a], [b]) => a.localeCompare(b));

  const canonicalQuery = query
    .map(([name, value]) => awsEncode(name) + "=" + awsEncode(value))
    .join("&");
  const canonicalRequest = [
    "GET",
    url.pathname,
    canonicalQuery,
    "host:" + url.host + "\n",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const { signature } = makeSignature({ config, date, canonicalRequest });
  return url.origin + url.pathname + "?" + canonicalQuery + "&X-Amz-Signature=" + signature;
};

exports._test = { awsEncode, canonicalKey, getConfiguration, formatAmzDate, sha256 };
