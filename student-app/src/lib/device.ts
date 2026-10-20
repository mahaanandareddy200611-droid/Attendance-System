import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import nacl from "tweetnacl";

import { apiRequest } from "./api";

const DEVICE_ID_PREFIX = "attendance:device-id:";
const DEVICE_SEED_PREFIX = "attendance:device-seed:";
const SPKI_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1] : 0;
    const c = hasC ? bytes[i + 2] : 0;
    output += BASE64[a >> 2];
    output += BASE64[((a & 3) << 4) | (b >> 4)];
    output += hasB ? BASE64[((b & 15) << 2) | (c >> 6)] : "=";
    output += hasC ? BASE64[c & 63] : "=";
  }
  return output;
}

export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "");
  let accumulator = 0;
  let bits = 0;
  const output: number[] = [];
  for (const character of clean) {
    const value = BASE64.indexOf(character);
    if (value < 0) throw new Error("Stored device key is corrupted.");
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

export function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toPublicKeyPem(rawPublicKey: Uint8Array): string {
  const der = new Uint8Array(SPKI_ED25519_PREFIX.length + rawPublicKey.length);
  der.set(SPKI_ED25519_PREFIX, 0);
  der.set(rawPublicKey, SPKI_ED25519_PREFIX.length);
  const base64 = bytesToBase64(der);
  const lines = base64.match(/.{1,64}/g) || [];
  return "-----BEGIN PUBLIC KEY-----\n" + lines.join("\n") + "\n-----END PUBLIC KEY-----";
}

async function loadSeed(userId: string): Promise<Uint8Array | null> {
  const stored = await SecureStore.getItemAsync(DEVICE_SEED_PREFIX + userId);
  return stored ? base64ToBytes(stored) : null;
}

export async function removeNativeDeviceKey(userId: string) {
  await Promise.all([
    SecureStore.deleteItemAsync(DEVICE_ID_PREFIX + userId),
    SecureStore.deleteItemAsync(DEVICE_SEED_PREFIX + userId),
  ]);
}

export async function getOrRegisterNativeDevice(userId: string, token: string) {
  const existingId = await SecureStore.getItemAsync(DEVICE_ID_PREFIX + userId);
  const existingSeed = await loadSeed(userId);

  if (existingId && existingSeed?.length === 32) {
    try {
      const remote = await apiRequest<any>("/devices/me", { token });
      if (remote.data?.status === "ACTIVE" && remote.data?.deviceId === existingId) {
        return existingId;
      }
    } catch {
      // A revoked or missing credential must not be trusted from local storage alone.
    }
  }

  const seed = existingSeed?.length === 32
    ? existingSeed
    : await Crypto.getRandomBytesAsync(32);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const deviceId = "native-" + Crypto.randomUUID();
  const challengeResponse = await apiRequest<any>("/devices/registration-challenge", {
    method: "POST",
    token,
  });
  const challengeId = challengeResponse.data?.challengeId;
  const challenge = challengeResponse.data?.challenge;
  if (!challengeId || !challenge) throw new Error("The server returned an invalid device challenge.");

  const signature = toBase64Url(
    nacl.sign.detached(new TextEncoder().encode(challenge), keyPair.secretKey),
  );
  await apiRequest("/devices/register", {
    method: "POST",
    token,
    body: {
      challengeId,
      deviceId,
      publicKey: toPublicKeyPem(keyPair.publicKey),
      signature,
    },
  });

  // Save only after server registration succeeds. The seed never leaves SecureStore.
  await SecureStore.setItemAsync(DEVICE_SEED_PREFIX + userId, bytesToBase64(seed));
  await SecureStore.setItemAsync(DEVICE_ID_PREFIX + userId, deviceId);
  return deviceId;
}

function canonicalNumber(value: number, fieldName: string) {
  if (!Number.isFinite(value)) throw new TypeError(fieldName + " must be a finite number");
  return Object.is(value, -0) ? "0" : String(value);
}

export async function signAttendance({
  userId,
  deviceId,
  sessionId,
  qrToken,
  idempotencyKey,
  biometricAssertionId,
  latitude,
  longitude,
  accuracyMeters,
  capturedAt,
}: {
  userId: string;
  deviceId: string;
  sessionId: string;
  qrToken: string;
  idempotencyKey: string;
  biometricAssertionId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
}) {
  const seed = await loadSeed(userId);
  if (!seed || seed.length !== 32) throw new Error("Register this phone as your attendance device first.");
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const message = JSON.stringify([
    "ATTENDANCE_V2",
    String(deviceId),
    String(sessionId),
    String(qrToken),
    String(idempotencyKey),
    String(biometricAssertionId),
    canonicalNumber(latitude, "latitude"),
    canonicalNumber(longitude, "longitude"),
    canonicalNumber(accuracyMeters, "accuracyMeters"),
    new Date(capturedAt).toISOString(),
  ]);
  return toBase64Url(nacl.sign.detached(new TextEncoder().encode(message), keyPair.secretKey));
}
