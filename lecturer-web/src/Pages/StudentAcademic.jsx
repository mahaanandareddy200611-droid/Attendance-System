import { useCallback, useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import {
  enrollBiometric,
  getMyBiometricEnrollment,
} from "../services/biometric.service";
import ActiveLivenessCapture from "../components/ActiveLivenessCapture";
import BiometricEnrollmentCapture from "../components/BiometricEnrollmentCapture";
import {
  getAvailableAttendanceSessions,
  getCurrentLocation,
  getMyAttendanceRecords,
  markAttendance,
  prepareAttendanceCheckin,
} from "../services/attendance.service";
import { getSections } from "../services/academic.service";
import { useAuth } from "../auth/useAuth";
import WorkspaceHeader from "../components/WorkspaceHeader";

function getQrToken(decodedText) {
  const value = String(decodedText || "").trim();
  try {
    const parsed = JSON.parse(value);
    return parsed.token || parsed.attendanceToken || value;
  } catch {
    return value;
  }
}

function apiErrorMessage(error, fallback) {
  return (
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    fallback
  );
}

function StudentAcademic() {
  const { user } = useAuth();
  const [biometricReady, setBiometricReady] = useState(false);
  const [biometricDeletePending, setBiometricDeletePending] = useState(false);
  const [enrollmentImage, setEnrollmentImage] = useState(null);
  const [availableSessions, setAvailableSessions] = useState([]);
  const [sections, setSections] = useState([]);
  const [records, setRecords] = useState([]);
  const [sessionId, setSessionId] = useState("");
  const [checkinIntentId, setCheckinIntentId] = useState("");
  const [intentExpiresAt, setIntentExpiresAt] = useState("");
  const [biometricAssertionId, setBiometricAssertionId] = useState("");
  const [locationEvidence, setLocationEvidence] = useState(null);
  const [qrTokenInput, setQrTokenInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [validatingQr, setValidatingQr] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [locationBusy, setLocationBusy] = useState(false);
  const [attendanceBusy, setAttendanceBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState(null);
  const scannerRef = useRef(null);
  const processingQrRef = useRef(false);
  const idempotencyKeyRef = useRef("");

  const selectedSession = availableSessions.find(
    (item) => String(item.sessionId) === String(sessionId),
  );

  const stopScanner = useCallback(async () => {
    const scanner = scannerRef.current;
    if (scanner?.isScanning) {
      try {
        await scanner.stop();
      } catch {
        // The scanner can already have stopped after a successful decode.
      }
    }
    scannerRef.current = null;
    setScanning(false);
  }, []);

  const refreshData = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setRefreshing(true);
    const outcomes = await Promise.allSettled([
      getMyBiometricEnrollment(),
      getSections({ limit: 100 }),
      getMyAttendanceRecords({ limit: 10 }),
      getAvailableAttendanceSessions(),
    ]);

    const failures = [];
    const enrollment = outcomes[0];
    if (enrollment.status === "fulfilled") {
      const status = enrollment.value.data?.data?.status;
      setBiometricReady(status === "ACTIVE");
      setBiometricDeletePending(status === "DELETE_PENDING");
    } else failures.push("face enrollment status");

    if (outcomes[1].status === "fulfilled") {
      setSections(outcomes[1].value.data?.data || []);
    } else failures.push("enrolled classes");

    if (outcomes[2].status === "fulfilled") {
      setRecords(outcomes[2].value.data?.data || []);
    } else failures.push("attendance history");

    if (outcomes[3].status === "fulfilled") {
      setAvailableSessions(outcomes[3].value.data?.data || []);
    } else failures.push("active sessions");

    if (failures.length) {
      setNotice({
        type: "error",
        text:
          "Some student information could not load: " +
          failures.join(", ") +
          ". Check your connection and use Refresh to retry.",
      });
    }
    if (!quiet) setRefreshing(false);
  }, []);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const outcomes = await Promise.allSettled([
        getMyBiometricEnrollment(),
        getSections({ limit: 100 }),
        getMyAttendanceRecords({ limit: 10 }),
        getAvailableAttendanceSessions(),
      ]);
      if (!active) return;

      const failures = [];
      if (outcomes[0].status === "fulfilled") {
        const status = outcomes[0].value.data?.data?.status;
        setBiometricReady(status === "ACTIVE");
        setBiometricDeletePending(status === "DELETE_PENDING");
      } else failures.push("face enrollment status");

      if (outcomes[1].status === "fulfilled") {
        setSections(outcomes[1].value.data?.data || []);
      } else failures.push("enrolled classes");

      if (outcomes[2].status === "fulfilled") {
        setRecords(outcomes[2].value.data?.data || []);
      } else failures.push("attendance history");

      if (outcomes[3].status === "fulfilled") {
        setAvailableSessions(outcomes[3].value.data?.data || []);
      } else failures.push("active sessions");

      if (failures.length) {
        setNotice({
          type: "error",
          text:
            "Some student information could not load: " +
            failures.join(", ") +
            ". Check your connection and use Refresh to retry.",
        });
      }
    };

    load();
    return () => {
      active = false;
      const scanner = scannerRef.current;
      if (scanner?.isScanning) scanner.stop().catch(() => {});
      scannerRef.current = null;
    };
  }, [user?.id]);

  const resetCheckin = () => {
    setCheckinIntentId("");
    setIntentExpiresAt("");
    setBiometricAssertionId("");
    setLocationEvidence(null);
    setQrTokenInput("");
    idempotencyKeyRef.current = "";
  };

  const selectSession = (nextSessionId) => {
    void stopScanner();
    resetCheckin();
    setSessionId(nextSessionId);
    setNotice({
      type: "success",
      text: "Session selected. Open the camera and scan its current QR code first.",
    });
  };

  const validateQrToken = async (rawToken) => {
    if (!sessionId) {
      setNotice({ type: "error", text: "Select your active class session first." });
      return;
    }
    if (!biometricReady) {
      setNotice({
        type: "error",
        text: "Complete your one-time face enrollment below before checking in.",
      });
      return;
    }
    const token = getQrToken(rawToken);
    if (token.length < 20) {
      setNotice({ type: "error", text: "The QR does not contain an attendance token. Scan the current code from your lecturer." });
      return;
    }

    setValidatingQr(true);
    setNotice(null);
    try {
      // Validate QR signature, freshness, Redis nonce, session, and roster on
      // the server before showing a face/liveness challenge to the student.
      const intent = await prepareAttendanceCheckin(token, sessionId);
      if (String(intent.sessionId) !== String(sessionId)) {
        throw new Error("That QR belongs to a different class session. Scan the code shown for your selected class.");
      }
      setCheckinIntentId(intent.checkinIntentId);
      setIntentExpiresAt(intent.expiresAt || "");
      setBiometricAssertionId("");
      setLocationEvidence(null);
      setQrTokenInput("");
      idempotencyKeyRef.current = crypto.randomUUID();
      setNotice({
        type: "success",
        text:
          "QR validated by the server. Now complete the face and liveness check below. " +
          "This check-in expires in about " +
          Math.max(1, Math.round((intent.expiresInMs || 600000) / 60000)) +
          " minute(s).",
      });
    } catch (error) {
      setCheckinIntentId("");
      setIntentExpiresAt("");
      setBiometricAssertionId("");
      setLocationEvidence(null);
      idempotencyKeyRef.current = "";
      setNotice({
        type: "error",
        text: apiErrorMessage(error, "QR validation failed. Scan the lecturer's current QR again."),
      });
    } finally {
      setValidatingQr(false);
    }
  };

  const startScan = async () => {
    setNotice(null);
    if (!sessionId) {
      setNotice({ type: "error", text: "Select an available class session first." });
      return;
    }
    if (!biometricReady) {
      setNotice({ type: "error", text: "Complete your one-time face enrollment before checking in." });
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNotice({
        type: "error",
        text: "Camera scanning requires the HTTPS website and a browser with camera support. You can paste the QR contents as a fallback below.",
      });
      return;
    }

    processingQrRef.current = false;
    setCheckinIntentId("");
    setIntentExpiresAt("");
    setBiometricAssertionId("");
    setLocationEvidence(null);
    idempotencyKeyRef.current = "";

    try {
      await stopScanner();
      const scanner = new Html5Qrcode("student-qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        async (decodedText) => {
          if (processingQrRef.current) return;
          processingQrRef.current = true;
          await stopScanner();
          await validateQrToken(decodedText);
          processingQrRef.current = false;
        },
        () => {},
      );
      setScanning(true);
    } catch (error) {
      scannerRef.current = null;
      setScanning(false);
      processingQrRef.current = false;
      setNotice({
        type: "error",
        text: apiErrorMessage(error, "Could not open the camera. Allow camera access and retry, or paste the QR contents below."),
      });
    }
  };

  const setupBiometric = async (event) => {
    event.preventDefault();
    if (!enrollmentImage || biometricBusy) return;
    setBiometricBusy(true);
    setNotice(null);
    try {
      await enrollBiometric(enrollmentImage);
      setBiometricReady(true);
      setBiometricDeletePending(false);
      setEnrollmentImage(null);
      setNotice({
        type: "success",
        text: "Face enrollment completed. You only need to enroll once; each attendance check-in will still verify your live face after its QR is validated.",
      });
    } catch (error) {
      const message = apiErrorMessage(error, "Face enrollment failed. Check the photo and try again.");
      if (error?.response?.status === 409 && /already exists/i.test(message)) {
        setBiometricReady(true);
        setBiometricDeletePending(false);
        setEnrollmentImage(null);
        setNotice({ type: "success", text: "A face enrollment already exists for this account. You can scan a QR and continue." });
      } else {
        setNotice({ type: "error", text: message });
      }
    } finally {
      setBiometricBusy(false);
    }
  };

  const captureLocation = async () => {
    setLocationBusy(true);
    setNotice(null);
    try {
      const evidence = await getCurrentLocation();
      setLocationEvidence(evidence);
      setNotice({
        type: "success",
        text: "Location captured. Submit attendance now while the check-in ticket is still valid.",
      });
    } catch (error) {
      setLocationEvidence(null);
      setNotice({
        type: "error",
        text: apiErrorMessage(error, "Could not get your location. Allow precise location access and retry."),
      });
    } finally {
      setLocationBusy(false);
    }
  };

  const submitAttendance = async () => {
    if (!checkinIntentId || !biometricAssertionId || !locationEvidence || attendanceBusy) return;
    setAttendanceBusy(true);
    setNotice(null);
    try {
      const response = await markAttendance({
        checkinIntentId,
        biometricAssertionId,
        locationEvidence,
        idempotencyKey: idempotencyKeyRef.current,
      });
      setNotice({
        type: "success",
        text: response.data?.message || "Attendance marked successfully.",
      });
      await refreshData({ quiet: true });
      setSessionId("");
      resetCheckin();
    } catch (error) {
      setNotice({
        type: "error",
        text: apiErrorMessage(error, "Attendance could not be marked. Review the error, then retry or scan a fresh QR."),
      });
    } finally {
      setAttendanceBusy(false);
    }
  };

  const clearExpiredIntent = () => {
    resetCheckin();
    setNotice({
      type: "error",
      text: "This check-in was cleared. Scan and validate a fresh QR to begin again.",
    });
  };

  const intentExpiryLabel =
    intentExpiresAt && Number.isFinite(new Date(intentExpiresAt).getTime())
      ? new Date(intentExpiresAt).toLocaleTimeString()
      : null;

  return (
    <main className="academic-page">
      <WorkspaceHeader />
      <section className="academic-content">
        <div className="academic-heading">
          <div>
            <p className="academic-eyebrow">STUDENT ATTENDANCE</p>
            <h1>Check in to your class</h1>
            <p>
              Welcome {user?.name || "student"}. Scan a valid lecturer QR first;
              the face and liveness check starts only after the server accepts it.
            </p>
          </div>
          <span className="academic-role">{user?.name || "Student"}</span>
        </div>

        {notice && (
          <div className={"academic-notice " + notice.type} role={notice.type === "error" ? "alert" : "status"}>
            {notice.text}
          </div>
        )}

        <section className="academic-card student-setup-card" aria-labelledby="student-face-title">
          <div className="academic-card-title">
            <span className="academic-step">01</span>
            <div>
              <h2 id="student-face-title">One-time face enrollment</h2>
              <p>Save your face enrollment once; live face/liveness is checked again after each valid QR scan.</p>
            </div>
          </div>

          {biometricReady ? (
            <div className="student-section-item">
              <strong>Face enrollment is active</strong>
              <span>Your enrolled identity is ready. You will not need to enroll again for every class.</span>
            </div>
          ) : biometricDeletePending ? (
            <div className="academic-notice error" role="status">
              The previous face enrollment is still being deleted by the provider. Refresh the page once provider cleanup is complete before re-enrolling.
              <button type="button" className="academic-button secondary" onClick={() => refreshData()} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Refresh enrollment status"}
              </button>
            </div>
          ) : (
            <form className="student-setup-item student-biometric-form" onSubmit={setupBiometric}>
              <div className="student-setup-copy">
                <strong>Enroll your face</strong>
                <span>Use the front camera or select one clear face photo. No device registration is needed.</span>
              </div>
              <BiometricEnrollmentCapture
                selectedImage={enrollmentImage}
                onImageSelected={setEnrollmentImage}
                disabled={biometricBusy}
              />
              <button className="academic-button" type="submit" disabled={!enrollmentImage || biometricBusy}>
                {biometricBusy ? "Enrolling face…" : "Save face enrollment"}
              </button>
            </form>
          )}
        </section>

        <section className="academic-card" aria-labelledby="student-classes-title">
          <div className="academic-card-title">
            <span className="academic-step">MY</span>
            <div>
              <h2 id="student-classes-title">My enrolled classes</h2>
              <p>Choose the class currently taking attendance.</p>
            </div>
          </div>
          {sections.length ? (
            <div className="student-section-list">
              {sections.map((section) => (
                <article className="student-section-item" key={section._id}>
                  <strong>{section.courseId?.code} · Section {section.name}</strong>
                  <span>
                    {section.courseId?.name} · {section.academicYear} · {section.room?.code}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <p className="academic-empty">No active class enrollments were found for this student account.</p>
          )}
        </section>

        <section className="academic-card" aria-labelledby="student-sessions-title">
          <div className="academic-card-title">
            <span className="academic-step">02</span>
            <div>
              <h2 id="student-sessions-title">Available check-ins</h2>
              <p>Select a live session, then scan the lecturer's QR code.</p>
            </div>
            <button type="button" className="academic-button secondary" onClick={() => refreshData()} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {availableSessions.length ? (
            availableSessions.map((item) => (
              <article className="student-section-item" key={item.sessionId}>
                <strong>{item.courseCode} · Section {item.section}</strong>
                <span>
                  Started {item.startedAt ? new Date(item.startedAt).toLocaleTimeString() : "recently"} ·
                  Expires {item.expiresAt ? new Date(item.expiresAt).toLocaleTimeString() : "when the session ends"}
                </span>
                <button
                  type="button"
                  className="academic-button secondary"
                  disabled={!biometricReady || attendanceBusy || validatingQr}
                  onClick={() => selectSession(item.sessionId)}
                >
                  {sessionId === item.sessionId ? "Selected session" : "Select session"}
                </button>
              </article>
            ))
          ) : (
            <p className="academic-empty">There are no live attendance sessions for your enrolled classes right now.</p>
          )}
        </section>

        {sessionId && (
          <section className="academic-card student-scan-card" aria-labelledby="student-qr-title">
            <div className="academic-card-title">
              <span className="academic-step">03</span>
              <div>
                <h2 id="student-qr-title">Scan and validate the lecturer QR</h2>
                <p>This is the first step of each check-in. Face/liveness is not requested until the server confirms this QR is valid.</p>
              </div>
            </div>
            <div id="student-qr-reader" className="student-qr-reader" />
            {!scanning ? (
              <button type="button" className="academic-button" onClick={startScan} disabled={!biometricReady || validatingQr || attendanceBusy || Boolean(checkinIntentId)}>
                {validatingQr ? "Validating QR…" : checkinIntentId ? "QR validated" : "Open camera and scan QR"}
              </button>
            ) : (
              <button type="button" className="academic-button secondary student-stop-button" onClick={() => void stopScanner()}>
                Stop camera
              </button>
            )}

            {!checkinIntentId && (
              <details className="student-qr-fallback">
                <summary>Camera not scanning? Paste QR contents</summary>
                <label className="academic-field" htmlFor="student-qr-token">
                  QR contents
                  <textarea
                    id="student-qr-token"
                    rows={3}
                    value={qrTokenInput}
                    onChange={(event) => setQrTokenInput(event.target.value)}
                    placeholder="Paste the full QR text here"
                    autoComplete="off"
                    disabled={validatingQr}
                  />
                </label>
                <button
                  type="button"
                  className="academic-button secondary"
                  onClick={() => void validateQrToken(qrTokenInput)}
                  disabled={!qrTokenInput.trim() || validatingQr || !biometricReady}
                >
                  {validatingQr ? "Checking with server…" : "Validate QR"}
                </button>
                <p className="academic-footnote">Pasting does not bypass security: the backend validates the signature, expiry, challenge nonce, selected session and student eligibility.</p>
              </details>
            )}

            {checkinIntentId && (
              <div className="student-checkin-form">
                <p className="academic-notice success" role="status">
                  QR accepted for {selectedSession?.courseCode || "your selected class"}. {intentExpiryLabel ? "Ticket expires at " + intentExpiryLabel + "." : ""}
                </p>
                <button type="button" className="academic-button secondary" onClick={clearExpiredIntent} disabled={attendanceBusy}>
                  Cancel this check-in
                </button>
              </div>
            )}
          </section>
        )}

        {checkinIntentId && (
          <section className="academic-card student-setup-card" aria-labelledby="student-liveness-title">
            <div className="academic-card-title">
              <span className="academic-step">04</span>
              <div>
                <h2 id="student-liveness-title">Face match and liveness</h2>
                <p>The server accepted your QR. Now prove your live face matches the face you enrolled.</p>
              </div>
            </div>
            {!biometricAssertionId ? (
              <ActiveLivenessCapture
                sessionId={sessionId}
                onVerified={(assertionId) => {
                  setBiometricAssertionId(assertionId);
                  setLocationEvidence(null);
                  setNotice({
                    type: "success",
                    text: "Face match and liveness passed. Get your current location to finish check-in.",
                  });
                }}
                disabled={attendanceBusy}
              />
            ) : (
              <p className="academic-notice success" role="status">
                Face match and liveness passed for this check-in.
              </p>
            )}

            {biometricAssertionId && (
              <>
                <button type="button" className="academic-button secondary" onClick={captureLocation} disabled={locationBusy || attendanceBusy}>
                  {locationBusy ? "Getting location…" : locationEvidence ? "Refresh location" : "Get current location"}
                </button>
                {locationEvidence && (
                  <p className="academic-footnote">
                    Location accuracy: {Math.round(locationEvidence.accuracyMeters)} m · Captured {new Date(locationEvidence.capturedAt).toLocaleTimeString()}
                  </p>
                )}
                <button type="button" className="academic-button" onClick={submitAttendance} disabled={!locationEvidence || attendanceBusy}>
                  {attendanceBusy ? "Submitting attendance…" : "Mark attendance"}
                </button>
              </>
            )}
          </section>
        )}

        <section className="academic-card" aria-labelledby="student-history-title">
          <div className="academic-card-title">
            <span className="academic-step">LOG</span>
            <div>
              <h2 id="student-history-title">Recent attendance</h2>
              <p>Attendance results saved by the server.</p>
            </div>
          </div>
          {records.length ? (
            <div className="academic-table-wrap">
              <table className="academic-table">
                <thead>
                  <tr><th>Course</th><th>Section</th><th>Marked at</th><th>Location check</th></tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record._id}>
                      <td>{record.courseCode || "—"}</td>
                      <td>{record.section || "—"}</td>
                      <td>{record.markedAt ? new Date(record.markedAt).toLocaleString() : "—"}</td>
                      <td>{record.verification?.proximity ? "Passed" : "Checked by server"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="academic-empty">No attendance records yet.</p>
          )}
        </section>
        <p className="academic-footnote">
          Flow: select class → scan QR → server validates the QR → live face/liveness → current location → attendance recorded. Browser-device registration is not part of this flow. Camera and location permissions are requested only when you start those steps.
        </p>
      </section>
    </main>
  );
}

export default StudentAcademic;