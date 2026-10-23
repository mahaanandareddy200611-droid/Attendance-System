import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import WorkspaceHeader from "../components/WorkspaceHeader";
import { useAuth } from "../auth/useAuth";
import { getApiErrorMessage } from "../api/errors";
import { enrollBiometric, getMyBiometricEnrollment } from "../services/biometric.service";
import "../Styles/Academic.css";

function messageFor(error, fallback) {
  return getApiErrorMessage(error, fallback);
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
  const params = new URLSearchParams(window.location.search);
  const requiredEnrollment = params.get("required") === "1";
  const consentFromSignup = params.get("consent") === "face-attendance-v1";
  const [consentGiven, setConsentGiven] = useState(consentFromSignup);
  const consentAccepted = consentFromSignup || consentGiven;

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const autoCameraStartedRef = useRef(false);
  const autoCaptureStartedRef = useRef(false);

  const [stream, setStream] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [enrollment, setEnrollment] = useState(null);
  const [notice, setNotice] = useState(null);
  const [autoCaptureCountdown, setAutoCaptureCountdown] = useState(null);

  const state = enrollment?.status || "NOT_ENROLLED";
  const isBusy = cameraBusy || submitBusy;
  const requiresCapture = !["ACTIVE", "PENDING_APPROVAL", "DELETE_PENDING"].includes(state);

  const stopCamera = useCallback(() => {
    const currentStream = streamRef.current;
    streamRef.current = null;
    setStream(null);
    setCameraReady(false);
    setAutoCaptureCountdown(null);
    stopStream(currentStream);
  }, []);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const response = await getMyBiometricEnrollment();
      setEnrollment(response?.data?.data || null);
      return response?.data?.data || null;
    } catch (error) {
      setNotice({ type: "error", text: messageFor(error, "Could not refresh your face-enrollment status.") });
      throw error;
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const submitEnrollment = useCallback(async () => {
    const video = videoRef.current;
    if (!consentAccepted) {
      setNotice({ type: "error", text: "Review and accept the face-enrollment notice before capture." });
      return;
    }
    if (!video || !cameraReady || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
      setNotice({ type: "error", text: "Wait until the live front-camera preview is ready, then retry automatic capture." });
      return;
    }
    if (["PENDING_APPROVAL", "ACTIVE", "DELETE_PENDING"].includes(enrollment?.status)) {
      setNotice({ type: "info", text: "An enrollment is already pending, active, or being deleted. Refresh the status instead of submitting another image." });
      return;
    }

    setSubmitBusy(true);
    setNotice({ type: "info", text: "Sending your consented enrollment frame to the biometric provider for profile creation…" });
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
      if (!blob || blob.size > 900 * 1024) {
        throw new Error("Could not compress this image below 900 KB. Improve lighting and retry.");
      }

      const response = await enrollBiometric(new File([blob], "student-face-enrollment.jpg", { type: "image/jpeg" }));
      const item = response?.data?.data || { status: "PENDING_APPROVAL", enrolledAt: new Date().toISOString() };
      setEnrollment(item);
      stopCamera();
      setNotice({
        type: "success",
        text: item.status === "ACTIVE"
          ? "Face enrollment is active. You can now scan a live class QR and complete the visible face/liveness check."
          : "Face enrollment submitted for lecturer approval. Attendance stays blocked until approval; after approval, scan a fresh live QR to check in.",
      });
    } catch (error) {
      const message = messageFor(error, "Face enrollment failed.");
      if (error?.response?.status === 409) {
        try {
          const current = await refreshStatus();
          const status = current?.status;
          if (["ACTIVE", "PENDING_APPROVAL", "DELETE_PENDING"].includes(status)) {
            setNotice({
              type: status === "DELETE_PENDING" ? "error" : "info",
              text: status === "ACTIVE"
                ? "Your face enrollment is already active."
                : status === "PENDING_APPROVAL"
                  ? "Your enrollment is already waiting for lecturer approval. Do not submit another image."
                  : "Provider deletion is pending. New enrollment remains blocked until deletion is confirmed.",
            });
            if (status !== "NOT_ENROLLED") stopCamera();
          } else {
            setNotice({ type: "error", text: message });
            autoCaptureStartedRef.current = true;
          }
        } catch {
          setNotice({ type: "error", text: message });
          autoCaptureStartedRef.current = true;
        }
      } else {
        setNotice({ type: "error", text: message });
        autoCaptureStartedRef.current = true;
      }
    } finally {
      setSubmitBusy(false);
    }
  }, [consentAccepted, cameraReady, enrollment?.status, refreshStatus, stopCamera]);

  const startCamera = useCallback(async () => {
    if (cameraBusy || submitBusy) return;
    if (!consentAccepted) {
      setNotice({ type: "error", text: "Review and accept the face-enrollment notice before enabling the camera." });
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNotice({ type: "error", text: "Face enrollment needs HTTPS (or localhost) and browser camera support." });
      return;
    }

    setNotice(null);
    setCameraBusy(true);
    autoCaptureStartedRef.current = false;
    stopCamera();
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = nextStream;
      setCameraReady(false);
      setStream(nextStream);
      setNotice({ type: "info", text: "Camera is active. Your preview stays visible; automatic capture begins after the preview is ready." });
    } catch (error) {
      setNotice({ type: "error", text: cameraErrorMessage(error) });
    } finally {
      setCameraBusy(false);
    }
  }, [cameraBusy, submitBusy, consentAccepted, stopCamera]);

  useEffect(() => {
    let active = true;
    getMyBiometricEnrollment()
      .then((response) => {
        if (active) setEnrollment(response?.data?.data || null);
      })
      .catch((error) => {
        if (active) setNotice({ type: "error", text: messageFor(error, "Could not read your face-enrollment status.") });
      })
      .finally(() => {
        if (active) setStatusLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => () => {
    stopStream(streamRef.current);
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!stream || !videoRef.current) return undefined;
    const video = videoRef.current;
    let active = true;
    const markReady = () => {
      if (active) setCameraReady(video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0);
    };
    video.srcObject = stream;
    video.addEventListener("loadedmetadata", markReady);
    video.addEventListener("canplay", markReady);
    video.play().then(markReady).catch(() => {
      setNotice({ type: "error", text: "Camera preview playback was blocked. Allow playback and retry." });
    });
    markReady();
    return () => {
      active = false;
      video.removeEventListener("loadedmetadata", markReady);
      video.removeEventListener("canplay", markReady);
      video.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    if (
      !requiredEnrollment ||
      !consentFromSignup ||
      statusLoading ||
      cameraBusy ||
      submitBusy ||
      !requiresCapture ||
      autoCameraStartedRef.current
    ) return;
    autoCameraStartedRef.current = true;
    void startCamera();
  }, [requiredEnrollment, consentFromSignup, statusLoading, cameraBusy, submitBusy, requiresCapture, startCamera]);

  useEffect(() => {
    if (
      !stream ||
      !cameraReady ||
      !consentAccepted ||
      statusLoading ||
      !requiresCapture ||
      submitBusy ||
      autoCaptureStartedRef.current
    ) return undefined;

    autoCaptureStartedRef.current = true;
    setAutoCaptureCountdown(4);
    const interval = window.setInterval(() => {
      setAutoCaptureCountdown((remaining) => Number.isFinite(remaining) && remaining > 1 ? remaining - 1 : 0);
    }, 1000);
    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
      setAutoCaptureCountdown(null);
      void submitEnrollment();
    }, 4100);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [stream, cameraReady, consentAccepted, statusLoading, requiresCapture, submitBusy, submitEnrollment]);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  return (
    <main className="academic-page">
      <WorkspaceHeader />
      <section className="academic-content">
        <div className="academic-heading">
          <div>
            <p className="academic-eyebrow">STUDENT SETUP</p>
            <h1>Face enrollment</h1>
            <p>Register your face once for attendance matching. Your camera stays visibly active while the app captures and verifies a live image.</p>
          </div>
          <span className="academic-role">{user?.name || "Student"}</span>
        </div>

        {notice && !stream && <div className={"academic-notice academic-toast " + notice.type} role={notice.type === "error" ? "alert" : "status"} aria-live={notice.type === "error" ? "assertive" : "polite"}>{notice.text}</div>}

        <section className="academic-card">
          <div className="academic-card-title">
            <span className="academic-step">01</span>
            <div>
              <h2>Your enrollment status</h2>
              <p>Enrollment and lecturer approval are separate from scanning a live attendance QR.</p>
            </div>
            <button type="button" className="academic-button secondary" onClick={() => void refreshStatus().catch(() => {})} disabled={statusLoading || isBusy}>
              {statusLoading ? "Refreshing…" : "Refresh status"}
            </button>
          </div>

          {statusLoading ? <p className="academic-empty" role="status">Checking your enrollment status…</p> : (
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
                ? "Your approved profile is ready. Attendance still requires a live QR and a visible face/liveness check."
                : state === "PENDING_APPROVAL"
                  ? "Your submission is waiting for review. Do not resubmit; attendance stays disabled until approval."
                  : state === "DELETE_PENDING"
                    ? "Provider deletion is not confirmed yet. New submissions are blocked until cleanup completes."
                    : state === "REJECTED"
                      ? "Your last request was rejected and provider deletion was confirmed. You may submit a new enrollment."
                      : state === "REVOKED"
                        ? "The previous profile was revoked. You may submit a new enrollment."
                        : "Enrollment is required before attendance check-in can be completed."}</span>
            </div>
          )}

          {requiresCapture && !statusLoading && (
            <div className="student-setup-item student-enrollment-camera">
              <div className="student-setup-copy">
                <strong>Live front-camera enrollment</strong>
                <span>Center your face in steady lighting. After consent and camera permission, one live frame is captured automatically when the preview is ready.</span>
              </div>

              {!consentFromSignup && (
                <label className="academic-consent">
                  <input type="checkbox" checked={consentGiven} onChange={(event) => setConsentGiven(event.target.checked)} />
                  <span><strong>Consent to face processing.</strong> Your live camera image is sent to the configured biometric provider to create a face profile for attendance matching. The app database stores an opaque provider profile reference and consent metadata, not the raw image or face vector. Your camera stays visibly active while capture is running.</span>
                </label>
              )}

              {!stream ? (
                <button type="button" className="academic-button" onClick={() => void startCamera()} disabled={!consentAccepted || isBusy}>
                  {cameraBusy ? "Opening camera…" : "Start camera and enroll automatically"}
                </button>
              ) : (
                <div className="active-liveness-actions">
                  {cameraReady && <span className="camera-live-indicator">Camera active · automatic capture enabled</span>}
                  {autoCaptureCountdown !== null && <p className="academic-footnote" role="status">Preparing your enrollment frame in {autoCaptureCountdown}… Keep your face visible.</p>}
                  {notice?.type === "error" && <button type="button" className="academic-button" onClick={() => { autoCaptureStartedRef.current = false; void submitEnrollment(); }} disabled={isBusy}>Retry automatic capture</button>}
                  <button type="button" className="academic-button secondary" onClick={stopCamera} disabled={isBusy}>Stop camera</button>
                </div>
              )}

              {stream && !cameraReady && <p className="academic-empty" role="status">Waiting for the camera preview… The camera window will appear as soon as permission is granted.</p>}
              {requiredEnrollment && <p className="academic-footnote">Enrollment is required to check in. If your request needs approval, you can return to this page to see its status.</p>}
            </div>
          )}

          <div className="active-liveness-actions"><Link className="academic-button secondary" to="/student/dashboard">Go to attendance</Link></div>
        </section>
      </section>

      {stream && (
        <div className="camera-modal-backdrop">
          <section
            className="camera-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="camera-modal-title"
            aria-describedby="camera-modal-description"
          >
            <div className="camera-modal-header">
              <span className="camera-modal-eyebrow">LIVE CAMERA · FACE ENROLLMENT</span>
              <h2 id="camera-modal-title">Position your face in the camera</h2>
              <p id="camera-modal-description">
                Look straight at the front camera. Keep your whole face inside the frame, use steady lighting, and make sure nobody else is visible.
                The camera stays visibly active and will capture automatically after the countdown.
              </p>
            </div>

            <div className="camera-modal-preview">
              <video
                ref={videoRef}
                className="camera-modal-video active-liveness-video"
                autoPlay
                playsInline
                muted
                aria-label="Live front-camera preview for face enrollment"
              />
              {!cameraReady && (
                <div className="camera-preview-overlay" role="status">
                  <span className="camera-preview-spinner" />
                  Connecting to your camera…
                </div>
              )}
            </div>

            <div className="camera-modal-status">
              {cameraReady
                ? <span className="camera-live-indicator">Camera active · preview visible</span>
                : <span className="camera-modal-pending">Waiting for camera preview…</span>}
              {autoCaptureCountdown !== null && !submitBusy && (
                <p className="camera-modal-countdown" role="status">
                  Capturing automatically in {autoCaptureCountdown} second{autoCaptureCountdown === 1 ? "" : "s"}.
                  Keep looking at the camera.
                </p>
              )}
              {submitBusy && (
                <p className="camera-modal-countdown" role="status">
                  Sending the captured face securely for enrollment…
                </p>
              )}
              {notice && (
                <p className={"camera-modal-message " + notice.type} role={notice.type === "error" ? "alert" : "status"}>
                  {notice.text}
                </p>
              )}
            </div>

            <div className="camera-modal-actions">
              {notice?.type === "error" && (
                <button
                  type="button"
                  className="academic-button"
                  onClick={() => {
                    autoCaptureStartedRef.current = true;
                    void submitEnrollment();
                  }}
                  disabled={isBusy || !cameraReady}
                >
                  Retry with a fresh capture
                </button>
              )}
              <button type="button" className="academic-button secondary" onClick={stopCamera} disabled={isBusy}>
                {submitBusy ? "Please wait…" : "Close camera"}
              </button>
            </div>
            <p className="camera-modal-privacy">
              Privacy: this is a visible live preview, not a background recording. The enrollment image is sent to the configured biometric provider for matching.
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
