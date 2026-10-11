import { Routes, Route, Navigate } from "react-router-dom";

import Dashboard from "./Pages/dashboard";
import AdminAcademic from "./Pages/AdminAcademic";
import LecturerAcademic from "./Pages/LecturerAcademic";
import LecturerAttendance from "./Pages/LecturerAttendance";
import StudentAcademic from "./Pages/StudentAcademic";

import Login from "./Pages/Login";
import Signup from "./Pages/Signup";
import ForgotPassword from "./Pages/ForgotPassword";

function RoleRoute({ roles, children }) {
  const token = localStorage.getItem("token");
  const role = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "{}").role || ""; }
    catch { return ""; }
  })();
  if (!token) return <Navigate to="/login" replace />;
  if (!roles.includes(role)) {
    const routeByRole = { Admin: "/admin/academic", Lecturer: "/dashboard", Student: "/student/academic" };
    return <Navigate to={routeByRole[role] || "/login"} replace />;
  }
  return children;
}

function App() {
  return (
    <Routes>

      <Route
        path="/login"
        element={<Login />}
      />

      <Route
        path="/signup"
        element={<Signup />}
      />

      <Route
        path="/forgot-password"
        element={<ForgotPassword />}
      />

      {/* Lecturer */}
      <Route
        path="/dashboard"
        element={<RoleRoute roles={["Lecturer"]}><Dashboard /></RoleRoute>}
      />

      <Route path="/admin/academic" element={<RoleRoute roles={["Admin"]}><AdminAcademic /></RoleRoute>} />
      <Route path="/lecturer/academic" element={<RoleRoute roles={["Lecturer"]}><LecturerAcademic /></RoleRoute>} />
      <Route path="/lecturer/attendance" element={<RoleRoute roles={["Lecturer"]}><LecturerAttendance /></RoleRoute>} />
      <Route path="/student/academic" element={<RoleRoute roles={["Student"]}><StudentAcademic /></RoleRoute>} />

      {/* Unknown URL */}
      <Route
        path="*"
        element={<Navigate to="/login" />}
      />

    </Routes>
  );
}

export default App;
