import { useEffect, useState } from "react";
import { getAttendanceReport } from "../services/attendance-lecturer.service";
import { getApiErrorMessage } from "../api/errors";
import { useAuth } from "../auth/useAuth";
import "../Styles/Academic.css";
import WorkspaceHeader from "../components/WorkspaceHeader";

const emptyFilters = { from: "", to: "", courseCode: "", section: "" };

export default function AttendanceReports() {
  const { user } = useAuth();
  const [filters, setFilters] = useState(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState(emptyFilters);
  const [records, setRecords] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let active = true;
    getAttendanceReport({ ...appliedFilters, page, limit: 50 })
      .then((response) => {
        if (!active) return;
        setRecords(response.data.data || []);
        setPagination(response.data.pagination);
      })
      .catch((requestError) => {
        if (active)
          setError(
            getApiErrorMessage(
              requestError,
              "Could not load attendance records.",
            ),
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [appliedFilters, page]);

  const exportCsv = () => {
    const rows = [
      ["Course", "Section", "Student", "Roll number", "Marked at"],
      ...records.map((record) => [
        record.courseCode,
        record.section,
        record.studentId?.Name,
        record.studentId?.RollNumber,
        record.markedAt ? new Date(record.markedAt).toISOString() : "",
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "attendance-report.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const admin = user?.role === "Admin";
  const updateFilter = (field, value) => {
    setFilters((current) => ({ ...current, [field]: value }));
  };

  return (
    <main className="academic-page">
      <WorkspaceHeader />
      <section className="academic-content">
        <div className="academic-heading">
          <div>
            <p className="academic-eyebrow">ATTENDANCE REPORTS</p>
            <h1>
              {admin ? "Institution attendance" : "My section attendance"}
            </h1>
            <p>
              Filters run on the server. Lecturer reports include only sessions
              you own.
            </p>
          </div>
          <span className="academic-role">{user?.role}</span>
        </div>

        {error && (
          <p className="academic-notice error" role="alert">
            {error}
          </p>
        )}

        <form
          className="academic-card report-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            setPage(1);
            setAppliedFilters(filters);
          }}
        >
          <label className="academic-field">
            <span>From date</span>
            <input
              type="date"
              value={filters.from}
              onChange={(event) => updateFilter("from", event.target.value)}
            />
          </label>
          <label className="academic-field">
            <span>Through date</span>
            <input
              type="date"
              value={filters.to}
              onChange={(event) => updateFilter("to", event.target.value)}
            />
          </label>
          <label className="academic-field">
            <span>Course code</span>
            <input
              value={filters.courseCode}
              onChange={(event) =>
                updateFilter("courseCode", event.target.value)
              }
              placeholder="CS101"
            />
          </label>
          <label className="academic-field">
            <span>Section name</span>
            <input
              value={filters.section}
              onChange={(event) => updateFilter("section", event.target.value)}
              placeholder="A"
            />
          </label>
          <button className="academic-button" type="submit" disabled={busy}>
            {busy ? "Loading…" : "Apply filters"}
          </button>
          <button
            className="academic-button secondary"
            type="button"
            disabled={!records.length}
            onClick={exportCsv}
          >
            Export current page
          </button>
        </form>

        <section className="academic-card">
          <div className="academic-table-wrap">
            <table className="academic-table">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Section</th>
                  <th>Student</th>
                  <th>Roll number</th>
                  <th>Marked at</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record._id}>
                    <td>{record.courseCode}</td>
                    <td>{record.section}</td>
                    <td>{record.studentId?.Name || "—"}</td>
                    <td>{record.studentId?.RollNumber || "—"}</td>
                    <td>
                      {record.markedAt
                        ? new Date(record.markedAt).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!busy && !records.length && (
            <p className="academic-empty">
              No attendance records match these filters.
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
              {pagination?.total || 0} records · Page {pagination?.page || page}{" "}
              of {Math.max(pagination?.pages || 1, 1)}
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
