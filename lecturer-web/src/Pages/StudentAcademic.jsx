import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { enrollBiometric, getMyBiometricEnrollment } from "../services/biometric.service";
import ActiveLivenessCapture from "../components/ActiveLivenessCapture";
import { getAvailableAttendanceSessions, getMyAttendanceRecords, markAttendance, validateAttendanceQr } from "../services/attendance.service";
import { getSections } from "../services/academic.service";
import { useAuth } from "../auth/useAuth";
import "../Styles/Academic.css";
import WorkspaceHeader from "../components/WorkspaceHeader";

function getQrToken(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed.token || parsed.attendanceToken || String(value || "").trim();
  } catch {
    return String(value || "").trim();
  }
}
function stopStream(stream) { stream?.getTracks().forEach((track) => track.stop()); }
function messageFor(error, fallback) {
  return error?.response?.data?.error?.message || error?.response?.data?.message || error?.message || fallback;
}

export default function StudentAcademic() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [biometricReady, setBiometricReady] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [enrollmentCameraActive, setEnrollmentCameraActive] = useState(false);
  const [enrollmentBusy, setEnrollmentBusy] = useState(false);
  const [checkingQr, setCheckingQr] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [attendanceBusy, setAttendanceBusy] = useState(false);
  const [manualQrToken, setManualQrToken] = useState("");
  const [qrTicket, setQrTicket] = useState(null);
  const [assertionId, setAssertionId] = useState("");
  const [notice, setNotice] = useState(null);
  const [sections, setSections] = useState([]);
  const [records, setRecords] = useState([]);
  const [sessions, setSessions] = useState([]);
  const scannerRef = useRef(null);
  const enrollmentStreamRef = useRef(null);
  const videoRef = useRef(null);
  const qrHandlingRef = useRef(false);
  const idempotencyKeyRef = useRef(null);

  useEffect(() => {
    let active = true;
    async function load() {
      // Keep the portal visible if any one dashboard request fails.
      const results = await Promise.allSettled([
        getMyBiometricEnrollment(), getSections({ limit: 100 }),
        getMyAttendanceRecords({ limit: 10 }), getAvailableAttendanceSessions(),
      ]);
      if (!active) return;
      const errors = [];
      if (results[0].status === "fulfilled") {
        const item = results[0].value?.data?.data;
        setBiometricReady(item?.status === "ACTIVE");
        setDeletePending(item?.status === "DELETE_PENDING");
        if (item?.status === "DELETE_PENDING") errors.push("Face enrollment deletion is pending with the biometric provider. Attendance remains blocked until deletion is confirmed.");
      } else errors.push(messageFor(results[0].reason, "Could not read face-enrollment status."));
      if (results[1].status === "fulfilled") setSections(results[1].value?.data?.data || []);
      else errors.push(messageFor(results[1].reason, "Could not load enrolled classes."));
      if (results[2].status === "fulfilled") setRecords(results[2].value?.data?.data || []);
      else errors.push(messageFor(results[2].reason, "Could not load attendance history."));
      if (results[3].status === "fulfilled") setSessions(results[3].value?.data?.data || []);
      else errors.push(messageFor(results[3].reason, "Could not load active attendance sessions."));
      if (errors.length) setNotice({ type: "error", text: errors[0] });
      setLoading(false);
    }
    void load();
    return () => {
      active = false;
      const scanner = scannerRef.current;
      if (scanner?.isScanning) scanner.stop().catch(() => {});
      stopStream(enrollmentStreamRef.current);
    };
  }, [user?.id]);

  useEffect(() => {
    if (!enrollmentCameraActive || !videoRef.current || !enrollmentStreamRef.current) return;
    videoRef.current.srcObject = enrollmentStreamRef.current;
    videoRef.current.play().catch(() => setNotice({ type: "error", text: "Camera preview could not start. Check camera permission and try again." }));
  }, [enrollmentCameraActive]);

  const stopScan = async () => {
    if (scannerRef.current?.isScanning) {
      try { await scannerRef.current.stop(); } catch { /* Camera may already have stopped. */ }
    }
    setScanning(false);
  };

  const validateScannedQr = async (rawValue) => {
    if (qrHandlingRef.current) return;
    qrHandlingRef.current = true;
    setCheckingQr(true);
    setNotice(null);
    await stopScan();
    try {
      const token = getQrToken(rawValue);
      if (!token) throw new Error("No QR token was detected. Scan the live code on the lecturer’s screen.");
      const response = await validateAttendanceQr(token);
      const result = response?.data?.data;
      if (!result?.validationId || !result?.sessionId) throw new Error("The server did not return a valid QR-check result. Scan the live code again.");
      setQrTicket({ validationId: result.validationId, sessionId: result.sessionId, courseCode: result.courseCode || "Class", section: result.section || "—" });
      setAssertionId("");
      idempotencyKeyRef.current = crypto.randomUUID();
      setManualQrToken("");
      setNotice({ type: "success", text: "QR verified by the server for " + (result.courseCode || "your class") + " · Section " + (result.section || "—") + ". Now complete the face check." });
    } catch (error) {
      setQrTicket(null);
      setAssertionId("");
      idempotencyKeyRef.current = null;
      setNotice({ type: "error", text: messageFor(error, "QR validation failed. Scan the current code from your lecturer.") });
    } finally {
      setCheckingQr(false);
      qrHandlingRef.current = false;
    }
  };

  const startScan = async () => {
    setNotice(null); setQrTicket(null); setAssertionId(""); idempotencyKeyRef.current = null;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNotice({ type: "error", text: "Camera scanning needs HTTPS (or localhost) and browser camera support." }); return;
    }
    try {
      const scanner = new Html5Qrcode("student-qr-reader");
      scannerRef.current = scanner;
      await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 240, height: 240 } },
        (decoded) => { void validateScannedQr(decoded); }, () => {});
      setScanning(true);
    } catch (error) {
      setScanning(false);
      setNotice({ type: "error", text: messageFor(error, "Could not open the camera. Allow camera access and try again.") });
    }
  };

  const startEnrollmentCamera = async () => {
    setNotice(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNotice({ type: "error", text: "Face enrollment needs HTTPS (or localhost) and browser camera support." }); return;
    }
    try {
      stopStream(enrollmentStreamRef.current);
      enrollmentStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "user" }, width: { ideal: 960 }, height: { ideal: 720 } } });
      setEnrollmentCameraActive(true);
    } catch (error) {
      setNotice({ type: "error", text: messageFor(error, "Could not open the front camera. Allow camera permission and retry.") });
    }
  };

  const stopEnrollmentCamera = () => {
    stopStream(enrollmentStreamRef.current); enrollmentStreamRef.current = null; setEnrollmentCameraActive(false);
  };

  const captureAndEnroll = async () => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video?.videoHeight) {
      setNotice({ type: "error", text: "Camera is still starting. Wait until your face is visible, then try again." }); return;
    }
    setEnrollmentBusy(true); setNotice(null);
    try {
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Could not capture an enrollment image.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error("Could not encode the camera image.")), "image/jpeg", 0.82));
      if (blob.size > 900 * 1024) throw new Error("The captured face image is too large. Improve lighting and retry.");
      await enrollBiometric(new File([blob], "student-face-enrollment.jpg", { type: "image/jpeg" }));
      setBiometricReady(true); setDeletePending(false); stopEnrollmentCamera();
      setNotice({ type: "success", text: "One-time face enrollment is complete. Now complete the live face/liveness check for this QR." });
    } catch (error) {
      const message = messageFor(error, "Face enrollment failed. Keep your face centered with good lighting and retry.");
      if (error?.response?.status === 409 && /already exists/i.test(message)) {
        setBiometricReady(true); setDeletePending(false); stopEnrollmentCamera();
        setNotice({ type: "success", text: "Your face is already enrolled. Continue with live face/liveness verification." });
      } else setNotice({ type: "error", text: message });
    } finally { setEnrollmentBusy(false); }
  };

  const refreshBiometricStatus = async () => {
    try {
      const response = await getMyBiometricEnrollment();
      const item = response?.data?.data;
      setBiometricReady(item?.status === "ACTIVE"); setDeletePending(item?.status === "DELETE_PENDING");
      setNotice({ type: item?.status === "DELETE_PENDING" ? "error" : "success",
        text: item?.status === "DELETE_PENDING" ? "Face deletion is still pending; attendance is blocked." : item?.status === "ACTIVE" ? "Your face enrollment is active." : "No active face enrollment was found." });
    } catch (error) { setNotice({ type: "error", text: messageFor(error, "Could not refresh face-enrollment status.") }); }
  };

  const refreshRecords = async () => {
    const results = await Promise.allSettled([getAvailableAttendanceSessions(), getMyAttendanceRecords({ limit: 10 })]);
    if (results[0].status === "fulfilled") setSessions(results[0].value?.data?.data || []);
    if (results[1].status === "fulfilled") setRecords(results[1].value?.data?.data || []);
    const failure = results.find((item) => item.status === "rejected");
    setNotice(failure ? { type: "error", text: messageFor(failure.reason, "Could not refresh attendance.") } : { type: "success", text: "Your active sessions and attendance history are up to date." });
  };

  const recordAttendance = async (newAssertionId) => {
    if (!qrTicket || !newAssertionId || attendanceBusy) return;
    setAssertionId(newAssertionId); setAttendanceBusy(true);
    setNotice({ type: "success", text: "Face match and liveness passed. Recording attendance…" });
    try {
      const response = await markAttendance({ validationId: qrTicket.validationId, biometricAssertionId: newAssertionId, idempotencyKey: idempotencyKeyRef.current || crypto.randomUUID() });
      setNotice({ type: "success", text: response?.data?.message || "Attendance marked successfully." });
      setQrTicket(null); setAssertionId(""); idempotencyKeyRef.current = null;
      const results = await Promise.allSettled([getAvailableAttendanceSessions(), getMyAttendanceRecords({ limit: 10 })]);
      if (results[0].status === "fulfilled") setSessions(results[0].value?.data?.data || []);
      if (results[1].status === "fulfilled") setRecords(results[1].value?.data?.data || []);
    } catch (error) {
      const message = messageFor(error, "Attendance check-in failed.");
      setNotice({ type: "error", text: message });
      if (/validation ticket.*expired|qr validation.*expired|scan the qr again/i.test(message)) { setQrTicket(null); setAssertionId(""); idempotencyKeyRef.current = null; }
    } finally { setAttendanceBusy(false); }
  };

  return (
    <main className="academic-page">
      <WorkspaceHeader />
      <section className="academic-content">
        <div className="academic-heading">
          <div><p className="academic-eyebrow">STUDENT ATTENDANCE</p><h1>Scan QR, verify your face, check in</h1><p>Welcome {user?.name || "student"}. Scan the live code first. The server validates it before asking for face verification.</p></div>
          <span className="academic-role">{user?.name || "Student"}</span>
        </div>
        {notice && <div className={"academic-notice " + notice.type} role={notice.type === "error" ? "alert" : "status"}>{notice.text}</div>}

        <section className="academic-card student-scan-card">
          <div className="academic-card-title"><span className="academic-step">01</span><div><h2>Scan the lecturer’s live QR</h2><p>Open the rear camera and scan the code on the lecturer’s screen. Invalid or expired codes are rejected by the server.</p></div></div>
          <div id="student-qr-reader" className="student-qr-reader" />
          <div className="active-liveness-actions">
            {!scanning ? <button type="button" className="academic-button" onClick={startScan} disabled={checkingQr || attendanceBusy}>{checkingQr ? "Validating QR…" : "Open camera and scan"}</button> : <button type="button" className="academic-button secondary" onClick={() => void stopScan()}>Stop camera</button>}
            {qrTicket && <button type="button" className="academic-button secondary" onClick={startScan} disabled={checkingQr || attendanceBusy}>Scan again</button>}
          </div>
          <details className="student-manual-qr"><summary>Enter QR token manually (camera fallback)</summary>
            <label className="academic-field"><span>QR token</span><input value={manualQrToken} onChange={(event) => setManualQrToken(event.target.value)} placeholder="Paste the token encoded in the lecturer QR" autoComplete="off" /></label>
            <button type="button" className="academic-button secondary" onClick={() => void validateScannedQr(manualQrToken)} disabled={!manualQrToken.trim() || checkingQr || attendanceBusy}>Validate QR</button>
          </details>
          <p className="academic-footnote">Camera access requires HTTPS (or localhost). The QR must be live and belong to an active class session where your account is enrolled.</p>
          {qrTicket && <div className="student-checkin-form"><p className="academic-eyebrow">SERVER-VALIDATED QR</p><h3>{qrTicket.courseCode} · Section {qrTicket.section}</h3><p className="academic-footnote">The server accepted this QR. Complete the face step below before the short-lived check-in authorization expires.</p></div>}
        </section>

        {qrTicket && <section className="academic-card student-setup-card">
          <div className="academic-card-title"><span className="academic-step">02</span><div><h2>Verify your face and liveness</h2><p>This step appears only after the QR is accepted by the server.</p></div></div>
          {deletePending ? <div className="academic-notice error" role="alert">Face enrollment deletion is pending, so attendance is blocked.<button type="button" className="academic-button secondary" onClick={() => void refreshBiometricStatus()}>Refresh face status</button></div> :
            !biometricReady ? <div className="student-setup-item student-enrollment-camera">
              <div className="student-setup-copy"><strong>One-time face enrollment</strong><span>Enroll your face once. Later check-ins will use live face matching and liveness verification against this enrollment.</span></div>
              {enrollmentCameraActive && <video ref={videoRef} className="active-liveness-video" autoPlay playsInline muted aria-label="Live front camera preview for one-time face enrollment" />}
              {!enrollmentCameraActive ? <button type="button" className="academic-button" onClick={() => void startEnrollmentCamera()} disabled={enrollmentBusy || checkingQr}>Open front camera</button> :
                <div className="active-liveness-actions"><button type="button" className="academic-button" onClick={() => void captureAndEnroll()} disabled={enrollmentBusy}>{enrollmentBusy ? "Enrolling face…" : "Capture and enroll face"}</button><button type="button" className="academic-button secondary" onClick={stopEnrollmentCamera} disabled={enrollmentBusy}>Cancel camera</button></div>}
              <p className="academic-footnote">Use good lighting and keep your face centered. Enrollment is sent to the configured biometric provider.</p>
            </div> :
            <>
              <ActiveLivenessCapture sessionId={qrTicket.sessionId} disabled={attendanceBusy || checkingQr} onVerified={(id) => { void recordAttendance(id); }} />
              {assertionId && <button type="button" className="academic-button secondary" onClick={() => void recordAttendance(assertionId)} disabled={attendanceBusy}>{attendanceBusy ? "Recording attendance…" : "Retry attendance submission"}</button>}
            </>}
        </section>}

        <section className="academic-card"><div className="academic-card-title"><span className="academic-step">MY</span><div><h2>My enrolled classes</h2><p>Only classes assigned to your student account are shown.</p></div></div>
          {loading ? <p className="academic-empty">Loading your classes…</p> : sections.length ? <div className="student-section-list">{sections.map((section) => <article className="student-section-item" key={section._id}><strong>{section.courseId?.code || "Course"} · Section {section.name || "—"}</strong><span>{section.courseId?.name || "Class"} · {section.academicYear || "Academic year not set"} · {section.room?.code || "Room not set"}</span></article>)}</div> : <p className="academic-empty">No active class enrollments were found.</p>}
        </section>
        <section className="academic-card"><div className="academic-card-title"><span className="academic-step">LIVE</span><div><h2>Available check-ins</h2><p>These sessions show that the lecturer has opened attendance. Scan the live QR to begin your check-in.</p></div><button type="button" className="academic-button secondary" onClick={() => void refreshRecords()}>Refresh</button></div>
          {loading ? <p className="academic-empty">Loading active sessions…</p> : sessions.length ? sessions.map((item) => <article className="student-section-item" key={item.sessionId}><strong>{item.courseCode} · Section {item.section}</strong><span>Started {new Date(item.startedAt).toLocaleTimeString()} · Expires {new Date(item.expiresAt).toLocaleTimeString()}</span></article>) : <p className="academic-empty">There are no active sessions for your classes right now.</p>}
        </section>
        <section className="academic-card"><div className="academic-card-title"><span className="academic-step">LOG</span><div><h2>Recent attendance</h2><p>Records returned by the attendance server.</p></div></div>
          {records.length ? <div className="academic-table-wrap"><table className="academic-table"><thead><tr><th>Course</th><th>Section</th><th>Marked at</th><th>Face check</th></tr></thead><tbody>{records.map((record) => <tr key={record._id}><td>{record.courseCode || "—"}</td><td>{record.section || "—"}</td><td>{record.markedAt ? new Date(record.markedAt).toLocaleString() : "—"}</td><td>{record.verification?.biometric ? "Passed" : "—"}</td></tr>)}</tbody></table></div> : <p className="academic-empty">No attendance records yet.</p>}
        </section>
      </section>
    </main>
  );
}
