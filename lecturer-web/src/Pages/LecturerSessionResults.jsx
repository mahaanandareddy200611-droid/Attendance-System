import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getSessionAttendance } from "../services/attendance-lecturer.service";
import { getApiErrorMessage } from "../api/errors";
import "../Styles/Academic.css";
import WorkspaceHeader from "../components/WorkspaceHeader";

const emptyResult = { session: null, data: [], pagination: null };

export default function LecturerSessionResults() {
  const { sessionId } = useParams();
  const [result, setResult] = useState(emptyResult);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await getSessionAttendance(sessionId, {
        q: query,
        page,
        limit: 50,
      });
      setResult({
        session: response.data.session,
        data: response.data.data || [],
        pagination: response.data.pagination,
      });
    } catch (requestError) {
      setError(
        getApiErrorMessage(requestError, "Could not load this session roster."),
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(
      () => {
        getSessionAttendance(sessionId, { q: query, page, limit: 50 })
          .then((response) => {
            if (!active) return;
            setResult({
              session: response.data.session,
              data: response.data.data || [],
              pagination: response.data.pagination,
            });
          })
          .catch((requestError) => {
            if (active)
              setError(
                getApiErrorMessage(
                  requestError,
                  "Could not load this session roster.",
                ),
              );
          })
          .finally(() => {
            if (active) setBusy(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [sessionId, query, page]);

  const exportCsv = () => {
    const headers = [
      "Roll number",
      "Student",
      "Email",
      "Attendance",
      "Marked at",
    ];
    const rows = result.data.map((row) => [
      row.rollNumber,
      row.studentId?.Name,
      row.studentId?.email,
      row.status,
      row.attendance?.markedAt
        ? new Date(row.attendance.markedAt).toISOString()
        : "",
    ]);
    const csv = [headers, ...rows]
      .map((row) =>
        row
          .map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `attendance-${sessionId}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const pagination = result.pagination;

  return (
    <main className="academic-page">
      <WorkspaceHeader />
      <section className="academic-content">
        <div className="academic-heading">
          <div>
            <p className="academic-eyebrow">SESSION RESULTS</p>
            <h1>
              {result.session
                ? `${result.session.courseCode} · Section ${result.session.section}`
                : "Attendance roster"}
            </h1>
            <p>
              Server-confirmed attendance states for the students registered
              when the session opened.
            </p>
          </div>
          <span className="academic-role">Lecturer</span>
        </div>

        {error && (
          <p className="academic-notice error" role="alert">
            {error}
          </p>
        )}

        <div className="academic-card report-toolbar">
          <label className="academic-field">
            <span>Find a student</span>
            <input
              value={query}
              onChange={(event) => {
                setBusy(true);
                setError("");
                setPage(1);
                setQuery(event.target.value);
              }}
              placeholder="Name, email, or roll number"
            />
          </label>
          <button
            className="academic-button"
            type="button"
            onClick={load}
            disabled={busy}
          >
            {busy ? "Loading…" : "Refresh"}
          </button>
          <button
            className="academic-button secondary"
            type="button"
            onClick={exportCsv}
            disabled={!result.data.length}
          >
            Export CSV
          </button>
        </div>

        <section className="academic-card">
          <div className="academic-table-wrap">
            <table className="academic-table">
              <thead>
                <tr>
                  <th>Roll number</th>
                  <th>Student</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Marked at</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((row) => (
                  <tr key={row._id}>
                    <td>{row.rollNumber}</td>
                    <td>{row.studentId?.Name || "—"}</td>
                    <td>{row.studentId?.email || "—"}</td>
                    <td>
                      <span
                        className={`attendance-state ${String(row.status).toLowerCase()}`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td>
                      {row.attendance?.markedAt
                        ? new Date(row.attendance.markedAt).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!busy && !result.data.length && (
            <p className="academic-empty">
              No enrolled students match this filter.
            </p>
          )}
          <div className="report-pagination">
            <button
              className="academic-button secondary"
              type="button"
              disabled={page <= 1 || busy}
              onClick={() => {
                setBusy(true);
                setPage((value) => value - 1);
              }}
            >
              Previous
            </button>
            <span>
              Page {pagination?.page || page} of{" "}
              {Math.max(pagination?.pages || 1, 1)}
            </span>
            <button
              className="academic-button secondary"
              type="button"
              disabled={page >= (pagination?.pages || 1) || busy}
              onClick={() => {
                setBusy(true);
                setPage((value) => value + 1);
              }}
            >
              Next
            </button>
          </div>
        </section>
      </section>
    </main>
  );
}
