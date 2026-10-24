import api from "../api/api";

export const getMyBiometricEnrollment = () => api.get("/biometric/me");
export const getPendingBiometricEnrollments = () => api.get("/biometric/enrollment-approvals");
export const approveBiometricEnrollment = (studentId) =>
  api.post(`/biometric/enrollment-approvals/${encodeURIComponent(studentId)}/approve`);
export const rejectBiometricEnrollment = (studentId) =>
  api.post(`/biometric/enrollment-approvals/${encodeURIComponent(studentId)}/reject`);

async function prepareBiometricImage(image) {
  if (
    !image ||
    !["image/jpeg", "image/png", "image/webp"].includes(image.type)
  ) {
    throw new Error("Choose a JPEG, PNG, or WebP photo.");
  }
  if (image.size <= 900 * 1024) return image;
  if (!window.createImageBitmap) {
    throw new Error("Choose a photo smaller than 900 KB for upload.");
  }

  const bitmap = await createImageBitmap(image);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.82, 0.7, 0.58, 0.46]) {
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (blob && blob.size <= 900 * 1024) {
      return new File([blob], "attendance-photo.jpg", { type: "image/jpeg" });
    }
  }
  throw new Error(
    "This photo is still too large. Choose a smaller or lower-resolution photo.",
  );
}

export async function enrollBiometric(image) {
  const photo = await prepareBiometricImage(image);
  const form = new FormData();
  form.append("image", photo, photo.name || "enrollment.jpg");
  form.append("consent", "true");
  form.append("consentVersion", "face-attendance-v1");
  return api.post("/biometric/enroll", form);
}

export async function verifyBiometricForSession({ sessionId, image }) {
  const photo = await prepareBiometricImage(image);
  const challengeResponse = await api.post("/biometric/challenge", {
    sessionId,
  });
  const { challengeId } = challengeResponse.data.data;
  const form = new FormData();
  form.append("sessionId", sessionId);
  form.append("challengeId", challengeId);
  form.append("challenge", challengeResponse.data.data.challenge);
  form.append("image", photo, photo.name || "verification.jpg");
  const response = await api.post("/biometric/verify", form);
  return response.data.data.assertionId;
}

export async function createActiveBiometricChallenge(sessionId) {
  const response = await api.post("/biometric/challenge-active", { sessionId }, { timeout: 30000 });
  const challenge = response.data?.data;
  if (!challenge?.challengeId || !challenge?.challenge || !Array.isArray(challenge.steps)) {
    throw new Error("The server returned an invalid liveness challenge.");
  }
  if (challenge.steps.length !== 5) {
    throw new Error(`The server returned ${challenge.steps.length} liveness steps; five ordered frames are required.`);
  }
  return challenge;
}

export async function verifyActiveBiometricSequence({ sessionId, challengeId, challenge, frames }) {
  if (!Array.isArray(frames) || frames.length !== 5) {
    throw new Error("Capture all five requested liveness frames first.");
  }
  const form = new FormData();
  form.append("sessionId", sessionId);
  form.append("challengeId", challengeId);
  form.append("challenge", challenge);
  frames.forEach((frame, index) => {
    form.append("frames", frame, frame.name || `liveness-frame-${index + 1}.jpg`);
  });
  const response = await api.post("/biometric/verify-active", form, {
    timeout: 120000,
  });
  return response.data.data.assertionId;
}

export const deleteMyBiometricEnrollment = () => api.delete("/biometric/me");
