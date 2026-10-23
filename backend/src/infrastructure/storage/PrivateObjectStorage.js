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

function canonicalizeQuery(parameters = []) {
  return parameters
    .map(([name, value]) => [awsEncode(name), awsEncode(value ?? "")])
    .sort(([nameA, valueA], [nameB, valueB]) => {
      if (nameA !== nameB) return nameA < nameB ? -1 : 1;
      if (valueA === valueB) return 0;
      return valueA < valueB ? -1 : 1;
    })
    .map(([name, value]) => name + "=" + value)
    .join("&");
}

function decodeXmlText(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function readXmlTag(xml, tagName) {
  const pattern = new RegExp("<" + tagName + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tagName + ">");
  const match = pattern.exec(xml);
  return match ? decodeXmlText(match[1]) : null;
}

function parseObjectVersions(xml) {
  const objects = [];
  // S3 ListObjectVersions interleaves Version and DeleteMarker elements in
  // provider order. Scan both tag types with one expression so we preserve
  // that order rather than grouping every Version before every DeleteMarker.
  const pattern = new RegExp("<(Version|DeleteMarker)(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>", "g");
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const kind = match[1];
    const key = readXmlTag(match[2], "Key");
    const versionId = readXmlTag(match[2], "VersionId");
    if (key === null || versionId === null || versionId === "") {
      throw new AppError("Private object storage returned invalid version metadata", 503);
    }
    objects.push({ key, versionId, kind });
  }
  return objects;
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

async function requestSigned({ method, key, body, contentType, query = [], bucketListing = false }) {
  const config = getConfiguration();
  const path = bucketListing ? "/" + awsEncode(config.bucket) : buildPath(config, key);
  const url = new URL(path, config.endpoint.origin);
  const canonicalQuery = canonicalizeQuery(query);
  if (canonicalQuery) url.search = canonicalQuery;

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
      .map((name) => name + ":" + String(headerValues[name]).trim())
      .join("\n");
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
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
  } catch (cause) {
    const error = new AppError("Private object storage is temporarily unavailable", 503);
    error.storageCode = "STORAGE_NETWORK_ERROR";
    const causeCode = cause?.cause?.code || cause?.code;
    const causeName = cause?.cause?.name || cause?.name;
    if (typeof causeCode === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(causeCode)) error.storageCauseCode = causeCode;
    if (typeof causeName === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(causeName)) error.storageCauseName = causeName;
    throw error;
  }

  if (method === "DELETE" && response.status === 404) return response;
  if (!response.ok) {
    let responseBody = "";
    try {
      responseBody = await response.text();
    } catch {
      // The HTTP status remains useful if the provider response body cannot be read.
    }
    const rawCode = readXmlTag(responseBody, "Code");
    const storageCode = typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(rawCode)
      ? rawCode
      : "HTTP_" + response.status;
    const error = new AppError("Private object storage request failed", 503);
    error.storageStatus = response.status;
    error.storageCode = storageCode;
    throw error;
  }
  return response;
}

/*
 * Backblaze B2 buckets are versioned. A plain S3 DELETE creates a hide marker
 * and leaves prior versions stored. If version purging is enabled, enumerate
 * and permanently delete every version and delete marker for this exact key.
 * The feature is opt-in so providers with different versioning support can
 * retain their native delete behavior.
 */
async function listObjectVersions(key) {
  canonicalKey(key);
  const response = await requestSigned({
    method: "GET",
    key,
    bucketListing: true,
    query: [["versions", ""], ["prefix", key]],
  });
  const xml = await response.text();
  if (!/<ListVersionsResult(?:\s|>)/.test(xml)) {
    throw new AppError("Private object storage returned invalid version listing", 503);
  }
  return parseObjectVersions(xml).filter((item) => item.key === key);
}

async function purgeObjectVersions({ key, maxBatches = 100 } = {}) {
  canonicalKey(key);
  let deletedVersions = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const versions = await listObjectVersions(key);
    if (versions.length === 0) return { deletedVersions };

    for (const version of versions) {
      await requestSigned({
        method: "DELETE",
        key,
        query: [["versionId", version.versionId]],
      });
      deletedVersions += 1;
    }
  }

  throw new AppError("Private object storage version deletion could not be verified", 503);
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
  if (String(process.env.OBJECT_STORAGE_PURGE_VERSIONS || "").trim().toLowerCase() === "true") {
    await purgeObjectVersions({ key });
    return;
  }
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
    "host:" + url.host,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const { signature } = makeSignature({ config, date, canonicalRequest });
  return url.origin + url.pathname + "?" + canonicalQuery + "&X-Amz-Signature=" + signature;
};

exports._test = { awsEncode, canonicalKey, canonicalizeQuery, decodeXmlText, parseObjectVersions, listObjectVersions, purgeObjectVersions, getConfiguration, formatAmzDate, sha256 };
