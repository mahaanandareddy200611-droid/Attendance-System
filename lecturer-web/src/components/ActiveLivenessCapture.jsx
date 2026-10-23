import { useEffect, useRef, useState } from "react";
import {
  createActiveBiometricChallenge,
  verifyActiveBiometricSequence,
} from "../services/biometric.service";

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function explainCameraError(error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") return "Camera permission was denied. Allow camera access for this HTTPS site and retry.";
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") return "No front camera was found. Connect or enable a camera and retry.";
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") return "The camera is busy or unavailable. Close other camera apps/tabs and retry.";
  return error?.response?.data?.error?.message || error?.message || "Could not start the camera-based liveness check.";
}

export default function ActiveLivenessCapture({
  sessionId,
  onVerified,
  disabled = false,
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const autoStartedRef = useRef(false);
  const captureInProgressRef = useRef(false);
  const [challenge, setChallenge] = useState(null);
  const [frames, setFrames] = useState([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [captureCountdown, setCaptureCountdown] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!cameraActive || !video || !stream) return undefined;

    const markReady = () => {
      setCameraReady(video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0);
    };
    video.srcObject = stream;
    video.addEventListener("loadedmetadata", markReady);
    video.addEventListener("canplay", markReady);
    video.play().then(markReady).catch(() => {
      setMessage("Camera preview could not start. Check the browser camera permission and retry.");
    });
    markReady();
    return () => {
      video.removeEventListener("loadedmetadata", markReady);
      video.removeEventListener("canplay", markReady);
      video.srcObject = null;
    };
  }, [cameraActive]);

  useEffect(() => () => stopStream(streamRef.current), []);

  const reset = () => {
    stopStream(streamRef.current);
    streamRef.current = null;
    setCameraActive(false);
    setCameraReady(false);
    setCaptureCountdown(null);
    captureInProgressRef.current = false;
    setChallenge(null);
    setFrames([]);
    setCurrentStep(0);
  };

  const start = async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setMessage("Camera liveness requires HTTPS (or localhost) and browser camera support.");
      return;
    }
    if (disabled || busy) return;
    setBusy(true);
    setMessage("");
    reset();
    try {
      // Ask for camera access before creating the short-lived challenge. A
      // permission prompt can take time and should not consume challenge TTL.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      const issued = await createActiveBiometricChallenge(sessionId);
      if (!Array.isArray(issued.steps) || issued.steps.length !== 3) {
        throw new Error("The server returned an invalid liveness sequence.");
      }
      setChallenge(issued);
      setFrames([]);
      setCurrentStep(0);
      setCameraActive(true);
      setMessage("Face verification is running. Follow the visible prompt; frames are captured automatically while the camera indicator is on.");
    } catch (error) {
      stopStream(streamRef.current);
      streamRef.current = null;
      setCameraActive(false);
      setMessage(explainCameraError(error));
    } finally {
      setBusy(false);
    }
  };

  const captureFrame = async () => {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        !video.videoWidth || !video.videoHeight) {
      setMessage("Camera is still starting. Wait a moment and try again.");
      captureInProgressRef.current = false;
      setCaptureCountdown(null);
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Could not prepare the camera frame.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (value) => value ? resolve(value) : reject(new Error("Could not encode the camera frame.")),
          "image/jpeg",
          0.82,
        );
      });
      if (blob.size > 900 * 1024) {
        throw new Error("Camera frame is too large. Move to better lighting and retry.");
      }

      const nextFrames = [
        ...frames,
        new File([blob], `liveness-frame-${currentStep + 1}.jpg`, { type: "image/jpeg" }),
      ];

      if (currentStep < 2) {
        setFrames(nextFrames);
        setCurrentStep(currentStep + 1);
        setMessage("Frame captured. Follow the next on-screen instruction; the next frame will be captured automatically.");
        return;
      }

      setMessage("Checking face match and liveness…");
      const assertionId = await verifyActiveBiometricSequence({
        sessionId,
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        frames: nextFrames,
      });
      stopStream(streamRef.current);
      streamRef.current = null;
      setCameraActive(false);
      setChallenge(null);
      setFrames([]);
      setCurrentStep(0);
      onVerified(assertionId);
      setMessage("Face match and active liveness checks passed for this attempt.");
    } catch (error) {
      setMessage(
        error?.response?.data?.error?.message ||
          error.message ||
          "Liveness verification failed. Start a new check and try again.",
      );
      // Challenges are single-use; a failed attempt must obtain a new challenge.
      reset();
    } finally {
      captureInProgressRef.current = false;
      setCaptureCountdown(null);
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!sessionId || disabled || busy || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void start();
    // start() is intentionally started once when a valid QR reveals this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, disabled]);

  useEffect(() => {
    if (!cameraActive || !cameraReady || !challenge || disabled || busy || captureInProgressRef.current) return undefined;

    captureInProgressRef.current = true;
    setCaptureCountdown(2);
    const interval = window.setInterval(() => {
      setCaptureCountdown((remaining) => Number.isFinite(remaining) && remaining > 1 ? remaining - 1 : 0);
    }, 1000);
    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
      setCaptureCountdown(null);
      void captureFrame();
    }, 2100);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
    // captureFrame is refreshed with the latest step/frame state; this effect is
    // keyed to the step and starts exactly one timer for each visible prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive, cameraReady, challenge?.challengeId, currentStep, disabled, busy]);

  const step = challenge?.steps?.[currentStep];

  return (
    <section className="student-setup-item active-liveness-capture">
      <div className="student-setup-copy">
        <strong>Active face and liveness check</strong>
        <span>After a valid QR, the camera check starts automatically. You will see each prompt and a live-camera indicator; no shutter button is needed.</span>
      </div>
      {cameraActive && (
        <>
          <video
            ref={videoRef}
            className="active-liveness-video"
            autoPlay
            playsInline
            muted
            aria-label="Live camera preview for face verification"
          />
          {step && (
            <div className="academic-notice" role="status">
              Step {currentStep + 1} of 3: {step.instruction}
            </div>
          )}
          <p className="camera-live-indicator">Camera active · frame capture and face/liveness matching are in progress</p>
          {captureCountdown !== null && <p className="academic-footnote" role="status">Next frame in {captureCountdown}… Follow the prompt and keep your face visible.</p>}
          <p className="academic-footnote">Three brief live frames are sent to the configured biometric provider for matching and active-liveness checks. The camera stops when the check finishes or you stop it.</p>
        </>
      )}
      {message && <p className="academic-footnote" role="status">{message}</p>}
      {!cameraActive ? (
        <div className="active-liveness-actions">
          <p className="academic-footnote" role="status">{busy ? "Starting the camera and preparing the secure check…" : message || "The check will start automatically after QR validation."}</p>
          {!busy && <button type="button" className="academic-button" onClick={() => { autoStartedRef.current = false; void start(); }} disabled={disabled || !sessionId}>Retry face verification</button>}
        </div>
      ) : (
        <div className="active-liveness-actions">
          <span className="academic-footnote" role="status">{busy ? "Checking the current frame…" : "Capturing automatically after each prompt."}</span>
          <button type="button" className="academic-button secondary" onClick={reset} disabled={busy || disabled}>
            Stop verification
          </button>
        </div>
      )}
    </section>
  );
}
