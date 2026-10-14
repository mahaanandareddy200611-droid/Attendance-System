import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Link } from "react-router-dom";
import {
  endAttendanceSession,
  getAttendanceQr,
  startAttendanceSession,
} from "../services/attendance-lecturer.service";
import "../Styles/Academic.css";

function LecturerAttendance() {
  const [sectionId, setSectionId] = useState("");
  const [session, setSession] = useState(null);
  const [qrImage, setQrImage] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!session?.sessionId) return undefined;
    let stopped = false;
    let timer;
    const refresh = async () => {
      try {
        const response = await getAttendanceQr(session.sessionId);
        if (stopped) return;
        const { token, refreshMs } = response.data.data;
        const image = await QRCode.toDataURL(token, {
          width: 300,
          margin: 2,
          errorCorrectionLevel: "M",
        });
        if (stopped) return;
        setQrImage(image);
        timer = window.setTimeout(
          refresh,
          Math.max(500, Number(refreshMs) || 1000),
        );
      } catch (error) {
        if (!stopped)
          setMessage(
            error.response?.data?.error?.message ||
              "Could not refresh the attendance QR.",
          );
        if (!stopped) timer = window.setTimeout(refresh, 2000);
      }
    };
    refresh();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [session?.sessionId]);

  const startSession = async (event) => {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    setQrImage("");
    try {
      const response = await startAttendanceSession(sectionId.trim());
      setSession(response.data.data);
      setMessage(
        "Attendance session started. Students can scan the rotating QR.",
      );
    } catch (error) {
      setMessage(
        error.response?.data?.error?.message ||
          error.response?.data?.message ||
          "Could not start the session. Check the section ID and your assignment.",
      );
    } finally {
      setLoading(false);
    }
  };

  const endSession = async () => {
    if (!session?.sessionId) return;
    setLoading(true);
    try {
      await endAttendanceSession(session.sessionId);
      setSession(null);
      setQrImage("");
      setMessage("Attendance session ended.");
    } catch (error) {
      setMessage(
        error.response?.data?.error?.message ||
          error.response?.data?.message ||
          "Could not end the session.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="academic-page">
      <header className="academic-topbar">
        <Link to="/dashboard" className="academic-brand">
          Attendance System
        </Link>
        <span>Lecturer workspace</span>
      </header>
      <section className="academic-content">
        <div className="academic-heading">
          <div>
            <p className="academic-eyebrow">LIVE ATTENDANCE</p>
            <h1>Start a class check-in</h1>
            <p>
              Start a session for an assigned section and display its rotating
              QR code.
            </p>
          </div>
          <span className="academic-role">Lecturer</span>
        </div>
        {message && (
          <div className="academic-notice" role="status">
            {message}
          </div>
        )}
        {!session ? (
          <form
            className="academic-card academic-lookup"
            onSubmit={startSession}
          >
            <label className="academic-field">
              <span>Section ID</span>
              <input
                value={sectionId}
                onChange={(event) => setSectionId(event.target.value)}
                required
                placeholder="Paste the section ID from your Admin"
              />
            </label>
            <button className="academic-button" disabled={loading}>
              {loading ? "Starting…" : "Start attendance"}
            </button>
          </form>
        ) : (
          <section className="academic-card lecturer-live-card">
            <div>
              <p className="academic-eyebrow">SESSION ACTIVE</p>
              <h2>
                {session.courseCode} · Section {session.section}
              </h2>
              <p>Eligible students: {session.eligibleStudentCount}</p>
            </div>
            {qrImage ? (
              <img
                className="lecturer-live-qr"
                src={qrImage}
                alt="Rotating attendance QR code"
              />
            ) : (
              <div className="lecturer-qr-loading">Generating QR…</div>
            )}
            <p className="academic-footnote">
              Keep this QR visible while students scan it. The code refreshes
              automatically.
            </p>
            <button
              className="academic-button lecturer-end-button"
              onClick={endSession}
              disabled={loading}
            >
              {loading ? "Ending…" : "End session"}
            </button>
          </section>
        )}
        <p className="academic-footnote">
          You must be assigned to the section and it must have at least one
          active student enrollment before a session can start.
        </p>
      </section>
    </main>
  );
}

export default LecturerAttendance;
