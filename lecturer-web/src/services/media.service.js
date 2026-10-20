import api from "../api/api";

export const listSessionEvidence = (sessionId) =>
  api.get(`/media/session/${encodeURIComponent(sessionId)}`);

export const uploadSessionEvidence = (sessionId, image) => {
  const form = new FormData();
  form.append("sessionId", sessionId);
  form.append("image", image, image.name || "evidence.jpg");
  return api.post("/media/evidence", form);
};

export const getSessionEvidenceUrl = (assetId) =>
  api.get(`/media/${encodeURIComponent(assetId)}/url`);

export const deleteSessionEvidence = (assetId) =>
  api.delete(`/media/${encodeURIComponent(assetId)}`);
