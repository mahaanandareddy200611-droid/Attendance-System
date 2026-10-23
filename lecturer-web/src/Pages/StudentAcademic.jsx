import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Html5Qrcode } from "html5-qrcode";
import { getMyBiometricEnrollment } from "../services/biometric.service";
import ActiveLivenessCapture from "../components/ActiveLivenessCapture";
import { getAvailableAttendanceSessions, getMyAttendanceRecords, markAttendance, validateAttendanceQr } from "../services/attendance.service";
import { getSections } from "../services/academic.service";
import { useAuth } from "../auth/useAuth";
import { getApiErrorMessage } from "../api/errors";
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
function cameraErrorMessage(error, fallback) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "Camera permission was denied. Allow camera access for this HTTPS site in your browser settings, then try again.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No camera was found. Connect or enable a camera, then try again.";
  if (name === "NotReadableError" || name === "TrackStartError") return "The camera is busy or blocked by another application. Close other camera apps/tabs and retry.";
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") return "The selected camera does not support the requested settings. Try the other camera or a lower resolution.";
  const detail = String(error?.message || "");
  if (/secure context|https|only.*secure/i.test(detail)) return "Camera access requires HTTPS (or localhost). Open the secure deployed site and try again.";
  return detail || fallback;
}
function messageFor(error, fallback) {
  return getApiErrorMessage(error, fallback);
}

