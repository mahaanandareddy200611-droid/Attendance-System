import { Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import WorkspaceHeader from "../components/WorkspaceHeader";

export default function Dashboard() {
  const { user } = useAuth();
  const firstName = user?.name?.trim().split(/\s+/)[0] || "Lecturer";

  return (
    <main className="academic-page">
      <WorkspaceHeader />
      <section className="academic-content">
        <div className="academic-heading lecturer-welcome-heading">
          <div>
            <p className="academic-eyebrow">LECTURER WORKSPACE</p>
            <h1>Welcome, {firstName}</h1>
            <p>
              Manage your assigned classes and run attendance for today’s
              sessions.
            </p>
          </div>
          <span className="academic-role">Lecturer</span>
        </div>

        <section className="lecturer-hero-card">
          <div className="lecturer-hero-copy">
            <span className="lecturer-hero-icon" aria-hidden="true">
              ✓
            </span>
            <div>
              <p className="academic-eyebrow">CLASS CHECK-IN</p>
              <h2>Start a live attendance session</h2>
              <p>
                Select one of your assigned sections. A rotating QR code will be
                ready for students to scan.
              </p>
            </div>
          </div>
          <Link className="academic-button" to="/lecturer/sessions/new">
            Start attendance
          </Link>
        </section>

        <div className="lecturer-action-grid">
          <Link className="lecturer-action-card" to="/lecturer/sections">
            <span className="lecturer-action-icon">01</span>
            <span className="lecturer-action-title">View my sections</span>
            <span className="lecturer-action-description">
              Open an assigned class roster and review enrolled students.
            </span>
            <span className="lecturer-action-link">
              Browse sections <span aria-hidden="true">→</span>
            </span>
          </Link>
          <Link className="lecturer-action-card" to="/lecturer/reports">
            <span className="lecturer-action-icon">02</span>
            <span className="lecturer-action-title">Attendance reports</span>
            <span className="lecturer-action-description">
              Filter records from sessions you own and export the current page.
            </span>
            <span className="lecturer-action-link">
              Open reports <span aria-hidden="true">→</span>
            </span>
          </Link>
        </div>

        <p className="academic-footnote">
          The server restricts class rosters, sessions, and reports to sections
          assigned to your Lecturer account.
        </p>
      </section>
    </main>
  );
}
