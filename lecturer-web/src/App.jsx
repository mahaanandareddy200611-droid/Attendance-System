import { Routes, Route, Navigate } from "react-router-dom";

import Dashboard from "./Pages/dashboard";
import AdminAcademic from "./Pages/AdminAcademic";
import LecturerAcademic from "./Pages/LecturerAcademic";
import LecturerAttendance from "./Pages/LecturerAttendance";
import StudentAcademic from "./Pages/StudentAcademic";

import Login from "./Pages/Login";
import Signup from "./Pages/Signup";
import ForgotPassword from "./Pages/ForgotPassword";
import { AuthProvider } from "./auth/AuthProvider";
import ProtectedRoute from "./auth/ProtectedRoute";

function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route path="/signup" element={<Signup />} />

        <Route path="/forgot-password" element={<ForgotPassword />} />

        {/* Lecturer */}
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute roles={["Lecturer"]}>
              <Dashboard />
            </ProtectedRoute>
          }
        />

        <Route
          path="/admin/academic"
          element={
            <ProtectedRoute roles={["Admin"]}>
              <AdminAcademic />
            </ProtectedRoute>
          }
        />
        <Route
          path="/lecturer/academic"
          element={
            <ProtectedRoute roles={["Lecturer"]}>
              <LecturerAcademic />
            </ProtectedRoute>
          }
        />
        <Route
          path="/lecturer/attendance"
          element={
            <ProtectedRoute roles={["Lecturer"]}>
              <LecturerAttendance />
            </ProtectedRoute>
          }
        />
        <Route
          path="/student/academic"
          element={
            <ProtectedRoute roles={["Student"]}>
              <StudentAcademic />
            </ProtectedRoute>
          }
        />

        {/* Unknown URL */}
        <Route path="*" element={<Navigate to="/login" />} />
      </Routes>
    </AuthProvider>
  );
}

export default App;
