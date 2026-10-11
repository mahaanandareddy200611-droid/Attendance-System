import api from "../api/api";

const DB_NAME = "attendance-device-credentials";
const STORE = "keys";
const KEY_ID = "active-ed25519-private-key";

function openKeyDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savePrivateKey(key) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(key, KEY_ID);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getDevicePrivateKey() {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY_ID);
    request.onsuccess = () => { db.close(); resolve(request.result || null); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

function toBase64(bytes) {
  let binary = "";
  new Uint8Array(bytes).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

export async function hasRegisteredDeviceKey() {
  return Boolean(await getDevicePrivateKey());
}

export async function registerThisBrowser() {
  if (!window.crypto?.subtle || !window.indexedDB) {
    throw new Error("This browser does not support secure device registration.");
  }
  const deviceId = localStorage.getItem("attendanceDeviceId") || crypto.randomUUID();
  const challengeResponse = await api.post("/devices/registration-challenge");
  const { challengeId, challenge } = challengeResponse.data.data;
  const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicDer = await crypto.subtle.exportKey("spki", generated.publicKey);
  const privateDer = await crypto.subtle.exportKey("pkcs8", generated.privateKey);
  const privateKey = await crypto.subtle.importKey("pkcs8", privateDer, { name: "Ed25519" }, false, ["sign"]);
  const publicBase64 = toBase64(publicDer);
  const publicKey = `-----BEGIN PUBLIC KEY-----\n${publicBase64.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----`;
  const signatureBytes = await crypto.subtle.sign("Ed25519", generated.privateKey, new TextEncoder().encode(challenge));
  const signature = toBase64(signatureBytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

  await api.post("/devices/register", { challengeId, deviceId, publicKey, signature });
  await savePrivateKey(privateKey);
  localStorage.setItem("attendanceDeviceId", deviceId);
  return deviceId;
}

export async function signAttendanceRequest({ sessionId, token, idempotencyKey }) {
  const privateKey = await getDevicePrivateKey();
  if (!privateKey) throw new Error("Register this browser as your attendance device first.");
  const message = ["ATTENDANCE_V1", sessionId, token, idempotencyKey].join("|");
  const signatureBytes = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(message));
  return toBase64(signatureBytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
