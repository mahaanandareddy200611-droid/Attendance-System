import api from "../api/api";

const DB_NAME = "attendance-device-credentials";
const STORE = "keys";
const keyIdFor = (userId) => `active-ed25519-private-key:${userId}`;
const deviceIdKeyFor = (userId) => `attendanceDeviceId:${userId}`;

export const getMyDevice = () => api.get("/devices/me");
export const revokeMyDevice = () => api.delete("/devices/me");

function openKeyDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savePrivateKey(key, keyId) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(key, keyId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function removeRegisteredBrowserKey(userId) {
  const db = await openKeyDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(keyIdFor(userId));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  localStorage.removeItem(deviceIdKeyFor(userId));
}

export async function getDevicePrivateKey(userId) {
  if (!userId) return null;
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(STORE, "readonly")
      .objectStore(STORE)
      .get(keyIdFor(userId));
    request.onsuccess = () => {
      db.close();
      resolve(request.result || null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

function toBase64(bytes) {
  let binary = "";
  new Uint8Array(bytes).forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export async function hasRegisteredDeviceKey(userId) {
  return Boolean(await getDevicePrivateKey(userId));
}

export async function registerThisBrowser(userId) {
  if (!userId) throw new Error("Log in before registering this device.");
  if (!window.crypto?.subtle || !window.indexedDB) {
    throw new Error(
      "This browser does not support secure device registration.",
    );
  }
  const deviceIdKey = deviceIdKeyFor(userId);
  const deviceId = localStorage.getItem(deviceIdKey) || crypto.randomUUID();
  const challengeResponse = await api.post("/devices/registration-challenge");
  const { challengeId, challenge } = challengeResponse.data.data;
  const generated = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    false,
    ["sign", "verify"],
  );
  const publicDer = await crypto.subtle.exportKey("spki", generated.publicKey);
  const publicBase64 = toBase64(publicDer);
  const publicKey = `-----BEGIN PUBLIC KEY-----\n${publicBase64.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----`;
  const signatureBytes = await crypto.subtle.sign(
    "Ed25519",
    generated.privateKey,
    new TextEncoder().encode(challenge),
  );
  const signature = toBase64(signatureBytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  await api.post("/devices/register", {
    challengeId,
    deviceId,
    publicKey,
    signature,
  });
  await savePrivateKey(generated.privateKey, keyIdFor(userId));
  localStorage.setItem(deviceIdKey, deviceId);
  return deviceId;
}

function canonicalNumber(value, fieldName) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }
  return Object.is(number, -0) ? "0" : String(number);
}

function canonicalTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("capturedAt must be a valid timestamp");
  }
  return date.toISOString();
}

export async function signAttendanceRequest({
  userId,
  deviceId,
  sessionId,
  token,
  idempotencyKey,
  biometricAssertionId,
  latitude,
  longitude,
  accuracyMeters,
  capturedAt,
}) {
  const privateKey = await getDevicePrivateKey(userId);
  if (!privateKey)
    throw new Error("Register this browser as your attendance device first.");

  // Keep this fixed-order payload identical to backend attendanceSignaturePayload.js.
  const message = JSON.stringify([
    "ATTENDANCE_V2",
    String(deviceId ?? ""),
    String(sessionId ?? ""),
    String(token ?? ""),
    String(idempotencyKey ?? ""),
    String(biometricAssertionId ?? ""),
    canonicalNumber(latitude, "latitude"),
    canonicalNumber(longitude, "longitude"),
    canonicalNumber(accuracyMeters, "accuracyMeters"),
    canonicalTimestamp(capturedAt),
  ]);

  const signatureBytes = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(message),
  );
  return toBase64(signatureBytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
