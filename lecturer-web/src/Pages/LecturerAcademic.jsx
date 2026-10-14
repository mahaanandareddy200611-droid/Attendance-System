import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getSectionStudents, getSections } from "../services/academic.service";
import { getApiErrorMessage } from "../api/errors";
import "../Styles/Academic.css";
import WorkspaceHeader from "../components/WorkspaceHeader";

function LecturerAcademic() {
  const { sectionId: routeSectionId } = useParams();
  const [sectionId, setSectionId] = useState("");
  const selectedSectionId = routeSectionId || sectionId;
  const [sections, setSections] = useState([]);
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getSections({ limit: 100 })
      .then((response) => setSections(response.data.data || []))
      .catch((error) =>
        setError(
          getApiErrorMessage(error, "Could not load assigned sections."),
        ),
      );
  }, []);

  const loadStudents = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    setLoaded(false);
    try {
      const response = await getSectionStudents(selectedSectionId.trim());
      setStudents(response.data?.data || []);
      setLoaded(true);
    } catch (requestError) {
      setError(
        getApiErrorMessage(
          requestError,
          "Could not load this assigned section.",
        ),
      );
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
            <p className="academic-eyebrow">MY CLASSES</p>
            <h1>Section roster</h1>
            <p>View rosters for sections assigned to your Lecturer account.</p>
          </div>
          <span className="academic-role">Lecturer</span>
        </div>
        <form className="academic-card academic-lookup" onSubmit={loadStudents}>
          <label className="academic-field">
            <span>Assigned section</span>
            <select
              value={selectedSectionId}
              onChange={(event) => setSectionId(event.target.value)}
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
          The server limits this roster endpoint to your assigned sections.
        </p>
      </section>
    </main>
  );
}

export default LecturerAcademic;
