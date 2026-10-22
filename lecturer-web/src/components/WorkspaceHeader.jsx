import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../auth/useAuth";

const linksByRole = {
  Admin: [
    ["Overview", "/admin/dashboard"],
    ["Courses", "/admin/courses"],
    ["Sections", "/admin/sections"],
    ["Enrollments", "/admin/enrollments"],
    ["Lecturers", "/admin/users"],
    ["Reports", "/admin/reports"],
  ],
  Lecturer: [
    ["Dashboard", "/lecturer/dashboard"],
    ["My sections", "/lecturer/sections"],
    ["Attendance", "/lecturer/sessions/new"],
    ["Reports", "/lecturer/reports"],
  ],
  Student: [["My classes", "/student/dashboard"]],
};

const homeByRole = {
  Admin: "/admin/dashboard",
  Lecturer: "/lecturer/dashboard",
  Student: "/student/dashboard",
};

export default function WorkspaceHeader() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [signingOut, setSigningOut] = useState(false);
  const role = user?.role;

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <header className="academic-topbar">
      <Link to={homeByRole[role] || "/login"} className="academic-brand">
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        <span className="brand-name">
          Attend<span>ance</span>
        </span>
      </Link>

      <nav
        className="workspace-navigation"
        aria-label={`${role || "User"} navigation`}
      >
        {(linksByRole[role] || []).map(([label, path]) => (
          <NavLink
            key={path}
            to={path}
            end={path.endsWith("dashboard")}
            className={({ isActive }) => {
              const inAttendanceSession =
                path === "/lecturer/sessions/new" &&
                pathname.startsWith("/lecturer/sessions/");
              return isActive || inAttendanceSession
                ? "workspace-link active"
                : "workspace-link";
            }}
          >
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="workspace-account">
        <div className="workspace-user-copy">
          <span className="workspace-user-name">{user?.name || role}</span>
          <span className="workspace-user-role">{role}</span>
        </div>
        <button className="workspace-signout" type="button" onClick={handleSignOut} disabled={signingOut}>
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </header>
  );
}
