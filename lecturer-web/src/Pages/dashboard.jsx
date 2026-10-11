import { Link } from "react-router-dom";

function Dashboard() {
  return (
    <main className="academic-page">
      <header className="academic-topbar"><strong>Attendance System</strong><span>Lecturer workspace</span></header>
      <section className="academic-welcome">
        <p className="academic-eyebrow">LECTURER</p>
        <h1>Academic workspace</h1>
        <p>Start a class check-in or view students enrolled in a section.</p>
        <div className="lecturer-dashboard-actions"><Link className="academic-primary-link" to="/lecturer/attendance">Start attendance</Link><Link className="academic-secondary-link" to="/lecturer/academic">View class roster</Link></div>
      </section>
    </main>
  );
}

export default Dashboard;
