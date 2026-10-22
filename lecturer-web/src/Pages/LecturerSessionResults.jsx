import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getSessionAttendance } from "../services/attendance-lecturer.service";
import {
  deleteSessionEvidence,
  getSessionEvidenceUrl,
  listSessionEvidence,
  uploadSessionEvidence,
} from "../services/media.service";
import { getApiErrorMessage } from "../api/errors";
import "../Styles/Academic.css";
import WorkspaceHeader from "../components/WorkspaceHeader";
import { createCsv, downloadCsv } from "../utils/csv.js";

const emptyResult = { session: null, data: [], pagination: null };

export default function LecturerSessionResults() {
  const { sessionId } = useParams();
  const [result, setResult] = useState(emptyResult);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState([]);
  const [evidenceFile, setEvidenceFile] = useState(null);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [evidenceNotice, setEvidenceNotice] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);

  const load = () => {
    setBusy(true);
    setError("");
    setRefreshVersion((value) => value + 1);
  };

  useEffect(() => {
    let active = true;
    let timer;
    let controller;
    let inFlight = false;

    const refresh = async () => {
      if (!active || inFlight) return;
      setBusy(true);
      setError("");
      inFlight = true;
      controller = new AbortController();
      try {
        const response = await getSessionAttendance(
          sessionId,
          { q: query, page, limit: 50 },
          { signal: controller.signal },
        );
        if (!active) return;
        setResult({
          session: response.data?.session || null,
          data: Array.isArray(response.data?.data) ? response.data.data : [],
          pagination: response.data?.pagination || null,
        });
        setError("");
      } catch (requestError) {
        if (active && !controller.signal.aborted) {
          setError(getApiErrorMessage(requestError, "Could not load or refresh this session roster."));
        }
      } finally {
        inFlight = false;
        if (active) {
          setBusy(false);
          // Schedule after completion to prevent overlapping polls.
          timer = window.setTimeout(refresh, 5000);
        }
      }
    };

    timer = window.setTimeout(refresh, query ? 250 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (controller) controller.abort();
    };
  }, [sessionId, query, page, refreshVersion]);

  const loadEvidence = async () => {
    try {
      const response = await listSessionEvidence(sessionId);
      setEvidence(response.data.data || []);
    } catch (requestError) {
      setEvidenceNotice(
        getApiErrorMessage(requestError, "Could not load private evidence."),
      );
    }
  };

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await listSessionEvidence(sessionId);
        if (active) setEvidence(response.data.data || []);
      } catch (requestError) {
        if (active) {
          setEvidenceNotice(
            getApiErrorMessage(requestError, "Could not load private evidence."),
          );
        }
      }
    };
    void refresh();
    return () => {
      active = false;
    };
  }, [sessionId]);


  const submitEvidence = async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!evidenceFile) return;
    setEvidenceBusy(true);
    setEvidenceNotice("");
    try {
      await uploadSessionEvidence(sessionId, evidenceFile);
      setEvidenceFile(null);
      formElement.reset();
      await loadEvidence();
      setEvidenceNotice("Evidence uploaded to private storage.");
    } catch (requestError) {
      setEvidenceNotice(
        getApiErrorMessage(requestError, "Evidence upload failed."),
      );
    } finally {
      setEvidenceBusy(false);
    }
  };

  const openEvidence = async (assetId) => {
    setEvidenceBusy(true);
    setEvidenceNotice("");
    let popup = null;
    try {
      // Open synchronously in the click handler; opening after await can be blocked.
      popup = window.open("about:blank", "_blank");
      if (popup) popup.opener = null;
      if (!popup) throw new Error("Your browser blocked the evidence tab. Allow pop-ups and try again.");
      const response = await getSessionEvidenceUrl(assetId);
      const url = new URL(response.data?.data?.url || "");
      if (url.protocol !== "https:") throw new Error("The server returned an unsafe evidence link.");
      popup.location.replace(url.href);
    } catch (requestError) {
      if (popup && !popup.closed) popup.close();
      setEvidenceNotice(getApiErrorMessage(requestError, "Could not open private evidence."));
    } finally {
      setEvidenceBusy(false);
    }
  };

  const removeEvidence = async (assetId) => {
    if (!window.confirm("Delete this retained evidence image? This cannot be undone.")) return;
    setEvidenceBusy(true);
    setEvidenceNotice("");
    try {
      await deleteSessionEvidence(assetId);
      await loadEvidence();
      setEvidenceNotice("Evidence deleted from private storage.");
    } catch (requestError) {
      setEvidenceNotice(
        getApiErrorMessage(requestError, "Evidence deletion failed."),
      );
    } finally {
      setEvidenceBusy(false);
    }
  };

  const exportCsv = () => {
    const headers = ["Roll number", "Student", "Email", "Attendance", "Marked at"];
    const rows = result.data.map((row) => [
      row.rollNumber,
      row.studentId?.Name,
      row.studentId?.email,
      row.status || "Unknown",
      row.attendance?.markedAt ? new Date(row.attendance.markedAt).toISOString() : "",
    ]);
    downloadCsv("attendance-" + sessionId + ".csv", createCsv(headers, rows));
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
              Export current page
          </button>
        </div>

        <section className="academic-card" aria-busy={busy}>
          {busy && <p className="academic-empty" role="status">Loading attendance results…</p>}
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
                    <td>{row.rollNumber || "—"}</td>
                    <td>{row.studentId?.Name || "—"}</td>
                    <td>{row.studentId?.email || "—"}</td>
                    <td>
                      <span
                        className={"attendance-state " + String(row.status || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "")}
                      >
                        {row.status || "Unknown"}
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

        <section className="academic-card">
          <div className="academic-card-title">
            <span className="academic-step">FILES</span>
            <div>
              <h2>Private session evidence</h2>
              <p>
                Evidence files are stored outside the database. Download links
                expire quickly, and retained files are deleted after the configured retention period.
              </p>
            </div>
          </div>
          {evidenceNotice && (
            <p className="academic-notice" role="status">{evidenceNotice}</p>
          )}
          <form className="media-upload-form" onSubmit={submitEvidence}>
            <label className="academic-field">
              <span>Upload a JPEG/PNG/WebP evidence image (max 1 MB before normalization)</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => setEvidenceFile(event.target.files?.[0] || null)}
              />
            </label>
            <button
              type="submit"
              className="academic-button"
              disabled={!evidenceFile || evidenceBusy}
            >
              {evidenceBusy ? "Working…" : "Upload privately"}
            </button>
          </form>
          {evidence.length ? (
            <div className="media-evidence-list">
              {evidence.map((asset) => (
                <article className="student-section-item" key={asset.id}>
                  <strong>
                    {asset.contentType} · {Math.ceil(asset.sizeBytes / 1024)} KB
                  </strong>
                  <span>
                    Added {new Date(asset.createdAt).toLocaleString()} ·
                    Retained until {new Date(asset.retentionUntil).toLocaleDateString()}
                  </span>
                  <div className="media-evidence-actions">
                    <button
                      type="button"
                      className="academic-button secondary"
                      disabled={evidenceBusy}
                      onClick={() => openEvidence(asset.id)}
                    >
                      Open temporarily
                    </button>
                    <button
                      type="button"
                      className="academic-button secondary"
                      disabled={evidenceBusy}
                      onClick={() => removeEvidence(asset.id)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="academic-empty">No retained evidence files for this session.</p>
          )}
        </section>
      </section>
    </main>
  );
}
