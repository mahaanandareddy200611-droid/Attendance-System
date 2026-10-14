import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { Link } from "react-router-dom";
import { enrollBiometric } from "../services/biometric.service";
import { markAttendance } from "../services/attendance.service";
import {
  hasRegisteredDeviceKey,
  registerThisBrowser,
} from "../services/device.service";
import "../Styles/Academic.css";

function decodeSessionId(token) {
  try {
    const payload = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(
      atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")),
    );
    return parsed.sid;
  } catch {
    throw new Error(
      "That QR code does not contain a valid attendance token. Scan the active QR from your lecturer.",
    );
  }
}

function getQrToken(decodedText) {
  try {
    const parsed = JSON.parse(decodedText);
    return parsed.token || parsed.attendanceToken || decodedText;
  } catch {
    return decodedText.trim();
  }
}

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem("user") || "{}");
  } catch {
    return {};
  }
}

function StudentAcademic() {
  const [user] = useState(readStoredUser);
  const [deviceReady, setDeviceReady] = useState(false);
  const [biometricReady, setBiometricReady] = useState(
    localStorage.getItem("attendanceBiometricReady") === "true",
  );
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [attendanceBusy, setAttendanceBusy] = useState(false);
  const [enrollmentImage, setEnrollmentImage] = useState(null);
  const [verificationImage, setVerificationImage] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [attendanceToken, setAttendanceToken] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [notice, setNotice] = useState(null);
  const scannerRef = useRef(null);

  useEffect(() => {
    hasRegisteredDeviceKey()
      .then(setDeviceReady)
      .catch(() => setDeviceReady(false));
  }, []);

  useEffect(
    () => () => {
      const scanner = scannerRef.current;
      if (scanner?.isScanning) scanner.stop().catch(() => {});
    },
    [],
  );

  const startScan = async () => {
    setNotice(null);
    setAttendanceToken("");
    setSessionId("");
    try {
      const scanner = new Html5Qrcode("student-qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        async (text) => {
          try {
            const token = getQrToken(text);
            const sid = decodeSessionId(token);
            setAttendanceToken(token);
            setSessionId(sid);
            setNotice({
              type: "success",
              text: "Active attendance QR scanned. Complete the check-in steps below.",
            });
            if (scanner.isScanning) await scanner.stop().catch(() => {});
            setScanning(false);
          } catch (error) {
            setNotice({ type: "error", text: error.message });
          }
        },
        () => {},
      );
      setScanning(true);
    } catch (error) {
      setNotice({
        type: "error",
        text:
          error?.message ||
          "Could not access the camera. Allow camera permission and try again.",
      });
    }
  };

  const stopScan = async () => {
    if (scannerRef.current?.isScanning)
      await scannerRef.current.stop().catch(() => {});
    setScanning(false);
  };

  const setupDevice = async () => {
    setDeviceBusy(true);
    setNotice(null);
    try {
      await registerThisBrowser();
      setDeviceReady(true);
      setNotice({
        type: "success",
        text: "This browser is registered as your attendance device.",
      });
    } catch (error) {
      setNotice({
        type: "error",
        text:
          error.response?.data?.error?.message ||
          error.message ||
          "Device registration failed.",
      });
    } finally {
      setDeviceBusy(false);
    }
  };

  const setupBiometric = async (event) => {
    event.preventDefault();
    if (!enrollmentImage) return;
    setBiometricBusy(true);
    setNotice(null);
    try {
      await enrollBiometric(enrollmentImage);
      localStorage.setItem("attendanceBiometricReady", "true");
      setBiometricReady(true);
      setNotice({ type: "success", text: "Face enrollment completed." });
    } catch (error) {
      const message =
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        "Face enrollment failed.";
      if (error.response?.status === 409 && /already exists/i.test(message)) {
        localStorage.setItem("attendanceBiometricReady", "true");
        setBiometricReady(true);
        setNotice({
          type: "success",
          text: "A face enrollment already exists for this account.",
        });
      } else setNotice({ type: "error", text: message });
    } finally {
      setBiometricBusy(false);
    }
  };

  const submitAttendance = async () => {
    setAttendanceBusy(true);
    setNotice(null);
    try {
      const response = await markAttendance({
        sessionId,
        token: attendanceToken,
        verificationImage,
      });
      setNotice({
        type: "success",
        text: response.data?.message || "Attendance marked successfully.",
      });
      setAttendanceToken("");
      setSessionId("");
    } catch (error) {
      setNotice({
        type: "error",
        text:
          error.response?.data?.error?.message ||
          error.response?.data?.message ||
          error.message ||
          "Attendance check-in failed.",
      });
    } finally {
      setAttendanceBusy(false);
    }
  };

  return (
    <main className="academic-page">
      <header className="academic-topbar">
        <span className="academic-brand">Attendance System</span>
        <span>Student workspace</span>
      </header>
      <section className="academic-content">
        <div className="academic-heading">
          <div>
            <p className="academic-eyebrow">STUDENT ATTENDANCE</p>
            <h1>Scan QR to check in</h1>
            <p>
              Register this browser, enroll your face, then scan the active QR
              shown by your lecturer.
            </p>
          </div>
          <span className="academic-role">{user.name || "Student"}</span>
        </div>

        {notice && (
          <div
            className={`academic-notice ${notice.type}`}
            role={notice.type === "error" ? "alert" : "status"}
          >
            {notice.text}
          </div>
        )}

        <section className="academic-card student-setup-card">
          <div className="academic-card-title">
            <span className="academic-step">01</span>
            <div>
              <h2>Secure check-in setup</h2>
              <p>Complete these once on this browser.</p>
            </div>
          </div>
          <div className="student-setup-grid">
            <div className="student-setup-item">
              <div className="student-setup-copy">
                <strong>Device registration</strong>
                <span>
                  {deviceReady
                    ? "This browser is registered"
                    : "Create a secure device key"}
                </span>
              </div>
              <button
                className="academic-button"
                onClick={setupDevice}
                disabled={deviceReady || deviceBusy}
              >
                {deviceBusy
                  ? "Registering…"
                  : deviceReady
                    ? "Ready"
                    : "Register browser"}
              </button>
            </div>
            <form className="student-setup-item" onSubmit={setupBiometric}>
              <label className="student-setup-copy" htmlFor="enrollment-image">
                <strong>Face enrollment</strong>
                <span>
                  {biometricReady
                    ? "Face enrollment is ready"
                    : "Choose a clear face photo for enrollment"}
                </span>
              </label>
              <input
                id="enrollment-image"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="user"
                onChange={(event) =>
                  setEnrollmentImage(event.target.files?.[0] || null)
                }
                disabled={biometricReady}
              />
              {!biometricReady && (
                <button
                  className="academic-button"
                  type="submit"
                  disabled={!enrollmentImage || biometricBusy}
                >
                  {biometricBusy ? "Enrolling…" : "Enroll face"}
                </button>
              )}
            </form>
          </div>
        </section>

        <section className="academic-card student-scan-card">
          <div className="academic-card-title">
            <span className="academic-step">02</span>
            <div>
              <h2>Scan the lecturer’s QR</h2>
              <p>
                Allow camera access and hold the active code inside the frame.
              </p>
            </div>
          </div>
          <div id="student-qr-reader" className="student-qr-reader" />
          {!scanning ? (
            <button className="academic-button" onClick={startScan}>
              {attendanceToken ? "Scan a different QR" : "Open camera and scan"}
            </button>
          ) : (
            <button
              className="academic-button student-stop-button"
              onClick={stopScan}
            >
              Stop camera
            </button>
          )}

          {attendanceToken && (
            <div className="student-checkin-form">
              <p className="academic-eyebrow">
                QR SCANNED · SESSION {sessionId.slice(0, 8)}
              </p>
              <label className="academic-field">
                <span>Take a fresh face photo for verification</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="user"
                  onChange={(event) =>
                    setVerificationImage(event.target.files?.[0] || null)
                  }
                />
                <small>
                  The backend checks face match and liveness during attendance
                  verification.
                </small>
              </label>
              <button
                className="academic-button"
                onClick={submitAttendance}
                disabled={
                  attendanceBusy ||
                  !deviceReady ||
                  !biometricReady ||
                  !verificationImage
                }
              >
                {attendanceBusy
                  ? "Verifying check-in…"
                  : "Verify and mark attendance"}
              </button>
              {(!deviceReady || !biometricReady || !verificationImage) && (
                <p className="academic-footnote">
                  Finish device registration, face enrollment, and the fresh
                  verification photo to enable check-in.
                </p>
              )}
            </div>
          )}
        </section>
        <p className="academic-footnote">
          Location permission is requested when you submit check-in. Keep this
          page open and use the same browser that you registered as your device.
        </p>
        <Link
          className="student-signout-link"
          to="/login"
          onClick={() => {
            localStorage.removeItem("token");
            localStorage.removeItem("user");
          }}
        >
          Sign out
        </Link>
      </section>
    </main>
  );
}

export default StudentAcademic;
