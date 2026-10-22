import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Link, useParams, useNavigate, useLocation } from "react-router-dom";
import { getSections } from "../services/academic.service";
import {
  endAttendanceSession,
  getAttendanceSessions,
  getAttendanceQr,
  startAttendanceSession,
} from "../services/attendance-lecturer.service";
import { getApiErrorMessage } from "../api/errors";
import "../Styles/Academic.css";
import WorkspaceHeader from "../components/WorkspaceHeader";

function LecturerAttendance() {
  const { sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const routeSession = location.state?.activeSession;
  const initialSession = routeSessionId && routeSession?.sessionId === routeSessionId
    ? routeSession
    : null;
  const [sectionId, setSectionId] = useState("");
  const [sections, setSections] = useState([]);
  const [activeSessions, setActiveSessions] = useState([]);
  const [session, setSession] = useState(initialSession);
  const [qrImage, setQrImage] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(() => location.state?.notice || "");
  const [pageLoading, setPageLoading] = useState(true);
  const [qrStatus, setQrStatus] = useState("loading");
  const [qrExpiresAt, setQrExpiresAt] = useState(null);
  const [qrError, setQrError] = useState("");
  const [qrRetryKey, setQrRetryKey] = useState(0);
  const [dataRetryKey, setDataRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      getSections({ limit: 100 }),
      getAttendanceSessions({ status: "ACTIVE", limit: 100 }),
    ])
      .then(([sectionResult, sessionResult]) => {
        if (!active) return;
        const failures = [];

        if (sectionResult.status === "fulfilled") {
          setSections(sectionResult.value.data?.data || []);
        } else {
          failures.push("assigned sections");
        }

        if (sessionResult.status === "fulfilled") {
          const sessions = sessionResult.value.data?.data || [];
          setActiveSessions(sessions);
          if (routeSessionId) {
            const existing = sessions.find((item) => item.sessionId === routeSessionId);
            if (existing) {
              setSession(existing);
            } else if (routeSession?.sessionId !== routeSessionId) {
              setMessage(
                "This session is no longer active or is not assigned to your account. Return to Attendance to select an active session.",
              );
            }
          }
        } else {
          failures.push("active sessions");
        }

        if (failures.length) {
          setMessage(
            `Could not load ${failures.join(" and ")}. You can retry below; an already-created session can still request its QR.`,
          );
        }
      })
      .finally(() => {
        if (active) setPageLoading(false);
      });
    return () => {
      active = false;
    };
  }, [routeSessionId, routeSession, dataRetryKey]);

  useEffect(() => {
    if (!session?.sessionId) return undefined;
    let stopped = false;
    let timer;

    const refresh = async () => {
      try {
        const response = await getAttendanceQr(session.sessionId);
        if (stopped) return;
        const payload = response.data?.data || {};
        const token = payload.token;
        if (typeof token !== "string" || token.length < 20) {
          throw new Error("The server did not return a valid attendance QR challenge.");
        }
        const image = await QRCode.toDataURL(token, {
          width: 300,
          margin: 2,
          errorCorrectionLevel: "M",
        });
        if (stopped) return;
        setQrImage(image);
        setQrExpiresAt(payload.expiresAt || null);
        setQrStatus("ready");
        setQrError("");
        timer = window.setTimeout(
          refresh,
          Math.max(500, Number(payload.refreshMs) || 1000),
        );
      } catch (error) {
        if (stopped) return;
        // Never show the last issued code when its freshness is uncertain.
        setQrImage("");
        setQrExpiresAt(null);
        setQrError(getApiErrorMessage(error, "Could not refresh the attendance QR."));
        const status = error?.response?.status;
        const terminal = [400, 401, 403, 404, 409, 410, 422].includes(status);
        setQrStatus(terminal ? "unavailable" : "retrying");
        const retryAfterSeconds = Number(error?.response?.headers?.["retry-after"]);
        const retryDelay = status === 429 && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(15000, Math.max(2000, retryAfterSeconds * 1000))
          : 2000;
        if (!terminal) timer = window.setTimeout(refresh, retryDelay);
      }
    };

    void refresh();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [session?.sessionId, qrRetryKey]);

  const startSession = async (event) => {
    event.preventDefault();
    if (loading || pageLoading || !sectionId.trim()) return;
    setLoading(true);
    setMessage("");
    setQrImage("");
    setQrExpiresAt(null);
    setQrError("");
    setQrStatus("loading");
    try {
      const response = await startAttendanceSession(sectionId.trim());
      const createdSession = response.data?.data;
      if (!createdSession?.sessionId) {
        throw new Error("The server did not return a session ID. Refresh the page and check active sessions before trying again.");
      }
      setSession(createdSession);
      setActiveSessions((current) => [
        createdSession,
        ...current.filter((item) => item.sessionId !== createdSession.sessionId),
      ]);
      const notice = "Attendance session started. The page is requesting the current server-issued QR.";
      setMessage(notice);
      navigate(`/lecturer/sessions/${createdSession.sessionId}/live`, {
        replace: true,
        state: { activeSession: createdSession, notice },
      });
    } catch (error) {
      setMessage(
        getApiErrorMessage(
          error,
          "Could not start the session. Check the section ID and your assignment.",
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  const retryQr = () => {
    setQrImage("");
    setQrExpiresAt(null);
    setQrError("");
    setQrStatus("loading");
    setQrRetryKey((value) => value + 1);
  };

  const endSession = async () => {
    if (!session?.sessionId || loading) return;
    if (!window.confirm("End this attendance session? Students will no longer be able to check in.")) return;
    setLoading(true);
    try {
      await endAttendanceSession(session.sessionId);
      setSession(null);
      setQrStatus("loading");
      setQrError("");
      setQrExpiresAt(null);
      setActiveSessions((current) =>
        current.filter((item) => item.sessionId !== session.sessionId),
      );
      setQrImage("");
      navigate("/lecturer/sessions/new", { replace: true });
      setMessage("Attendance session ended.");
    } catch (error) {
      setMessage(getApiErrorMessage(error, "Could not end the session."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="academic-page">
      <WorkspaceHeader />
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
        {pageLoading && <p className="academic-empty" role="status">Loading your assigned sections and sessions…</p>}
        {!session && !routeSessionId ? (
          <form
            className="academic-card academic-lookup"
            onSubmit={startSession}
          >
            <label className="academic-field">
              <span>Assigned section</span>
              <select
                value={sectionId}
                onChange={(event) => setSectionId(event.target.value)}
                disabled={pageLoading || loading || sections.length === 0}
                required
              >
                <option value="">Choose a section</option>
                {sections.map((section) => (
                  <option key={section._id} value={section._id}>
                    {section.courseId?.code} · {section.name} ·{" "}
                    {section.academicYear}
                  </option>
                ))}
              </select>
            </label>
            <button className="academic-button" disabled={loading || pageLoading || sections.length === 0}>
              {loading ? "Starting…" : "Start attendance"}
            </button>
          </form>
        ) : (
          <section className="academic-card lecturer-live-card">
            <div>
              <p className="academic-eyebrow">{qrStatus === "ready" ? "SESSION ACTIVE · QR LIVE" : qrStatus === "unavailable" ? "SESSION QR UNAVAILABLE" : "SESSION ACTIVE · QR REFRESHING"}</p>
              <h2>
                {session.courseCode} · Section {session.section}
              </h2>
              <p>Eligible students: {session.eligibleStudentCount}</p>
            </div>
            {qrImage ? (
              <img
                className="lecturer-live-qr"
                src={qrImage}
                alt="Server-issued rotating attendance QR code"
              />
            ) : (
              <div className="lecturer-qr-loading" role="status">
                {qrStatus === "unavailable" ? "QR unavailable — do not use an old code" : qrStatus === "retrying" ? "QR refresh failed. Retrying…" : "Generating server-issued QR…"}
              </div>
            )}
            {qrError && <p className="academic-notice error" role="alert">{qrError}</p>}
            {!qrImage && qrStatus === "unavailable" && (
              <div className="lecturer-qr-recovery" role="group" aria-label="QR recovery actions">
                <button className="academic-button" type="button" onClick={retryQr} disabled={loading}>
                  Retry QR request
                </button>
                <Link className="academic-button secondary" to="/lecturer/sessions/new">
                  Return to attendance
                </Link>
              </div>
            )}
            {qrExpiresAt && Number.isFinite(new Date(qrExpiresAt).getTime()) && (
              <p className="academic-footnote">Current challenge expires {new Date(qrExpiresAt).toLocaleTimeString()}.</p>
            )}
            {session.expiresAt && Number.isFinite(new Date(session.expiresAt).getTime()) && (
              <p className="academic-footnote">Session expires {new Date(session.expiresAt).toLocaleString()}.</p>
            )}
            <p className="academic-footnote">
              The QR challenge is issued by the server and refreshed automatically.
              If refresh fails, the previous code is hidden until a fresh challenge is obtained.
            </p>
            <Link
              className="academic-button"
              to={`/lecturer/sessions/${session.sessionId}/attendance`}
            >
              View attendance results
            </Link>
            <button
              className="academic-button lecturer-end-button"
              onClick={endSession}
              disabled={loading}
            >
              {loading ? "Ending…" : "End session"}
            </button>
          </section>
        )}
        {!session && !pageLoading && !sections.length && !message && (
          <div className="academic-card">
            <p className="academic-empty">
              No assigned active sections were returned. If this was a temporary load failure, retry; otherwise ask an administrator to verify your section assignment.
            </p>
            <button
              className="academic-button secondary"
              type="button"
              onClick={() => {
                setMessage("");
                setPageLoading(true);
                setDataRetryKey((value) => value + 1);
              }}
              disabled={loading}
            >
              Retry loading sections
            </button>
          </div>
        )}
        {!session && routeSessionId && !pageLoading && (
          <section className="academic-card" aria-live="polite">
            <h2>Recover live attendance session</h2>
            <p className="academic-empty">
              {message || "The active session details could not be restored yet. Retry loading sessions before starting another one."}
            </p>
            <div className="lecturer-qr-recovery">
              <button
                className="academic-button"
                type="button"
                onClick={() => {
                  setMessage("");
                  setPageLoading(true);
                  setDataRetryKey((value) => value + 1);
                }}
                disabled={loading}
              >
                Retry loading session
              </button>
              <Link className="academic-button secondary" to="/lecturer/sessions/new">
                Return to attendance
              </Link>
            </div>
          </section>
        )}
        {!session && !routeSessionId && !pageLoading && message.startsWith("Could not load ") && (
          <section className="academic-card" aria-live="polite">
            <p className="academic-empty">The attendance setup could not load all required lists.</p>
            <button
              className="academic-button secondary"
              type="button"
              onClick={() => {
                setMessage("");
                setPageLoading(true);
                setDataRetryKey((value) => value + 1);
              }}
              disabled={loading}
            >
              Retry loading attendance setup
            </button>
          </section>
        )}
        {!session && activeSessions.length > 0 && (
          <section className="academic-card">
            <h2>Active sessions</h2>
            {activeSessions.map((activeSession) => (
              <p key={activeSession.sessionId}>
                {activeSession.courseCode} · Section {activeSession.section} —{" "}
                <Link to={`/lecturer/sessions/${activeSession.sessionId}/live`}>
                  Resume live QR
                </Link>
              </p>
            ))}
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
