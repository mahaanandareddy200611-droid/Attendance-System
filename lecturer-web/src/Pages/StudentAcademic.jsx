import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import {
  enrollBiometric,
  getMyBiometricEnrollment,
} from "../services/biometric.service";
import ActiveLivenessCapture from "../components/ActiveLivenessCapture";
import {
  getAvailableAttendanceSessions,
  getMyAttendanceRecords,
  markAttendance,
} from "../services/attendance.service";
import {
  hasRegisteredDeviceKey,
  getMyDevice,
  revokeMyDevice,
  removeRegisteredBrowserKey,
  registerThisBrowser,
} from "../services/device.service";
import { getSections } from "../services/academic.service";
import { useAuth } from "../auth/useAuth";
import "../Styles/Academic.css";
import WorkspaceHeader from "../components/WorkspaceHeader";

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

function StudentAcademic() {
  const { user } = useAuth();
  const [deviceReady, setDeviceReady] = useState(false);
  const [biometricReady, setBiometricReady] = useState(false);
  const [biometricAssertionId, setBiometricAssertionId] = useState("");
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [attendanceBusy, setAttendanceBusy] = useState(false);
  const [enrollmentImage, setEnrollmentImage] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [attendanceToken, setAttendanceToken] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [notice, setNotice] = useState(null);
  const [sections, setSections] = useState([]);
  const [records, setRecords] = useState([]);
  const [availableSessions, setAvailableSessions] = useState([]);
  const scannerRef = useRef(null);
  const idempotencyKeyRef = useRef(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      getMyDevice(),
      hasRegisteredDeviceKey(user?.id),
      getMyBiometricEnrollment(),
      getSections({ limit: 100 }),
      getMyAttendanceRecords({ limit: 10 }),
      getAvailableAttendanceSessions(),
    ])
      .then(
        ([
          deviceResponse,
          hasLocalKey,
          biometricResponse,
          sectionResponse,
          recordResponse,
          sessionResponse,
        ]) => {
          if (!active) return;
          const device = deviceResponse.data.data;
          setDeviceReady(
            Boolean(
              device &&
                hasLocalKey &&
                localStorage.getItem(`attendanceDeviceId:${user?.id}`) ===
                  device.deviceId,
            ),
          );
          setBiometricReady(Boolean(biometricResponse.data.data));
          setSections(sectionResponse.data.data || []);
          setRecords(recordResponse.data.data || []);
          setAvailableSessions(sessionResponse.data.data || []);
        },
      )
      .catch((error) => {
        if (active)
          setNotice({
            type: "error",
            text:
              error.response?.data?.error?.message ||
              "Could not load your student information.",
          });
      });
    return () => {
      active = false;
    };
  }, [user?.id]);

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
    setBiometricAssertionId("");
    idempotencyKeyRef.current = null;
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
            idempotencyKeyRef.current = crypto.randomUUID();
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
      await registerThisBrowser(user.id);
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

  const revokeDevice = async () => {
    setDeviceBusy(true);
    setNotice(null);
    try {
      await revokeMyDevice();
      await removeRegisteredBrowserKey(user.id);
      setDeviceReady(false);
      setNotice({
        type: "success",
        text: "This browser has been unregistered. Register again if you want to use it for attendance.",
      });
    } catch (error) {
      setNotice({
        type: "error",
        text:
          error.response?.data?.error?.message ||
          "Could not unregister this browser.",
      });
    } finally {
      setDeviceBusy(false);
    }
  };

  const refreshAttendance = async () => {
    setNotice(null);
    try {
      const [sessionsResponse, recordsResponse] = await Promise.all([
        getAvailableAttendanceSessions(),
        getMyAttendanceRecords({ limit: 10 }),
      ]);
      setAvailableSessions(sessionsResponse.data.data || []);
      setRecords(recordsResponse.data.data || []);
      setNotice({
        type: "success",
        text: "Your check-ins and attendance history are up to date.",
      });
    } catch (error) {
      setNotice({
        type: "error",
        text:
          error.response?.data?.error?.message ||
          "Could not refresh attendance.",
      });
    }
  };

  const setupBiometric = async (event) => {
    event.preventDefault();
    if (!enrollmentImage) return;
    setBiometricBusy(true);
    setNotice(null);
    try {
      await enrollBiometric(enrollmentImage);
      setBiometricReady(true);
      setNotice({ type: "success", text: "Face enrollment completed." });
    } catch (error) {
      const message =
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        "Face enrollment failed.";
      if (error.response?.status === 409 && /already exists/i.test(message)) {
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
        userId: user.id,
        sessionId,
        token: attendanceToken,
        biometricAssertionId,
        idempotencyKey: idempotencyKeyRef.current,
      });
      setNotice({
        type: "success",
        text: response.data?.message || "Attendance marked successfully.",
      });
      const recordsResponse = await getMyAttendanceRecords({ limit: 10 });
      setRecords(recordsResponse.data.data || []);
      setAttendanceToken("");
      setSessionId("");
      setBiometricAssertionId("");
      idempotencyKeyRef.current = null;
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
      <WorkspaceHeader />
      <section className="academic-content">
        <div className="academic-heading">
          <div>
            <p className="academic-eyebrow">STUDENT ATTENDANCE</p>
            <h1>Scan QR to check in</h1>
            <p>
              Welcome {user?.name || "student"}. Register this browser, enroll
              your face, then scan the active QR shown by your lecturer.
            </p>
          </div>
          <span className="academic-role">{user?.name || "Student"}</span>
        </div>

        {notice && (
          <div
            className={`academic-notice ${notice.type}`}
            role={notice.type === "error" ? "alert" : "status"}
          >
            {notice.text}
          </div>
        )}

        <section className="academic-card">
          <div className="academic-card-title">
            <span className="academic-step">MY</span>
            <div>
              <h2>My enrolled classes</h2>
              <p>Only sections assigned to your student account appear here.</p>
            </div>
          </div>
          {sections.length ? (
            <div className="student-section-list">
              {sections.map((section) => (
                <article className="student-section-item" key={section._id}>
                  <strong>
                    {section.courseId?.code} · Section {section.name}
                  </strong>
                  <span>
                    {section.courseId?.name} · {section.academicYear} ·{" "}
                    {section.room?.code}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <p className="academic-empty">
              No active class enrollments were found.
            </p>
          )}
        </section>

        <section className="academic-card">
          <div className="academic-card-title">
            <span className="academic-step">LIVE</span>
            <div>
              <h2>Available check-ins</h2>
              <p>Live sessions for your enrolled sections.</p>
            </div>
            <button
              type="button"
              className="academic-button secondary"
              onClick={refreshAttendance}
            >
              Refresh
            </button>
          </div>
          {availableSessions.length ? (
            availableSessions.map((item) => (
              <article className="student-section-item" key={item.sessionId}>
                <strong>
                  {item.courseCode} · Section {item.section}
                </strong>
                <span>
                  Started {new Date(item.startedAt).toLocaleTimeString()} ·
                  Expires {new Date(item.expiresAt).toLocaleTimeString()}
                </span>
              </article>
            ))
          ) : (
            <p className="academic-empty">
              There are no active sessions for your classes right now.
            </p>
          )}
        </section>

        <section className="academic-card">
          <div className="academic-card-title">
            <span className="academic-step">LOG</span>
            <div>
              <h2>Recent attendance</h2>
              <p>Your own attendance records from the server.</p>
            </div>
          </div>
          {records.length ? (
            <div className="academic-table-wrap">
              <table className="academic-table">
                <thead>
                  <tr>
                    <th>Course</th>
                    <th>Section</th>
                    <th>Marked at</th>
                    <th>Location check</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record._id}>
                      <td>{record.courseCode}</td>
                      <td>{record.section}</td>
                      <td>
                        {record.markedAt
                          ? new Date(record.markedAt).toLocaleString()
                          : "—"}
                      </td>
                      <td>{record.verification?.proximity ? "Passed" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="academic-empty">No attendance records yet.</p>
          )}
        </section>

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
              {deviceReady && (
                <button
                  className="academic-button secondary"
                  type="button"
                  onClick={revokeDevice}
                  disabled={deviceBusy}
                >
                  Unregister browser
                </button>
              )}
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
          <p className="student-privacy-note">
            Your device key stays in this browser profile. Use a personal,
            trusted device and sign out when you finish. Face images are sent to
            the attendance service for verification.
          </p>
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
              <ActiveLivenessCapture
                sessionId={sessionId}
                disabled={!deviceReady || !biometricReady || attendanceBusy}
                onVerified={(assertionId) => {
                  setBiometricAssertionId(assertionId);
                  setNotice({
                    type: "success",
                    text: "Face matching and the active liveness sequence passed. Finish check-in before the assertion expires.",
                  });
                }}
              />
              <p className="academic-footnote">
                {biometricAssertionId
                  ? "A short-lived verification assertion is ready for this session."
                  : "Complete all three camera instructions to create a one-time verification assertion."}
              </p>
              <button
                className="academic-button"
                onClick={submitAttendance}
                disabled={
                  attendanceBusy ||
                  !deviceReady ||
                  !biometricReady ||
                  !biometricAssertionId
                }
              >
                {attendanceBusy
                  ? "Verifying check-in…"
                  : "Verify and mark attendance"}
              </button>
              {(!deviceReady || !biometricReady || !biometricAssertionId) && (
                <p className="academic-footnote">
                  Finish device registration, face enrollment, and the active
                  liveness check to enable check-in.
                </p>
              )}
            </div>
          )}
        </section>
        <p className="academic-footnote">
          Location permission is requested when you submit check-in. Attendance
          requires a location reading accurate within 150 meters and no older
          than two minutes. Use this page over HTTPS, in the same browser
          profile where you registered your device.
        </p>
      </section>
    </main>
  );
}

export default StudentAcademic;
