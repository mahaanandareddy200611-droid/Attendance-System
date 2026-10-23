import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import WorkspaceHeader from "../components/WorkspaceHeader";
import { useAuth } from "../auth/useAuth";
import { enrollBiometric, getMyBiometricEnrollment } from "../services/biometric.service";
import "../Styles/Academic.css";

function messageFor(error, fallback) {
  return error?.response?.data?.error?.message ||
    error?.response?.data?.message || error?.message || fallback;
}

function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    return "Camera permission was denied. Allow camera access for this HTTPS site, then retry.";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "No front camera was found. Connect or enable a camera, then retry.";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "The camera is busy or blocked by another application. Close other camera apps/tabs, then retry.";
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return "Face enrollment needs HTTPS (or localhost) and browser camera support.";
  }
  return error?.message || "Could not open the front camera. Check browser permissions and retry.";
}

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

export default function StudentFaceEnrollment() {
  const { user } = useAuth();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [enrollment, setEnrollment] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let active = true;
    getMyBiometricEnrollment()
      .then((response) => {
        if (active) setEnrollment(response?.data?.data || null);
      })
      .catch((error) => {
        if (active) setNotice({ type: "error", text: messageFor(error, "Could not read your face-enrollment status.") });
      })
      .finally(() => { if (active) setStatusLoading(false); });
    return () => {
      active = false;
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!stream || !video) return undefined;
    let active = true;
    const onMetadata = () => {
      if (!active) return;
      setCameraReady(video.videoWidth > 0 && video.videoHeight > 0);
      video.play().catch(() => {
        setNotice({ type: "error", text: "Camera preview playback was blocked. Allow playback and retry." });
      });
    };
    video.srcObject = stream;
    video.addEventListener("loadedmetadata", onMetadata);
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) onMetadata();
    return () => {
      active = false;
      video.removeEventListener("loadedmetadata", onMetadata);
      video.srcObject = null;
      stopStream(stream);
      if (streamRef.current === stream) streamRef.current = null;
    };
  }, [stream]);

  const stopCamera = () => {
    const current = streamRef.current;
    streamRef.current = null;
    setStream(null);
    setCameraReady(false);
    stopStream(current);
  };

  const startCamera = async () => {
    if (cameraBusy || submitBusy) return;
    setNotice(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNotice({ type: "error", text: "Face enrollment needs HTTPS (or localhost) and browser camera support." });
      return;
    }
    setCameraBusy(true);
    stopCamera();
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = nextStream;
      setCameraReady(false);
      setStream(nextStream);
      setNotice({ type: "info", text: "Camera opened. Center your face, keep your whole face visible, and use clear lighting." });
    } catch (error) {
      setNotice({ type: "error", text: cameraErrorMessage(error) });
    } finally {
      setCameraBusy(false);
    }
  };

  const refreshStatus = async () => {
    setStatusLoading(true);
    setNotice(null);
    try {
      const response = await getMyBiometricEnrollment();
      setEnrollment(response?.data?.data || null);
    } catch (error) {
      setNotice({ type: "error", text: messageFor(error, "Could not refresh your face-enrollment status.") });
    } finally {
      setStatusLoading(false);
    }
  };

  const submitEnrollment = async () => {
    const video = videoRef.current;
    if (!video || !cameraReady || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
      setNotice({ type: "error", text: "Wait until the live front-camera preview is ready, then try again." });
      return;
    }
    if (["PENDING_APPROVAL", "ACTIVE", "DELETE_PENDING"].includes(enrollment?.status)) {
      setNotice({ type: "error", text: "An enrollment is already pending, active, or being deleted. Refresh the status before retrying." });
      return;
    }
    setSubmitBusy(true);
    setNotice(null);
    try {
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Could not prepare the face image.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      let blob = null;
      for (const quality of [0.82, 0.7, 0.58]) {
        blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (blob && blob.size <= 900 * 1024) break;
      }
      if (!blob || blob.size > 900 * 1024) throw new Error("Could not compress this image below 900 KB. Improve lighting and retry.");
      const response = await enrollBiometric(new File([blob], "student-face-enrollment.jpg", { type: "image/jpeg" }));
      const item = response?.data?.data;
      setEnrollment(item || { status: "PENDING_APPROVAL", enrolledAt: new Date().toISOString() });
      stopCamera();
      setNotice({
        type: "success",
        text: item?.status === "ACTIVE"
          ? "Face enrollment is active. You can now scan a live class QR and complete face/liveness verification."
          : "Face enrollment submitted for lecturer approval. Attendance stays blocked until approval; after approval, scan a fresh live QR to check in.",
      });
    } catch (error) {
      const responseStatus = error?.response?.status;
      const message = messageFor(error, "Face enrollment failed.");
      if (responseStatus === 409) {
        await refreshStatus();
        setNotice({ type: "info", text: message + " Your current enrollment state has been refreshed." });
      } else {
        setNotice({ type: "error", text: message });
      }
    } finally {
      setSubmitBusy(false);
    }
  };

  const state = enrollment?.status || "NOT_ENROLLED";
  const isBusy = cameraBusy || submitBusy;

  return (
    <main className="academic-page">
      <WorkspaceHeader />
      <section className="academic-content">
        <div className="academic-heading">
          <div>
            <p className="academic-eyebrow">STUDENT SETUP</p>
            <h1>Face enrollment</h1>
            <p>Submit your face profile once. A lecturer assigned to one of your active classes or an administrator must approve it before attendance matching is enabled.</p>
          </div>
          <span className="academic-role">{user?.name || "Student"}</span>
        </div>

        {notice && <div className={"academic-notice " + notice.type} role={notice.type === "error" ? "alert" : "status"}>{notice.text}</div>}

        <section className="academic-card">
          <div className="academic-card-title">
            <span className="academic-step">01</span>
            <div><h2>Your enrollment status</h2><p>Enrollment and approval are separate from scanning a live attendance QR.</p></div>
            <button type="button" className="academic-button secondary" onClick={() => void refreshStatus()} disabled={statusLoading || isBusy}>{statusLoading ? "Refreshing…" : "Refresh status"}</button>
          </div>
          {statusLoading ? <p className="academic-empty" role="status">Checking your enrollment status…</p> :
            <div className={"academic-notice " + (state === "ACTIVE" ? "success" : state === "PENDING_APPROVAL" ? "info" : state === "DELETE_PENDING" ? "error" : "info")} role="status">
              <strong>{({
                NOT_ENROLLED: "Face not enrolled",
                PENDING_APPROVAL: "Waiting for lecturer approval",
                ACTIVE: "Face enrollment approved",
                DELETE_PENDING: "Enrollment deletion is pending",
                REJECTED: "Enrollment rejected",
                REVOKED: "Enrollment revoked",
              })[state] || state}</strong>
              <span>{state === "ACTIVE"
                ? "Your approved face profile is ready. Attendance still requires a live QR, liveness challenge and face match."
                : state === "PENDING_APPROVAL"
                  ? "Your submission is waiting for review. Do not resubmit; you will need approval before attendance can be marked."
                  : state === "DELETE_PENDING"
                    ? "Provider deletion is not confirmed yet. New submissions are blocked until cleanup completes."
                    : state === "REJECTED"
                      ? "Your last request was rejected and the provider deletion is confirmed. You may submit a new enrollment."
                      : state === "REVOKED"
                        ? "The previous profile was revoked. You may submit a new enrollment."
                        : "Use the front camera below to submit your one-time enrollment. A valid attendance QR is not required for this step."}</span>
            </div>}

          {state !== "ACTIVE" && state !== "PENDING_APPROVAL" && state !== "DELETE_PENDING" && (
            <div className="student-setup-item student-enrollment-camera">
              <div className="student-setup-copy"><strong>Live front-camera capture</strong><span>Keep the camera image clear and do not upload an unrelated photo. Only submit a real enrollment image for your own account.</span></div>
              {stream && <video ref={videoRef} className="active-liveness-video" autoPlay playsInline muted aria-label="Live front-camera preview for face enrollment" />}
              {!stream ? <button type="button" className="academic-button" onClick={() => void startCamera()} disabled={isBusy}>{cameraBusy ? "Opening camera…" : "Open front camera"}</button> : <div className="active-liveness-actions">
                <button type="button" className="academic-button" onClick={() => void submitEnrollment()} disabled={!cameraReady || isBusy}>{submitBusy ? "Submitting…" : "Capture and submit enrollment"}</button>
                <button type="button" className="academic-button secondary" onClick={stopCamera} disabled={isBusy}>Stop camera</button>
              </div>}
              {stream && !cameraReady && <p className="academic-empty" role="status">Waiting for camera metadata and preview…</p>}
            </div>
          )}

          <div className="active-liveness-actions"><Link className="academic-button secondary" to="/student/dashboard">Go to attendance</Link></div>
        </section>
      </section>
    </main>
  );
}