export default function StudentAcademic() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [biometricReady, setBiometricReady] = useState(false);
  const [approvalPending, setApprovalPending] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [checkingQr, setCheckingQr] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scannerStarting, setScannerStarting] = useState(false);
  const [attendanceBusy, setAttendanceBusy] = useState(false);
  const [qrTicket, setQrTicket] = useState(null);
  const [assertionId, setAssertionId] = useState("");
  const [notice, setNotice] = useState(null);
  const [sections, setSections] = useState([]);
  const [records, setRecords] = useState([]);
  const [sessions, setSessions] = useState([]);
  const scannerRef = useRef(null);
  const qrHandlingRef = useRef(false);
  const idempotencyKeyRef = useRef(null);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

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
        setApprovalPending(item?.status === "PENDING_APPROVAL");
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
      else if (results[0].status === "fulfilled" && results[0].value?.data?.data?.status === "REJECTED") {
        setNotice({ type: "info", text: "Your previous face enrollment was rejected. You can submit a new enrollment after scanning a live QR." });
      }
      const enrollmentStatus = results[0].status === "fulfilled"
        ? results[0].value?.data?.data?.status
        : null;
      if (
        results[0].status === "fulfilled" &&
        !["ACTIVE", "PENDING_APPROVAL", "DELETE_PENDING"].includes(enrollmentStatus)
      ) {
        navigate("/student/face-enrollment?required=1", { replace: true });
      }
      setLoading(false);
    }
    void load();
    return () => {
      active = false;
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (scanner) {
        void (async () => {
          try { if (scanner.isScanning) await scanner.stop(); } catch { /* Camera may already have stopped. */ }
          try { await scanner.clear(); } catch { /* The route is already unmounting. */ }
        })();
      }
    };
  }, [user?.id, navigate]);

  const stopScan = async () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (scanner) {
      try { if (scanner.isScanning) await scanner.stop(); } catch { /* Camera may already have stopped. */ }
      try { await scanner.clear(); } catch { /* Browser permission may have been revoked mid-scan. */ }
    }
    setScanning(false);
    setScannerStarting(false);
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
    if (checkingQr || attendanceBusy || scannerStarting) return;
    setNotice(null);
    setQrTicket(null);
    setAssertionId("");
    idempotencyKeyRef.current = null;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNotice({ type: "error", text: "Camera scanning needs HTTPS (or localhost) and browser camera support." });
      return;
    }

    await stopScan();
    setScannerStarting(true);
    setNotice({ type: "info", text: "Opening your camera… If prompted, allow camera access for this site." });
    let scanner;
    try {
      // Make the target visible before html5-qrcode measures its dimensions.
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
      scanner = new Html5Qrcode("student-qr-reader", { verbose: false });
      scannerRef.current = scanner;
      const config = {
        fps: 12,
        aspectRatio: 1,
        qrbox: (width, height) => {
          const size = Math.max(140, Math.min(320, Math.floor(Math.min(width, height) * 0.74)));
          return { width: size, height: size };
        },
        videoConstraints: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      };
      const onDecoded = (decodedText) => { void validateScannedQr(decodedText); };
      const onDecodeMiss = () => {};
      let cameras = [];
      try { cameras = await Html5Qrcode.getCameras(); } catch { /* start() below reports permission/device failures. */ }
      if (cameras.length) {
        const camera = cameras.find((item) => /(back|rear|environment|world)/i.test(item.label || "")) || cameras[cameras.length - 1];
        await scanner.start(camera.id, config, onDecoded, onDecodeMiss);
      } else {
        await scanner.start({ facingMode: { ideal: "environment" } }, config, onDecoded, onDecodeMiss);
      }
      setScanning(true);
      setScannerStarting(false);
      setNotice({ type: "info", text: "Camera is live. Hold the lecturer’s QR inside the frame; we will verify it with the server." });
    } catch (error) {
      if (scanner) {
        try { if (scanner.isScanning) await scanner.stop(); } catch { /* Startup may fail before a stream exists. */ }
        try { await scanner.clear(); } catch { /* Keep the next retry clean. */ }
      }
      if (scannerRef.current === scanner) scannerRef.current = null;
      setScanning(false);
      setScannerStarting(false);
      setNotice({ type: "error", text: cameraErrorMessage(error, "Could not open the camera. Check browser permission, close other camera apps, and retry.") });
    }
  };

  const refreshBiometricStatus = async () => {
    try {
      const response = await getMyBiometricEnrollment();
      const item = response?.data?.data;
      setBiometricReady(item?.status === "ACTIVE");
      setApprovalPending(item?.status === "PENDING_APPROVAL");
      setDeletePending(item?.status === "DELETE_PENDING");
      const text = item?.status === "DELETE_PENDING"
        ? "Face deletion is still pending; attendance is blocked."
        : item?.status === "PENDING_APPROVAL"
          ? "Your face enrollment is pending lecturer/admin approval. Attendance is disabled until approval."
          : item?.status === "ACTIVE"
            ? "Your face enrollment is active."
            : item?.status === "REJECTED"
              ? "Your previous face enrollment was rejected. You may submit a new enrollment after scanning a live QR."
              : "No active face enrollment was found.";
      setNotice({ type: item?.status === "DELETE_PENDING" ? "error" : item?.status === "PENDING_APPROVAL" ? "info" : "success", text });
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
        {notice && <div className={"academic-notice academic-toast " + notice.type} role={notice.type === "error" ? "alert" : "status"} aria-live={notice.type === "error" ? "assertive" : "polite"}>{notice.text}</div>}
        {approvalPending && <div className="academic-notice info enrollment-pending-notice" role="status"><strong>Face enrollment awaiting approval</strong><span>A lecturer or administrator must approve your enrollment before face verification and attendance are enabled.</span><button type="button" className="academic-button secondary" onClick={() => void refreshBiometricStatus()}>Refresh status</button></div>}

        <section className="academic-card student-scan-card">
          <div className="academic-card-title"><span className="academic-step">01</span><div><h2>Scan the lecturer’s live QR</h2><p>Open the rear camera and scan the code on the lecturer’s screen. Invalid or expired codes are rejected by the server.</p></div></div>
          <div id="student-qr-reader" className={"student-qr-reader" + (scanning || scannerStarting ? " is-active" : "")} aria-label="QR camera preview" />
          <div className="active-liveness-actions">
            {!scanning ? <button type="button" className="academic-button" onClick={startScan} disabled={checkingQr || attendanceBusy || scannerStarting}>{scannerStarting ? "Opening camera…" : checkingQr ? "Validating QR…" : "Open camera and scan"}</button> : <button type="button" className="academic-button secondary" onClick={() => void stopScan()}>Stop camera</button>}
            {qrTicket && <button type="button" className="academic-button secondary" onClick={startScan} disabled={checkingQr || attendanceBusy}>Scan again</button>}
          </div>
          <p className="academic-footnote">Camera access requires HTTPS (or localhost). The QR must be live and belong to an active class session where your account is enrolled.</p>
          {qrTicket && <div className="student-checkin-form"><p className="academic-eyebrow">SERVER-VALIDATED QR</p><h3>{qrTicket.courseCode} · Section {qrTicket.section}</h3><p className="academic-footnote">The server accepted this QR. Complete the face step below before the short-lived check-in authorization expires.</p></div>}
        </section>

        {qrTicket && <section className="academic-card student-setup-card">
          <div className="academic-card-title"><span className="academic-step">02</span><div><h2>Verify your face and liveness</h2><p>This step appears only after the QR is accepted by the server.</p></div></div>
          {deletePending ? <div className="academic-notice error" role="alert">Face enrollment deletion is pending, so attendance is blocked.<button type="button" className="academic-button secondary" onClick={() => void refreshBiometricStatus()}>Refresh face status</button></div> :
            approvalPending ? <div className="academic-notice info" role="status">Your enrollment is waiting for lecturer/admin approval. After approval, scan the lecturer’s live QR again.</div> :
            !biometricReady ? <div className="academic-notice info" role="status">Face enrollment is required before attendance can be verified. <Link to="/student/face-enrollment?required=1">Open secure face setup</Link></div> :
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
