import { useEffect, useRef, useState } from "react";
import {
  createActiveBiometricChallenge,
  verifyActiveBiometricSequence,
} from "../services/biometric.service";

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

export default function ActiveLivenessCapture({
  sessionId,
  onVerified,
  disabled = false,
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [challenge, setChallenge] = useState(null);
  const [frames, setFrames] = useState([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [cameraActive, setCameraActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (cameraActive && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {
        setMessage("Camera playback was blocked. Allow camera permission and try again.");
      });
    }
  }, [cameraActive]);

  useEffect(() => () => stopStream(streamRef.current), []);

  const reset = () => {
    stopStream(streamRef.current);
    streamRef.current = null;
    setCameraActive(false);
    setChallenge(null);
    setFrames([]);
    setCurrentStep(0);
  };

  const start = async () => {
    setBusy(true);
    setMessage("");
    reset();
    try {
      const issued = await createActiveBiometricChallenge(sessionId);
      if (!Array.isArray(issued.steps) || issued.steps.length !== 3) {
        throw new Error("The server returned an invalid liveness sequence.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      setChallenge(issued);
      setFrames([]);
      setCurrentStep(0);
      setCameraActive(true);
      setMessage("Follow each instruction and capture one clear frame per step.");
    } catch (error) {
      stopStream(streamRef.current);
      streamRef.current = null;
      setCameraActive(false);
      setMessage(
        error?.response?.data?.error?.message ||
          error.message ||
          "Could not start the camera-based liveness check.",
      );
    } finally {
      setBusy(false);
    }
  };

  const captureFrame = async () => {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        !video.videoWidth || !video.videoHeight) {
      setMessage("Camera is still starting. Wait a moment and try again.");
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
        setMessage("Frame captured. Follow the next instruction.");
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
      setBusy(false);
    }
  };

  const step = challenge?.steps?.[currentStep];

  return (
    <section className="student-setup-item active-liveness-capture">
      <div className="student-setup-copy">
        <strong>Active face and liveness check</strong>
        <span>Capture a center frame and follow the server's randomized left/right turn instructions.</span>
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
          <p className="academic-footnote">
            Captured frames are sent for verification and are not retained by this component.
          </p>
        </>
      )}
      {message && <p className="academic-footnote" role="status">{message}</p>}
      {!cameraActive ? (
        <button type="button" className="academic-button" onClick={start} disabled={disabled || busy || !sessionId}>
          {busy ? "Starting…" : "Start face/liveness check"}
        </button>
      ) : (
        <div className="active-liveness-actions">
          <button type="button" className="academic-button" onClick={captureFrame} disabled={disabled || busy}>
            {busy ? "Processing…" : `Capture frame ${currentStep + 1} of 3`}
          </button>
          <button type="button" className="academic-button secondary" onClick={reset} disabled={busy}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
