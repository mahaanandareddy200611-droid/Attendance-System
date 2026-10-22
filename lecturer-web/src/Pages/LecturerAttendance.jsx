import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Link, useParams, useNavigate } from "react-router-dom";
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
  const [sectionId, setSectionId] = useState("");
  const [sections, setSections] = useState([]);
  const [activeSessions, setActiveSessions] = useState([]);
  const [session, setSession] = useState(null);
  const [qrImage, setQrImage] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [pageLoading, setPageLoading] = useState(true);
  const [qrStatus, setQrStatus] = useState("loading");
  const [qrExpiresAt, setQrExpiresAt] = useState(null);
  const [qrError, setQrError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      getSections({ limit: 100 }),
      getAttendanceSessions({ status: "ACTIVE", limit: 100 }),
    ])
      .then(([sectionResponse, sessionResponse]) => {
        if (!active) return;
        setSections(sectionResponse.data.data || []);
        const sessions = sessionResponse.data.data || [];
        setActiveSessions(sessions);
        if (routeSessionId) {
          const existing = sessions.find(
            (item) => item.sessionId === routeSessionId,
          );
          if (existing) setSession(existing);
          else
            setMessage(
              "This session is no longer active or is not assigned to your account.",
            );
        }
      })
      .catch((error) => {
        if (active)
          setMessage(
            getApiErrorMessage(error, "Could not load your assigned sessions."),
          );
      })
      .finally(() => {
        if (active) setPageLoading(false);
      });
    return () => {
      active = false;
    };
  }, [routeSessionId]);

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
        const terminal = [401, 403, 404, 409].includes(error?.response?.status);
        setQrStatus(terminal ? "unavailable" : "retrying");
        if (!terminal) timer = window.setTimeout(refresh, 2000);
      }
    };

    void refresh();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [session?.sessionId]);

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
      setSession(response.data.data);
      setActiveSessions((current) => [response.data.data, ...current]);
      navigate(`/lecturer/sessions/${response.data.data.sessionId}/live`, {
        replace: true,
      });
      setMessage(
        "Attendance session started. Students can scan the rotating QR.",
      );
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
        {!session ? (
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
        {!session && !pageLoading && !sections.length && (
          <p className="academic-empty">No assigned active sections were returned by the server. Ask an administrator to verify your section assignment.</p>
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
