import api from "../api/api";

export async function enrollBiometric(image) {
  const form = new FormData();
  form.append("image", image, image.name || "enrollment.jpg");
  return api.post("/biometric/enroll", form);
}

export async function verifyBiometricForSession({ sessionId, image }) {
  const challengeResponse = await api.post("/biometric/challenge", { sessionId });
  const { challengeId } = challengeResponse.data.data;
  const form = new FormData();
  form.append("sessionId", sessionId);
  form.append("challengeId", challengeId);
  form.append("image", image, image.name || "verification.jpg");
  const response = await api.post("/biometric/verify", form);
  return response.data.data.assertionId;
}
