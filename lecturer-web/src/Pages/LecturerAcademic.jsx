import { useState } from "react";
import { Link } from "react-router-dom";
import { getSectionStudents } from "../services/academic.service";
import "../Styles/Academic.css";

function LecturerAcademic() {
  const [sectionId, setSectionId] = useState("");
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const loadStudents = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    setLoaded(false);
    try {
      const response = await getSectionStudents(sectionId.trim());
      setStudents(response.data?.data || []);
      setLoaded(true);
    } catch (requestError) {
      setError(
        requestError.response?.data?.error?.message ||
          requestError.response?.data?.message ||
          "Could not load this section. Check the ID and your Lecturer access.",
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
            <p className="academic-eyebrow">MY CLASSES</p>
            <h1>Section roster</h1>
            <p>Look up active students enrolled in a class section.</p>
          </div>
          <span className="academic-role">Lecturer</span>
        </div>
        <form className="academic-card academic-lookup" onSubmit={loadStudents}>
          <label className="academic-field">
            <span>Section ID</span>
            <input
              value={sectionId}
              onChange={(event) => setSectionId(event.target.value)}
              placeholder="Paste the section ID"
              required
            />
          </label>
          <button className="academic-button" disabled={loading}>
            {loading ? "Loading roster…" : "Load roster"}
          </button>
        </form>
        {error && (
          <div className="academic-notice error" role="alert">
            {error}
          </div>
        )}
        {loaded && (
          <section className="academic-card academic-roster">
            <div className="academic-roster-heading">
              <div>
                <h2>Enrolled students</h2>
                <p>
                  {students.length} active{" "}
                  {students.length === 1 ? "student" : "students"}
                </p>
              </div>
            </div>
            {students.length ? (
              <div className="academic-table-wrap">
                <table className="academic-table">
                  <thead>
                    <tr>
                      <th>Roll number</th>
                      <th>Student</th>
                      <th>Email</th>
                      <th>Enrollment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {students.map((row) => (
                      <tr key={row._id}>
                        <td>
                          {row.rollNumber || row.studentId?.RollNumber || "—"}
                        </td>
                        <td>
                          {row.studentId?.Name || row.studentId?.name || "—"}
                        </td>
                        <td>{row.studentId?.email || "—"}</td>
                        <td>
                          <span className="academic-status">
                            {row.status || "ACTIVE"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="academic-empty">
                No active students are enrolled in this section yet.
              </p>
            )}
          </section>
        )}
        <p className="academic-footnote">
          Ask your Admin for the section ID. The current academic API does not
          include a “my sections” listing endpoint.
        </p>
      </section>
    </main>
  );
}

export default LecturerAcademic;
