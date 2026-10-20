import { apiRequest } from "./api";

export async function getBiometricEnrollment(token: string) {
  const response = await apiRequest<any>("/biometric/me", { token });
  return response.data ?? null;
}

export async function enrollFace(token: string, imageUri: string) {
  const form = new FormData();
  form.append("image", { uri: imageUri, name: "enrollment.jpg", type: "image/jpeg" } as any);
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
  if (frames.length !== 3) throw new Error("Exactly three camera frames are required.");
  const form = new FormData();
  form.append("sessionId", sessionId);
  form.append("challengeId", challengeId);
  form.append("challenge", challenge);
  frames.forEach((uri, index) => {
    form.append("frames", { uri, name: "liveness-" + (index + 1) + ".jpg", type: "image/jpeg" } as any);
  });
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
