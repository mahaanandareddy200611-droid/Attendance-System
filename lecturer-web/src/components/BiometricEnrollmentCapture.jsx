import { useEffect, useRef, useState } from "react";

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

async function encodeFaceFrame(video) {
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Could not prepare the camera image.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  for (const quality of [0.82, 0.7, 0.58, 0.46]) {
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error("Could not encode the camera image.")),
        "image/jpeg",
        quality,
      );
    });
    if (blob.size <= 900 * 1024) {
      return new File([blob], "face-enrollment.jpg", { type: "image/jpeg" });
    }
  }

  throw new Error("The captured image is too large. Move into better lighting and try again.");
}

export default function BiometricEnrollmentCapture({
  disabled = false,
  selectedImage,
  onImageSelected,
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!cameraActive || !videoRef.current || !streamRef.current) return;
    videoRef.current.srcObject = streamRef.current;
    videoRef.current.play().catch(() => {
      setError("Camera preview could not start. Check browser camera permission and try again.");
    });
  }, [cameraActive]);

  useEffect(() => () => stopStream(streamRef.current), []);

  const closeCamera = () => {
    stopStream(streamRef.current);
    streamRef.current = null;
    setCameraActive(false);
  };

  const openCamera = async () => {
    setError("");
    if (!window.isSecureContext) {
      setError("Camera access requires the HTTPS website. Open the deployed secure website and try again.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not support camera capture. Choose a JPEG, PNG, or WebP image below instead.");
      return;
    }

    setBusy(true);
    try {
      closeCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      setCameraActive(true);
    } catch (captureError) {
      stopStream(streamRef.current);
      streamRef.current = null;
      setCameraActive(false);
      const reason = captureError?.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access in your browser settings, or upload a face photo instead."
        : captureError?.name === "NotFoundError"
          ? "No camera was found. Upload a face photo instead."
          : captureError?.message || "Could not open the camera. Upload a face photo instead.";
      setError(reason);
    } finally {
      setBusy(false);
    }
  };

  const capture = async () => {
    const video = videoRef.current;
    if (
      !video ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !video.videoWidth ||
      !video.videoHeight
    ) {
      setError("The camera is still starting. Wait until your face appears, then capture.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const image = await encodeFaceFrame(video);
      onImageSelected(image);
      if (fileInputRef.current) fileInputRef.current.value = "";
      closeCamera();
    } catch (captureError) {
      setError(captureError?.message || "Could not capture a usable face image.");
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = (event) => {
    onImageSelected(event.target.files?.[0] || null);
    setError("");
    if (cameraActive) closeCamera();
  };

  return (
    <div className="biometric-enrollment-capture">
      <div className="biometric-enrollment-actions">
        {!cameraActive ? (
          <button
            className="academic-button secondary"
            type="button"
            onClick={openCamera}
            disabled={disabled || busy}
          >
            {busy ? "Opening camera…" : "Use camera"}
          </button>
        ) : (
          <>
            <button
              className="academic-button"
              type="button"
              onClick={capture}
              disabled={disabled || busy}
            >
              {busy ? "Capturing…" : "Capture face photo"}
            </button>
            <button
              className="academic-button secondary"
              type="button"
              onClick={closeCamera}
              disabled={busy}
            >
              Cancel camera
            </button>
          </>
        )}
      </div>

      {cameraActive && (
        <div className="biometric-enrollment-camera">
          <video
            ref={videoRef}
            className="biometric-enrollment-video"
            autoPlay
            playsInline
            muted
            aria-label="Live camera preview for face enrollment"
          />
          <p className="academic-footnote">
            Face the camera directly, use even lighting, and remove anything obscuring your face.
          </p>
        </div>
      )}

      <label className="academic-field biometric-enrollment-file" htmlFor="enrollment-image">
        <span>Or choose a face photo</span>
        <input
          ref={fileInputRef}
          id="enrollment-image"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="user"
          onChange={chooseFile}
          disabled={disabled || busy}
        />
      </label>

      {selectedImage && (
        <p className="academic-notice success" role="status">
          {selectedImage.name || "Face photo"} selected ({Math.max(1, Math.round(selectedImage.size / 1024))} KB). Select Save face enrollment to submit it.
        </p>
      )}
      {error && <p className="academic-notice error" role="alert">{error}</p>}
    </div>
  );
}
