import { Platform } from "react-native";

import { apiRequest } from "./api";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 - 16 * 1024;
const MAX_WEB_CAPTURE_CHARS = 16 * 1024 * 1024;

async function createWebCameraBlob(uri: string): Promise<Blob> {
  let source: Blob;
  try {
    // On web, expo-camera's "uri" may be raw base64 (not a data URL).
    // Handle both that SDK format and explicit data:/blob: URLs.
    if (/^(data:|blob:)/i.test(uri)) {
      const response = await fetch(uri);
      if (!response.ok) throw new Error("capture unreadable");
      source = await response.blob();
    } else {
      const base64 = uri.trim();
      if (!base64 || base64.length > MAX_WEB_CAPTURE_CHARS) {
        throw new Error("capture size invalid");
      }
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      source = new Blob([bytes], { type: "image/jpeg" });
    }
  } catch {
    throw new Error("Could not read the live camera capture. Close and reopen the camera, then retry.");
  }

  if (!source.size) {
    throw new Error("The camera returned an empty image. Keep your face visible and retry.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new Error("The camera image could not be decoded. Improve lighting, keep your face centered, and retry.");
  }

  try {
    const longestSide = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, 1280 / longestSide);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("This browser could not prepare the camera image. Try a current version of Chrome or Edge.");
    }

    context.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.82, 0.72, 0.62, 0.52, 0.42]) {
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", quality);
      });
      if (!blob || !blob.size) continue;
      if (blob.type !== "image/jpeg") {
        throw new Error("The browser could not encode the camera image as JPEG. Retry in a current browser.");
      }
      if (blob.size <= MAX_UPLOAD_BYTES) return blob;
    }
    throw new Error("The camera image is too large to upload safely. Move closer to your face, improve lighting, and retry.");
  } finally {
    bitmap.close();
  }
}

async function appendImagePart(form: FormData, fieldName: string, uri: string, filename: string) {
  if (Platform.OS === "web") {
    form.append(fieldName, await createWebCameraBlob(uri), filename);
    return;
  }
  form.append(fieldName, { uri, name: filename, type: "image/jpeg" } as any);
}

export async function getBiometricEnrollment(token: string) {
  const response = await apiRequest<any>("/biometric/me", { token });
  return response.data ?? null;
}

export async function enrollFace(token: string, imageUri: string, consentGiven: boolean) {
  if (!consentGiven) {
    throw new Error("Explicit consent is required before creating a biometric profile.");
  }
  const form = new FormData();
  await appendImagePart(form, "image", imageUri, "enrollment.jpg");
  form.append("consent", "true");
  form.append("consentVersion", "face-attendance-v1");
  return apiRequest<any>("/biometric/enroll", {
    method: "POST",
    token,
    body: form,
    timeoutMs: 30000,
  });
}

export async function deleteFaceEnrollment(token: string) {
  return apiRequest<any>("/biometric/me", { method: "DELETE", token });
}

export async function issueActiveLivenessChallenge(token: string, sessionId: string) {
  const response = await apiRequest<any>("/biometric/challenge-active", {
    method: "POST",
    token,
    body: { sessionId },
  });
  if (!response.data?.challengeId || !response.data?.challenge || !Array.isArray(response.data?.steps)) {
    throw new Error("The server returned an invalid liveness challenge.");
  }
  return response.data as {
    challengeId: string;
    challenge: string;
    steps: { index: number; step: string; instruction: string }[];
    expiresInMs: number;
  };
}

export async function verifyActiveLiveness({
  token,
  sessionId,
  challengeId,
  challenge,
  frames,
}: {
  token: string;
  sessionId: string;
  challengeId: string;
  challenge: string;
  frames: string[];
}) {
  if (frames.length !== 5) throw new Error("Exactly five camera frames are required.");
  const form = new FormData();
  form.append("sessionId", sessionId);
  form.append("challengeId", challengeId);
  form.append("challenge", challenge);
  for (const [index, uri] of frames.entries()) {
    await appendImagePart(form, "frames", uri, "liveness-" + (index + 1) + ".jpg");
  }
  const response = await apiRequest<any>("/biometric/verify-active", {
    method: "POST",
    token,
    body: form,
    timeoutMs: 45000,
  });
  const assertionId = response.data?.assertionId;
  if (!assertionId) throw new Error("Liveness verification did not return a one-time assertion.");
  return assertionId as string;
}
